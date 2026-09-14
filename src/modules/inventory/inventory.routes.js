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
const item = z.object({ productId: z.uuid(), variantId: z.uuid().nullable().optional(), packageId: z.uuid().nullable().optional(),
  quantity: z.number().positive(), unitCost: z.number().min(0).optional() });
const listQuery = z.object({
  page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(), sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(),
  warehouseId: z.uuid().optional(), productId: z.uuid().optional(), status: z.string().max(40).optional(),
});
const transferSchema = z.object({
  sourceWarehouseId: z.uuid(), targetWarehouseId: z.uuid(), note: z.string().max(1000).optional(),
  items: z.array(item.omit({ unitCost: true }).extend({ batchId: z.uuid().nullable().optional(), serialIds: z.array(z.uuid()).max(1000).optional() })).min(1).max(500),
}).refine((value) => value.sourceWarehouseId !== value.targetWarehouseId, { message: "Warehouses must differ" });
const adjustmentSchema = z.object({
  warehouseId: z.uuid(), reason: z.string().trim().min(3).max(500),
  items: z.array(item.extend({ quantity: z.number().refine((value) => value !== 0), batchId: z.uuid().nullable().optional(),
    serialIds: z.array(z.uuid()).max(1000).optional(), serialNumbers: z.array(z.string().trim().min(1).max(120)).max(1000).optional(),
    lotNumber: z.string().trim().max(100).optional(), manufacturedAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional() })).min(1).max(500),
});
const countSchema = z.object({
  warehouseId: z.uuid(), note: z.string().max(1000).optional(),
  items: z.array(z.object({ productId: z.uuid(), counted: z.number().min(0) })).min(1).max(2000),
});
const receiptSchema = z.object({
  supplierId: z.uuid(), warehouseId: z.uuid(), note: z.string().max(1000).optional(),
  items: z.array(item.extend({ unitCost: z.number().min(0), lotNumber: z.string().trim().max(100).optional(),
    manufacturedAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional(), serialNumbers: z.array(z.string().trim().min(1).max(120)).max(1000).optional() })).min(1).max(500),
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

async function resolveReceiptItems(tx, companyId, items) {
  const productIds = [...new Set(items.map(({ productId }) => productId))];
  const products = await tx.product.findMany({
    where: { companyId, id: { in: productIds }, deletedAt: null, status: "ACTIVE" },
    include: { variants: true, packages: true },
  });
  if (products.length !== productIds.length) throw new ValidationError("Invalid receipt product reference");
  const productMap = new Map(products.map((product) => [product.id, product]));
  const seenSerials = new Set();
  const resolved = items.map((row) => {
    const product = productMap.get(row.productId);
    const activeVariants = product.variants.filter((item) => item.status === "ACTIVE");
    const variant = row.variantId ? activeVariants.find((item) => item.id === row.variantId) : null;
    const productPackage = row.packageId ? product.packages.find((item) => item.id === row.packageId && item.status === "ACTIVE") : null;
    if (row.variantId && !variant) throw new ValidationError("Variant does not belong to receipt product");
    if (activeVariants.length && !variant) throw new ValidationError(`${product.name}: variant tanlash majburiy`);
    if (row.packageId && (!productPackage || (productPackage.variantId && productPackage.variantId !== row.variantId))) {
      throw new ValidationError("Package does not belong to receipt product/variant");
    }
    const conversionToBase = Number(productPackage?.conversionToBase || 1);
    const baseQuantity = Math.round(Number(row.quantity) * conversionToBase * 1000) / 1000;
    const serialNumbers = [...new Set((row.serialNumbers || []).map((value) => String(value).trim()).filter(Boolean))];
    if (serialNumbers.some((value) => seenSerials.has(value))) throw new ValidationError("Serial/IMEI values must be unique within the receipt");
    serialNumbers.forEach((value) => seenSerials.add(value));
    if ((product.trackLot || product.trackExpiry) && !row.lotNumber) throw new ValidationError(`${product.name}: lot/partiya raqami lot/expiry tracking uchun majburiy`);
    if (product.trackExpiry && !row.expiresAt) throw new ValidationError(`${product.name}: yaroqlilik muddati majburiy`);
    if (row.manufacturedAt && row.expiresAt && row.expiresAt <= row.manufacturedAt) throw new ValidationError(`${product.name}: expiry ishlab chiqarilgan sanadan keyin bo‘lishi kerak`);
    if (product.trackSerial) {
      if (!Number.isInteger(baseQuantity)) throw new ValidationError(`${product.name}: serial mahsulot miqdori butun son bo‘lishi kerak`);
      if (serialNumbers.length !== baseQuantity) throw new ValidationError(`${product.name}: har bir dona uchun bitta serial/IMEI kiriting`);
    } else if (serialNumbers.length) throw new ValidationError(`${product.name}: serial tracking yoqilmagan`);
    return { ...row, variantId: variant?.id, packageId: productPackage?.id, conversionToBase, baseQuantity,
      total: Math.round(Number(row.quantity) * Number(row.unitCost) * 100) / 100, serialNumbers };
  });
  const allSerials = resolved.flatMap((row) => row.serialNumbers);
  if (allSerials.length) {
    const duplicate = await tx.productSerial.findFirst({ where: { companyId, OR: [{ serial: { in: allSerials } }, { imei: { in: allSerials } }] }, select: { serial: true, imei: true } });
    if (duplicate) throw new ConflictError(`Serial/IMEI ${duplicate.imei || duplicate.serial} already exists`);
  }
  return resolved;
}

function workflowRoutes(router, prisma) {
  router.get("/stocks", requirePermission("inventory.read"), validate({ query: listQuery }), asyncHandler(async (request, response) => {
    const page = parsePagination(request.validated.query, { allowedSortFields: ["updatedAt", "onHand", "reserved"] });
    const where = { companyId: request.tenant.companyId, stockKey: "BASE" };
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

async function resolveInventoryProductRows(tx, companyId, warehouseId, items, mode) {
  const productIds = [...new Set(items.map(({ productId }) => productId))];
  const products = await tx.product.findMany({
    where: { companyId, id: { in: productIds }, deletedAt: null, status: "ACTIVE" },
    include: { variants: true, packages: true },
  });
  if (products.length !== productIds.length) throw new ValidationError("Invalid inventory product reference");
  const productMap = new Map(products.map((product) => [product.id, product]));
  const usedSerialIds = new Set();
  const newSerialNumbers = new Set();
  const resolved = [];

  for (const row of items) {
    const product = productMap.get(row.productId);
    const activeVariants = product.variants.filter((item) => item.status === "ACTIVE");
    const variant = row.variantId ? activeVariants.find((item) => item.id === row.variantId) : null;
    const productPackage = row.packageId ? product.packages.find((item) => item.id === row.packageId && item.status === "ACTIVE") : null;
    if (row.variantId && !variant) throw new ValidationError("Variant does not belong to inventory product");
    if (activeVariants.length && !variant) throw new ValidationError(`${product.name}: variant tanlash majburiy`);
    if (row.packageId && (!productPackage || (productPackage.variantId && productPackage.variantId !== row.variantId))) throw new ValidationError("Package does not belong to inventory product/variant");
    const conversionToBase = Number(productPackage?.conversionToBase || 1);
    const baseQuantity = Math.round(Number(row.quantity) * conversionToBase * 1000) / 1000;
    const absoluteBase = Math.abs(baseQuantity);
    const serialIds = [...new Set(row.serialIds || [])];
    const serialNumbers = [...new Set((row.serialNumbers || []).map((value) => String(value).trim()).filter(Boolean))];
    if (serialIds.some((id) => usedSerialIds.has(id))) throw new ValidationError("Serial / IMEI can only appear once per inventory document");
    serialIds.forEach((id) => usedSerialIds.add(id));
    if (serialNumbers.some((value) => newSerialNumbers.has(value))) throw new ValidationError("New serial / IMEI values must be unique within the document");
    serialNumbers.forEach((value) => newSerialNumbers.add(value));

    const isOutgoing = mode === "TRANSFER" || baseQuantity < 0;
    if (product.trackSerial) {
      if (!Number.isInteger(absoluteBase)) throw new ValidationError(`${product.name}: serial mahsulot miqdori butun base birlik bo‘lishi kerak`);
      if (isOutgoing) {
        if (serialIds.length !== absoluteBase) throw new ValidationError(`${product.name}: har bir chiqayotgan dona uchun serial / IMEI tanlang`);
        const valid = await tx.productSerial.findMany({ where: { id: { in: serialIds }, companyId, productId: product.id, warehouseId,
          variantId: variant?.id || null, status: "AVAILABLE" }, select: { id: true, batchId: true } });
        if (valid.length !== serialIds.length) throw new ConflictError(`${product.name}: serial / IMEI birliklaridan biri mavjud emas`);
        if (row.batchId && valid.some((item) => item.batchId !== row.batchId)) throw new ValidationError(`${product.name}: tanlangan seriallar boshqa partiyaga tegishli`);
      } else {
        if (serialNumbers.length !== absoluteBase) throw new ValidationError(`${product.name}: har bir kirayotgan dona uchun yangi serial / IMEI kiriting`);
      }
    } else if (serialIds.length || serialNumbers.length) throw new ValidationError(`${product.name}: serial tracking yoqilmagan`);

    let batch = null;
    if (product.trackLot || product.trackExpiry) {
      if (isOutgoing) {
        if (!row.batchId) throw new ValidationError(`${product.name}: chiqim uchun lot/partiyani tanlang`);
        batch = await tx.productBatch.findFirst({ where: { id: row.batchId, companyId, productId: product.id, warehouseId, variantId: variant?.id || null } });
        if (!batch || Number(batch.quantity) - Number(batch.reserved) < absoluteBase) throw new ConflictError(`${product.name}: tanlangan partiyada yetarli bo‘sh qoldiq yo‘q`);
      } else {
        if (!row.lotNumber) throw new ValidationError(`${product.name}: kirim uchun lot/partiya raqami majburiy`);
        if (product.trackExpiry && !row.expiresAt) throw new ValidationError(`${product.name}: yaroqlilik muddati majburiy`);
        if (row.manufacturedAt && row.expiresAt && row.expiresAt <= row.manufacturedAt) throw new ValidationError(`${product.name}: expiry ishlab chiqarilgan sanadan keyin bo‘lishi kerak`);
      }
    } else if (row.batchId || row.lotNumber || row.expiresAt || row.manufacturedAt) throw new ValidationError(`${product.name}: lot/expiry tracking yoqilmagan`);

    resolved.push({ productId: product.id, variantId: variant?.id || null, packageId: productPackage?.id || null, batchId: batch?.id || row.batchId || null,
      quantity: baseQuantity, unitCost: row.unitCost == null ? undefined : Number(row.unitCost) / conversionToBase, serialIds, serialNumbers,
      lotNumber: row.lotNumber || null, manufacturedAt: row.manufacturedAt || null, expiresAt: row.expiresAt || null, product });
  }

  if (newSerialNumbers.size) {
    const values = [...newSerialNumbers];
    const duplicate = await tx.productSerial.findFirst({ where: { companyId, OR: [{ serial: { in: values } }, { imei: { in: values } }] }, select: { serial: true, imei: true } });
    if (duplicate) throw new ConflictError(`Serial/IMEI ${duplicate.imei || duplicate.serial} already exists`);
  }
  return resolved;
}

async function applyAdjustmentTracking(tx, { companyId, warehouseId, row }) {
  const quantity = Number(row.quantity);
  const absolute = Math.abs(quantity);
  let batchId = row.batchId;
  if (quantity > 0 && (row.product.trackLot || row.product.trackExpiry)) {
    const variantKey = row.variantId || "BASE";
    const batch = await tx.productBatch.upsert({ where: { companyId_productId_warehouseId_lotNumber_variantKey: { companyId, productId: row.productId, warehouseId, lotNumber: row.lotNumber, variantKey } },
      create: { companyId, productId: row.productId, variantId: row.variantId, variantKey, warehouseId, lotNumber: row.lotNumber, manufacturedAt: row.manufacturedAt, expiresAt: row.expiresAt, quantity },
      update: { quantity: { increment: quantity }, manufacturedAt: row.manufacturedAt, expiresAt: row.expiresAt } });
    batchId = batch.id;
  } else if (quantity < 0 && row.batchId) {
    const batch = await tx.productBatch.findFirst({ where: { id: row.batchId, companyId, productId: row.productId, warehouseId, variantId: row.variantId || null } });
    if (!batch || Number(batch.quantity) - Number(batch.reserved) < absolute) throw new ConflictError("Tracked batch stock is insufficient for adjustment");
    await tx.productBatch.update({ where: { id: batch.id }, data: { quantity: { decrement: absolute } } });
  }
  if (quantity > 0 && row.product.trackSerial) {
    await tx.productSerial.createMany({ data: row.serialNumbers.map((serial) => ({ companyId, productId: row.productId, variantId: row.variantId,
      warehouseId, batchId, serial, imei: /^\d{15}$/.test(serial) ? serial : null })) });
  } else if (quantity < 0 && row.product.trackSerial) {
    const updated = await tx.productSerial.updateMany({ where: { id: { in: row.serialIds }, companyId, productId: row.productId, warehouseId,
      variantId: row.variantId || null, status: "AVAILABLE", ...(row.batchId ? { batchId: row.batchId } : {}) }, data: { status: "DAMAGED" } });
    if (updated.count !== row.serialIds.length) throw new ConflictError("One or more adjustment serial / IMEI units are unavailable");
  }
  return batchId;
}

async function moveTrackedInventory(tx, { companyId, sourceWarehouseId, targetWarehouseId, row }) {
  const quantity = Number(row.quantity);
  let targetBatchId = null;
  if (row.batchId) {
    const sourceBatch = await tx.productBatch.findFirst({ where: { id: row.batchId, companyId, productId: row.productId, warehouseId: sourceWarehouseId, variantId: row.variantId || null } });
    if (!sourceBatch || Number(sourceBatch.quantity) - Number(sourceBatch.reserved) < quantity) throw new ConflictError("Transfer batch stock is insufficient");
    await tx.productBatch.update({ where: { id: sourceBatch.id }, data: { quantity: { decrement: quantity } } });
    const variantKey = row.variantId || "BASE";
    const targetBatch = await tx.productBatch.upsert({ where: { companyId_productId_warehouseId_lotNumber_variantKey: { companyId, productId: row.productId, warehouseId: targetWarehouseId, lotNumber: sourceBatch.lotNumber, variantKey } },
      create: { companyId, productId: row.productId, variantId: row.variantId, variantKey, warehouseId: targetWarehouseId, lotNumber: sourceBatch.lotNumber,
        manufacturedAt: sourceBatch.manufacturedAt, expiresAt: sourceBatch.expiresAt, quantity }, update: { quantity: { increment: quantity } } });
    targetBatchId = targetBatch.id;
  }
  if (row.product.trackSerial) {
    const updated = await tx.productSerial.updateMany({ where: { id: { in: row.serialIds }, companyId, productId: row.productId, warehouseId: sourceWarehouseId,
      variantId: row.variantId || null, status: "AVAILABLE", ...(row.batchId ? { batchId: row.batchId } : {}) }, data: { warehouseId: targetWarehouseId, batchId: targetBatchId } });
    if (updated.count !== row.serialIds.length) throw new ConflictError("One or more transfer serial / IMEI units are unavailable");
  }
  return targetBatchId;
}

function adjustmentRoutes(router, prisma) {
  router.get("/adjustments", requirePermission("inventory.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.stockAdjustment.findMany({ where: { companyId: request.tenant.companyId }, include: { warehouse: true, items: { include: { product: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
  })));
  router.post("/adjustments", requirePermission("inventory.create"), validate({ body: adjustmentSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      await assertTenantReferences(tx, companyId, { warehouses: [input.warehouseId], products: input.items.map(({ productId }) => productId) });
      const rows = await resolveInventoryProductRows(tx, companyId, input.warehouseId, input.items, "ADJUSTMENT");
      return tx.stockAdjustment.create({ data: { companyId, warehouseId: input.warehouseId, reason: input.reason,
        number: await nextDocumentNumber(tx, companyId, "ADJUSTMENT", "ADJ"),
        status: "PENDING_APPROVAL", items: { create: rows.map(({ product: _product, ...row }) => row) } }, include: { items: true, warehouse: true } });
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "StockAdjustment", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/adjustments/:id/approve", requirePermission("inventory.approve"), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const data = await prisma.$transaction(async (tx) => {
      const doc = await tx.stockAdjustment.findFirst({ where: { id: request.params.id, companyId }, include: { items: { include: { product: true } } } });
      if (!doc) throw new NotFoundError("Stock adjustment not found");
      if (doc.status !== "PENDING_APPROVAL") throw new ConflictError("Stock adjustment cannot be approved in its current status");
      for (const row of doc.items) {
        const batchId = await applyAdjustmentTracking(tx, { companyId, warehouseId: doc.warehouseId, row });
        await changeStock(tx, { companyId, warehouseId: doc.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, batchId,
          employeeId: request.auth.employeeId, quantity: row.quantity, type: Number(row.quantity) > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
          referenceType: "StockAdjustment", referenceId: doc.id, reason: doc.reason, unitCost: row.unitCost });
      }
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
      const rows = await resolveInventoryProductRows(tx, companyId, input.sourceWarehouseId, input.items, "TRANSFER");
      return tx.stockTransfer.create({ data: { companyId, sourceWarehouseId: input.sourceWarehouseId, targetWarehouseId: input.targetWarehouseId,
        note: input.note, number: await nextDocumentNumber(tx, companyId, "TRANSFER", "TRF"), status: "PENDING_APPROVAL",
        items: { create: rows.map(({ product: _product, serialNumbers: _serialNumbers, lotNumber: _lotNumber, manufacturedAt: _manufacturedAt, expiresAt: _expiresAt, unitCost: _unitCost, ...row }) => row) } }, include: { items: true } });
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
      const doc = await tx.stockTransfer.findFirst({ where: { id: request.params.id, companyId }, include: { items: { include: { product: true } } } });
      if (!doc) throw new NotFoundError("Stock transfer not found");
      if (doc.status !== "APPROVED") throw new ConflictError("Only approved transfers can be completed");
      for (const row of doc.items) {
        const targetBatchId = await moveTrackedInventory(tx, { companyId, sourceWarehouseId: doc.sourceWarehouseId, targetWarehouseId: doc.targetWarehouseId, row });
        await changeStock(tx, { companyId, warehouseId: doc.sourceWarehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, batchId: row.batchId, employeeId: request.auth.employeeId,
          quantity: -Number(row.quantity), type: "TRANSFER_OUT", referenceType: "StockTransfer", referenceId: doc.id });
        await changeStock(tx, { companyId, warehouseId: doc.targetWarehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, batchId: targetBatchId, employeeId: request.auth.employeeId,
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
      const stocks = await tx.warehouseStock.findMany({ where: { warehouseId: input.warehouseId, stockKey: "BASE", productId: { in: input.items.map(({ productId }) => productId) } } });
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
      const doc = await tx.inventoryCount.findFirst({ where: { id: request.params.id, companyId }, include: { items: { include: { product: true } } } });
      if (!doc) throw new NotFoundError("Inventory count not found");
      if (doc.status !== "IN_PROGRESS") throw new ConflictError("Inventory count cannot be completed");
      for (const row of doc.items) if (Number(row.difference) !== 0) {
        if (row.product.trackSerial || row.product.trackLot || row.product.trackExpiry) throw new ValidationError(`${row.product.name}: tracked mahsulot farqini serial/lot ma’lumoti bilan Qoldiq tuzatish orqali kiriting`);
        await changeStock(tx, { companyId, warehouseId: doc.warehouseId, productId: row.productId, employeeId: request.auth.employeeId, quantity: row.difference, type: "COUNT_CORRECTION",
          referenceType: "InventoryCount", referenceId: doc.id });
      }
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
      const rows = await resolveReceiptItems(tx, companyId, input.items);
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
      const doc = await tx.goodsReceipt.findFirst({ where: { id: request.params.id, companyId }, include: { items: { include: { product: true } } } });
      if (!doc) throw new NotFoundError("Goods receipt not found");
      if (doc.status !== "DRAFT") throw new ConflictError("Goods receipt is already processed");
      for (const row of doc.items) {
        let batchId = row.batchId;
        if (row.lotNumber) {
          const variantKey = row.variantId || "BASE";
          const batch = await tx.productBatch.upsert({ where: { companyId_productId_warehouseId_lotNumber_variantKey: { companyId, productId: row.productId,
            warehouseId: doc.warehouseId, lotNumber: row.lotNumber, variantKey } }, create: { companyId, productId: row.productId, variantId: row.variantId, variantKey,
            warehouseId: doc.warehouseId, lotNumber: row.lotNumber, manufacturedAt: row.manufacturedAt, expiresAt: row.expiresAt, quantity: row.baseQuantity || row.quantity },
          update: { quantity: { increment: row.baseQuantity || row.quantity }, manufacturedAt: row.manufacturedAt, expiresAt: row.expiresAt } }); batchId = batch.id;
          await tx.goodsReceiptItem.update({ where: { id: row.id }, data: { batchId } });
        }
        const serialNumbers = Array.isArray(row.serialNumbers) ? row.serialNumbers : [];
        if (row.product.trackSerial && serialNumbers.length !== Number(row.baseQuantity || row.quantity)) throw new ValidationError("Serialized receipt quantity does not match serial/IMEI count");
        if (serialNumbers.length) await tx.productSerial.createMany({ data: serialNumbers.map((serial) => ({ companyId, productId: row.productId,
          variantId: row.variantId, warehouseId: doc.warehouseId, batchId, serial, imei: /^\d{15}$/.test(serial) ? serial : null })) });
        await changeStock(tx, { companyId, warehouseId: doc.warehouseId, productId: row.productId, variantId: row.variantId, packageId: row.packageId, batchId,
          employeeId: request.auth.employeeId, quantity: row.baseQuantity || row.quantity,
          unitCost: Number(row.total) / Number(row.baseQuantity || row.quantity), type: "GOODS_RECEIPT", referenceType: "GoodsReceipt", referenceId: doc.id });
      }
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
