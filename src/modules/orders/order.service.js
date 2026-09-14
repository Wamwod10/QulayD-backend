import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { changeStock } from "../inventory/balances/balance.service.js";
import { nextOrderNumber } from "./order-number.service.js";

const include = {
  customer: true, warehouse: true, agent: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true } }, items: { include: { product: { include: { unit: true, barcodes: true } }, variant: true, package: true } },
  reservations: true, history: { orderBy: { createdAt: "asc" } }, pickLists: true, packing: true,
  deliveries: true, invoices: true, payments: true, receipt: true,
};

async function attachOrderTracking(tx, companyId, orders) {
  const list = Array.isArray(orders) ? orders : [orders];
  const serialIds = [...new Set(list.flatMap((order) => (order?.items || []).flatMap((item) => Array.isArray(item.serialIds) ? item.serialIds : [])))];
  const legacyOrders = list.filter((order) => (order?.items || []).some((item) => item.product?.trackSerial && !(Array.isArray(item.serialIds) && item.serialIds.length)));
  const [serials, legacySerials] = await Promise.all([
    serialIds.length ? tx.productSerial.findMany({
      where: { companyId, id: { in: serialIds } },
      select: { id: true, serial: true, imei: true, status: true, productId: true, variantId: true, warehouseId: true, batchId: true, soldOrderId: true,
        batch: { select: { id: true, lotNumber: true, expiresAt: true } } },
    }) : [],
    legacyOrders.length ? tx.productSerial.findMany({
      where: { companyId, soldOrderId: { in: legacyOrders.map((order) => order.id) }, status: "SOLD" },
      select: { id: true, serial: true, imei: true, status: true, productId: true, variantId: true, warehouseId: true, batchId: true, soldOrderId: true,
        batch: { select: { id: true, lotNumber: true, expiresAt: true } } },
      orderBy: { createdAt: "asc" },
    }) : [],
  ]);
  const byId = new Map(serials.map((serial) => [serial.id, serial]));
  for (const order of list) {
    const serialItems = (order?.items || []).filter((item) => item.product?.trackSerial);
    for (const item of order?.items || []) {
      const ids = Array.isArray(item.serialIds) ? item.serialIds : [];
      if (ids.length) {
        item.serials = ids.map((id) => byId.get(id)).filter(Boolean);
        continue;
      }
      if (!item.product?.trackSerial) { item.serials = []; continue; }
      const sameIdentityItems = serialItems.filter((candidate) => candidate.productId === item.productId && (candidate.variantId || null) === (item.variantId || null));
      item.serials = sameIdentityItems.length === 1
        ? legacySerials.filter((serial) => serial.soldOrderId === order.id && serial.productId === item.productId && (serial.variantId || null) === (item.variantId || null))
        : [];
    }
  }
  return orders;
}

function totals(input) {
  const rows = input.items.map((row) => ({ ...row, discount: row.discount || 0, tax: row.tax || 0,
    total: row.quantity * row.unitPrice - (row.discount || 0) + (row.tax || 0) }));
  const subtotal = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);
  const itemDiscount = rows.reduce((sum, row) => sum + row.discount, 0);
  const itemTax = rows.reduce((sum, row) => sum + row.tax, 0);
  const discount = itemDiscount + (input.discount || 0); const tax = itemTax + (input.tax || 0);
  return { rows, subtotal, discount, tax, total: subtotal - discount + tax };
}

