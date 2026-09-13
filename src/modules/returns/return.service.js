import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { changeStock } from "../inventory/balances/balance.service.js";
const include = { order: true, customer: true, items: { include: { product: true, orderItem: true } } };
export function createReturnService(prisma) {
  return {
    list(companyId) { return prisma.return.findMany({ where: { companyId }, include, orderBy: { createdAt: "desc" }, take: 500 }); },
    async create(companyId, input) { return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: input.orderId, companyId, status: "COMPLETED" }, include: { items: true } });
      if (!order) throw new NotFoundError("Completed order not found");
      const prior = await tx.returnItem.groupBy({ by: ["orderItemId"], where: { orderItemId: { in: input.items.map(({ orderItemId }) => orderItemId) },
        return: { companyId, status: { notIn: ["REJECTED", "CANCELLED"] } } }, _sum: { quantity: true } });
      let total = 0; const rows = input.items.map((row) => {
        const source = order.items.find(({ id }) => id === row.orderItemId);
        const alreadyReturned = Number(prior.find(({ orderItemId }) => orderItemId === row.orderItemId)?._sum.quantity || 0);
        if (!source || alreadyReturned + row.quantity > Number(source.quantity)) throw new ValidationError("Invalid return quantity");
        const amount = row.quantity * Number(source.unitPrice); total += amount; return { orderItemId: source.id, productId: source.productId, quantity: row.quantity, unitPrice: source.unitPrice, total: amount, condition: row.condition };
      });
      return tx.return.create({ data: { companyId, orderId: order.id, customerId: order.customerId, reason: input.reason, total,
        number: await nextDocumentNumber(tx, companyId, "RETURN", "RET"), status: "REQUESTED", items: { create: rows } }, include });
    }); },
    async approve(companyId, id) { const current = await prisma.return.findFirst({ where: { id, companyId } }); if (!current) throw new NotFoundError("Return not found");
      if (current.status !== "REQUESTED") throw new ConflictError("Return cannot be approved"); return prisma.return.update({ where: { id }, data: { status: "APPROVED" }, include }); },
    async receive(companyId, employeeId, id) { return prisma.$transaction(async (tx) => {
      const doc = await tx.return.findFirst({ where: { id, companyId }, include: { items: true, order: true } }); if (!doc) throw new NotFoundError("Return not found");
      if (doc.status !== "APPROVED") throw new ConflictError("Only approved return can be received");
      for (const row of doc.items) await changeStock(tx, { companyId, warehouseId: doc.order.warehouseId, productId: row.productId, employeeId,
        quantity: row.quantity, type: "RETURN_IN", referenceType: "Return", referenceId: doc.id, reason: doc.reason });
      return tx.return.update({ where: { id }, data: { status: "RECEIVED" }, include });
    }, { isolationLevel: "Serializable" }); },
    async refund(companyId, employeeId, id, input) { return prisma.$transaction(async (tx) => {
      const doc = await tx.return.findFirst({ where: { id, companyId }, include }); if (!doc) throw new NotFoundError("Return not found");
      if (doc.status !== "RECEIVED") throw new ConflictError("Return must be received before refund");
      if (input.method === "CASH") { const shift = input.shiftId ? await tx.shift.findFirst({ where: { id: input.shiftId, companyId, employeeId, status: "OPEN" } }) : null;
        if (!shift || Number(shift.expectedCash) < Number(doc.total)) throw new ConflictError("Open shift with sufficient cash is required");
        await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId: shift.id, type: "REFUND", amount: doc.total, reference: doc.number, description: input.note } });
        await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: { decrement: doc.total } } }); await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { decrement: doc.total } } }); }
      const payment = await tx.payment.create({ data: { companyId, customerId: doc.customerId, orderId: doc.orderId, employeeId, shiftId: input.shiftId,
        number: await nextDocumentNumber(tx, companyId, "REFUND", "REF"), method: input.method, status: "REFUNDED", amount: doc.total, paidAt: new Date(), confirmedAt: new Date(), note: input.note } });
      await tx.ledgerEntry.createMany({ data: [
        { companyId, customerId: doc.customerId, side: "DEBIT", account: "SALES_RETURN", amount: doc.total, referenceType: "Return", referenceId: doc.id },
        { companyId, customerId: doc.customerId, side: "CREDIT", account: input.method === "CASH" ? "CASH_AND_BANK" : "REFUND_PAYABLE", amount: doc.total, referenceType: "Return", referenceId: doc.id },
      ] });
      const data = await tx.return.update({ where: { id }, data: { status: "REFUNDED" }, include }); return { data, payment };
    }, { isolationLevel: "Serializable" }); },
  };
}
