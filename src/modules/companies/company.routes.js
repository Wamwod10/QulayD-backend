import { Router } from "express";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { writeAudit } from "../audit/audit.service.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { companyUpdateSchema } from "./company.validation.js";
export function createCompanyRouter({ prisma }) {
  const router = Router(); router.use(requireModule("settings"));
  router.get("/current", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.company.findUnique({ where: { id: request.tenant.companyId } }) })));
  router.patch("/current", requireRole("OWNER", "ADMIN"), validate({ body: companyUpdateSchema }), asyncHandler(async (request, response) => {
    const before = await prisma.company.findUnique({ where: { id: request.tenant.companyId } });
    const data = await prisma.company.update({ where: { id: request.tenant.companyId }, data: request.validated.body });
    await writeAudit(prisma, request, { action: "UPDATE", entity: "Company", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  })); return router;
}
