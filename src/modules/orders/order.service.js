import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { changeStock } from "../inventory/balances/balance.service.js";
import { nextOrderNumber } from "./order-number.service.js";

const include = {
  customer: true, warehouse: true, agent: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true } }, items: { include: { product: { include: { unit: true, barcodes: true } } } },
  reservations: true, history: { orderBy: { createdAt: "asc" } }, pickLists: true, packing: true,
  deliveries: true, invoices: true, payments: true, receipt: true,
};

function totals(input) {
  const rows = input.items.map((row) => ({ ...row, discount: row.discount || 0, tax: row.tax || 0,
    total: row.quantity * row.unitPrice - (row.discount || 0) + (row.tax || 0) }));
  const subtotal = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);
  const itemDiscount = rows.reduce((sum, row) => sum + row.discount, 0);
  const itemTax = rows.reduce((sum, row) => sum + row.tax, 0);
  const discount = itemDiscount + (input.discount || 0); const tax = itemTax + (input.tax || 0);
  return { rows, subtotal, discount, tax, total: subtotal - discount + tax };
}

async function addHistory(tx, order, employeeId, note) {
  await tx.orderStatusHistory.create({ data: { orderId: order.id, employeeId, status: order.status,
    fulfillment: order.fulfillmentStatus, delivery: order.deliveryStatus, note } });
}

async function reserve(tx, order, employeeId) {
  for (const row of order.items) {
    await changeStock(tx, { companyId: order.companyId, warehouseId: order.warehouseId, productId: row.productId,
      employeeId, reserved: row.quantity, type: "RESERVATION", referenceType: "Order", referenceId: order.id });
    await tx.stockReservation.create({ data: { companyId: order.companyId, orderId: order.id, orderItemId: row.id,
      warehouseId: order.warehouseId, productId: row.productId, quantity: row.quantity } });
  }
}

async function release(tx, order, employeeId, status = "RELEASED") {
  const reservations = await tx.stockReservation.findMany({ where: { orderId: order.id, status: "ACTIVE" } });
  for (const row of reservations) {
    await changeStock(tx, { companyId: order.companyId, warehouseId: row.warehouseId, productId: row.productId,
      employeeId, reserved: -Number(row.quantity), type: "RESERVATION_RELEASE", referenceType: "Order", referenceId: order.id });
    await tx.stockReservation.update({ where: { id: row.id }, data: { status } });
  }
}

async function assertReferences(tx, companyId, input) {
  const productIds = [...new Set(input.items.map(({ productId }) => productId))];
  const [warehouse, products, customer, agent, branch, priceList] = await Promise.all([
    tx.warehouse.count({ where: { id: input.warehouseId, companyId, deletedAt: null } }),
    tx.product.count({ where: { id: { in: productIds }, companyId, deletedAt: null, status: "ACTIVE" } }),
    input.customerId ? tx.customer.count({ where: { id: input.customerId, companyId, deletedAt: null } }) : 1,
    input.agentId ? tx.employee.count({ where: { id: input.agentId, companyId, deletedAt: null, status: "ACTIVE" } }) : 1,
    input.branchId ? tx.branch.count({ where: { id: input.branchId, companyId, deletedAt: null } }) : 1,
    input.priceListId ? tx.priceList.count({ where: { id: input.priceListId, companyId, deletedAt: null } }) : 1,
  ]);
  if ([warehouse, customer, agent, branch, priceList].some((count) => count !== 1) || products !== productIds.length) {
    throw new ValidationError("Invalid company resource reference");
  }
}

export function createOrderService(prisma) {
  const find = async (companyId, id, tx = prisma) => {
    const order = await tx.order.findFirst({ where: { id, companyId }, include });
    if (!order) throw new NotFoundError("Order not found"); return order;
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
      return { data, meta: paginationMeta({ ...page, total }) };
    },
    find,
    async create(companyId, employeeId, input) {
      return prisma.$transaction(async (tx) => {
        await assertReferences(tx, companyId, input); const calculated = totals(input);
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
            productId: row.productId, quantity: Number(row.quantity), unitPrice: Number(row.unitPrice),
            discount: Number(row.discount), tax: Number(row.tax),
          })),
          discount: input.discount === undefined ? Number(current.discount) - current.items.reduce((sum, row) => sum + Number(row.discount), 0) : input.discount,
          tax: input.tax === undefined ? Number(current.tax) - current.items.reduce((sum, row) => sum + Number(row.tax), 0) : input.tax,
        };
        await assertReferences(tx, companyId, merged);
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
        for (const row of reservations) {
          await changeStock(tx, { companyId, warehouseId: row.warehouseId, productId: row.productId, employeeId,
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
