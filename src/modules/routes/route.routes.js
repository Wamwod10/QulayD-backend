import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requireAnyPermission, requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { routePlanSchema, routeTemplateSchema, routeTemplateUpdateSchema, territorySchema } from "./route.validation.js";

const params = z.object({ id: z.uuid() });

function isPrivileged(request) {
  const roles = request.auth?.user?.roles || [];
  return roles.includes("OWNER") || roles.includes("ADMIN");
}

function isAgentWorkspace(request) {
  return !isPrivileged(request) && (request.auth?.user?.modules || []).includes("agent_workspace");
}

function agentTemplateScope(request) {
  return isAgentWorkspace(request) ? { OR: [{ agentId: request.auth.employeeId }, { agentId: null }] } : {};
}

function agentPlanScope(request) {
  return isAgentWorkspace(request) ? { agentId: request.auth.employeeId } : {};
}

function assertAgentPlanAccess(request, plan) {
  if (isAgentWorkspace(request) && plan.agentId !== request.auth.employeeId) {
    throw new AuthorizationError("Agent faqat o‘z marshruti bilan ishlashi mumkin");
  }
}

async function validateRefs(prisma, companyId, input) {
  const inputStops = input.stops || [];
  const ids = [...new Set(inputStops.map(({ customerId }) => customerId))];
  const [customers, agent, territory] = await Promise.all([
    ids.length ? prisma.customer.count({ where: { companyId, id: { in: ids }, deletedAt: null, status: "ACTIVE" } }) : 0,
    input.agentId ? prisma.employee.count({ where: {
      companyId,
      id: input.agentId,
      status: "ACTIVE",
      deletedAt: null,
      modules: { some: { module: "agent_workspace", enabled: true } },
    } }) : 1,
    input.territoryId ? prisma.territory.count({ where: { companyId, id: input.territoryId, status: "ACTIVE" } }) : 1,
  ]);
  if (customers !== ids.length || agent !== 1 || territory !== 1) throw new ValidationError("Invalid route resource reference");
}

function normalizeStops(rows = []) {
  return rows
    .map((row, index) => ({ customerId: row.customerId, stopOrder: Number(row.stopOrder || index + 1) }))
    .sort((a, b) => a.stopOrder - b.stopOrder);
}

