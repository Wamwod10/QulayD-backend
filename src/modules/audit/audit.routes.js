import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
const query = z.object({ page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(), action: z.string().max(80).optional(), entity: z.string().max(80).optional(), employeeId: z.uuid().optional(), entityId: z.string().max(100).optional() });
export function createAuditRouter({ prisma }) {
  const router = Router(); router.use(requireModule("settings"), requirePermission("settings.read"));
  router.get("/", validate({ query }), asyncHandler(async (request, response) => {
    const page = parsePagination(request.validated.query, { allowedSortFields: ["createdAt", "action", "entity"] }); const where = { companyId: request.tenant.companyId };
    for (const field of ["action", "entity", "employeeId", "entityId"]) if (request.validated.query[field]) where[field] = request.validated.query[field];
    const [data, total] = await prisma.$transaction([prisma.auditLog.findMany({ where, include: { employee: { select: { id: true, name: true } } }, skip: page.skip, take: page.take,
      orderBy: { [page.sortBy || "createdAt"]: page.sortOrder } }), prisma.auditLog.count({ where })]);
    return sendSuccess(response, { data, meta: paginationMeta({ ...page, total }) });
  })); return router;
}
