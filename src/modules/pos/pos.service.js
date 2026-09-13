import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { changeStock } from "../inventory/balances/balance.service.js";

export function createPosService(prisma) {
  return {
    async openShift(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const cashbox = await tx.cashbox.findFirst({ where: { id: input.cashboxId, companyId, status: "ACTIVE" } });
        if (!cashbox) throw new NotFoundError("Cashbox not found");
        const active = await tx.shift.findFirst({ where: { companyId, status: "OPEN", OR: [{ employeeId }, { cashboxId: input.cashboxId }] } });
        if (active) throw new ConflictError("Employee or cashbox already has an open shift");
        const shift = await tx.shift.create({ data: { companyId, employeeId, cashboxId: input.cashboxId,
          openingBalance: input.openingBalance, expectedCash: input.openingBalance, note: input.note } });
        await tx.cashTransaction.create({ data: { companyId, cashboxId: input.cashboxId, shiftId: shift.id,
          type: "OPENING", amount: input.openingBalance, description: "Shift opening balance" } });
        await tx.cashbox.update({ where: { id: input.cashboxId }, data: { balance: input.openingBalance } });
        return shift;
      });
    },
    currentShift(companyId, employeeId) {
      return prisma.shift.findFirst({ where: { companyId, employeeId, status: "OPEN" }, include: { cashbox: true, transactions: { orderBy: { createdAt: "desc" } } } });
    },
    async cashAction(companyId, employeeId, shiftId, input) {
      return prisma.$transaction(async (tx) => {
        const shift = await tx.shift.findFirst({ where: { id: shiftId, companyId, employeeId, status: "OPEN" } });
        if (!shift) throw new NotFoundError("Open shift not found");
        const positive = ["CASH_IN", "INCOME"].includes(input.type); const delta = positive ? input.amount : -input.amount;
        if (Number(shift.expectedCash) + delta < 0) throw new ConflictError("Cashbox balance cannot become negative");
        const transaction = await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId,
          type: input.type, amount: input.amount, description: input.description } });
        await tx.shift.update({ where: { id: shiftId }, data: { expectedCash: { increment: delta } } });
        await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { increment: delta } } });
        return transaction;
      });
    },
    async closeShift(companyId, employeeId, shiftId, input) {
      return prisma.$transaction(async (tx) => {
        const shift = await tx.shift.findFirst({ where: { id: shiftId, companyId, employeeId, status: "OPEN" } });
        if (!shift) throw new NotFoundError("Open shift not found");
        const difference = input.closingBalance - Number(shift.expectedCash);
        await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId,
          type: "CLOSING", amount: input.closingBalance, description: "Shift closing balance" } });
        await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: input.closingBalance } });
        return tx.shift.update({ where: { id: shiftId }, data: { status: "CLOSED", closingBalance: input.closingBalance,
          difference, closedAt: new Date(), note: input.note || shift.note }, include: { transactions: true, payments: true } });
      });
    },
    async sale(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const productIds = [...new Set(input.items.map(({ productId }) => productId))];
        const [warehouse, products, customer, shift] = await Promise.all([
          tx.warehouse.count({ where: { id: input.warehouseId, companyId, deletedAt: null } }),
          tx.product.count({ where: { id: { in: productIds }, companyId, deletedAt: null, status: "ACTIVE" } }),
          input.customerId ? tx.customer.count({ where: { id: input.customerId, companyId, deletedAt: null } }) : 1,
          input.shiftId ? tx.shift.findFirst({ where: { id: input.shiftId, companyId, employeeId, status: "OPEN" } }) : null,
        ]);
        if (warehouse !== 1 || products !== productIds.length || customer !== 1) throw new ValidationError("Invalid POS resource reference");
        if (input.payments.some(({ method }) => method === "CASH") && !shift) throw new ValidationError("An open shift is required for cash payment");
        if (input.payments.some(({ method }) => method === "CREDIT") && !input.customerId) throw new ValidationError("Customer is required for credit sale");
        const rows = input.items.map((row) => ({ ...row, discount: row.discount || 0,
          total: row.quantity * row.unitPrice - (row.discount || 0), tax: 0 }));
        const subtotal = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);
        const discount = rows.reduce((sum, row) => sum + row.discount, 0); const total = subtotal - discount;
        const paid = input.payments.reduce((sum, row) => sum + row.amount, 0);
        if (Math.abs(paid - total) > 0.01) throw new ValidationError("Payment total must equal sale total", { expected: total, actual: paid });
        const order = await tx.order.create({ data: { companyId, warehouseId: input.warehouseId, customerId: input.customerId,
          createdById: employeeId, number: await nextDocumentNumber(tx, companyId, "ORDER", "ORD"), channel: "POS",
          status: "COMPLETED", fulfillmentStatus: "FULFILLED", deliveryStatus: "DELIVERED", paymentStatus: "PAID",
          currency: input.currency || "UZS", subtotal, discount, total, completedAt: new Date(), note: input.note,
          items: { create: rows } }, include: { items: true } });
        for (const row of order.items) await changeStock(tx, { companyId, warehouseId: input.warehouseId, productId: row.productId,
          employeeId, quantity: -Number(row.quantity), type: "SALE", referenceType: "Order", referenceId: order.id });
        await tx.orderStatusHistory.create({ data: { orderId: order.id, employeeId, status: "COMPLETED", fulfillment: "FULFILLED", delivery: "DELIVERED", note: "POS sale completed" } });
        const creditAmount = input.payments.filter(({ method }) => method === "CREDIT").reduce((sum, row) => sum + row.amount, 0);
        const invoice = await tx.invoice.create({ data: { companyId, orderId: order.id, customerId: input.customerId,
          number: await nextDocumentNumber(tx, companyId, "INVOICE", "INV"), status: creditAmount ? "PARTIALLY_PAID" : "PAID",
          currency: input.currency || "UZS", subtotal, discount, total, paid: total - creditAmount, issuedAt: new Date(),
          items: { create: rows.map((row) => ({ productId: row.productId, description: "POS item", quantity: row.quantity,
            unitPrice: row.unitPrice, total: row.total })) } } });
        const payments = [];
        for (const row of input.payments.filter(({ method }) => method !== "CREDIT")) {
          const payment = await tx.payment.create({ data: { companyId, customerId: input.customerId, orderId: order.id,
            employeeId, shiftId: input.shiftId, number: await nextDocumentNumber(tx, companyId, "PAYMENT", "PAY"),
            method: row.method, status: "CONFIRMED", amount: row.amount, currency: input.currency || "UZS",
            externalRef: row.externalRef, paidAt: new Date(), confirmedAt: new Date(),
            allocations: { create: { invoiceId: invoice.id, amount: row.amount } } } });
          payments.push(payment);
          if (row.method === "CASH") {
            await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId: shift.id,
              type: "SALE", amount: row.amount, reference: payment.number, description: order.number } });
            await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: { increment: row.amount } } });
            await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { increment: row.amount } } });
          }
        }
        if (creditAmount) {
          await tx.debt.create({ data: { companyId, customerId: input.customerId, invoiceId: invoice.id, original: creditAmount, outstanding: creditAmount } });
          await tx.customer.update({ where: { id: input.customerId }, data: { balance: { increment: creditAmount } } });
        }
        const settledAmount = total - creditAmount;
        await tx.ledgerEntry.createMany({ data: [
          ...(settledAmount > 0 ? [{ companyId, customerId: input.customerId, side: "DEBIT", account: "CASH_AND_BANK", amount: settledAmount, referenceType: "Order", referenceId: order.id }] : []),
          ...(creditAmount > 0 ? [{ companyId, customerId: input.customerId, side: "DEBIT", account: "RECEIVABLE", amount: creditAmount, referenceType: "Order", referenceId: order.id }] : []),
          { companyId, customerId: input.customerId, side: "CREDIT", account: "SALES", amount: total, referenceType: "Order", referenceId: order.id },
        ] });
        const receipt = await tx.receipt.create({ data: { companyId, orderId: order.id,
          number: await nextDocumentNumber(tx, companyId, "RECEIPT", "RCP"), payload: { orderNumber: order.number, total, currency: input.currency || "UZS", payments: input.payments } } });
        return { order, invoice, payments, receipt };
      }, { isolationLevel: "Serializable", timeout: 30_000 });
    },
  };
}
