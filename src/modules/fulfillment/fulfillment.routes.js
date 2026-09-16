import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";

const params = z.object({ id: z.uuid() });
const lineParams = z.object({ id: z.uuid(), lineId: z.uuid() });
const lineUpdate = z.object({
  pickedQuantity: z.number().min(0),
  shortageQuantity: z.number().min(0).default(0),
  serialIds: z.array(z.uuid()).max(500).optional(),
  batchAllocations: z.array(z.object({ batchId: z.uuid(), quantity: z.number().positive() })).max(100).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

function roundQty(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000; }
function isPrivileged(request) { return (request.auth?.user?.roles || []).some((role) => ["OWNER", "ADMIN"].includes(role)); }
function employeeWarehouseScope(request) { return isPrivileged(request) ? null : request.auth?.user?.warehouseId || null; }

async function recalcPickList(tx, pickListId) {
  const lines = await tx.pickListItem.findMany({ where: { pickListId }, select: { requiredBaseQuantity: true, pickedBaseQuantity: true, shortageBaseQuantity: true } });
  const required = lines.reduce((sum, line) => sum + Number(line.requiredBaseQuantity), 0);
  const picked = lines.reduce((sum, line) => sum + Number(line.pickedBaseQuantity), 0);
  const shortage = lines.reduce((sum, line) => sum + Number(line.shortageBaseQuantity), 0);
  const progress = required > 0 ? Math.min(100, Math.max(0, Math.floor((picked / required) * 100))) : 100;
  const exception = shortage > 0 ? `${roundQty(shortage)} base birlik yetishmayapti` : null;
  await tx.pickList.update({ where: { id: pickListId }, data: { progress, exception } });
  return { progress, exception };
}

async function replaceBatchReservation(tx, line, allocations) {
  const previous = Array.isArray(line.batchAllocations) ? line.batchAllocations : [];
  for (const allocation of previous) {
    if (!allocation?.batchId || Number(allocation.quantity || 0) <= 0) continue;
    const batch = await tx.productBatch.findUnique({ where: { id: allocation.batchId } });
    if (!batch) continue;
    const release = Math.min(Number(batch.reserved), Number(allocation.quantity));
    if (release > 0) await tx.productBatch.update({ where: { id: batch.id }, data: { reserved: { decrement: release } } });
  }
  for (const allocation of allocations) {
    const batch = await tx.productBatch.findFirst({ where: {
      id: allocation.batchId,
      companyId: line.companyId,
      warehouseId: line.pickList.order.warehouseId,
      productId: line.orderItem.productId,
      variantId: line.orderItem.variantId || null,
    } });
    if (!batch) throw new ValidationError("Selected lot/batch does not belong to this pick line", { batchId: allocation.batchId });
    if (line.orderItem.product.trackExpiry && batch.expiresAt && batch.expiresAt <= new Date()) throw new ConflictError("Expired batch cannot be picked", { batchId: batch.id });
    const available = Number(batch.quantity) - Number(batch.reserved);
    if (available + 1e-9 < Number(allocation.quantity)) throw new ConflictError("Selected lot/batch does not have enough available quantity", {
      batchId: batch.id, required: Number(allocation.quantity), available: Math.max(0, available),
    });
    await tx.productBatch.update({ where: { id: batch.id }, data: { reserved: { increment: Number(allocation.quantity) } } });
  }
}

export function createFulfillmentRouter({ prisma }) {
  const router = Router();
  router.use(requireModule("fulfillment"), requirePermission("fulfillment.read"));

  router.get("/pick-lists", asyncHandler(async (request, response) => {
    const warehouseId = employeeWarehouseScope(request);
    const data = await prisma.pickList.findMany({
      where: { companyId: request.tenant.companyId, ...(warehouseId ? { order: { warehouseId } } : {}) },
      include: {
        pickerEmployee: { select: { id: true, name: true, warehouseId: true, modules: { where: { enabled: true }, select: { module: true } } } },
        items: { include: { orderItem: { include: { product: { include: { barcodes: true } }, variant: { include: { barcodes: true } }, package: { include: { barcodes: true } } } } } },
        order: { include: { customer: true, warehouse: true, items: { include: { product: true, variant: true, package: true } } } },
      },
      orderBy: { createdAt: "desc" }, take: 500,
    });
    const serialIds = [...new Set(data.flatMap((pick) => pick.items.flatMap((line) => Array.isArray(line.orderItem.serialIds) ? line.orderItem.serialIds : [])))];
    const productIds = [...new Set(data.flatMap((pick) => pick.items.map((line) => line.orderItem.productId)))];
    const warehouseIds = [...new Set(data.map((pick) => pick.order.warehouseId))];
    const [serials, batches] = await Promise.all([
      serialIds.length ? prisma.productSerial.findMany({ where: { companyId: request.tenant.companyId, id: { in: serialIds }, status: "RESERVED" },
        select: { id: true, serial: true, imei: true, productId: true, variantId: true, warehouseId: true, batchId: true } }) : [],
      productIds.length && warehouseIds.length ? prisma.productBatch.findMany({ where: { companyId: request.tenant.companyId, productId: { in: productIds }, warehouseId: { in: warehouseIds }, quantity: { gt: 0 } },
        select: { id: true, productId: true, variantId: true, warehouseId: true, lotNumber: true, expiresAt: true, quantity: true, reserved: true }, orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }] }) : [],
    ]);
    const serialById = new Map(serials.map((row) => [row.id, row]));
    for (const pick of data) {
      for (const line of pick.items) {
        const orderItem = line.orderItem;
        line.reservedSerials = (Array.isArray(orderItem.serialIds) ? orderItem.serialIds : []).map((id) => serialById.get(id)).filter(Boolean);
        line.availableBatches = batches.filter((batch) => batch.warehouseId === pick.order.warehouseId && batch.productId === orderItem.productId
          && (batch.variantId || null) === (orderItem.variantId || null))
          .map((batch) => ({ ...batch, available: Math.max(0, Number(batch.quantity) - Number(batch.reserved)) }));
      }
    }
    return sendSuccess(response, { data });
  }));

  router.patch("/pick-lists/:id/assign", requirePermission("fulfillment.update"), validate({
    params, body: z.object({ employeeId: z.uuid().nullable() }),
  }), asyncHandler(async (request, response) => {
    const current = await prisma.pickList.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId }, include: { order: true } });
    if (!current) throw new NotFoundError("Pick list not found");
    if (request.validated.body.employeeId) {
      const employee = await prisma.employee.findFirst({ where: {
        id: request.validated.body.employeeId, companyId: request.tenant.companyId, status: "ACTIVE", deletedAt: null,
        OR: [
          { modules: { some: { module: "warehouse_workspace", enabled: true } } },
          { modules: { some: { module: "fulfillment_workspace", enabled: true } } },
        ],
      }, select: { id: true, warehouseId: true } });
      if (!employee) throw new ValidationError("Picker must be an active warehouse/fulfillment employee");
      if (employee.warehouseId && employee.warehouseId !== current.order.warehouseId) throw new ValidationError("Picker belongs to a different warehouse");
    }
    const data = await prisma.pickList.update({ where: { id: current.id }, data: { pickerEmployeeId: request.validated.body.employeeId }, include: { pickerEmployee: { select: { id: true, name: true } } } });
    return sendSuccess(response, { data });
  }));

  router.patch("/pick-lists/:id/items/:lineId", requirePermission("fulfillment.update"), validate({ params: lineParams, body: lineUpdate }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const input = request.validated.body;
    const data = await prisma.$transaction(async (tx) => {
      const line = await tx.pickListItem.findFirst({ where: { id: request.params.lineId, pickListId: request.params.id, companyId }, include: {
        pickList: { include: { order: true } }, orderItem: { include: { product: true, variant: true, package: true } },
      } });
      if (!line) throw new NotFoundError("Pick-list line not found");
      if (line.pickList.status !== "IN_PROGRESS" || line.pickList.order.fulfillmentStatus !== "PICKING") throw new ConflictError("Picking is not in progress");
      const scopeWarehouse = employeeWarehouseScope(request);
      if (scopeWarehouse && scopeWarehouse !== line.pickList.order.warehouseId) throw new ValidationError("Pick list belongs to another warehouse");
      if (line.pickList.pickerEmployeeId && !isPrivileged(request) && line.pickList.pickerEmployeeId !== request.auth.employeeId) {
        throw new ConflictError("Pick list is assigned to another employee");
      }

      const required = Number(line.requiredQuantity); const conversion = Number(line.orderItem.conversionToBase || 1);
      const picked = roundQty(input.pickedQuantity); const shortage = roundQty(input.shortageQuantity || 0);
      if (picked + shortage > required + 1e-9) throw new ValidationError("Picked + shortage quantity cannot exceed required quantity");
      const pickedBase = roundQty(picked * conversion); const shortageBase = roundQty(shortage * conversion);
      const product = line.orderItem.product;
      let serialIds = [];
      let batchAllocations = Array.isArray(input.batchAllocations) ? input.batchAllocations.map((row) => ({ batchId: row.batchId, quantity: roundQty(row.quantity) })) : [];

      if (product.trackSerial) {
        if (!Number.isInteger(pickedBase)) throw new ValidationError("Serialized product pick quantity must resolve to whole base units");
        serialIds = [...new Set(input.serialIds || [])];
        if (serialIds.length !== pickedBase) throw new ValidationError("Scanned serial / IMEI count must equal picked base quantity", { required: pickedBase, scanned: serialIds.length });
        const reservedIds = new Set(Array.isArray(line.orderItem.serialIds) ? line.orderItem.serialIds : []);
        if (serialIds.some((id) => !reservedIds.has(id))) throw new ValidationError("Scanned serial / IMEI is not reserved for this order item");
        const serials = serialIds.length ? await tx.productSerial.findMany({ where: {
          id: { in: serialIds }, companyId, warehouseId: line.pickList.order.warehouseId, productId: line.orderItem.productId,
          variantId: line.orderItem.variantId || null, soldOrderId: line.pickList.orderId, status: "RESERVED",
        }, select: { id: true, batchId: true } }) : [];
        if (serials.length !== serialIds.length) throw new ConflictError("One or more scanned serial / IMEI units are no longer reserved for this order");
        if (product.trackLot || product.trackExpiry) {
          const grouped = new Map();
          for (const serial of serials) {
            if (!serial.batchId) throw new ValidationError("Tracked serial / IMEI is missing its lot/batch");
            grouped.set(serial.batchId, roundQty((grouped.get(serial.batchId) || 0) + 1));
          }
          batchAllocations = [...grouped.entries()].map(([batchId, quantity]) => ({ batchId, quantity }));
        }
      } else if (product.trackLot || product.trackExpiry) {
        const allocated = roundQty(batchAllocations.reduce((sum, row) => sum + Number(row.quantity || 0), 0));
        if (Math.abs(allocated - pickedBase) > 1e-9) throw new ValidationError("Lot/batch allocation must equal picked base quantity", { pickedBase, allocated });
      } else {
        batchAllocations = [];
      }

      if (product.trackLot || product.trackExpiry) await replaceBatchReservation(tx, line, batchAllocations);
      const updated = await tx.pickListItem.update({ where: { id: line.id }, data: {
        pickedQuantity: picked, shortageQuantity: shortage, pickedBaseQuantity: pickedBase, shortageBaseQuantity: shortageBase,
        serialIds, batchAllocations, note: input.note === undefined ? line.note : input.note,
      }, include: { orderItem: { include: { product: true, variant: true, package: true } } } });
      const state = await recalcPickList(tx, line.pickListId);
      return { ...updated, pickListProgress: state.progress, pickListException: state.exception };
    }, { isolationLevel: "Serializable" });
    return sendSuccess(response, { data });
  }));

  router.get("/packing", asyncHandler(async (request, response) => {
    const warehouseId = employeeWarehouseScope(request);
    const data = await prisma.packing.findMany({ where: { companyId: request.tenant.companyId, ...(warehouseId ? { order: { warehouseId } } : {}) }, include: { order: { include: { customer: true } } }, orderBy: { createdAt: "desc" }, take: 500 });
    return sendSuccess(response, { data });
  }));
  return router;
}
