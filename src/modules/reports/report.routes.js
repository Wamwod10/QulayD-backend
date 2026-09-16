import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
const query = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), warehouseId: z.uuid().optional() });
const period = (value) => ({ ...(value.from ? { gte: value.from } : {}), ...(value.to ? { lte: value.to } : {}) });
export function createReportRouter({ prisma }) {
  const router = Router(); router.use(requireModule("reports"), requirePermission("reports.read"));
  router.get("/sales", validate({ query }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const where = { companyId, status: "COMPLETED" }; const range = period(request.validated.query);
    if (Object.keys(range).length) where.completedAt = range; if (request.validated.query.warehouseId) where.warehouseId = request.validated.query.warehouseId;
    const [summary, byChannel, topProducts, confirmedOrders] = await Promise.all([
      prisma.order.aggregate({ where, _sum: { total: true, discount: true, tax: true }, _count: true, _avg: { total: true } }),
      prisma.order.groupBy({ by: ["channel"], where, _sum: { total: true }, _count: true, orderBy: { _sum: { total: "desc" } } }),
      prisma.orderItem.groupBy({ by: ["productId"], where: { order: where }, _sum: { quantity: true, total: true }, orderBy: { _sum: { total: "desc" } }, take: 20 }),
      prisma.order.count({ where: { companyId, status: "CONFIRMED", ...(request.validated.query.warehouseId ? { warehouseId: request.validated.query.warehouseId } : {}) } }),
    ]);
    const products = await prisma.product.findMany({ where: { id: { in: topProducts.map(({ productId }) => productId) }, companyId }, select: { id: true, name: true, sku: true } });
    const names = new Map(products.map((row) => [row.id, row]));
    return sendSuccess(response, { data: { summary: { ...summary, operational: { confirmedOrders } }, byChannel, topProducts: topProducts.map((row) => ({ ...row, product: names.get(row.productId) })) } });
  }));
  router.get("/inventory", validate({ query }), asyncHandler(async (request, response) => {
    const where = { companyId: request.tenant.companyId, stockKey: "BASE" }; if (request.validated.query.warehouseId) where.warehouseId = request.validated.query.warehouseId;
    const [stocks, movementCount] = await Promise.all([prisma.warehouseStock.findMany({ where, include: { product: true, warehouse: true } }),
      prisma.stockMovement.count({ where: { companyId: request.tenant.companyId, ...(Object.keys(period(request.validated.query)).length ? { createdAt: period(request.validated.query) } : {}) } })]);
    const summary = stocks.reduce((acc, row) => { acc.onHand += Number(row.onHand); acc.reserved += Number(row.reserved);
      acc.value += Number(row.onHand) * Number(row.product.costPrice); if (Number(row.onHand) - Number(row.reserved) <= Number(row.product.minStock)) acc.lowStock += 1; return acc; },
    { onHand: 0, reserved: 0, available: 0, value: 0, lowStock: 0, movementCount }); summary.available = summary.onHand - summary.reserved;
    return sendSuccess(response, { data: { summary, stocks } });
  }));
  router.get("/finance", validate({ query }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const range = period(request.validated.query);
    const [payments, invoices, debts, cash] = await Promise.all([
      prisma.payment.aggregate({ where: { companyId, status: "CONFIRMED", ...(Object.keys(range).length ? { confirmedAt: range } : {}) }, _sum: { amount: true }, _count: true }),
      prisma.invoice.aggregate({ where: { companyId, status: { not: "VOID" }, ...(Object.keys(range).length ? { createdAt: range } : {}) }, _sum: { total: true, paid: true, credited: true }, _count: true }),
      prisma.debt.aggregate({ where: { companyId, outstanding: { gt: 0 } }, _sum: { outstanding: true }, _count: true }),
      prisma.cashbox.aggregate({ where: { companyId, status: "ACTIVE" }, _sum: { balance: true } }),
    ]); return sendSuccess(response, { data: { payments, invoices, debts, cashBalance: cash._sum.balance || 0 } });
  }));

  router.get("/debt", validate({ query }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const range = period(request.validated.query);
    const debts = await prisma.debt.findMany({ where: { companyId, customerId: { not: null }, outstanding: { gt: 0 },
      ...(Object.keys(range).length ? { createdAt: range } : {}) }, include: { customer: true }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] });
    const grouped = new Map(); const now = new Date();
    for (const debt of debts) {
      const key = debt.customerId; const current = grouped.get(key) || { customerId: key, customer: debt.customer, debt: 0, overdue: 0, invoices: 0 };
      const amount = Number(debt.outstanding || 0); current.debt += amount; current.invoices += 1;
      if (debt.dueAt && debt.dueAt < now) current.overdue += amount;
      grouped.set(key, current);
    }
    const agentIds = [...new Set([...grouped.values()].map((row) => row.customer?.metadata?.agentId).filter(Boolean))];
    const agents = agentIds.length ? await prisma.employee.findMany({ where: { companyId, id: { in: agentIds }, deletedAt: null }, select: { id: true, name: true } }) : [];
    const agentNames = new Map(agents.map((row) => [row.id, row.name]));
    const rows = [...grouped.values()].map((row) => ({ ...row, debt: Math.round(row.debt * 100) / 100,
      overdue: Math.round(row.overdue * 100) / 100, creditLimit: Number(row.customer?.creditLimit || 0),
      agentName: agentNames.get(row.customer?.metadata?.agentId) || "—",
      remainingLimit: Math.max(0, Number(row.customer?.creditLimit || 0) - row.debt),
      debtStatus: Number(row.customer?.creditLimit || 0) > 0 && row.debt > Number(row.customer.creditLimit) ? "OVER_LIMIT" : row.overdue > 0 ? "OVERDUE" : "OPEN" }));
    const aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const debt of debts) {
      const amount = Number(debt.outstanding || 0); const anchor = debt.dueAt || debt.createdAt;
      const days = Math.max(0, Math.floor((now.getTime() - new Date(anchor).getTime()) / 86400000));
      if (days <= 30) aging.d0_30 += amount; else if (days <= 60) aging.d31_60 += amount; else if (days <= 90) aging.d61_90 += amount; else aging.d90_plus += amount;
    }
    return sendSuccess(response, { data: { summary: { totalDebt: rows.reduce((sum, row) => sum + row.debt, 0),
      totalOverdue: rows.reduce((sum, row) => sum + row.overdue, 0), debtorCount: rows.length, aging }, rows } });
  }));

  router.get("/agents", validate({ query }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const range = period(request.validated.query);
    const agents = await prisma.employee.findMany({ where: { companyId, status: "ACTIVE", deletedAt: null,
      OR: [{ modules: { some: { module: "agent_workspace", enabled: true } } }, { roles: { some: { role: { code: "AGENT" } } } }] },
      select: { id: true, name: true, title: true, phone: true, status: true } });
    const agentIds = agents.map(({ id }) => id);
    if (!agentIds.length) return sendSuccess(response, { data: { summary: { sales: 0, visits: 0, orders: 0 }, rows: [] } });
    const [visits, orders, sales, templates] = await Promise.all([
      prisma.visit.groupBy({ by: ["employeeId"], where: { companyId, employeeId: { in: agentIds }, ...(Object.keys(range).length ? { createdAt: range } : {}) }, _count: true }),
      prisma.order.groupBy({ by: ["agentId"], where: { companyId, agentId: { in: agentIds }, status: { notIn: ["CANCELLED"] }, ...(Object.keys(range).length ? { orderedAt: range } : {}) }, _count: true }),
      prisma.order.groupBy({ by: ["agentId"], where: { companyId, agentId: { in: agentIds }, status: "COMPLETED", ...(Object.keys(range).length ? { completedAt: range } : {}) }, _sum: { total: true }, _count: true }),
      prisma.routeTemplate.findMany({ where: { companyId, agentId: { in: agentIds }, status: "ACTIVE" }, include: { territory: true } }),
    ]);
    const visitMap = new Map(visits.map((row) => [row.employeeId, row._count]));
    const orderMap = new Map(orders.map((row) => [row.agentId, row._count]));
    const salesMap = new Map(sales.map((row) => [row.agentId, { count: row._count, amount: Number(row._sum.total || 0) }]));
    const territoryMap = new Map(); for (const template of templates) if (template.agentId && template.territory?.name && !territoryMap.has(template.agentId)) territoryMap.set(template.agentId, template.territory.name);
    const rows = agents.map((agent) => { const visitCount = visitMap.get(agent.id) || 0; const orderCount = orderMap.get(agent.id) || 0; const sold = salesMap.get(agent.id) || { count: 0, amount: 0 };
      return { ...agent, territory: territoryMap.get(agent.id) || "—", visits: visitCount, orders: orderCount, completedOrders: sold.count,
        conversion: visitCount ? Math.round((orderCount / visitCount) * 100) : 0, sales: sold.amount }; });
    return sendSuccess(response, { data: { summary: { sales: rows.reduce((sum, row) => sum + row.sales, 0), visits: rows.reduce((sum, row) => sum + row.visits, 0),
      orders: rows.reduce((sum, row) => sum + row.orders, 0) }, rows } });
  }));

  router.get("/delivery", validate({ query }), asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const range = period(request.validated.query);
    const where = { companyId, ...(Object.keys(range).length ? { createdAt: range } : {}) };
    const rows = await prisma.delivery.findMany({ where, include: { customer: true, order: { select: { id: true, number: true, total: true } },
      trip: { include: { driver: { select: { id: true, name: true } } } } }, orderBy: { createdAt: "desc" }, take: 2000 });
    const delivered = rows.filter((row) => row.status === "DELIVERED").length;
    const failed = rows.filter((row) => row.status === "FAILED").length;
    const partial = rows.filter((row) => row.status === "PARTIALLY_DELIVERED").length;
    const terminal = delivered + failed;
    return sendSuccess(response, { data: { summary: { delivered, failed, partial, total: rows.length,
      successRate: terminal ? Math.round((delivered / terminal) * 100) : 100 }, rows: rows.map((row) => ({ ...row,
        total: Number(row.order?.total || 0), orderNumber: row.order?.number || "—", customerName: row.customer?.name || "—",
        tripNumber: row.trip?.number || "—", driverName: row.trip?.driver?.name || "—" })) } });
  }));
  return router;
}
