import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { routePlanSchema, routeTemplateSchema, routeTemplateUpdateSchema, territorySchema } from "./route.validation.js";
const params = z.object({ id: z.uuid() });
async function validateRefs(prisma, companyId, input) {
  const ids = [...new Set(input.stops.map(({ customerId }) => customerId))];
  const [customers, agent, territory] = await Promise.all([prisma.customer.count({ where: { companyId, id: { in: ids }, deletedAt: null } }),
    input.agentId ? prisma.employee.count({ where: { companyId, id: input.agentId, status: "ACTIVE", deletedAt: null } }) : 1,
    input.territoryId ? prisma.territory.count({ where: { companyId, id: input.territoryId } }) : 1]);
  if (customers !== ids.length || agent !== 1 || territory !== 1) throw new ValidationError("Invalid route resource reference");
}
export function createRouteRouter({ prisma }) {
  const router = Router(); router.use(requireModule("routes"));
  router.use("/territories", createTenantCrudRouter({ prisma, model: "territory", entity: "Territory", module: "routes",
    createSchema: territorySchema, searchFields: ["name", "code"], filterFields: ["status"], softDelete: false }));
  router.get("/templates", requirePermission("routes.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.routeTemplate.findMany({ where: { companyId: request.tenant.companyId }, include: { territory: true, agent: { select: { id: true, name: true } }, stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } } }, orderBy: { name: "asc" } }) })));
  router.post("/templates", requirePermission("routes.create"), validate({ body: routeTemplateSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId; await validateRefs(prisma, companyId, input);
    const { stops, ...fields } = input; const data = await prisma.routeTemplate.create({ data: { ...fields, companyId, stops: { create: stops } }, include: { stops: true } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "RouteTemplate", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.patch("/templates/:id", requirePermission("routes.update"), validate({ params, body: routeTemplateUpdateSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.routeTemplate.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId }, include: { stops: true } });
    if (!current) throw new NotFoundError("Route template not found");
    const input = request.validated.body; const refs = { territoryId: input.territoryId === undefined ? current.territoryId : input.territoryId,
      agentId: input.agentId === undefined ? current.agentId : input.agentId, stops: input.stops || current.stops };
    await validateRefs(prisma, request.tenant.companyId, refs); const { stops, ...fields } = input;
    const data = await prisma.routeTemplate.update({ where: { id: current.id }, data: { ...fields, ...(stops ? { stops: { deleteMany: {}, create: stops } } : {}) }, include: { stops: true } });
    await writeAudit(prisma, request, { action: "UPDATE", entity: "RouteTemplate", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  }));
  router.delete("/templates/:id", requirePermission("routes.delete"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.routeTemplate.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } });
    if (!current) throw new NotFoundError("Route template not found");
    const data = await prisma.routeTemplate.update({ where: { id: current.id }, data: { status: "ARCHIVED" } });
    await writeAudit(prisma, request, { action: "DELETE", entity: "RouteTemplate", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  }));
  router.get("/plans", requirePermission("routes.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.routePlan.findMany({ where: { companyId: request.tenant.companyId }, include: { template: true, agent: { select: { id: true, name: true } }, stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } } }, orderBy: { planDate: "desc" }, take: 500 }) })));
  router.post("/plans", requirePermission("routes.create"), validate({ body: routePlanSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body; const companyId = request.tenant.companyId; await validateRefs(prisma, companyId, input);
    if (input.templateId && !(await prisma.routeTemplate.count({ where: { id: input.templateId, companyId } }))) throw new ValidationError("Route template is invalid");
    const { stops, ...fields } = input; const data = await prisma.routePlan.create({ data: { ...fields, companyId, status: "APPROVED", stops: { create: stops } }, include: { stops: true } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "RoutePlan", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  for (const [path, from, status] of [["start", "APPROVED", "IN_PROGRESS"], ["complete", "IN_PROGRESS", "COMPLETED"], ["cancel", "APPROVED", "CANCELLED"]]) {
    router.post(`/plans/:id/${path}`, requirePermission("routes.update"), validate({ params }), asyncHandler(async (request, response) => {
      const current = await prisma.routePlan.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } });
      if (!current) throw new NotFoundError("Route plan not found");
      if (current.status !== from) throw new ConflictError(`Route plan cannot be ${path}ed`);
      const data = await prisma.routePlan.update({ where: { id: current.id }, data: { status } });
      await writeAudit(prisma, request, { action: path.toUpperCase(), entity: "RoutePlan", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
    }));
  }
  return router;
}
