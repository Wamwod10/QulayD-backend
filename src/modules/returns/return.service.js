import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { changeStock } from "../inventory/balances/balance.service.js";

const include = { order: true, customer: true, items: { include: { product: true, orderItem: true } } };
const roundQty = (value) => Math.round(Number(value || 0) * 1000) / 1000;
const asJsonArray = (value) => Array.isArray(value) ? value : [];

function normalizedBatchAllocations(value) {
  return asJsonArray(value)
    .map((row) => ({ batchId: row?.batchId, quantity: roundQty(row?.quantity) }))
    .filter((row) => row.batchId && row.quantity > 0);
}

function claimedBatchMap(items) {
  const claimed = new Map();
  for (const item of items) {
    for (const allocation of normalizedBatchAllocations(item.batchAllocations)) {
      claimed.set(allocation.batchId, roundQty((claimed.get(allocation.batchId) || 0) + allocation.quantity));
    }
  }
  return claimed;
}

function allocateReturnedBatches(sourceAllocations, claimed, requestedQuantity, details = {}) {
  let remaining = roundQty(requestedQuantity);
  const allocations = [];
  for (const source of normalizedBatchAllocations(sourceAllocations)) {
    const available = Math.max(0, roundQty(source.quantity - (claimed.get(source.batchId) || 0)));
    const used = Math.min(remaining, available);
    if (used > 0) allocations.push({ batchId: source.batchId, quantity: roundQty(used) });
    remaining = roundQty(remaining - used);
    if (remaining <= 0) break;
  }
  if (remaining > 0) throw new ConflictError("Original sold lot/batch quantity is not available for this return", { ...details, remaining });
  return allocations;
}

function allocationsFromSerials(serials) {
  const grouped = new Map();
  for (const serial of serials) {
    if (!serial.batchId) throw new ConflictError("Returned serial/IMEI is missing its original lot/batch identity", { serialId: serial.id });
    grouped.set(serial.batchId, roundQty((grouped.get(serial.batchId) || 0) + 1));
  }
  return [...grouped.entries()].map(([batchId, quantity]) => ({ batchId, quantity }));
}

function assertAllocationsAvailable(sourceAllocations, claimed, allocations, details = {}) {
  const source = new Map(normalizedBatchAllocations(sourceAllocations).map((row) => [row.batchId, row.quantity]));
  for (const row of allocations) {
    const available = Math.max(0, roundQty((source.get(row.batchId) || 0) - (claimed.get(row.batchId) || 0)));
    if (row.quantity > available + 1e-9) {
      throw new ConflictError("Returned lot/batch does not match the original sold item", { ...details, batchId: row.batchId, requested: row.quantity, available });
    }
  }
}

async function restoreBatches(tx, { companyId, warehouseId, productId, variantId, allocations }) {
  for (const allocation of normalizedBatchAllocations(allocations)) {
    const batch = await tx.productBatch.findFirst({
      where: { id: allocation.batchId, companyId, warehouseId, productId, variantId: variantId || null },
      select: { id: true },
    });
    if (!batch) throw new ConflictError("Original lot/batch no longer exists for restock", { productId, batchId: allocation.batchId });
    await tx.productBatch.update({ where: { id: batch.id }, data: { quantity: { increment: allocation.quantity } } });
  }
}

