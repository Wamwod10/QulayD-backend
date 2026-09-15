import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { changeStock, resolveAllowNegativeStock } from "../inventory/balances/balance.service.js";

const toCents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (value) => value / 100;
const toMillis = (value) => Math.round(Number(value || 0) * 1000);
const decimalPlaces = (value) => (String(value).split(".")[1] || "").length;
const lineKey = (row) => `${row.productId}:${row.variantId || "base"}:${row.packageId || "base"}`;

function discountCents(input, grossCents) {
  const spec = input.discount || (input.discountAmount != null ? { type: "FIXED", value: input.discountAmount } : null);
  if (!spec) return 0;
  const amount = spec.type === "PERCENT" ? Math.round(grossCents * spec.value / 100) : toCents(spec.value);
  if (spec.type === "PERCENT" && spec.value > 100) throw new ValidationError("Discount percent cannot exceed 100");
  if (amount > grossCents) throw new ValidationError("Discount cannot exceed item total");
  return amount;
}

async function consumeBatches(tx, { companyId, warehouseId, product, variantId, requestedBatchId, baseQuantity }) {
  if (!product.trackLot && !product.trackExpiry) return [];
  const where = { companyId, warehouseId, productId: product.id, variantId: variantId || null,
    ...(requestedBatchId ? { id: requestedBatchId } : {}), quantity: { gt: 0 } };
  if (product.trackExpiry) where.expiresAt = { gt: new Date() };
  const batches = await tx.productBatch.findMany({ where, orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }] });
  let remaining = baseQuantity; const allocations = [];
  for (const batch of batches) {
    const used = Math.min(remaining, Math.max(0, Number(batch.quantity) - Number(batch.reserved)));
    if (used > 0) {
      await tx.productBatch.update({ where: { id: batch.id }, data: { quantity: { decrement: used } } });
      allocations.push({ batchId: batch.id, quantity: used });
    }
    remaining = Math.round((remaining - used) * 1000) / 1000;
    if (remaining <= 0) break;
  }
  if (remaining > 0) throw new ConflictError("Selected lot/batch has insufficient non-expired stock", { productId: product.id, remaining });
  return allocations;
}

