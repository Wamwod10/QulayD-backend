import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { createReturnService } from "./return.service.js";
import { returnCreateSchema, returnRefundSchema } from "./return.validation.js";
const params = z.object({ id: z.uuid() });
export function createReturnRouter({ prisma }) {
  const router = Router(); const service = createReturnService(prisma); router.use(requireModule("sales"));
  router.get("/", requirePermission("sales.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await service.list(request.tenant.companyId) })));
  router.post("/", requirePermission("sales.create"), validate({ body: returnCreateSchema }), asyncHandler(async (request, response) => { const data = await service.create(request.tenant.companyId, request.validated.body);
    await writeAudit(prisma, request, { action: "CREATE", entity: "Return", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data }); }));
  for (const [path, action, permission, schema] of [["approve", "approve", "sales.approve"], ["receive", "receive", "inventory.update"], ["refund", "refund", "finance.approve", returnRefundSchema]]) {
    router.post(`/:id/${path}`, requirePermission(permission), validate({ params, ...(schema ? { body: schema } : {}) }), asyncHandler(async (request, response) => {
      const args = action === "approve" ? [request.tenant.companyId, request.params.id] : action === "receive" ? [request.tenant.companyId, request.auth.employeeId, request.params.id]
        : [request.tenant.companyId, request.auth.employeeId, request.params.id, request.validated.body]; const result = await service[action](...args); const data = result.data || result;
      await writeAudit(prisma, request, { action: path.toUpperCase(), entity: "Return", entityId: data.id, after: data }); return sendSuccess(response, { data: result });
    }));
  } return router;
}
