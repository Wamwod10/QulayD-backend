import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { createPosService } from "./pos.service.js";
import { cashActionSchema, cashboxSchema, closeShiftSchema, heldCartSchema, openShiftSchema, paymentMethodSchema, posSaleSchema } from "./pos.validation.js";
const params = z.object({ id: z.uuid() });
export function createPosRouter({ prisma }) {
  const router = Router(); const service = createPosService(prisma); router.use(requireModule("pos"));
  router.use("/cashboxes", createTenantCrudRouter({ prisma, model: "cashbox", entity: "Cashbox", module: "pos",
    createSchema: cashboxSchema, searchFields: ["name", "code"], filterFields: ["status", "branchId", "warehouseId"], softDelete: false,
    tenantRelationFields: { branchId: "branch", warehouseId: "warehouse" } }));
  router.use("/payment-methods", createTenantCrudRouter({ prisma, model: "paymentMethodConfig", entity: "PaymentMethod", module: "pos",
    createSchema: paymentMethodSchema, searchFields: ["name", "code"], filterFields: ["status", "method"], softDelete: false }));
  router.get("/held-carts", requirePermission("pos.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.heldCart.findMany({
    where: { companyId: request.tenant.companyId, employeeId: request.auth.employeeId }, include: { customer: true, items: { include: { product: true, variant: true, package: true } } }, orderBy: { createdAt: "desc" }, take: 100,
  }) })));
  router.post("/held-carts", requirePermission("pos.create"), validate({ body: heldCartSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const productIds = [...new Set(input.items.map(({ productId }) => productId))];
    const [products, customer] = await Promise.all([
      prisma.product.findMany({ where: { companyId: request.tenant.companyId, id: { in: productIds }, deletedAt: null, status: "ACTIVE" }, include: { variants: true, packages: true, serials: true } }),
      input.customerId ? prisma.customer.count({ where: { companyId: request.tenant.companyId, id: input.customerId, deletedAt: null } }) : 1,
    ]);
    if (products.length !== productIds.length || customer !== 1) throw new ValidationError("Invalid held cart resource reference");
    const productMap = new Map(products.map((product) => [product.id, product]));
    const usedSerialIds = new Set();
    for (const row of input.items) {
      const product = productMap.get(row.productId);
      const variant = row.variantId ? product.variants.find((item) => item.id === row.variantId && item.status === "ACTIVE") : null;
      const productPackage = row.packageId ? product.packages.find((item) => item.id === row.packageId && item.status === "ACTIVE") : null;
      if (row.variantId && !variant) throw new ValidationError("Held cart variant does not belong to product");
      if (row.packageId && (!productPackage || (productPackage.variantId && productPackage.variantId !== row.variantId))) throw new ValidationError("Held cart package does not belong to product/variant");
      const serialIds = row.serialIds || [];
      if (product.trackSerial) {
        const required = Number(row.baseQuantity || Number(row.quantity) * Number(row.conversionToBase || 1));
        if (!Number.isInteger(required) || serialIds.length !== required) throw new ValidationError("Every serialized held-cart unit must include one serial / IMEI");
        const validIds = new Set(product.serials.filter((item) => item.status === "AVAILABLE" && (item.variantId || null) === (row.variantId || null)).map((item) => item.id));
        if (serialIds.some((id) => !validIds.has(id) || usedSerialIds.has(id))) throw new ValidationError("Held cart contains an invalid or duplicate serial / IMEI");
        serialIds.forEach((id) => usedSerialIds.add(id));
      } else if (serialIds.length) throw new ValidationError("Serial / IMEI can only be attached to serialized products");
    }
    const { items, ...fields } = input; const data = await prisma.heldCart.create({ data: { ...fields, companyId: request.tenant.companyId, employeeId: request.auth.employeeId,
      items: { create: items.map((row) => { const conversionToBase = row.conversionToBase || 1; return { productId: row.productId, variantId: row.variantId,
        packageId: row.packageId, quantity: row.quantity, baseQuantity: row.baseQuantity || row.quantity * conversionToBase, conversionToBase,
        unitPrice: row.unitPrice, discount: row.discountAmount || (row.discount?.type === "FIXED" ? row.discount.value : 0), serialIds: row.serialIds || [] }; }) } },
      include: { items: { include: { product: true, variant: true, package: true } } } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "HeldCart", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.delete("/held-carts/:id", requirePermission("pos.delete"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.heldCart.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId, employeeId: request.auth.employeeId } });
    const result = await prisma.heldCart.deleteMany({ where: { id: request.params.id, companyId: request.tenant.companyId, employeeId: request.auth.employeeId } });
    if (current) await writeAudit(prisma, request, { action: "DELETE", entity: "HeldCart", entityId: current.id, before: current });
    return sendSuccess(response, { data: { deleted: result.count === 1 } });
  }));
  router.get("/receipts/:id", requirePermission("pos.read"), validate({ params }), asyncHandler(async (request, response) => {
    const data = await prisma.receipt.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId }, include: { order: { include: { items: { include: { product: true, variant: true, package: true } }, customer: true } }, payment: true } });
    if (!data) throw new NotFoundError("Receipt not found");
    return sendSuccess(response, { data });
  }));
  router.get("/shifts", requirePermission("pos.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.shift.findMany({
    where: { companyId: request.tenant.companyId }, include: { employee: { select: { id: true, name: true } }, cashbox: true }, orderBy: { openedAt: "desc" }, take: 500,
  }) })));
  router.post("/receipts/:id/print", requirePermission("pos.update"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.receipt.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } });
    const result = await prisma.receipt.updateMany({ where: { id: request.params.id, companyId: request.tenant.companyId }, data: { printedAt: new Date() } });
    if (current && result.count) await writeAudit(prisma, request, { action: "PRINT", entity: "Receipt", entityId: current.id, before: current, after: { ...current, printedAt: new Date() } });
    return sendSuccess(response, { data: { printed: result.count === 1 } });
  }));
  router.get("/shifts/current", requirePermission("pos.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await service.currentShift(request.tenant.companyId, request.auth.employeeId) })));
  router.post("/shifts/open", requirePermission("pos.create"), validate({ body: openShiftSchema }), asyncHandler(async (request, response) => {
    const data = await service.openShift(request.tenant.companyId, request.auth.employeeId, request.validated.body);
    await writeAudit(prisma, request, { action: "OPEN", entity: "Shift", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/shifts/:id/cash", requirePermission("pos.update"), validate({ params, body: cashActionSchema }), asyncHandler(async (request, response) => {
    const data = await service.cashAction(request.tenant.companyId, request.auth.employeeId, request.params.id, request.validated.body);
    await writeAudit(prisma, request, { action: data.type, entity: "CashTransaction", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/shifts/:id/close", requirePermission("pos.update"), validate({ params, body: closeShiftSchema }), asyncHandler(async (request, response) => {
    const data = await service.closeShift(request.tenant.companyId, request.auth.employeeId, request.params.id, request.validated.body);
    await writeAudit(prisma, request, { action: "CLOSE", entity: "Shift", entityId: data.id, after: data }); return sendSuccess(response, { data });
  }));
  router.post("/sales", requirePermission("pos.create"), validate({ body: posSaleSchema }), asyncHandler(async (request, response) => {
    const data = await service.sale(request.tenant.companyId, request.auth.employeeId, request.validated.body);
    await writeAudit(prisma, request, { action: "POS_SALE", entity: "Order", entityId: data.order.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  return router;
}
