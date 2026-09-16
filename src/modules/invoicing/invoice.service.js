import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { INVOICE_INCLUDE } from "./invoice.constants.js";

export async function issueInvoiceInTransaction(tx, companyId, id) {
  const invoice = await tx.invoice.findFirst({ where: { id, companyId }, include: INVOICE_INCLUDE });
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (invoice.status !== "DRAFT") throw new ConflictError("Only draft invoices can be issued");
  const netTotal = Math.max(0, Number(invoice.total) - Number(invoice.credited || 0));
  let paid = Number(invoice.paid || 0);
  let advanceApplied = 0;
  if (invoice.customerId && paid + 0.01 < netTotal) {
    const customer = await tx.customer.findFirst({ where: { id: invoice.customerId, companyId }, select: { advance: true } });
    advanceApplied = Math.min(Number(customer?.advance || 0), Math.max(0, netTotal - paid));
    if (advanceApplied > 0) {
      paid += advanceApplied;
      await tx.customer.update({ where: { id: invoice.customerId }, data: { advance: { decrement: advanceApplied } } });
    }
  }
  const outstanding = Math.max(0, netTotal - paid);
  const status = outstanding <= 0.01 ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "ISSUED";
  const data = await tx.invoice.update({ where: { id }, data: { status, paid, issuedAt: new Date() }, include: INVOICE_INCLUDE });
  if (outstanding > 0 && invoice.customerId) {
    await tx.debt.create({ data: { companyId, customerId: invoice.customerId, invoiceId: invoice.id,
      referenceType: "Invoice", referenceId: invoice.id, original: outstanding, outstanding, dueAt: invoice.dueAt } });
    await tx.customer.update({ where: { id: invoice.customerId }, data: { balance: { increment: outstanding } } });
  }
  await tx.ledgerEntry.createMany({ data: [
    { companyId, customerId: invoice.customerId, side: "DEBIT", account: "RECEIVABLE", amount: invoice.total, referenceType: "Invoice", referenceId: invoice.id, description: invoice.number },
    { companyId, customerId: invoice.customerId, side: "CREDIT", account: "SALES", amount: invoice.total, referenceType: "Invoice", referenceId: invoice.id, description: invoice.number },
    ...(advanceApplied > 0 ? [
      { companyId, customerId: invoice.customerId, side: "DEBIT", account: "CUSTOMER_ADVANCE", amount: advanceApplied, referenceType: "CustomerAdvanceApplied", referenceId: invoice.id, description: invoice.number },
      { companyId, customerId: invoice.customerId, side: "CREDIT", account: "RECEIVABLE", amount: advanceApplied, referenceType: "CustomerAdvanceApplied", referenceId: invoice.id, description: invoice.number },
    ] : []),
  ] });
  return data;
}

export function createInvoiceService(prisma) {
  return {
    async list(companyId, query) {
      const page = parsePagination(query, { allowedSortFields: ["createdAt", "issuedAt", "dueAt", "total", "number"] });
      const where = { companyId };
      for (const field of ["status", "customerId", "orderId"]) if (query[field]) where[field] = query[field];
      if (page.search) where.OR = [{ number: { contains: page.search, mode: "insensitive" } }, { customer: { name: { contains: page.search, mode: "insensitive" } } }];
      const [data, total] = await prisma.$transaction([
        prisma.invoice.findMany({ where, include: INVOICE_INCLUDE, skip: page.skip, take: page.take, orderBy: { [page.sortBy || "createdAt"]: page.sortOrder } }),
        prisma.invoice.count({ where }),
      ]); return { data, meta: paginationMeta({ ...page, total }) };
    },
    async find(companyId, id) { const data = await prisma.invoice.findFirst({ where: { id, companyId }, include: INVOICE_INCLUDE }); if (!data) throw new NotFoundError("Invoice not found"); return data; },
    async create(companyId, input) {
      return prisma.$transaction(async (tx) => {
        const customer = input.customerId ? await tx.customer.count({ where: { id: input.customerId, companyId, deletedAt: null } }) : 1;
        const order = input.orderId ? await tx.order.count({ where: { id: input.orderId, companyId } }) : 1;
        if (customer !== 1 || order !== 1) throw new ValidationError("Invalid invoice resource reference");
        const rows = input.items.map((row) => ({ ...row, tax: row.tax || 0, total: row.quantity * row.unitPrice + (row.tax || 0) }));
        const subtotal = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0); const tax = rows.reduce((sum, row) => sum + row.tax, 0);
        const discount = input.discount || 0; const total = subtotal + tax - discount;
        return tx.invoice.create({ data: { companyId, customerId: input.customerId, orderId: input.orderId,
          number: await nextDocumentNumber(tx, companyId, "INVOICE", "INV"), currency: input.currency || "UZS",
          subtotal, tax, discount, total, dueAt: input.dueAt, items: { create: rows } }, include: INVOICE_INCLUDE });
      });
    },
    async issue(companyId, id) {
      return prisma.$transaction((tx) => issueInvoiceInTransaction(tx, companyId, id), { isolationLevel: "Serializable" });
    },
    async void(companyId, id) {
      return prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({ where: { id, companyId }, include: { debts: true } });
        if (!invoice) throw new NotFoundError("Invoice not found"); if (Number(invoice.paid) > 0 || Number(invoice.credited || 0) > 0 || invoice.status === "VOID") throw new ConflictError("Paid, credited or void invoice cannot be voided");
        const outstanding = invoice.debts.reduce((sum, debt) => sum + Number(debt.outstanding), 0);
        await tx.debt.updateMany({ where: { invoiceId: id }, data: { outstanding: 0, settledAt: new Date() } });
        if (invoice.customerId && outstanding) await tx.customer.update({ where: { id: invoice.customerId }, data: { balance: { decrement: outstanding } } });
        if (invoice.status !== "DRAFT") await tx.ledgerEntry.createMany({ data: [
          { companyId, customerId: invoice.customerId, side: "DEBIT", account: "SALES_REVERSAL", amount: invoice.total, referenceType: "InvoiceVoid", referenceId: invoice.id, description: invoice.number },
          { companyId, customerId: invoice.customerId, side: "CREDIT", account: "RECEIVABLE", amount: invoice.total, referenceType: "InvoiceVoid", referenceId: invoice.id, description: invoice.number },
        ] });
        return tx.invoice.update({ where: { id }, data: { status: "VOID" }, include: INVOICE_INCLUDE });
      });
    },
  };
}