async function resolveItems(tx, companyId, items) {
  const products = await tx.product.findMany({ where: { companyId, id: { in: [...new Set(items.map((row) => row.productId))] }, deletedAt: null, status: "ACTIVE" },
    include: { unit: true, variants: true, packages: true } });
  const byId = new Map(products.map((row) => [row.id, row]));
  return items.map((row) => {
    const product = byId.get(row.productId);
    const activeVariants = product?.variants.filter((item) => item.status === "ACTIVE") || [];
    const variant = row.variantId ? activeVariants.find((item) => item.id === row.variantId) : null;
    const productPackage = row.packageId ? product?.packages.find((item) => item.id === row.packageId && item.status === "ACTIVE") : null;
    if (!product || (row.variantId && !variant) || (row.packageId && !productPackage)) throw new ValidationError("Invalid product variant/package reference");
    if (activeVariants.length && !variant) throw new ValidationError("Variant is required for this product", { productId: row.productId });
    if (productPackage?.variantId && productPackage.variantId !== variant?.id) throw new ValidationError("Package does not belong to selected variant", { productId: row.productId, packageId: row.packageId });
    const conversionToBase = Number(productPackage?.conversionToBase || 1);
    const baseQuantity = Math.round(row.quantity * conversionToBase * 1000) / 1000;
    if (product.trackSerial && (!Number.isInteger(baseQuantity) || baseQuantity <= 0)) throw new ValidationError("Serialized products require a whole base-unit quantity", { productId: row.productId });
    return { ...row, variantId: variant?.id, packageId: productPackage?.id, baseQuantity, conversionToBase,
      productName: product.name, sku: variant?.sku || product.sku, unitName: product.unit.shortName,
      variantName: variant?.name, packageName: productPackage?.name };
  });
}

async function consumeTrackedBatches(tx, { companyId, warehouseId, product, variantId, quantity }) {
  if (!product.trackLot && !product.trackExpiry) return [];
  const where = { companyId, warehouseId, productId: product.id, variantId: variantId || null, quantity: { gt: 0 } };
  if (product.trackExpiry) where.expiresAt = { gt: new Date() };
  const batches = await tx.productBatch.findMany({ where, orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }] });
  let remaining = Number(quantity); const allocations = [];
  for (const batch of batches) {
    const available = Math.max(0, Number(batch.quantity) - Number(batch.reserved));
    const used = Math.min(remaining, available);
    if (used > 0) {
      await tx.productBatch.update({ where: { id: batch.id }, data: { quantity: { decrement: used } } });
      allocations.push({ batchId: batch.id, quantity: used });
    }
    remaining = Math.round((remaining - used) * 1000) / 1000;
    if (remaining <= 0) break;
  }
  if (remaining > 0) throw new ConflictError("Insufficient non-expired lot/batch stock", { productId: product.id, variantId: variantId || null, remaining });
  return allocations;
}

async function assertTrackedBatchAvailability(tx, order) {
  const requiredByIdentity = new Map();
  for (const row of order.items) {
    if (!row.product.trackLot && !row.product.trackExpiry) continue;
    const key = `${row.productId}:${row.variantId || "BASE"}`;
    const current = requiredByIdentity.get(key) || { product: row.product, productId: row.productId, variantId: row.variantId || null, required: 0 };
    current.required = Math.round((current.required + Number(row.baseQuantity ?? row.quantity)) * 1000) / 1000;
    requiredByIdentity.set(key, current);
  }
  for (const row of requiredByIdentity.values()) {
    const batchWhere = { companyId: order.companyId, warehouseId: order.warehouseId, productId: row.productId,
      variantId: row.variantId, quantity: { gt: 0 } };
    if (row.product.trackExpiry) batchWhere.expiresAt = { gt: new Date() };
    const [batches, active] = await Promise.all([
      tx.productBatch.findMany({ where: batchWhere, select: { quantity: true } }),
      tx.stockReservation.aggregate({ where: { companyId: order.companyId, warehouseId: order.warehouseId, productId: row.productId,
        variantId: row.variantId, status: "ACTIVE" }, _sum: { quantity: true } }),
    ]);
    const usable = batches.reduce((sum, batch) => sum + Number(batch.quantity), 0) - Number(active._sum.quantity || 0);
    if (usable + 1e-9 < row.required) throw new ConflictError("Insufficient non-expired lot/batch stock", {
      productId: row.productId, variantId: row.variantId, required: row.required, available: Math.max(0, usable),
    });
  }
}

