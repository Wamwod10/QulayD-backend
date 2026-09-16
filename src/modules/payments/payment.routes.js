import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { createPaymentService } from "./payment.service.js";
import { paymentCreateSchema } from "./payment.validation.js";
const params = z.object({ id: z.uuid() });
const cashSettlementBody = z.object({ shiftId: z.uuid() });
const query = z.object({ page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), search: z.string().max(200).optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(), status: z.string().max(30).optional(), method: z.string().max(30).optional(), customerId: z.uuid().optional(), supplierId: z.uuid().optional(), orderId: z.uuid().optional() });
export function createPaymentRouter({ prisma }) {
  const router = Router(); const service = createPaymentService(prisma); router.use(requireModule("finance"));
  router.get("/", requirePermission("finance.read"), validate({ query }), asyncHandler(async (request, response) => { const result = await service.list(request.tenant.companyId, request.validated.query); return sendSuccess(response, result); }));
  router.post("/", requirePermission("finance.create"), validate({ body: paymentCreateSchema }), asyncHandler(async (request, response) => { const data = await service.create(request.tenant.companyId, request.auth.employeeId, request.validated.body);
    await writeAudit(prisma, request, { action: "CREATE", entity: "Payment", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data }); }));
  router.post("/:id/settle-cash", requirePermission("finance.approve"), validate({ params, body: cashSettlementBody }), asyncHandler(async (request, response) => {
    const data = await service.settleCash(request.tenant.companyId, request.auth.employeeId, request.params.id, request.validated.body.shiftId);
    await writeAudit(prisma, request, { action: "SETTLE_CASH", entity: "Payment", entityId: data.id, after: data });
    return sendSuccess(response, { data });
  }));
  for (const [path, action] of [["confirm", "confirm"], ["cancel", "cancel"]]) router.post(`/:id/${path}`, requirePermission(path === "confirm" ? "finance.approve" : "finance.update"), validate({ params }), asyncHandler(async (request, response) => {
    const data = await service[action](request.tenant.companyId, ...(action === "confirm" ? [request.auth.employeeId, request.params.id] : [request.params.id]));
    await writeAudit(prisma, request, { action: path.toUpperCase(), entity: "Payment", entityId: data.id, after: data }); return sendSuccess(response, { data });
  })); return router;
}
