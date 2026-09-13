import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";

const include = { customer: true, supplier: true, order: true, employee: { select: { id: true, name: true } },
  allocations: { include: { invoice: true } }, debtAllocations: { include: { debt: true } }, receipt: true };

export function createPaymentService(prisma) {
  return {
    async list(companyId, query) {
      const page = parsePagination(query, { allowedSortFields: ["createdAt", "paidAt", "amount", "number"] }); const where = { companyId };
      for (const field of ["status", "method", "customerId", "supplierId", "orderId"]) if (query[field]) where[field] = query[field];
      if (page.search) where.OR = [{ number: { contains: page.search, mode: "insensitive" } }, { externalRef: { contains: page.search, mode: "insensitive" } }];
      const [data, total] = await prisma.$transaction([prisma.payment.findMany({ where, include, skip: page.skip, take: page.take,
        orderBy: { [page.sortBy || "createdAt"]: page.sortOrder } }), prisma.payment.count({ where })]);
      return { data, meta: paginationMeta({ ...page, total }) };
    },
    async create(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const allocationTotal = [...(input.allocations || []), ...(input.debtAllocations || [])].reduce((sum, row) => sum + row.amount, 0);
        if (allocationTotal > input.amount + 0.01) throw new ValidationError("Allocations exceed payment amount");
        const invoiceIds = [...new Set((input.allocations || []).map(({ invoiceId }) => invoiceId))];
        const debtIds = [...new Set((input.debtAllocations || []).map(({ debtId }) => debtId))];
        const [customer, supplier, order, shift, invoices, debts] = await Promise.all([
          input.customerId ? tx.customer.count({ where: { id: input.customerId, companyId, deletedAt: null } }) : 1,
          input.supplierId ? tx.supplier.count({ where: { id: input.supplierId, companyId, deletedAt: null } }) : 1,
          input.orderId ? tx.order.count({ where: { id: input.orderId, companyId } }) : 1,
          input.shiftId ? tx.shift.count({ where: { id: input.shiftId, companyId, status: "OPEN" } }) : 1,
          invoiceIds.length ? tx.invoice.count({ where: { id: { in: invoiceIds }, companyId, status: { not: "VOID" }, ...(input.customerId ? { customerId: input.customerId } : {}) } }) : 0,
          debtIds.length ? tx.debt.count({ where: { id: { in: debtIds }, companyId, supplierId: input.supplierId, outstanding: { gt: 0 } } }) : 0,
        ]);
        if (customer !== 1 || supplier !== 1 || order !== 1 || shift !== 1 || invoices !== invoiceIds.length || debts !== debtIds.length) throw new ValidationError("Invalid payment resource reference");
        return tx.payment.create({ data: { companyId, employeeId, customerId: input.customerId, supplierId: input.supplierId, orderId: input.orderId,
          shiftId: input.shiftId, method: input.method, amount: input.amount, currency: input.currency || "UZS",
          externalRef: input.externalRef, note: input.note, number: await nextDocumentNumber(tx, companyId, "PAYMENT", "PAY"),
          allocations: { create: input.allocations || [] }, debtAllocations: { create: input.debtAllocations || [] } }, include });
      });
    },
    async confirm(companyId, employeeId, id) {
      return prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findFirst({ where: { id, companyId }, include });
        if (!payment) throw new NotFoundError("Payment not found"); if (payment.status !== "PENDING") throw new ConflictError("Payment is already processed");
        for (const allocation of payment.allocations) {
          const invoice = allocation.invoice; const nextPaid = Number(invoice.paid) + Number(allocation.amount);
          if (nextPaid > Number(invoice.total) + 0.01) throw new ConflictError("Payment allocation overpays invoice", { invoiceId: invoice.id });
          await tx.invoice.update({ where: { id: invoice.id }, data: { paid: nextPaid,
            status: nextPaid >= Number(invoice.total) ? "PAID" : "PARTIALLY_PAID" } });
          const debts = await tx.debt.findMany({ where: { invoiceId: invoice.id, outstanding: { gt: 0 } }, orderBy: { createdAt: "asc" } });
          let remaining = Number(allocation.amount);
          for (const debt of debts) {
            const applied = Math.min(remaining, Number(debt.outstanding)); const outstanding = Number(debt.outstanding) - applied;
            await tx.debt.update({ where: { id: debt.id }, data: { outstanding, settledAt: outstanding <= 0 ? new Date() : null } });
            remaining -= applied;
          }
          if (invoice.customerId) await tx.customer.update({ where: { id: invoice.customerId }, data: { balance: { decrement: Number(allocation.amount) } } });
        }
        for (const allocation of payment.debtAllocations) {
          const outstanding = Number(allocation.debt.outstanding) - Number(allocation.amount);
          if (outstanding < -0.01) throw new ConflictError("Payment allocation overpays debt", { debtId: allocation.debt.id });
          await tx.debt.update({ where: { id: allocation.debt.id }, data: { outstanding: Math.max(0, outstanding), settledAt: outstanding <= 0 ? new Date() : null } });
          if (allocation.debt.supplierId) await tx.supplier.update({ where: { id: allocation.debt.supplierId }, data: { balance: { decrement: Number(allocation.amount) } } });
        }
        if (payment.method === "CASH") {
          const shift = payment.shiftId ? await tx.shift.findFirst({ where: { id: payment.shiftId, companyId, status: "OPEN" } }) : null;
          if (!shift) throw new ValidationError("Open shift is required for cash payment");
          const outgoing = Boolean(payment.supplierId);
          if (outgoing && Number(shift.expectedCash) < Number(payment.amount)) throw new ConflictError("Cashbox has insufficient cash");
          await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId: shift.id, type: outgoing ? "EXPENSE" : "INCOME",
            amount: payment.amount, reference: payment.number, description: outgoing ? "Supplier payment" : "Customer payment" } });
          await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: outgoing ? { decrement: payment.amount } : { increment: payment.amount } } });
          await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: outgoing ? { decrement: payment.amount } : { increment: payment.amount } } });
        }
        await tx.ledgerEntry.createMany({ data: payment.supplierId ? [
          { companyId, supplierId: payment.supplierId, side: "DEBIT", account: "PAYABLE", amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number },
          { companyId, supplierId: payment.supplierId, side: "CREDIT", account: "CASH_AND_BANK", amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number },
        ] : [
          { companyId, customerId: payment.customerId, side: "DEBIT", account: "CASH_AND_BANK", amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number },
          { companyId, customerId: payment.customerId, side: "CREDIT", account: "RECEIVABLE", amount: payment.amount, referenceType: "Payment", referenceId: payment.id, description: payment.number },
        ] });
        await tx.payment.update({ where: { id }, data: { status: "CONFIRMED", confirmedAt: new Date(), paidAt: new Date(), employeeId } });
        await tx.receipt.create({ data: { companyId, paymentId: id, number: await nextDocumentNumber(tx, companyId, "RECEIPT", "RCP"),
          payload: { paymentNumber: payment.number, amount: Number(payment.amount), method: payment.method } } });
        return tx.payment.findUnique({ where: { id }, include });
      }, { isolationLevel: "Serializable" });
    },
    async cancel(companyId, id) {
      const payment = await prisma.payment.findFirst({ where: { id, companyId } }); if (!payment) throw new NotFoundError("Payment not found");
      if (payment.status !== "PENDING") throw new ConflictError("Confirmed payments require a refund workflow");
      return prisma.payment.update({ where: { id }, data: { status: "CANCELLED" }, include });
    },
  };
}