async function reserveSerializedUnits(tx, order) {
  for (const row of order.items) {
    if (!row.product.trackSerial) continue;
    const required = Number(row.baseQuantity ?? row.quantity);
    if (!Number.isInteger(required)) throw new ValidationError("Serialized products require whole base-unit quantities", { productId: row.productId });
    let serials = [];
    if (row.product.trackLot || row.product.trackExpiry) {
      const batchWhere = { companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId,
        variantId: row.variantId || null, quantity: { gt: 0 } };
      if (row.product.trackExpiry) batchWhere.expiresAt = { gt: new Date() };
      const batches = await tx.productBatch.findMany({ where: batchWhere, orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }] });
      let remaining = required;
      for (const batch of batches) {
        const physicalAvailable = Math.max(0, Math.floor(Number(batch.quantity) - Number(batch.reserved)));
        if (!physicalAvailable) continue;
        const found = await tx.productSerial.findMany({
          where: { companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId,
            variantId: row.variantId || null, batchId: batch.id, status: "AVAILABLE" },
          select: { id: true, batchId: true }, orderBy: { createdAt: "asc" }, take: Math.min(remaining, physicalAvailable),
        });
        serials.push(...found); remaining -= found.length;
        if (remaining <= 0) break;
      }
    } else {
      serials = await tx.productSerial.findMany({
        where: { companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId, variantId: row.variantId || null, status: "AVAILABLE" },
        select: { id: true, batchId: true }, orderBy: { createdAt: "asc" }, take: required,
      });
    }
    if (serials.length !== required) throw new ConflictError("Insufficient available serial / IMEI units", {
      productId: row.productId, variantId: row.variantId || null, required, available: serials.length,
    });
    const serialIds = serials.map((item) => item.id);
    const result = await tx.productSerial.updateMany({
      where: { id: { in: serialIds }, companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId,
        variantId: row.variantId || null, status: "AVAILABLE" },
      data: { status: "RESERVED", soldOrderId: order.id },
    });
    if (result.count !== required) throw new ConflictError("Serial / IMEI reservation changed concurrently", { productId: row.productId });
    await tx.orderItem.update({ where: { id: row.id }, data: { serialIds } });
  }
}

async function consumeReservedSerials(tx, order) {
  const consumedByItem = new Map();
  for (const row of order.items) {
    if (!row.product.trackSerial) continue;
    const required = Number(row.baseQuantity ?? row.quantity);
    const storedIds = Array.isArray(row.serialIds) ? row.serialIds : [];
    const serials = storedIds.length === required
      ? await tx.productSerial.findMany({ where: { id: { in: storedIds }, companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId,
        variantId: row.variantId || null, soldOrderId: order.id, status: "RESERVED" }, select: { id: true, batchId: true } })
      : await tx.productSerial.findMany({ where: { companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId,
        variantId: row.variantId || null, soldOrderId: order.id, status: "RESERVED" }, select: { id: true, batchId: true }, orderBy: { createdAt: "asc" }, take: required });
    if (serials.length !== required) throw new ConflictError("Reserved serial / IMEI quantity does not match order item", {
      productId: row.productId, orderItemId: row.id, required, reserved: serials.length,
    });
    if ((row.product.trackLot || row.product.trackExpiry) && serials.some((serial) => !serial.batchId)) {
      throw new ConflictError("Reserved serial / IMEI is missing lot/batch identity", { productId: row.productId, orderItemId: row.id });
    }
    const serialIds = serials.map((item) => item.id);
    const result = await tx.productSerial.updateMany({
      where: { id: { in: serialIds }, companyId: order.companyId, productId: row.productId, warehouseId: order.warehouseId,
        variantId: row.variantId || null, status: "RESERVED", soldOrderId: order.id },
      data: { status: "SOLD" },
    });
    if (result.count !== required) throw new ConflictError("Reserved serial / IMEI units changed concurrently", { productId: row.productId });
    if (storedIds.length !== required) await tx.orderItem.update({ where: { id: row.id }, data: { serialIds } });
    consumedByItem.set(row.id, serials);
  }
  return consumedByItem;
}

