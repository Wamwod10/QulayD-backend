import { Router } from "express";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
export function createFulfillmentRouter({ prisma }) {
  const router = Router(); router.use(requireModule("fulfillment"), requirePermission("fulfillment.read"));
  router.get("/pick-lists", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.pickList.findMany({ where: { companyId: request.tenant.companyId }, include: { order: { include: { customer: true, items: { include: { product: true } } } } }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  router.get("/packing", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.packing.findMany({ where: { companyId: request.tenant.companyId }, include: { order: { include: { customer: true } } }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  return router;
}
