import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { nextDocumentNumber } from "../../shared/documents/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { changeStock } from "./balances/balance.service.js";
import { warehouseCreateSchema } from "./warehouses/warehouse.validation.js";

const idParams = z.object({ id: z.uuid() });
const item = z.object({ productId: z.uuid(), quantity: z.number().positive(), unitCost: z.number().min(0).optional() });
const listQuery = z.object({
  page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(), sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(),
  warehouseId: z.uuid().optional(), productId: z.uuid().optional(), status: z.string().max(40).optional(),
});
const transferSchema = z.object({
  sourceWarehouseId: z.uuid(), targetWarehouseId: z.uuid(), note: z.string().max(1000).optional(),
  items: z.array(item.omit({ unitCost: true })).min(1).max(500),
}).refine((value) => value.sourceWarehouseId !== value.targetWarehouseId, { message: "Warehouses must differ" });
const adjustmentSchema = z.object({
  warehouseId: z.uuid(), reason: z.string().trim().min(3).max(500),
  items: z.array(item.extend({ quantity: z.number().refine((value) => value !== 0) })).min(1).max(500),
});
const countSchema = z.object({
  warehouseId: z.uuid(), note: z.string().max(1000).optional(),
  items: z.array(z.object({ productId: z.uuid(), counted: z.number().min(0) })).min(1).max(2000),
});
const receiptSchema = z.object({
  supplierId: z.uuid(), warehouseId: z.uuid(), note: z.string().max(1000).optional(),
  items: z.array(item.extend({ unitCost: z.number().min(0) })).min(1).max(500),
});

async function assertTenantReferences(tx, companyId, { warehouses = [], products = [], supplierId }) {
  const uniqueProducts = [...new Set(products)]; const uniqueWarehouses = [...new Set(warehouses)];
  const [productCount, warehouseCount, supplierCount] = await Promise.all([
    uniqueProducts.length ? tx.product.count({ where: { companyId, id: { in: uniqueProducts }, deletedAt: null } }) : 0,
    uniqueWarehouses.length ? tx.warehouse.count({ where: { companyId, id: { in: uniqueWarehouses }, deletedAt: null } }) : 0,
    supplierId ? tx.supplier.count({ where: { companyId, id: supplierId, deletedAt: null } }) : 0,
  ]);
  if (productCount !== uniqueProducts.length || warehouseCount !== uniqueWarehouses.length || (supplierId && supplierCount !== 1)) {
    throw new ValidationError("One or more referenced resources do not belong to this company");
  }
}

function workflowRoutes(router, prisma) {
  router.get("/stocks", requirePermission("inventory.read"), validate({ query: listQuery }), asyncHandler(async (request, response) => {
    const page = parsePagination(request.validated.query, { allowedSortFields: ["updatedAt", "onHand", "reserved"] });
    const where = { companyId: request.tenant.companyId };
    if (request.validated.query.warehouseId) where.warehouseId = request.validated.query.warehouseId;
    if (request.validated.query.productId) where.productId = request.validated.query.productId;
    if (page.search) where.product = { OR: [
      { name: { contains: page.search, mode: "insensitive" } }, { sku: { contains: page.search } },
      { barcodes: { some: { barcode: { contains: page.search } } } },
    ] };
    const [data, total] = await prisma.$transaction([
      prisma.warehouseStock.findMany({ where, include: { warehouse: true, product: { include: { unit: true, category: true, barcodes: true } } },
        skip: page.skip, take: page.take, orderBy: { [page.sortBy || "updatedAt"]: page.sortOrder } }),
      prisma.warehouseStock.count({ where }),
    ]);
    return sendSuccess(response, { data: data.map((row) => ({ ...row, available: Number(row.onHand) - Number(row.reserved) })), meta: paginationMeta({ ...page, total }) });
  }));

  router.get("/movements", requirePermission("inventory.read"), validate({ query: listQuery }), asyncHandler(async (request, response) => {
    const page = parsePagination(request.validated.query, { allowedSortFields: ["createdAt", "quantity", "type"] });
    const where = { companyId: request.tenant.companyId };
    for (const field of ["warehouseId", "productId"]) if (request.validated.query[field]) where[field] = request.validated.query[field];
    const [data, total] = await prisma.$transaction([
      prisma.stockMovement.findMany({ where, include: { warehouse: true, product: true, employee: { select: { id: true, name: true } } }, skip: page.skip, take: page.take, orderBy: { [page.sortBy || "createdAt"]: page.sortOrder } }),
      prisma.stockMovement.count({ where }),
    ]);
    return sendSuccess(response, { data, meta: paginationMeta({ ...page, total }) });
  }));

  router.get("/reservations", requirePermission("inventory.read"), validate({ query: listQuery }), asyncHandler(async (request, response) => {
    const where = { companyId: request.tenant.companyId };
    if (request.validated.query.status) where.status = request.validated.query.status;
    if (request.validated.query.warehouseId) where.warehouseId = request.validated.query.warehouseId;
    return sendSuccess(response, { data: await prisma.stockReservation.findMany({ where, include: { product: true, order: true }, orderBy: { createdAt: "desc" }, take: 500 }) });
  }));
}