async function consumeSerializedBatches(tx, { companyId, warehouseId, product, variantId, serials }) {
  if (!product.trackLot && !product.trackExpiry) return [];
  const byBatch = new Map();
  for (const serial of serials) {
    if (!serial.batchId) throw new ConflictError("Serialized unit is missing lot/batch identity", { productId: product.id, serialId: serial.id });
    byBatch.set(serial.batchId, (byBatch.get(serial.batchId) || 0) + 1);
  }
  const allocations = [];
  for (const [batchId, quantity] of byBatch) {
    const where = { id: batchId, companyId, warehouseId, productId: product.id, variantId: variantId || null };
    if (product.trackExpiry) where.expiresAt = { gt: new Date() };
    const batch = await tx.productBatch.findFirst({ where });
    if (!batch || Number(batch.quantity) - Number(batch.reserved) + 1e-9 < quantity) {
      throw new ConflictError("Reserved serial / IMEI lot/batch stock is no longer available", { productId: product.id, variantId: variantId || null, batchId, required: quantity });
    }
    await tx.productBatch.update({ where: { id: batch.id }, data: { quantity: { decrement: quantity } } });
    allocations.push({ batchId, quantity });
  }
  return allocations;
}

async function addHistory(tx, order, employeeId, note) {
  await tx.orderStatusHistory.create({ data: { orderId: order.id, employeeId, status: order.status,
    fulfillment: order.fulfillmentStatus, delivery: order.deliveryStatus, note } });
}

async function reserve(tx, order, employeeId) {
  await assertTrackedBatchAvailability(tx, order);
  for (const row of order.items) {
    await changeStock(tx, { companyId: order.companyId, warehouseId: order.warehouseId, productId: row.productId,
      employeeId, variantId: row.variantId, packageId: row.packageId, reserved: Number(row.baseQuantity ?? row.quantity), type: "RESERVATION", referenceType: "Order", referenceId: order.id });
    await tx.stockReservation.create({ data: { companyId: order.companyId, orderId: order.id, orderItemId: row.id,
      warehouseId: order.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, quantity: Number(row.baseQuantity ?? row.quantity) } });
  }
  await reserveSerializedUnits(tx, order);
}

async function release(tx, order, employeeId, status = "RELEASED") {
  const reservations = await tx.stockReservation.findMany({ where: { orderId: order.id, status: "ACTIVE" } });
  for (const row of reservations) {
    await changeStock(tx, { companyId: order.companyId, warehouseId: row.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId,
      employeeId, reserved: -Number(row.quantity), type: "RESERVATION_RELEASE", referenceType: "Order", referenceId: order.id });
    await tx.stockReservation.update({ where: { id: row.id }, data: { status } });
  }
  await tx.productSerial.updateMany({ where: { companyId: order.companyId, soldOrderId: order.id, status: "RESERVED" }, data: { status: "AVAILABLE", soldOrderId: null } });
}

async function assertReferences(tx, companyId, input) {
  const productIds = [...new Set(input.items.map(({ productId }) => productId))];
  const [warehouse, products, customer, agent, branch, priceList] = await Promise.all([
    tx.warehouse.count({ where: { id: input.warehouseId, companyId, deletedAt: null } }),
    tx.product.count({ where: { id: { in: productIds }, companyId, deletedAt: null, status: "ACTIVE" } }),
    input.customerId ? tx.customer.count({ where: { id: input.customerId, companyId, deletedAt: null } }) : 1,
    input.agentId ? tx.employee.count({ where: { id: input.agentId, companyId, deletedAt: null, status: "ACTIVE" } }) : 1,
    input.branchId ? tx.branch.count({ where: { id: input.branchId, companyId, deletedAt: null } }) : 1,
    input.priceListId ? tx.priceList.count({ where: { id: input.priceListId, companyId, status: "ACTIVE" } }) : 1,
  ]);
  if ([warehouse, customer, agent, branch, priceList].some((count) => count !== 1) || products !== productIds.length) {
    throw new ValidationError("Invalid company resource reference");
  }
}

