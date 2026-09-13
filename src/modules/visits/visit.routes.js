import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { visitCreateSchema, visitLocationSchema } from "./visit.validation.js";
const params = z.object({ id: z.uuid() });
export function createVisitRouter({ prisma }) {
  const router = Router(); router.use(requireModule("agents"));
  router.get("/", requirePermission("agents.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.visit.findMany({ where: { companyId: request.tenant.companyId }, include: { employee: { select: { id: true, name: true } }, customer: true }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  router.post("/", requirePermission("agents.create"), validate({ body: visitCreateSchema }), asyncHandler(async (request, response) => {
    const employeeId = request.validated.body.employeeId || request.auth.employeeId; const companyId = request.tenant.companyId;
    const [employee, customer] = await Promise.all([prisma.employee.count({ where: { id: employeeId, companyId, status: "ACTIVE" } }), prisma.customer.count({ where: { id: request.validated.body.customerId, companyId, deletedAt: null } })]);
    if (!employee || !customer) throw new ValidationError("Invalid visit resource reference"); const data = await prisma.visit.create({ data: { ...request.validated.body, employeeId, companyId } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "Visit", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/:id/check-in", requirePermission("agents.update"), validate({ params, body: visitLocationSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.visit.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } }); if (!current) throw new NotFoundError("Visit not found");
    if (current.status !== "PLANNED") throw new ConflictError("Visit cannot be started"); const data = await prisma.visit.update({ where: { id: current.id }, data: { ...request.validated.body, status: "IN_PROGRESS", checkInAt: new Date() } });
    await writeAudit(prisma, request, { action: "CHECK_IN", entity: "Visit", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  }));
  router.post("/:id/check-out", requirePermission("agents.update"), validate({ params, body: visitLocationSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.visit.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } }); if (!current) throw new NotFoundError("Visit not found");
    if (current.status !== "IN_PROGRESS") throw new ConflictError("Visit is not active"); const data = await prisma.visit.update({ where: { id: current.id }, data: { ...request.validated.body, status: "COMPLETED", checkOutAt: new Date() } });
    await writeAudit(prisma, request, { action: "CHECK_OUT", entity: "Visit", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  })); return router;
}