function adjustmentRoutes(router, prisma) {
  router.get("/adjustments", requirePermission("inventory.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.stockAdjustment.findMany({ where: { companyId: request.tenant.companyId }, include: { warehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
  })));
  router.post("/adjustments", requirePermission("inventory.create"), validate({ body: adjustmentSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      await assertTenantReferences(tx, companyId, { warehouses: [input.warehouseId], products: input.items.map(({ productId }) => productId) });
      return tx.stockAdjustment.create({ data: { companyId, warehouseId: input.warehouseId, reason: input.reason,
        number: await nextDocumentNumber(tx, companyId, "ADJUSTMENT", "ADJ"),
        status: "PENDING_APPROVAL", items: { create: input.items } }, include: { items: true, warehouse: true } });
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "StockAdjustment", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/adjustments/:id/approve", requirePermission("inventory.approve"), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const doc = await tx.stockAdjustment.findFirst({ where: { id: request.params.id, companyId }, include: { items: true } });
      if (!doc) throw new NotFoundError("Stock adjustment not found");
      if (doc.status !== "PENDING_APPROVAL") throw new ConflictError("Stock adjustment cannot be approved in its current status");
      for (const row of doc.items) await changeStock(tx, { companyId, warehouseId: doc.warehouseId, productId: row.productId,
        employeeId: request.auth.employeeId, quantity: row.quantity, type: Number(row.quantity) > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
        referenceType: "StockAdjustment", referenceId: doc.id, reason: doc.reason, unitCost: row.unitCost });
      return tx.stockAdjustment.update({ where: { id: doc.id }, data: { status: "COMPLETED", approvedAt: new Date() }, include: { items: true } });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "APPROVE", entity: "StockAdjustment", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  }));
}

function transferRoutes(router, prisma) {
  router.get("/transfers", requirePermission("inventory.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.stockTransfer.findMany({ where: { companyId: request.tenant.companyId }, include: { sourceWarehouse: true, targetWarehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
  })));
  router.post("/transfers", requirePermission("inventory.create"), validate({ body: transferSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      await assertTenantReferences(tx, companyId, { warehouses: [input.sourceWarehouseId, input.targetWarehouseId], products: input.items.map(({ productId }) => productId) });
      return tx.stockTransfer.create({ data: { companyId, sourceWarehouseId: input.sourceWarehouseId, targetWarehouseId: input.targetWarehouseId,
        note: input.note, number: await nextDocumentNumber(tx, companyId, "TRANSFER", "TRF"), status: "PENDING_APPROVAL",
        items: { create: input.items } }, include: { items: true } });
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "StockTransfer", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/transfers/:id/approve", requirePermission("inventory.approve"), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const current = await prisma.stockTransfer.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } });
    if (!current) throw new NotFoundError("Stock transfer not found");
    if (current.status !== "PENDING_APPROVAL") throw new ConflictError("Transfer cannot be approved");
    const data = await prisma.stockTransfer.update({ where: { id: current.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: request.auth.employeeId } });
    await writeAudit(prisma, request, { action: "APPROVE", entity: "StockTransfer", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  }));
  router.post("/transfers/:id/complete", requirePermission("inventory.update"), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const doc = await tx.stockTransfer.findFirst({ where: { id: request.params.id, companyId }, include: { items: true } });
      if (!doc) throw new NotFoundError("Stock transfer not found");
      if (doc.status !== "APPROVED") throw new ConflictError("Only approved transfers can be completed");
      for (const row of doc.items) {
        await changeStock(tx, { companyId, warehouseId: doc.sourceWarehouseId, productId: row.productId, employeeId: request.auth.employeeId,
          quantity: -Number(row.quantity), type: "TRANSFER_OUT", referenceType: "StockTransfer", referenceId: doc.id });
        await changeStock(tx, { companyId, warehouseId: doc.targetWarehouseId, productId: row.productId, employeeId: request.auth.employeeId,
          quantity: row.quantity, type: "TRANSFER_IN", referenceType: "StockTransfer", referenceId: doc.id });
        await tx.stockTransferItem.update({ where: { id: row.id }, data: { received: row.quantity } });
      }
      return tx.stockTransfer.update({ where: { id: doc.id }, data: { status: "COMPLETED", completedAt: new Date() }, include: { items: true } });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "COMPLETE", entity: "StockTransfer", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  }));
}