async function resolveSale(tx, companyId, input) {
  const productIds = [...new Set(input.items.map(({ productId }) => productId))];
  const [warehouse, customer, products, defaultPriceList, methodConfigs] = await Promise.all([
    tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId, deletedAt: null, status: "ACTIVE" } }),
    input.customerId ? tx.customer.findFirst({ where: { id: input.customerId, companyId, deletedAt: null, status: "ACTIVE" } }) : null,
    tx.product.findMany({ where: { id: { in: productIds }, companyId, deletedAt: null, status: "ACTIVE" }, include: {
      unit: true, prices: { where: { validTo: null } }, variants: true, packages: true,
    } }),
    tx.priceList.findFirst({ where: { companyId, isDefault: true, status: "ACTIVE" } }),
    tx.paymentMethodConfig.findMany({ where: { companyId, status: "ACTIVE" } }),
  ]);
  if (!warehouse || products.length !== productIds.length || (input.customerId && !customer)) throw new ValidationError("Invalid POS resource reference");
  const configuredPriceListId = input.priceListId || customer?.metadata?.priceListId || defaultPriceList?.id;
  const configuredPriceList = configuredPriceListId
    ? await tx.priceList.findFirst({ where: { id: configuredPriceListId, companyId, status: "ACTIVE" } })
    : null;
  if (input.priceListId && !configuredPriceList) throw new ValidationError("Selected price list is not active or does not belong to company");
  const effectivePriceListId = configuredPriceList?.id || defaultPriceList?.id || null;
  const productMap = new Map(products.map((product) => [product.id, product]));
  const seenLines = new Set();
  const rows = input.items.map((item) => {
    const product = productMap.get(item.productId);
    const key = lineKey(item);
    if (seenLines.has(key)) throw new ValidationError("Duplicate product/variant/package POS lines must be merged before checkout");
    seenLines.add(key);
    const activeVariants = product.variants.filter((row) => row.status === "ACTIVE");
    const variant = item.variantId ? activeVariants.find((row) => row.id === item.variantId) : null;
    const productPackage = item.packageId ? product.packages.find((row) => row.id === item.packageId && row.status === "ACTIVE") : null;
    if (item.variantId && !variant) throw new ValidationError("Variant does not belong to product", { productId: item.productId, variantId: item.variantId });
    if (activeVariants.length && !variant) throw new ValidationError("Variant is required for this product", { productId: item.productId });
    if (item.packageId && (!productPackage || (productPackage.variantId && productPackage.variantId !== item.variantId))) throw new ValidationError("Package does not belong to product/variant");
    if (item.batchId && !product.trackLot && !product.trackExpiry) throw new ValidationError("Lot/batch can only be selected for batch-tracked products", { productId: product.id });
    if (decimalPlaces(item.quantity) > product.unit.precision) throw new ValidationError(`Quantity precision exceeds ${product.unit.precision}`, { productId: product.id });
    const conversionToBase = Number(productPackage?.conversionToBase || 1);
    const baseMillis = Math.round(toMillis(item.quantity) * conversionToBase);
    if (baseMillis <= 0) throw new ValidationError("Base quantity must be positive");
    const listPrice = product.prices.find((price) => price.priceListId === effectivePriceListId)?.price ?? product.prices[0]?.price;
    const resolvedPrice = productPackage?.price ?? variant?.price ?? listPrice ?? item.unitPrice ?? 0;
    const grossCents = Math.round(toMillis(item.quantity) * toCents(resolvedPrice) / 1000);
    const itemDiscountCents = discountCents(item, grossCents);
    return { productId: product.id, variantId: variant?.id, packageId: productPackage?.id, quantity: item.quantity,
      baseQuantity: baseMillis / 1000, conversionToBase, unitPrice: fromCents(toCents(resolvedPrice)), discount: fromCents(itemDiscountCents), tax: 0,
      total: fromCents(grossCents - itemDiscountCents), productName: product.name, sku: variant?.sku || product.sku, unitName: product.unit.shortName,
      variantName: variant?.name, packageName: productPackage?.name, serialIds: item.serialIds || [], batchId: item.batchId, product };
  });
  const subtotalCents = rows.reduce((sum, row) => sum + Math.round(toMillis(row.quantity) * toCents(row.unitPrice) / 1000), 0);
  const itemDiscountCents = rows.reduce((sum, row) => sum + toCents(row.discount), 0);
  const orderDiscountCents = discountCents({ discount: input.discount }, subtotalCents - itemDiscountCents);
  const totalCents = subtotalCents - itemDiscountCents - orderDiscountCents;
  if (totalCents < 0) throw new ValidationError("Sale total cannot be negative");
  const configByCode = new Map(methodConfigs.map((config) => [config.code, config]));
  const payments = input.payments.map((row) => {
    const config = row.methodCode ? configByCode.get(row.methodCode) : methodConfigs.find((item) => item.method === row.method);
    if (row.methodCode && !config) throw new ValidationError(`Payment method ${row.methodCode} is not active`);
    return { ...row, method: config?.method || row.method, methodCode: config?.code || row.method };
  });
  const paidCents = payments.reduce((sum, row) => sum + toCents(row.amount), 0);
  if (paidCents !== totalCents) throw new ValidationError("Payment total must equal sale total", { expected: fromCents(totalCents), actual: fromCents(paidCents) });
  const creditCents = payments.filter(({ method }) => method === "CREDIT").reduce((sum, row) => sum + toCents(row.amount), 0);
  if (creditCents && !customer) throw new ValidationError("Customer is required for credit sale");
  if (creditCents && toCents(customer.creditLimit) < toCents(customer.balance) + creditCents) throw new ConflictError("Customer credit limit exceeded");
  return { warehouse, customer, rows, payments, priceListId: effectivePriceListId, subtotal: fromCents(subtotalCents), discount: fromCents(itemDiscountCents + orderDiscountCents), total: fromCents(totalCents), creditAmount: fromCents(creditCents) };
}