export function createOrderService(prisma) {
  const find = async (companyId, id, tx = prisma) => {
    const order = await tx.order.findFirst({ where: { id, companyId }, include });
    if (!order) throw new NotFoundError("Order not found");
    await attachOrderTracking(tx, companyId, order);
    return order;
  };
  return {
    async list(companyId, query) {
      const page = parsePagination(query, { allowedSortFields: ["orderedAt", "createdAt", "updatedAt", "total", "number"] });
      const where = { companyId };
      for (const field of ["status", "warehouseId", "customerId", "agentId", "channel"]) if (query[field]) where[field] = query[field];
      if (page.search) where.OR = [{ number: { contains: page.search, mode: "insensitive" } },
        { customer: { name: { contains: page.search, mode: "insensitive" } } }];
      const [data, total] = await prisma.$transaction([
        prisma.order.findMany({ where, include, skip: page.skip, take: page.take, orderBy: { [page.sortBy || "orderedAt"]: page.sortOrder } }),
        prisma.order.count({ where }),
      ]);
      await attachOrderTracking(prisma, companyId, data);
      return { data, meta: paginationMeta({ ...page, total }) };
    },
    find,
    async create(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        await assertReferences(tx, companyId, input); const calculated = totals({ ...input, items: await resolveItems(tx, companyId, input.items) });
        const order = await tx.order.create({ data: {
          companyId, createdById: employeeId, branchId: input.branchId, warehouseId: input.warehouseId,
          customerId: input.customerId, priceListId: input.priceListId, agentId: input.agentId,
          channel: input.channel, currency: input.currency, note: input.note, deliveryAddress: input.deliveryAddress,
          number: await nextOrderNumber(tx, companyId), subtotal: calculated.subtotal, discount: calculated.discount,
          tax: calculated.tax, total: calculated.total, items: { create: calculated.rows },
        }, include });
        await addHistory(tx, order, employeeId, "Order created"); return order;
      });
    },
    async update(companyId, id, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        const current = await find(companyId, id, tx);
        if (current.status !== "DRAFT") throw new ConflictError("Only draft orders can be edited");
        const merged = {
          branchId: input.branchId === undefined ? current.branchId : input.branchId,
          warehouseId: current.warehouseId,
          customerId: input.customerId === undefined ? current.customerId : input.customerId,
          priceListId: input.priceListId === undefined ? current.priceListId : input.priceListId,
          agentId: input.agentId === undefined ? current.agentId : input.agentId,
          items: input.items || current.items.map((row) => ({
            productId: row.productId, variantId: row.variantId, packageId: row.packageId, quantity: Number(row.quantity), unitPrice: Number(row.unitPrice),
            discount: Number(row.discount), tax: Number(row.tax),
          })),
          discount: input.discount === undefined ? Number(current.discount) - current.items.reduce((sum, row) => sum + Number(row.discount), 0) : input.discount,
          tax: input.tax === undefined ? Number(current.tax) - current.items.reduce((sum, row) => sum + Number(row.tax), 0) : input.tax,
        };
        await assertReferences(tx, companyId, merged);
        if (input.items) merged.items = await resolveItems(tx, companyId, merged.items);
        const calculated = totals(merged);
        const data = {
          branchId: merged.branchId, customerId: merged.customerId, priceListId: merged.priceListId, agentId: merged.agentId,
          channel: input.channel, currency: input.currency, note: input.note, deliveryAddress: input.deliveryAddress,
          subtotal: calculated.subtotal, discount: calculated.discount, tax: calculated.tax, total: calculated.total,
          ...(input.items ? { items: { deleteMany: {}, create: calculated.rows } } : {}),
        };
        const order = await tx.order.update({ where: { id }, data, include });
        await addHistory(tx, order, employeeId, "Draft order updated");
        return order;
      });
    },
    async confirm(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx);
        if (!["DRAFT", "PENDING_APPROVAL"].includes(order.status)) throw new ConflictError("Order cannot be confirmed");
        await reserve(tx, order, employeeId);
        const next = await tx.order.update({ where: { id }, data: { status: "CONFIRMED", fulfillmentStatus: "RESERVED", confirmedAt: new Date(),
          pickLists: { create: { companyId, number: await nextDocumentNumber(tx, companyId, "PICK_LIST", "PICK"), status: "APPROVED" } } }, include });
        await addHistory(tx, next, employeeId, note || "Order confirmed and stock reserved"); return next;
      }, { isolationLevel: "Serializable" });
    },
    async startPicking(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx); if (order.fulfillmentStatus !== "RESERVED") throw new ConflictError("Order is not ready for picking");
        await tx.pickList.updateMany({ where: { orderId: id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
        const next = await tx.order.update({ where: { id }, data: { fulfillmentStatus: "PICKING" }, include });
        await addHistory(tx, next, employeeId, note || "Picking started"); return next;
      });
    },
    async completePicking(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx); if (order.fulfillmentStatus !== "PICKING") throw new ConflictError("Picking is not in progress");
        await tx.pickList.updateMany({ where: { orderId: id }, data: { status: "COMPLETED", progress: 100, pickedAt: new Date() } });
        const next = await tx.order.update({ where: { id }, data: { fulfillmentStatus: "PICKED" }, include });
        await addHistory(tx, next, employeeId, note || "Picking completed"); return next;
      });
    },
    async pack(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx); if (order.fulfillmentStatus !== "PICKED") throw new ConflictError("Order is not picked");
        await tx.packing.upsert({ where: { orderId: id }, create: { companyId, orderId: id, status: "COMPLETED", packedAt: new Date() },
          update: { status: "COMPLETED", packedAt: new Date() } });
        const next = await tx.order.update({ where: { id }, data: { fulfillmentStatus: "PACKED" }, include });
        await addHistory(tx, next, employeeId, note || "Order packed"); return next;
      });
    },
    async ready(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx); if (order.fulfillmentStatus !== "PACKED") throw new ConflictError("Order is not packed");
        const next = await tx.order.update({ where: { id }, data: { fulfillmentStatus: "FULFILLED", deliveryStatus: "PLANNED" }, include });
        await addHistory(tx, next, employeeId, note || "Order ready for delivery"); return next;
      });
    },
    async complete(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx);
        if (order.status !== "CONFIRMED") throw new ConflictError("Only confirmed orders can be completed");
        const reservations = await tx.stockReservation.findMany({ where: { orderId: id, status: "ACTIVE" } });
        const consumedSerials = await consumeReservedSerials(tx, order);
        const orderItemById = new Map(order.items.map((item) => [item.id, item]));
        for (const row of reservations) {
          const orderItem = orderItemById.get(row.orderItemId);
          if (!orderItem) throw new ConflictError("Order reservation is missing its order item", { reservationId: row.id });
          const batchAllocations = orderItem.product.trackSerial
            ? await consumeSerializedBatches(tx, { companyId, warehouseId: row.warehouseId, product: orderItem.product, variantId: row.variantId, serials: consumedSerials.get(orderItem.id) || [] })
            : await consumeTrackedBatches(tx, { companyId, warehouseId: row.warehouseId, product: orderItem.product, variantId: row.variantId, quantity: Number(row.quantity) });
          await tx.orderItem.update({ where: { id: orderItem.id }, data: { fulfilledQty: orderItem.quantity, ...(batchAllocations.length ? { batchAllocations } : {}) } });
          await changeStock(tx, { companyId, warehouseId: row.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, employeeId,
            quantity: -Number(row.quantity), reserved: -Number(row.quantity), type: "SALE", referenceType: "Order", referenceId: id });
          await tx.stockReservation.update({ where: { id: row.id }, data: { status: "CONSUMED" } });
        }
        const next = await tx.order.update({ where: { id }, data: { status: "COMPLETED", fulfillmentStatus: "FULFILLED",
          deliveryStatus: order.deliveryStatus === "NOT_PLANNED" ? "DELIVERED" : order.deliveryStatus, completedAt: new Date() }, include });
        await addHistory(tx, next, employeeId, note || "Order completed"); return next;
      }, { isolationLevel: "Serializable" });
    },
    async cancel(companyId, id, employeeId, note) {
      return prisma.$transaction(async (tx) => {
        const order = await find(companyId, id, tx); if (["COMPLETED", "CANCELLED"].includes(order.status)) throw new ConflictError("Order cannot be cancelled");
        await release(tx, order, employeeId, "CANCELLED");
        const next = await tx.order.update({ where: { id }, data: { status: "CANCELLED", fulfillmentStatus: "CANCELLED", deliveryStatus: "CANCELLED", cancelledAt: new Date() }, include });
        await addHistory(tx, next, employeeId, note || "Order cancelled"); return next;
      }, { isolationLevel: "Serializable" });
    },
  };
}
