import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler, dayRangeForTimeZone } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { visitCreateSchema, visitLocationSchema } from "./visit.validation.js";

const params = z.object({ id: z.uuid() });

function isAgentWorkspace(request) {
  const roles = request.auth?.user?.roles || [];
  const privileged = roles.includes("OWNER") || roles.includes("ADMIN");
  return !privileged && (request.auth?.user?.modules || []).includes("agent_workspace");
}

function visitScope(request) {
  return {
    companyId: request.tenant.companyId,
    ...(isAgentWorkspace(request) ? { employeeId: request.auth.employeeId } : {}),
  };
}

function assertSelfVisit(request, employeeId) {
  if (isAgentWorkspace(request) && employeeId !== request.auth.employeeId) {
    throw new AuthorizationError("Agent faqat o‘z tashrifi bilan ishlashi mumkin");
  }
}

async function getCompanySettings(client, companyId) {
  const settings = await client.settings.findUnique({ where: { companyId }, select: { data: true } });
  return settings?.data || {};
}

async function findCurrentRoutePlan(client, companyId, employeeId, customerId, settings) {
  const timeZone = settings?.company?.timezone || "Asia/Tashkent";
  const { start, end } = dayRangeForTimeZone(new Date(), timeZone);
  return client.routePlan.findFirst({
    where: {
      companyId,
      agentId: employeeId,
      planDate: { gte: start, lt: end },
      status: { in: ["APPROVED", "IN_PROGRESS"] },
      stops: { some: { customerId } },
    },
    include: { stops: { where: { customerId }, take: 1 } },
    orderBy: { createdAt: "desc" },
  });
}

async function assertRoutePolicy(client, request, employeeId, customerId, settings) {
  if (!isAgentWorkspace(request) || settings?.agents?.allowOutsideRoute !== false) return null;
  const plan = await findCurrentRoutePlan(client, request.tenant.companyId, employeeId, customerId, settings);
  if (!plan) throw new AuthorizationError("Bu mijoz bugungi tasdiqlangan marshrutingizga kiritilmagan");
  return plan;
}

