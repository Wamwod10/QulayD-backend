import { Router } from "express";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
export function createDashboardRouter({ prisma }) {
  const router = Router(); router.use(requireModule("dashboard"), requirePermission("dashboard.read"));
  router.get("/", asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const [sales, orderCount, customers, products, lowStock, receivables, unread] = await Promise.all([
      prisma.order.aggregate({ where: { companyId, status: "COMPLETED", completedAt: { gte: start } }, _sum: { total: true } }),
      prisma.order.count({ where: { companyId, orderedAt: { gte: start } } }), prisma.customer.count({ where: { companyId, deletedAt: null } }),
      prisma.product.count({ where: { companyId, deletedAt: null, status: "ACTIVE" } }),
      prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "WarehouseStock" s JOIN "Product" p ON p.id=s."productId" WHERE s."companyId"=${companyId}::uuid AND (s."onHand"-s.reserved)<=p."minStock"`,
      prisma.debt.aggregate({ where: { companyId, outstanding: { gt: 0 } }, _sum: { outstanding: true } }),
      prisma.notification.count({ where: { companyId, status: "UNREAD", OR: [
        { employeeId: request.auth.employeeId },
        { employeeId: null, reads: { none: { employeeId: request.auth.employeeId } } },
      ], AND: [{ OR: [{ module: null }, { module: { in: request.auth.user.modules } }] }] } }),
    ]);
    return sendSuccess(response, { data: { todaySales: sales._sum.total || 0, todayOrders: orderCount, customers, products,
      lowStock: lowStock[0]?.count || 0, receivables: receivables._sum.outstanding || 0, unreadNotifications: unread } });
  })); return router;
}
