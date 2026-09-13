import { Router } from "express";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { ConflictError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { settingsUpdateSchema } from "./settings.validation.js";
export function createSettingsRouter({ prisma }) {
  const router = Router(); router.use(requireModule("settings"));
  router.get("/", requirePermission("settings.read"), asyncHandler(async (request, response) => {
    const data = await prisma.settings.upsert({ where: { companyId: request.tenant.companyId },
      create: { companyId: request.tenant.companyId, data: {} }, update: {} });
    return sendSuccess(response, { data });
  }));
  router.put("/", requirePermission("settings.update"), validate({ body: settingsUpdateSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.settings.findUnique({ where: { companyId: request.tenant.companyId } });
    if (!current || current.version !== request.validated.body.version) throw new ConflictError("Settings were changed by another session");
    const result = await prisma.settings.updateMany({ where: { companyId: request.tenant.companyId, version: current.version },
      data: { data: request.validated.body.data, version: { increment: 1 } } });
    if (!result.count) throw new ConflictError("Settings were changed by another session");
    const data = await prisma.settings.findUnique({ where: { companyId: request.tenant.companyId } });
    await writeAudit(prisma, request, { action: "UPDATE", entity: "Settings", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  })); return router;
}