export function createPosService(prisma) {
  return {
    async openShift(companyId, employeeId, input) { return prisma.$transaction(async (tx) => {
      const cashbox = await tx.cashbox.findFirst({ where: { id: input.cashboxId, companyId, status: "ACTIVE" } });
      if (!cashbox) throw new NotFoundError("Cashbox not found");
      const active = await tx.shift.findFirst({ where: { companyId, status: "OPEN", OR: [{ employeeId }, { cashboxId: input.cashboxId }] } });
      if (active) throw new ConflictError("Employee or cashbox already has an open shift");
      const shift = await tx.shift.create({ data: { companyId, employeeId, cashboxId: input.cashboxId, openingBalance: input.openingBalance, expectedCash: input.openingBalance, note: input.note } });
      await tx.cashTransaction.create({ data: { companyId, cashboxId: input.cashboxId, shiftId: shift.id, type: "OPENING", amount: input.openingBalance, description: "Shift opening balance" } });
      await tx.cashbox.update({ where: { id: input.cashboxId }, data: { balance: input.openingBalance } }); return shift;
    }); },
    currentShift(companyId, employeeId) { return prisma.shift.findFirst({ where: { companyId, employeeId, status: "OPEN" }, include: { cashbox: true, transactions: { orderBy: { createdAt: "desc" } } } }); },
    async cashAction(companyId, employeeId, shiftId, input) { return prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findFirst({ where: { id: shiftId, companyId, employeeId, status: "OPEN" } }); if (!shift) throw new NotFoundError("Open shift not found");
      const positive = ["CASH_IN", "INCOME"].includes(input.type); const delta = positive ? input.amount : -input.amount;
      if (Number(shift.expectedCash) + delta < 0) throw new ConflictError("Cashbox balance cannot become negative");
      const transaction = await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId, type: input.type, amount: input.amount, description: input.description } });
      await tx.shift.update({ where: { id: shiftId }, data: { expectedCash: { increment: delta } } }); await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { increment: delta } } }); return transaction;
    }); },
    async closeShift(companyId, employeeId, shiftId, input) { return prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findFirst({ where: { id: shiftId, companyId, employeeId, status: "OPEN" } }); if (!shift) throw new NotFoundError("Open shift not found");
      const difference = input.closingBalance - Number(shift.expectedCash); await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId, type: "CLOSING", amount: input.closingBalance, description: "Shift closing balance" } });
      await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: input.closingBalance } }); return tx.shift.update({ where: { id: shiftId }, data: { status: "CLOSED", closingBalance: input.closingBalance, difference, closedAt: new Date(), note: input.note || shift.note }, include: { transactions: true, payments: true } });
    }); },
    async sale(companyId, employeeId, input) { return prisma.$transaction(async (tx) => {
      const [resolved, allowNegative] = await Promise.all([
        resolveSale(tx, companyId, input),
        resolveAllowNegativeStock(tx, companyId),
      ]);
      const shift = resolved.payments.some(({ method }) => method === "CASH") ? await tx.shift.findFirst({ where: { id: input.shiftId, companyId, employeeId, status: "OPEN" }, include: { cashbox: true } }) : null;
      if (resolved.payments.some(({ method }) => method === "CASH") && !shift) throw new ValidationError("An open shift is required for cash payment");
      if (shift?.cashbox?.warehouseId && shift.cashbox.warehouseId !== input.warehouseId) throw new ValidationError("Cash shift belongs to a different warehouse");
      if (shift?.cashbox?.branchId && resolved.warehouse.branchId && shift.cashbox.branchId !== resolved.warehouse.branchId) throw new ValidationError("Cash shift belongs to a different branch");
      const order = await tx.order.create({ data: { companyId, warehouseId: input.warehouseId, customerId: input.customerId, priceListId: resolved.priceListId,
        createdById: employeeId, number: await nextDocumentNumber(tx, companyId, "ORDER", "ORD"), channel: "POS", status: "COMPLETED",
        fulfillmentStatus: "FULFILLED", deliveryStatus: "DELIVERED", paymentStatus: resolved.creditAmount ? "PARTIALLY_PAID" : "PAID",
        currency: input.currency || "UZS", subtotal: resolved.subtotal, discount: resolved.discount, total: resolved.total, completedAt: new Date(), note: input.note,
        items: { create: resolved.rows.map(({ product: _product, batchId: _batch, ...row }) => ({ ...row, fulfilledQty: row.quantity })) } }, include: { items: true } });
      const inputByKey = new Map(resolved.rows.map((row) => [lineKey(row), row]));
      for (const row of order.items) {
        const source = inputByKey.get(lineKey(row));
        let batchAllocations = [];
        let serialRows = [];
        if (source.product.trackSerial) {
          if (!Number.isInteger(Number(row.baseQuantity)) || source.serialIds.length !== Number(row.baseQuantity)) throw new ValidationError("Every serialized unit must have one selected serial/IMEI");
          serialRows = await tx.productSerial.findMany({
            where: { id: { in: source.serialIds }, companyId, productId: row.productId, warehouseId: input.warehouseId,
              status: "AVAILABLE", variantId: row.variantId || null },
            select: { id: true, batchId: true },
          });
          if (serialRows.length !== source.serialIds.length) throw new ConflictError("One or more serial/IMEI units are unavailable");
          if (source.batchId && serialRows.some((serial) => serial.batchId !== source.batchId)) throw new ValidationError("Selected serial/IMEI units do not belong to the selected lot/batch");
        }
        if (source.product.trackSerial && (source.product.trackLot || source.product.trackExpiry)) {
          if (serialRows.some((serial) => !serial.batchId)) throw new ConflictError("Serialized batch-tracked product has a serial/IMEI without lot/batch identity", { productId: row.productId });
          const byBatch = new Map();
          for (const serial of serialRows) byBatch.set(serial.batchId, (byBatch.get(serial.batchId) || 0) + 1);
          for (const [batchId, quantity] of byBatch) {
            batchAllocations.push(...await consumeBatches(tx, {
              companyId, warehouseId: input.warehouseId, product: source.product, variantId: row.variantId,
              requestedBatchId: batchId, baseQuantity: quantity,
            }));
          }
        } else {
          batchAllocations = await consumeBatches(tx, {
            companyId, warehouseId: input.warehouseId, product: source.product, variantId: row.variantId,
            requestedBatchId: source.batchId, baseQuantity: Number(row.baseQuantity),
          });
        }
        if (source.product.trackSerial) {
          const updated = await tx.productSerial.updateMany({
            where: { id: { in: source.serialIds }, companyId, productId: row.productId, warehouseId: input.warehouseId,
              status: "AVAILABLE", variantId: row.variantId || null },
            data: { status: "SOLD", soldOrderId: order.id },
          });
          if (updated.count !== source.serialIds.length) throw new ConflictError("One or more serial/IMEI units are unavailable");
        }
        if (batchAllocations.length || source.serialIds.length) {
          await tx.orderItem.update({ where: { id: row.id }, data: { batchAllocations, serialIds: source.serialIds } });
        }
        await changeStock(tx, { companyId, warehouseId: input.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId,
          employeeId, quantity: -Number(row.baseQuantity), allowNegative, type: "SALE", referenceType: "Order", referenceId: order.id });
      }
      await tx.orderStatusHistory.create({ data: { orderId: order.id, employeeId, status: "COMPLETED", fulfillment: "FULFILLED", delivery: "DELIVERED", note: "POS sale completed" } });
      const settledAmount = resolved.total - resolved.creditAmount;
      const invoice = await tx.invoice.create({ data: { companyId, orderId: order.id, customerId: input.customerId,
        number: await nextDocumentNumber(tx, companyId, "INVOICE", "INV"), status: resolved.creditAmount ? (settledAmount ? "PARTIALLY_PAID" : "ISSUED") : "PAID",
        currency: input.currency || "UZS", subtotal: resolved.subtotal, discount: resolved.discount, total: resolved.total, paid: settledAmount,
        dueAt: resolved.payments.find(({ method }) => method === "CREDIT")?.dueAt, issuedAt: new Date(), items: { create: resolved.rows.map((row) => ({ productId: row.productId,
          description: [row.productName, row.variantName, row.packageName].filter(Boolean).join(" · "), variantName: row.variantName, packageName: row.packageName,
          quantity: row.quantity, baseQuantity: row.baseQuantity, unitPrice: row.unitPrice, total: row.total })) } } });
      const payments = [];
      for (const row of resolved.payments.filter(({ method }) => method !== "CREDIT")) {
        const payment = await tx.payment.create({ data: { companyId, customerId: input.customerId, orderId: order.id, employeeId, shiftId: input.shiftId,
          number: await nextDocumentNumber(tx, companyId, "PAYMENT", "PAY"), method: row.method, status: "CONFIRMED", amount: row.amount,
          currency: input.currency || "UZS", externalRef: row.externalRef, note: row.methodCode, paidAt: new Date(), confirmedAt: new Date(),
          allocations: { create: { invoiceId: invoice.id, amount: row.amount } } } }); payments.push(payment);
        if (row.method === "CASH") { await tx.cashTransaction.create({ data: { companyId, cashboxId: shift.cashboxId, shiftId: shift.id, type: "SALE", amount: row.amount, reference: payment.number, description: order.number } });
          await tx.shift.update({ where: { id: shift.id }, data: { expectedCash: { increment: row.amount } } }); await tx.cashbox.update({ where: { id: shift.cashboxId }, data: { balance: { increment: row.amount } } }); }
      }
      if (resolved.creditAmount) { await tx.debt.create({ data: { companyId, customerId: input.customerId, invoiceId: invoice.id, original: resolved.creditAmount, outstanding: resolved.creditAmount, dueAt: invoice.dueAt } });
        await tx.customer.update({ where: { id: input.customerId }, data: { balance: { increment: resolved.creditAmount } } }); }
      await tx.ledgerEntry.createMany({ data: [
        ...(settledAmount > 0 ? [{ companyId, customerId: input.customerId, side: "DEBIT", account: "CASH_AND_BANK", amount: settledAmount, referenceType: "Order", referenceId: order.id }] : []),
        ...(resolved.creditAmount > 0 ? [{ companyId, customerId: input.customerId, side: "DEBIT", account: "RECEIVABLE", amount: resolved.creditAmount, referenceType: "Order", referenceId: order.id }] : []),
        { companyId, customerId: input.customerId, side: "CREDIT", account: "SALES", amount: resolved.total, referenceType: "Order", referenceId: order.id },
      ] });
      const receipt = await tx.receipt.create({ data: { companyId, orderId: order.id, number: await nextDocumentNumber(tx, companyId, "RECEIPT", "RCP"),
        payload: { orderNumber: order.number, subtotal: resolved.subtotal, discount: resolved.discount, total: resolved.total, currency: input.currency || "UZS",
          items: resolved.rows.map(({ product: _product, serialIds: _serials, ...row }) => row), payments: resolved.payments.map(({ dueAt: _dueAt, ...row }) => row) } } });
      return { order, invoice, payments, receipt };
    }, { isolationLevel: "Serializable", timeout: 30_000 }); },
  };
}