function countAndReceiptRoutes(router, prisma) {
  router.get("/counts", requirePermission("inventory.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.inventoryCount.findMany({ where: { companyId: request.tenant.companyId }, include: { warehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
  })));
  router.post("/counts", requirePermission("inventory.create"), validate({ body: countSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      await assertTenantReferences(tx, companyId, { warehouses: [input.warehouseId], products: input.items.map(({ productId }) => productId) });
      const stocks = await tx.warehouseStock.findMany({ where: { warehouseId: input.warehouseId, productId: { in: input.items.map(({ productId }) => productId) } } });
      const byProduct = new Map(stocks.map((row) => [row.productId, Number(row.onHand)]));
      return tx.inventoryCount.create({ data: { companyId, warehouseId: input.warehouseId, note: input.note,
        number: await nextDocumentNumber(tx, companyId, "COUNT", "CNT"), status: "IN_PROGRESS",
        items: { create: input.items.map((row) => ({ productId: row.productId, counted: row.counted,
          expected: byProduct.get(row.productId) || 0, difference: row.counted - (byProduct.get(row.productId) || 0) })) } }, include: { items: true } });
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "InventoryCount", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/counts/:id/complete", requirePermission("inventory.approve"), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const doc = await tx.inventoryCount.findFirst({ where: { id: request.params.id, companyId }, include: { items: true } });
      if (!doc) throw new NotFoundError("Inventory count not found");
      if (doc.status !== "IN_PROGRESS") throw new ConflictError("Inventory count cannot be completed");
      for (const row of doc.items) if (Number(row.difference) !== 0) await changeStock(tx, { companyId, warehouseId: doc.warehouseId,
        productId: row.productId, employeeId: request.auth.employeeId, quantity: row.difference, type: "COUNT_CORRECTION",
        referenceType: "InventoryCount", referenceId: doc.id });
      return tx.inventoryCount.update({ where: { id: doc.id }, data: { status: "COMPLETED", countedAt: new Date() }, include: { items: true } });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "COMPLETE", entity: "InventoryCount", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  }));

  router.get("/goods-receipts", requirePermission("inventory.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.goodsReceipt.findMany({ where: { companyId: request.tenant.companyId }, include: { warehouse: true, supplier: true, items: { include: { product: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
  })));
  router.post("/goods-receipts", requirePermission("inventory.create"), validate({ body: receiptSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      await assertTenantReferences(tx, companyId, { warehouses: [input.warehouseId], products: input.items.map(({ productId }) => productId), supplierId: input.supplierId });
      const rows = input.items.map((row) => ({ ...row, total: row.quantity * row.unitCost }));
      return tx.goodsReceipt.create({ data: { companyId, supplierId: input.supplierId, warehouseId: input.warehouseId, note: input.note,
        number: await nextDocumentNumber(tx, companyId, "GOODS_RECEIPT", "GR"), status: "DRAFT",
        total: rows.reduce((sum, row) => sum + row.total, 0), items: { create: rows } }, include: { items: true } });
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "GoodsReceipt", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/goods-receipts/:id/confirm", requirePermission("inventory.approve"), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const doc = await tx.goodsReceipt.findFirst({ where: { id: request.params.id, companyId }, include: { items: true } });
      if (!doc) throw new NotFoundError("Goods receipt not found");
      if (doc.status !== "DRAFT") throw new ConflictError("Goods receipt is already processed");
      for (const row of doc.items) await changeStock(tx, { companyId, warehouseId: doc.warehouseId, productId: row.productId,
        employeeId: request.auth.employeeId, quantity: row.quantity, unitCost: row.unitCost, type: "GOODS_RECEIPT",
        referenceType: "GoodsReceipt", referenceId: doc.id });
      if (Number(doc.total) > 0) {
        await tx.debt.create({ data: { companyId, supplierId: doc.supplierId, original: doc.total, outstanding: doc.total } });
        await tx.supplier.update({ where: { id: doc.supplierId }, data: { balance: { increment: doc.total } } });
        await tx.ledgerEntry.createMany({ data: [
          { companyId, supplierId: doc.supplierId, side: "DEBIT", account: "INVENTORY", amount: doc.total, referenceType: "GoodsReceipt", referenceId: doc.id },
          { companyId, supplierId: doc.supplierId, side: "CREDIT", account: "PAYABLE", amount: doc.total, referenceType: "GoodsReceipt", referenceId: doc.id },
        ] });
      }
      return tx.goodsReceipt.update({ where: { id: doc.id }, data: { status: "COMPLETED", receivedAt: new Date() }, include: { items: true } });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "CONFIRM", entity: "GoodsReceipt", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  }));
}

export function createInventoryRouter({ prisma }) {
  const router = Router(); router.use(requireModule("inventory"));
  router.use("/warehouses", createTenantCrudRouter({ prisma, model: "warehouse", entity: "Warehouse", module: "inventory",
    createSchema: warehouseCreateSchema, searchFields: ["name", "code", "address"], filterFields: ["status", "branchId"], include: { branch: true },
    tenantRelationFields: { branchId: "branch" } }));
  workflowRoutes(router, prisma); adjustmentRoutes(router, prisma); transferRoutes(router, prisma); countAndReceiptRoutes(router, prisma);
  return router;
}
