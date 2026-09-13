import { Router } from "express";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
export function createAgentRouter({ prisma }) {
  const router = Router(); router.use(requireModule("agents"), requirePermission("agents.read"));
  router.get("/", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.employee.findMany({ where: { companyId: request.tenant.companyId, status: "ACTIVE", deletedAt: null,
    OR: [{ title: { contains: "agent", mode: "insensitive" } }, { roles: { some: { role: { code: "SALES_AGENT" } } } }] }, select: { id: true, name: true, title: true, phone: true, branchId: true, modules: true } }) })));
  return router;
}
