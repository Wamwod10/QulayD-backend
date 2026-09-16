import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { AuthorizationError, ConflictError, NotFoundError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { approveOrderInTransaction } from "../orders/order.service.js";

const params = z.object({ id: z.uuid() });
const review = z.object({ reason: z.string().trim().max(1000).optional() });

export function createApprovalRouter({ prisma }) {
  const router = Router();
  router.use(requireRole("OWNER", "ADMIN"));
  router.get("/", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.approval.findMany({
    where: { companyId: request.tenant.companyId }, include: { requestedBy: { select: { id: true, name: true } }, reviewedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }, take: 500,
  }) })));

  router.post("/:id/approve", validate({ params, body: review }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const before = await prisma.approval.findFirst({ where: { id: request.params.id, companyId } });
    if (!before) throw new NotFoundError("Approval not found");
    if (before.status !== "PENDING_APPROVAL") throw new ConflictError("Approval is already reviewed");
    const isOrderApproval = before.entity === "Order" && before.action === "CONFIRM_ORDER";
    if (isOrderApproval && !(request.auth?.user?.roles || []).includes("OWNER")) throw new AuthorizationError("Only Owner can approve an Admin order");
    const data = await prisma.$transaction(async (tx) => {
      if (isOrderApproval) await approveOrderInTransaction(tx, companyId, before.entityId, request.auth.employeeId, request.validated.body.reason || "Owner approved order");
      return tx.approval.update({ where: { id: before.id }, data: { status: "APPROVED", reason: request.validated.body.reason,
        reviewedById: request.auth.employeeId, reviewedAt: new Date() } });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "APPROVED", entity: "Approval", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));

  router.post("/:id/reject", validate({ params, body: review }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const before = await prisma.approval.findFirst({ where: { id: request.params.id, companyId } });
    if (!before) throw new NotFoundError("Approval not found");
    if (before.status !== "PENDING_APPROVAL") throw new ConflictError("Approval is already reviewed");
    const isOrderApproval = before.entity === "Order" && before.action === "CONFIRM_ORDER";
    if (isOrderApproval && !(request.auth?.user?.roles || []).includes("OWNER")) throw new AuthorizationError("Only Owner can reject an Admin order");
    const data = await prisma.$transaction(async (tx) => {
      if (isOrderApproval) {
        const order = await tx.order.findFirst({ where: { id: before.entityId, companyId, status: "PENDING_APPROVAL" } });
        if (!order) throw new ConflictError("Order is no longer waiting for approval");
        await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED", fulfillmentStatus: "CANCELLED", deliveryStatus: "CANCELLED", cancelledAt: new Date() } });
        await tx.orderStatusHistory.create({ data: { orderId: order.id, employeeId: request.auth.employeeId, status: "CANCELLED", fulfillment: "CANCELLED", delivery: "CANCELLED", note: request.validated.body.reason || "Owner rejected order" } });
      }
      return tx.approval.update({ where: { id: before.id }, data: { status: "REJECTED", reason: request.validated.body.reason,
        reviewedById: request.auth.employeeId, reviewedAt: new Date() } });
    }, { isolationLevel: "Serializable" });
    await writeAudit(prisma, request, { action: "REJECTED", entity: "Approval", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));
  return router;
}