export function createRouteRouter({ prisma }) {
  const router = Router();
  router.use(requireModule("routes"));

  router.delete("/territories/:id", requirePermission("routes.delete"), validate({ params }), asyncHandler(async (request, response) => {
    const before = await prisma.territory.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } });
    if (!before) throw new NotFoundError("Territory not found");
    const data = await prisma.territory.update({ where: { id: before.id }, data: { status: "INACTIVE" } });
    await writeAudit(prisma, request, { action: "ARCHIVE", entity: "Territory", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));

  router.use("/territories", createTenantCrudRouter({
    prisma,
    model: "territory",
    entity: "Territory",
    module: "routes",
    createSchema: territorySchema,
    searchFields: ["name", "code"],
    filterFields: ["status"],
    softDelete: false,
  }));

  router.get("/templates", requirePermission("routes.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.routeTemplate.findMany({
      where: { companyId: request.tenant.companyId, ...agentTemplateScope(request) },
      include: {
        territory: true,
        agent: { select: { id: true, name: true } },
        stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } },
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
  })));

  router.post("/templates", requirePermission("routes.create"), validate({ body: routeTemplateSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body;
    const companyId = request.tenant.companyId;
    const scopedInput = isAgentWorkspace(request) ? { ...input, agentId: request.auth.employeeId } : input;
    await validateRefs(prisma, companyId, scopedInput);
    const { stops, ...fields } = scopedInput;
    const data = await prisma.routeTemplate.create({
      data: { ...fields, companyId, stops: { create: normalizeStops(stops) } },
      include: { territory: true, agent: { select: { id: true, name: true } }, stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } } },
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "RouteTemplate", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));

  router.patch("/templates/:id", requirePermission("routes.update"), validate({ params, body: routeTemplateUpdateSchema }), asyncHandler(async (request, response) => {
    const current = await prisma.routeTemplate.findFirst({
      where: { id: request.params.id, companyId: request.tenant.companyId, ...agentTemplateScope(request) },
      include: { stops: true },
    });
    if (!current) throw new NotFoundError("Route template not found");
    const rawInput = request.validated.body;
    const input = isAgentWorkspace(request) ? { ...rawInput, agentId: request.auth.employeeId } : rawInput;
    const refs = {
      territoryId: input.territoryId === undefined ? current.territoryId : input.territoryId,
      agentId: input.agentId === undefined ? current.agentId : input.agentId,
      stops: input.stops || current.stops,
    };
    await validateRefs(prisma, request.tenant.companyId, refs);
    const { stops, ...fields } = input;
    const data = await prisma.routeTemplate.update({
      where: { id: current.id },
      data: { ...fields, ...(stops ? { stops: { deleteMany: {}, create: normalizeStops(stops) } } : {}) },
      include: { territory: true, agent: { select: { id: true, name: true } }, stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } } },
    });
    await writeAudit(prisma, request, { action: "UPDATE", entity: "RouteTemplate", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  }));

  router.delete("/templates/:id", requirePermission("routes.delete"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.routeTemplate.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId, ...agentTemplateScope(request) } });
    if (!current) throw new NotFoundError("Route template not found");
    const data = await prisma.routeTemplate.update({ where: { id: current.id }, data: { status: "ARCHIVED" } });
    await writeAudit(prisma, request, { action: "DELETE", entity: "RouteTemplate", entityId: data.id, before: current, after: data });
    return sendSuccess(response, { data });
  }));

  router.get("/plans", requirePermission("routes.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.routePlan.findMany({
      where: { companyId: request.tenant.companyId, ...agentPlanScope(request) },
      include: {
        template: { include: { territory: true } },
        agent: { select: { id: true, name: true } },
        stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } },
      },
      orderBy: { planDate: "desc" },
      take: 500,
    }),
  })));

  router.post("/plans", requirePermission("routes.create"), validate({ body: routePlanSchema }), asyncHandler(async (request, response) => {
    const input = request.validated.body;
    const companyId = request.tenant.companyId;
    let template = null;
    let agentId = input.agentId || null;
    let planStops = input.stops || [];
    let name = input.name || "";

    if (input.templateId) {
      template = await prisma.routeTemplate.findFirst({
        where: { id: input.templateId, companyId, status: "ACTIVE", ...agentTemplateScope(request) },
        include: { stops: { orderBy: { stopOrder: "asc" } } },
      });
      if (!template) throw new ValidationError("Route template is invalid");
      agentId = template.agentId || agentId;
      planStops = template.stops.map(({ customerId, stopOrder }) => ({ customerId, stopOrder }));
      name = name || template.name;
    }

    if (isAgentWorkspace(request)) agentId = request.auth.employeeId;
    if (!agentId) throw new ValidationError("Route plan agent is required");
    if (!planStops.length) throw new ValidationError("Route plan must contain at least one customer stop");

    await validateRefs(prisma, companyId, { agentId, stops: planStops });
    if (template?.agentId && agentId !== template.agentId) throw new ValidationError("Route plan agent must match the selected template");

    const dayStart = new Date(input.planDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const duplicate = await prisma.routePlan.count({
      where: { companyId, agentId, planDate: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELLED" } },
    });
    if (duplicate) throw new ConflictError("This agent already has a route plan for the selected date");

    const data = await prisma.routePlan.create({
      data: {
        companyId,
        templateId: template?.id || null,
        agentId,
        name: name || `Marshrut · ${input.planDate.toISOString().slice(0, 10)}`,
        planDate: input.planDate,
        status: "APPROVED",
        stops: { create: normalizeStops(planStops) },
      },
      include: { template: { include: { territory: true } }, agent: { select: { id: true, name: true } }, stops: { include: { customer: true }, orderBy: { stopOrder: "asc" } } },
    });
    await writeAudit(prisma, request, { action: "CREATE", entity: "RoutePlan", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));

  for (const [path, from, status] of [["start", "APPROVED", "IN_PROGRESS"], ["complete", "IN_PROGRESS", "COMPLETED"], ["cancel", "APPROVED", "CANCELLED"]]) {
    router.post(`/plans/:id/${path}`, requireAnyPermission("routes.update", "agents.update"), validate({ params }), asyncHandler(async (request, response) => {
      const current = await prisma.routePlan.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId, ...agentPlanScope(request) } });
      if (!current) throw new NotFoundError("Route plan not found");
      assertAgentPlanAccess(request, current);
      if (current.status !== from) throw new ConflictError(`Route plan cannot be ${path}ed`);
      if (path === "complete") {
        const remaining = await prisma.routePlanStop.count({ where: { routePlanId: current.id, status: { notIn: ["COMPLETED", "CANCELLED"] } } });
        if (remaining) throw new ConflictError("Route plan has unfinished customer stops", { remaining });
      }
      const data = await prisma.routePlan.update({ where: { id: current.id }, data: { status } });
      await writeAudit(prisma, request, { action: path.toUpperCase(), entity: "RoutePlan", entityId: data.id, before: current, after: data });
      return sendSuccess(response, { data });
    }));
  }

  return router;
}