export function createReturnService(prisma) {
  return {
    list(companyId) { return prisma.return.findMany({ where: { companyId }, include, orderBy: { createdAt: "desc" }, take: 500 }); },
    async create(companyId, input) { return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, companyId, status: "COMPLETED" },
        include: { items: { include: { product: true } } },
      });
      if (!order) throw new NotFoundError("Completed order not found");
      const requestedOrderItemIds = input.items.map(({ orderItemId }) => orderItemId);
      const prior = await tx.returnItem.findMany({
        where: { orderItemId: { in: requestedOrderItemIds }, return: { companyId, status: { notIn: ["REJECTED", "CANCELLED"] } } },
        select: { orderItemId: true, quantity: true, serialIds: true, batchAllocations: true },
      });
      const claimedSerialIds = new Set(prior.flatMap((item) => asJsonArray(item.serialIds)));
      const claimedBatches = claimedBatchMap(prior);
      let total = 0; const rows = [];

      for (const row of input.items) {
        const source = order.items.find(({ id }) => id === row.orderItemId);
        const alreadyReturned = prior.filter(({ orderItemId }) => orderItemId === row.orderItemId).reduce((sum, item) => sum + Number(item.quantity), 0);
        if (!source || alreadyReturned + row.quantity > Number(source.quantity) + 1e-9) throw new ValidationError("Invalid return quantity");
        const amount = row.quantity * Number(source.unitPrice);
        const conversionToBase = Number(source.conversionToBase || 1);
        const baseQuantity = roundQty(row.quantity * conversionToBase);
        const sourceSerialIds = asJsonArray(source.serialIds);
        let serialIds = [...new Set(row.serialIds || [])];
        let serialRows = [];

        if (source.product.trackSerial) {
          if (!Number.isInteger(baseQuantity)) throw new ValidationError("Serialized return quantity must resolve to whole base units", { orderItemId: source.id });
          if (!serialIds.length && sourceSerialIds.length) serialIds = sourceSerialIds.filter((serialId) => !claimedSerialIds.has(serialId)).slice(0, baseQuantity);
          if (!serialIds.length) {
            const legacySerials = await tx.productSerial.findMany({
              where: { companyId, soldOrderId: order.id, productId: source.productId, variantId: source.variantId || null,
                status: "SOLD", id: { notIn: [...claimedSerialIds] } },
              select: { id: true }, orderBy: { createdAt: "asc" }, take: baseQuantity,
            });
            serialIds = legacySerials.map((item) => item.id);
          }
          if (serialIds.length !== baseQuantity || serialIds.some((serialId) => claimedSerialIds.has(serialId))) {
            throw new ValidationError("Every serialized returned unit must have a unique serial / IMEI", { orderItemId: source.id });
          }
          if (sourceSerialIds.length && serialIds.some((serialId) => !sourceSerialIds.includes(serialId))) {
            throw new ValidationError("One or more return serial / IMEI values do not belong to this sold line", { orderItemId: source.id });
          }
          serialRows = await tx.productSerial.findMany({
            where: { id: { in: serialIds }, companyId, soldOrderId: order.id, productId: source.productId,
              variantId: source.variantId || null, status: "SOLD" },
            select: { id: true, batchId: true },
          });
          if (serialRows.length !== serialIds.length) throw new ValidationError("One or more return serial / IMEI values do not belong to the sold item", { orderItemId: source.id });
          serialIds.forEach((serialId) => claimedSerialIds.add(serialId));
        } else if (serialIds.length) {
          throw new ValidationError("Serial / IMEI can only be returned for serialized products", { orderItemId: source.id });
        }

        let batchAllocations = [];
        if (source.product.trackLot || source.product.trackExpiry) {
          const sourceAllocations = normalizedBatchAllocations(source.batchAllocations);
          if (!sourceAllocations.length) {
            if ((row.condition || "RESTOCK") === "RESTOCK") {
              throw new ConflictError("Original sold lot/batch identity is unavailable. Use a tracked stock adjustment instead of automatic restock.", { orderItemId: source.id });
            }
          } else if (source.product.trackSerial) {
            batchAllocations = allocationsFromSerials(serialRows);
            assertAllocationsAvailable(sourceAllocations, claimedBatches, batchAllocations, { orderItemId: source.id });
          } else {
            batchAllocations = allocateReturnedBatches(sourceAllocations, claimedBatches, baseQuantity, { orderItemId: source.id });
          }
          for (const allocation of batchAllocations) {
            claimedBatches.set(allocation.batchId, roundQty((claimedBatches.get(allocation.batchId) || 0) + allocation.quantity));
          }
        }

        total += amount;
        rows.push({
          orderItemId: source.id, productId: source.productId, variantId: source.variantId, packageId: source.packageId,
          quantity: row.quantity, baseQuantity, conversionToBase, unitPrice: source.unitPrice, total: amount,
          condition: row.condition || "RESTOCK", serialIds, batchAllocations,
        });
      }

      return tx.return.create({ data: {
        companyId, orderId: order.id, customerId: order.customerId, reason: input.reason, total,
        number: await nextDocumentNumber(tx, companyId, "RETURN", "RET"), status: "REQUESTED", items: { create: rows },
      }, include });
    }, { isolationLevel: "Serializable" }); },
    async approve(companyId, id) {
      const current = await prisma.return.findFirst({ where: { id, companyId } });
      if (!current) throw new NotFoundError("Return not found");
      if (current.status !== "REQUESTED") throw new ConflictError("Return cannot be approved");
      return prisma.return.update({ where: { id }, data: { status: "APPROVED" }, include });
    },
    async receive(companyId, employeeId, id) { return prisma.$transaction(async (tx) => {
      const doc = await tx.return.findFirst({ where: { id, companyId }, include: { items: true, order: true } });
      if (!doc) throw new NotFoundError("Return not found");
      if (doc.status !== "APPROVED") throw new ConflictError("Only approved return can be received");
      for (const row of doc.items) {
        const serialIds = asJsonArray(row.serialIds);
        const batchAllocations = normalizedBatchAllocations(row.batchAllocations);
        if (row.condition === "RESTOCK") {
          if (batchAllocations.length) {
            await restoreBatches(tx, { companyId, warehouseId: doc.order.warehouseId, productId: row.productId, variantId: row.variantId, allocations: batchAllocations });
          }
          await changeStock(tx, {
            companyId, warehouseId: doc.order.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, employeeId,
            quantity: Number(row.baseQuantity || row.quantity), type: "RETURN_IN", referenceType: "Return", referenceId: doc.id, reason: doc.reason,
          });
          if (serialIds.length) {
            const updated = await tx.productSerial.updateMany({
              where: { id: { in: serialIds }, companyId, productId: row.productId, soldOrderId: doc.orderId, status: "SOLD", variantId: row.variantId || null },
              data: { status: "AVAILABLE", warehouseId: doc.order.warehouseId, soldOrderId: null },
            });
            if (updated.count !== serialIds.length) throw new ConflictError("One or more returned serial/IMEI units are invalid");
          }
        } else if (serialIds.length) {
          const updated = await tx.productSerial.updateMany({
            where: { id: { in: serialIds }, companyId, productId: row.productId, soldOrderId: doc.orderId, status: "SOLD", variantId: row.variantId || null },
            data: { status: "DAMAGED", warehouseId: doc.order.warehouseId, soldOrderId: null },
          });
          if (updated.count !== serialIds.length) throw new ConflictError("One or more returned serial/IMEI units are invalid");
        }
      }
      return tx.return.update({ where: { id }, data: { status: "RECEIVED" }, include });
    }, { isolationLevel: "Serializable" }); },
    async refund(companyId, employeeId, id, input) { return prisma.$transaction(async (tx) => {
      const doc = await tx.return.findFirst({ where: { id, companyId }, include });
      if (!doc) throw new NotFoundError("Return not found");
      if (doc.status !== "RECEIVED") throw new ConflictError("Return must be received before refund");

      const invoices = await tx.invoice.findMany({ where: { companyId, orderId: doc.orderId, status: { not: "VOID" } },
        include: { debts: { where: { outstanding: { gt: 0 } }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] } },
        orderBy: [{ issuedAt: "asc" }, { createdAt: "asc" }] });
      let remainingCredit = Number(doc.total);
      let creditOffset = 0;
      let advanceRestored = 0;
      let payoutAmount = 0;

      for (const invoice of invoices) {
        if (remainingCredit <= 0.009) break;
        const netBefore = Math.max(0, Number(invoice.total) - Number(invoice.credited || 0));
        const credit = Math.min(remainingCredit, netBefore);
        if (credit <= 0.009) continue;
        const oldOutstanding = Math.max(0, netBefore - Number(invoice.paid || 0));
        const debtPart = Math.min(credit, oldOutstanding);
        let paidPart = Math.max(0, credit - debtPart);

        let debtRemaining = debtPart;
        for (const debt of invoice.debts) {
          if (debtRemaining <= 0.009) break;
          const applied = Math.min(debtRemaining, Number(debt.outstanding));
          const outstanding = Math.max(0, Number(debt.outstanding) - applied);
          await tx.debt.update({ where: { id: debt.id }, data: { outstanding, settledAt: outstanding <= 0.009 ? new Date() : null } });
          debtRemaining -= applied;
          creditOffset += applied;
        }
        if (debtRemaining > 0.01) throw new ConflictError("Invoice debt records are inconsistent with invoice outstanding", { invoiceId: invoice.id, debtRemaining });

        let restoredFromAdvance = 0;
        if (paidPart > 0 && doc.customerId) {
          const [advanceApplied, priorRestored] = await Promise.all([
            tx.ledgerEntry.aggregate({ where: { companyId, referenceType: "CustomerAdvanceApplied", referenceId: invoice.id,
              account: "CUSTOMER_ADVANCE", side: "DEBIT" }, _sum: { amount: true } }),
            tx.ledgerEntry.aggregate({ where: { companyId, referenceType: "ReturnAdvanceRestore", description: invoice.id,
              account: "CUSTOMER_ADVANCE", side: "CREDIT" }, _sum: { amount: true } }),
          ]);
          const refundableAdvance = Math.max(0, Number(advanceApplied._sum.amount || 0) - Number(priorRestored._sum.amount || 0));
          restoredFromAdvance = Math.min(paidPart, refundableAdvance);
          if (restoredFromAdvance > 0) {
            await tx.customer.update({ where: { id: doc.customerId }, data: { advance: { increment: restoredFromAdvance } } });
            advanceRestored += restoredFromAdvance;
          }
        }
        const externalPayout = Math.max(0, paidPart - restoredFromAdvance);
        payoutAmount += externalPayout;
        const newCredited = Number(invoice.credited || 0) + credit;
        const newPaid = Math.max(0, Number(invoice.paid || 0) - paidPart);
        const adjustedTotal = Math.max(0, Number(invoice.total) - newCredited);
        const status = adjustedTotal <= 0.009 || newPaid + 0.009 >= adjustedTotal ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "ISSUED";
        await tx.invoice.update({ where: { id: invoice.id }, data: { credited: newCredited, paid: newPaid, status } });
        if (restoredFromAdvance > 0) await tx.ledgerEntry.create({ data: { companyId, customerId: doc.customerId,
          side: "CREDIT", account: "CUSTOMER_ADVANCE", amount: restoredFromAdvance, referenceType: "ReturnAdvanceRestore",
          referenceId: doc.id, description: invoice.id } });
        remainingCredit -= credit;
      }
      if (remainingCredit > 0.01) throw new ConflictError("Return amount exceeds the issued invoice value", { remainingCredit });
      if (doc.customerId && creditOffset > 0) {
        const customer = await tx.customer.update({ where: { id: doc.customerId }, data: { balance: { decrement: creditOffset } } });
        if (Number(customer.balance) < -0.01) throw new ConflictError("Customer balance would become inconsistent after return");
      }

      const originalPayments = await tx.payment.findMany({ where: { companyId, orderId: doc.orderId, status: "CONFIRMED", amount: { gt: 0 } },
        orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }] });
      const priorRefunds = await tx.payment.findMany({ where: { companyId, orderId: doc.orderId, status: "REFUNDED", amount: { gt: 0 } } });
      const refundedByTender = new Map();
      for (const payment of priorRefunds) {
        const key = payment.methodCode || payment.method;
        refundedByTender.set(key, (refundedByTender.get(key) || 0) + Number(payment.amount));
      }
      const allocations = [];
      let payoutRemaining = Math.round(payoutAmount * 100) / 100;
      for (const payment of originalPayments) {
        if (payoutRemaining <= 0.009) break;
        const key = payment.methodCode || payment.method;
        const used = refundedByTender.get(key) || 0;
        const available = Math.max(0, Number(payment.amount) - used);
        const amount = Math.min(payoutRemaining, available);
        if (amount <= 0.009) continue;
        allocations.push({ method: payment.method, methodCode: payment.methodCode || payment.method, amount });
        refundedByTender.set(key, used + amount);
        payoutRemaining -= amount;
      }
      if (payoutRemaining > 0.009) {
        const methodConfig = input.methodCode
          ? await tx.paymentMethodConfig.findFirst({ where: { companyId, code: input.methodCode, status: "ACTIVE" } })
          : await tx.paymentMethodConfig.findFirst({ where: { companyId, method: input.method, status: "ACTIVE" } });
        if (!methodConfig) throw new ConflictError("Selected refund payment method is disabled or unavailable");
        allocations.push({ method: methodConfig.method, methodCode: methodConfig.code, amount: payoutRemaining });
        payoutRemaining = 0;
      }

      const cashTotal = allocations.filter((row) => row.method === "CASH").reduce((sum, row) => sum + row.amount, 0);
      let shift = null;
      if (cashTotal > 0.009) {
        shift = input.shiftId ? await tx.shift.findFirst({ where: { id: input.shiftId, companyId, employeeId, status: "OPEN" }, include: { cashbox: true } }) : null;
        if (!shift || shift.cashbox?.warehouseId !== doc.order.warehouseId || Number(shift.expectedCash) + 0.009 < cashTotal) {
          throw new ConflictError("Refund uchun shu omborga tegishli ochiq smenada yetarli naqd pul kerak", { cashRequired: cashTotal });
        }
      }

      const payments = [];
      for (const allocation of allocations) {
        const payment = await tx.payment.create({ data: { companyId, customerId: doc.customerId, orderId: doc.orderId, employeeId,
          shiftId: allocation.method === "CASH" ? shift?.id : null, number: await nextDocumentNumber(tx, companyId, "REFUND", "REF"),
          method: allocation.method, methodCode: allocation.methodCode, status: "REFUNDED", amount: allocation.amount,
          paidAt: new Date(), confirmedAt: new Date(), note: input.note || `Return ${doc.number}` } });
        payments.push(payment);
        if (allocation.method === "CASH") {
          await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId: shift.id, type: "REFUND",
            amount: allocation.amount, reference: doc.number, description: input.note } });
          await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: { decrement: allocation.amount } } });
          await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { decrement: allocation.amount } } });
        }
      }

      await tx.ledgerEntry.createMany({ data: [
        { companyId, customerId: doc.customerId, side: "DEBIT", account: "SALES_RETURN", amount: doc.total, referenceType: "Return", referenceId: doc.id },
        ...(creditOffset > 0 ? [{ companyId, customerId: doc.customerId, side: "CREDIT", account: "RECEIVABLE", amount: creditOffset, referenceType: "Return", referenceId: doc.id }] : []),
        ...allocations.map((row) => ({ companyId, customerId: doc.customerId, side: "CREDIT", account: "CASH_AND_BANK", amount: row.amount,
          referenceType: "Return", referenceId: doc.id, description: row.methodCode })),
      ] });
      const data = await tx.return.update({ where: { id }, data: { status: "REFUNDED" }, include });
      return { data, payment: payments[0] || null, payments, creditOffset, advanceRestored, payoutAmount: Math.round(payoutAmount * 100) / 100 };
    }, { isolationLevel: "Serializable" }); },
  };
}
