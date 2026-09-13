import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { writeAudit } from "../../modules/audit/audit.service.js";
import { NotFoundError } from "../errors/index.js";
import { paginationMeta, parsePagination } from "../pagination/index.js";
import { sendSuccess } from "../responses/index.js";
import { asyncHandler } from "../utils/index.js";

const idParams = z.object({ id: z.uuid() });

export function createTenantCrudRouter({
  prisma, model, entity, module, permission = module, createSchema, updateSchema = createSchema.partial(),
  searchFields = ["name"], sortFields = ["createdAt", "updatedAt", "name"], filterFields = [],
  include, softDelete = true, beforeCreate, beforeUpdate,
  tenantRelationFields = {},
}) {
  const router = Router();
  const delegate = prisma[model];
  const moduleGuard = requireModule(module);
  const listQuery = z.object({
    page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.string().max(64).optional(), sortOrder: z.enum(["asc", "desc"]).optional(),
    search: z.string().trim().max(200).optional(),
  }).catchall(z.string().trim().max(200));
  const assertTenantRelations = async (payload, companyId) => {
    for (const [field, relationModel] of Object.entries(tenantRelationFields)) {
      if (!payload[field]) continue;
      const exists = await prisma[relationModel].count({ where: { id: payload[field], companyId } });
      if (!exists) throw new NotFoundError(`${field} does not belong to this company`);
    }
  };

  router.get("/", moduleGuard, requirePermission(`${permission}.read`), validate({ query: listQuery }), asyncHandler(async (request, response) => {
    const page = parsePagination(request.validated.query, { allowedSortFields: sortFields });
    const where = { companyId: request.tenant.companyId, ...(softDelete ? { deletedAt: null } : {}) };
    if (page.search) where.OR = searchFields.map((field) => ({ [field]: { contains: page.search, mode: "insensitive" } }));
    for (const field of filterFields) if (request.validated.query[field]) where[field] = request.validated.query[field];
    const [data, total] = await prisma.$transaction([
      delegate.findMany({ where, include, skip: page.skip, take: page.take,
        orderBy: { [page.sortBy || sortFields[0]]: page.sortOrder } }),
      delegate.count({ where }),
    ]);
    return sendSuccess(response, { data, meta: paginationMeta({ ...page, total }) });
  }));

  router.get("/:id", moduleGuard, requirePermission(`${permission}.read`), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const data = await delegate.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId,
      ...(softDelete ? { deletedAt: null } : {}) }, include });
    if (!data) throw new NotFoundError(`${entity} not found`);
    return sendSuccess(response, { data });
  }));

  router.post("/", moduleGuard, requirePermission(`${permission}.create`), validate({ body: createSchema }), asyncHandler(async (request, response) => {
    let payload = { ...request.validated.body, companyId: request.tenant.companyId };
    await assertTenantRelations(payload, request.tenant.companyId);
    if (beforeCreate) payload = await beforeCreate(payload, request);
    const data = await delegate.create({ data: payload, include });
    await writeAudit(prisma, request, { action: "CREATE", entity, entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));

  router.patch("/:id", moduleGuard, requirePermission(`${permission}.update`), validate({ params: idParams, body: updateSchema }), asyncHandler(async (request, response) => {
    const before = await delegate.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId,
      ...(softDelete ? { deletedAt: null } : {}) } });
    if (!before) throw new NotFoundError(`${entity} not found`);
    let payload = request.validated.body;
    await assertTenantRelations(payload, request.tenant.companyId);
    if (beforeUpdate) payload = await beforeUpdate(payload, request, before);
    const data = await delegate.update({ where: { id: before.id }, data: payload, include });
    await writeAudit(prisma, request, { action: "UPDATE", entity, entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));

  router.delete("/:id", moduleGuard, requirePermission(`${permission}.delete`), validate({ params: idParams }), asyncHandler(async (request, response) => {
    const before = await delegate.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId,
      ...(softDelete ? { deletedAt: null } : {}) } });
    if (!before) throw new NotFoundError(`${entity} not found`);
    const data = softDelete
      ? await delegate.update({ where: { id: before.id }, data: { deletedAt: new Date(), status: "ARCHIVED" } })
      : await delegate.delete({ where: { id: before.id } });
    await writeAudit(prisma, request, { action: "DELETE", entity, entityId: before.id, before });
    return sendSuccess(response, { data });
  }));
  return router;
}