function distanceMeters(a, b) {
  const values = [a?.latitude, a?.longitude, b?.latitude, b?.longitude].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [latA, lngA, latB, lngB] = values;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function assertLocationPolicy(input, customer, settings, phase) {
  const agents = settings?.agents || {};
  const required = phase === "check-in" ? agents.requireGpsCheckIn === true : agents.requireGpsCheckOut === true;
  const hasLocation = input.latitude !== undefined && input.longitude !== undefined;
  if (required && !hasLocation) {
    throw new ValidationError(phase === "check-in" ? "Tashrifni boshlash uchun GPS joylashuvi majburiy" : "Tashrifni yakunlash uchun GPS joylashuvi majburiy");
  }
  if (!hasLocation) return;
  const distance = distanceMeters(input, customer);
  const limit = Number(settings?.maps?.geofenceMeters || 250);
  if (distance != null && Number.isFinite(limit) && limit > 0 && distance > limit) {
    throw new ValidationError(`Mijoz joylashuvidan ${Math.round(distance)} m uzoqdasiz. Ruxsat etilgan masofa ${Math.round(limit)} m`);
  }
}

async function syncRouteStopOnCheckIn(tx, companyId, employeeId, customerId, settings) {
  const plan = await findCurrentRoutePlan(tx, companyId, employeeId, customerId, settings);
  if (!plan) return;
  const stop = plan.stops[0];
  if (stop && stop.status !== "COMPLETED") {
    await tx.routePlanStop.update({ where: { id: stop.id }, data: { status: "IN_PROGRESS" } });
  }
  if (plan.status === "APPROVED") await tx.routePlan.update({ where: { id: plan.id }, data: { status: "IN_PROGRESS" } });
}

async function syncRouteStopOnCheckOut(tx, companyId, employeeId, customerId, settings) {
  const plan = await findCurrentRoutePlan(tx, companyId, employeeId, customerId, settings);
  if (!plan) return;
  const stop = plan.stops[0];
  if (stop) await tx.routePlanStop.update({ where: { id: stop.id }, data: { status: "COMPLETED", visitedAt: new Date() } });
  const remaining = await tx.routePlanStop.count({ where: { routePlanId: plan.id, status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  await tx.routePlan.update({ where: { id: plan.id }, data: { status: remaining === 0 ? "COMPLETED" : "IN_PROGRESS" } });
}

export function createVisitRouter({ prisma }) {
  const router = Router();
  router.use(requireModule("agents"));

  router.get("/", requirePermission("agents.read"), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.visit.findMany({
      where: visitScope(request),
      include: { employee: { select: { id: true, name: true } }, customer: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  })));

  router.post("/", requirePermission("agents.create"), validate({ body: visitCreateSchema }), asyncHandler(async (request, response) => {
    const requestedEmployeeId = request.validated.body.employeeId || request.auth.employeeId;
    assertSelfVisit(request, requestedEmployeeId);
    const employeeId = isAgentWorkspace(request) ? request.auth.employeeId : requestedEmployeeId;
    const companyId = request.tenant.companyId;
    const [employee, customer, settings] = await Promise.all([
      prisma.employee.findFirst({
        where: { id: employeeId, companyId, status: "ACTIVE", deletedAt: null, modules: { some: { module: "agent_workspace", enabled: true } } },
        select: { id: true },
      }),
      prisma.customer.findFirst({ where: { id: request.validated.body.customerId, companyId, deletedAt: null, status: "ACTIVE" }, select: { id: true } }),
      getCompanySettings(prisma, companyId),
    ]);
    if (!employee || !customer) throw new ValidationError("Invalid visit resource reference");
    await assertRoutePolicy(prisma, request, employeeId, customer.id, settings);

    const timeZone = settings?.company?.timezone || "Asia/Tashkent";
    const { start, end } = dayRangeForTimeZone(new Date(), timeZone);
    const existing = await prisma.visit.findFirst({
      where: { companyId, employeeId, customerId: customer.id, createdAt: { gte: start, lt: end }, status: { in: ["PLANNED", "IN_PROGRESS"] } },
      select: { id: true },
    });
    if (existing) throw new ConflictError("Bu mijoz uchun faol tashrif allaqachon mavjud");

    const data = await prisma.visit.create({ data: { ...request.validated.body, employeeId, companyId } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "Visit", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));

  router.post("/:id/check-in", requirePermission("agents.update"), validate({ params, body: visitLocationSchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const settings = await getCompanySettings(prisma, companyId);
    const before = await prisma.visit.findFirst({ where: { id: request.params.id, ...visitScope(request) } });
    if (!before) throw new NotFoundError("Visit not found");
    assertSelfVisit(request, before.employeeId);
    if (before.status !== "PLANNED") throw new ConflictError("Visit cannot be started");
    await assertRoutePolicy(prisma, request, before.employeeId, before.customerId, settings);
    const customer = await prisma.customer.findFirst({ where: { id: before.customerId, companyId, deletedAt: null } });
    if (!customer) throw new NotFoundError("Customer not found");
    assertLocationPolicy(request.validated.body, customer, settings, "check-in");
    const activeOtherVisit = await prisma.visit.count({ where: { companyId, employeeId: before.employeeId, status: "IN_PROGRESS", id: { not: before.id } } });
    if (activeOtherVisit) throw new ConflictError("Avvalgi faol tashrifni yakunlang");

    const data = await prisma.$transaction(async (tx) => {
      const next = await tx.visit.update({ where: { id: before.id }, data: { ...request.validated.body, status: "IN_PROGRESS", checkInAt: new Date() } });
      await syncRouteStopOnCheckIn(tx, companyId, before.employeeId, before.customerId, settings);
      return next;
    });
    await writeAudit(prisma, request, { action: "CHECK_IN", entity: "Visit", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));

  router.post("/:id/check-out", requirePermission("agents.update"), validate({ params, body: visitLocationSchema }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const settings = await getCompanySettings(prisma, companyId);
    const before = await prisma.visit.findFirst({ where: { id: request.params.id, ...visitScope(request) } });
    if (!before) throw new NotFoundError("Visit not found");
    assertSelfVisit(request, before.employeeId);
    if (before.status !== "IN_PROGRESS") throw new ConflictError("Visit is not active");
    const customer = await prisma.customer.findFirst({ where: { id: before.customerId, companyId, deletedAt: null } });
    if (!customer) throw new NotFoundError("Customer not found");
    assertLocationPolicy(request.validated.body, customer, settings, "check-out");

    const data = await prisma.$transaction(async (tx) => {
      const next = await tx.visit.update({ where: { id: before.id }, data: { ...request.validated.body, status: "COMPLETED", checkOutAt: new Date() } });
      await syncRouteStopOnCheckOut(tx, companyId, before.employeeId, before.customerId, settings);
      return next;
    });
    await writeAudit(prisma, request, { action: "CHECK_OUT", entity: "Visit", entityId: data.id, before, after: data });
    return sendSuccess(response, { data });
  }));

  return router;
}
