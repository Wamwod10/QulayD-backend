import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { ConflictError, NotFoundError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
const params = z.object({ id: z.uuid() }); const review = z.object({ reason: z.string().trim().max(1000).optional() });
export function createApprovalRouter({ prisma }) {
  const router = Router(); router.use(requireRole("OWNER", "ADMIN"));
  router.get("/", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.approval.findMany({ where: { companyId: request.tenant.companyId }, include: { requestedBy: { select: { id: true, name: true } }, reviewedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  for (const [path, status] of [["approve", "APPROVED"], ["reject", "REJECTED"]]) router.post(`/:id/${path}`, validate({ params, body: review }), asyncHandler(async (request, response) => {
    const current = await prisma.approval.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } }); if (!current) throw new NotFoundError("Approval not found");
    if (current.status !== "PENDING_APPROVAL") throw new ConflictError("Approval is already reviewed"); const data = await prisma.approval.update({ where: { id: current.id }, data: { status, reason: request.validated.body.reason, reviewedById: request.auth.employeeId, reviewedAt: new Date() } });
    await writeAudit(prisma, request, { action: status, entity: "Approval", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  })); return router;
}
