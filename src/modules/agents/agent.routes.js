import { Router } from "express";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler, dayRangeForTimeZone } from "../../shared/utils/index.js";

function isAgentWorkspace(request) {
  const roles = request.auth?.user?.roles || [];
  return !roles.includes("OWNER") && !roles.includes("ADMIN") && (request.auth?.user?.modules || []).includes("agent_workspace");
}

function numeric(value) {
  return Number(value || 0);
}

export function createAgentRouter({ prisma }) {
  const router = Router();
  router.use(requireModule("agents"), requirePermission("agents.read"));

  router.get("/", asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId;
    const settings = await prisma.settings.findUnique({ where: { companyId }, select: { data: true } });
    const timeZone = settings?.data?.company?.timezone || "Asia/Tashkent";
    const { start, end } = dayRangeForTimeZone(new Date(), timeZone);

    const employees = await prisma.employee.findMany({
      where: {
        companyId,
        status: "ACTIVE",
        deletedAt: null,
        ...(isAgentWorkspace(request) ? { id: request.auth.employeeId } : {
          OR: [
            { modules: { some: { module: "agent_workspace", enabled: true } } },
            { title: { contains: "agent", mode: "insensitive" } },
            { roles: { some: { role: { code: "SALES_AGENT" } } } },
          ],
        }),
      },
      select: {
        id: true,
        name: true,
        title: true,
        phone: true,
        branchId: true,
        warehouseId: true,
        status: true,
        modules: true,
      },
      orderBy: { name: "asc" },
    });

    const ids = employees.map((item) => item.id);
    if (!ids.length) return sendSuccess(response, { data: [] });

    const [plans, visits, orders, payments, templates, latestVisits] = await Promise.all([
      prisma.routePlan.findMany({
        where: { companyId, agentId: { in: ids }, planDate: { gte: start, lt: end }, status: { not: "CANCELLED" } },
        include: { stops: { select: { id: true, status: true } }, template: { include: { territory: true } } },
      }),
      prisma.visit.findMany({
        where: { companyId, employeeId: { in: ids }, createdAt: { gte: start, lt: end } },
        select: { id: true, employeeId: true, status: true, checkInAt: true, checkOutAt: true },
      }),
      prisma.order.findMany({
        where: { companyId, agentId: { in: ids }, orderedAt: { gte: start, lt: end }, status: { not: "CANCELLED" } },
        select: { id: true, agentId: true, status: true, total: true },
      }),
      prisma.payment.findMany({
        where: { companyId, employeeId: { in: ids }, confirmedAt: { gte: start, lt: end }, status: "CONFIRMED", customerId: { not: null } },
        select: { id: true, employeeId: true, amount: true },
      }),
      prisma.routeTemplate.findMany({
        where: { companyId, agentId: { in: ids }, status: "ACTIVE" },
        select: { agentId: true, territory: { select: { id: true, name: true, code: true } } },
      }),
      prisma.visit.findMany({
        where: { companyId, employeeId: { in: ids }, latitude: { not: null }, longitude: { not: null } },
        select: { employeeId: true, latitude: true, longitude: true, checkInAt: true, checkOutAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: Math.max(ids.length * 5, 25),
      }),
    ]);

    const planMap = new Map();
    for (const plan of plans) {
      const current = planMap.get(plan.agentId) || { planned: 0, completed: 0, status: null, territories: new Set() };
      current.planned += plan.stops.length;
      current.completed += plan.stops.filter((stop) => stop.status === "COMPLETED").length;
      if (plan.status === "IN_PROGRESS") current.status = "ON_ROUTE";
      else if (!current.status && plan.status === "APPROVED") current.status = "ACTIVE";
      if (plan.template?.territory?.name) current.territories.add(plan.template.territory.name);
      planMap.set(plan.agentId, current);
    }

    const visitMap = new Map();
    for (const visit of visits) {
      const current = visitMap.get(visit.employeeId) || { total: 0, active: false };
      current.total += visit.status === "COMPLETED" ? 1 : 0;
      current.active ||= visit.status === "IN_PROGRESS";
      visitMap.set(visit.employeeId, current);
    }

    const orderMap = new Map();
    for (const order of orders) {
      const current = orderMap.get(order.agentId) || { count: 0, sales: 0 };
      current.count += 1;
      if (order.status === "COMPLETED") current.sales += numeric(order.total);
      orderMap.set(order.agentId, current);
    }

    const paymentMap = new Map();
    for (const payment of payments) paymentMap.set(payment.employeeId, numeric(paymentMap.get(payment.employeeId)) + numeric(payment.amount));

    const territoryMap = new Map();
    for (const template of templates) {
      if (!template.agentId || !template.territory?.name) continue;
      if (!territoryMap.has(template.agentId)) territoryMap.set(template.agentId, new Set());
      territoryMap.get(template.agentId).add(template.territory.name);
    }

    const locationMap = new Map();
    for (const visit of latestVisits) if (!locationMap.has(visit.employeeId)) locationMap.set(visit.employeeId, visit);

    const data = employees.map((employee) => {
      const plan = planMap.get(employee.id);
      const visit = visitMap.get(employee.id);
      const order = orderMap.get(employee.id);
      const latest = locationMap.get(employee.id);
      const territories = new Set([...(territoryMap.get(employee.id) || []), ...(plan?.territories || [])]);
      return {
        ...employee,
        territory: [...territories].join(", ") || "",
        territoryNames: [...territories],
        plannedVisitsToday: plan?.planned || 0,
        visitsToday: visit?.total || 0,
        ordersToday: order?.count || 0,
        salesToday: order?.sales || 0,
        paymentsToday: paymentMap.get(employee.id) || 0,
        activityStatus: visit?.active ? "AT_VISIT" : (plan?.status || "ACTIVE"),
        latitude: latest?.latitude == null ? null : Number(latest.latitude),
        longitude: latest?.longitude == null ? null : Number(latest.longitude),
      };
    });

    return sendSuccess(response, { data });
  }));

  return router;
}
