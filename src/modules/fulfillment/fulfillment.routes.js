import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { NotFoundError, ValidationError } from "../../shared/errors/index.js";
export function createFulfillmentRouter({ prisma }) {
  const router = Router(); router.use(requireModule("fulfillment"), requirePermission("fulfillment.read"));
  router.get("/pick-lists", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.pickList.findMany({ where: { companyId: request.tenant.companyId }, include: { pickerEmployee: { select: { id: true, name: true } }, order: { include: { customer: true, items: { include: { product: true } } } } }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  router.patch("/pick-lists/:id/assign", requirePermission("fulfillment.update"), validate({
    params: z.object({ id: z.uuid() }), body: z.object({ employeeId: z.uuid().nullable() }),
  }), asyncHandler(async (request, response) => {
    const current = await prisma.pickList.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } });
    if (!current) throw new NotFoundError("Pick list not found");
    if (request.validated.body.employeeId) {
      const employee = await prisma.employee.count({ where: { id: request.validated.body.employeeId, companyId: request.tenant.companyId, status: "ACTIVE", deletedAt: null } });
      if (!employee) throw new ValidationError("Picker employee is invalid");
    }
    const data = await prisma.pickList.update({ where: { id: current.id }, data: { pickerEmployeeId: request.validated.body.employeeId }, include: { pickerEmployee: { select: { id: true, name: true } } } });
    return sendSuccess(response, { data });
  }));
  router.get("/packing", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.packing.findMany({ where: { companyId: request.tenant.companyId }, include: { order: { include: { customer: true } } }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  return router;
}
