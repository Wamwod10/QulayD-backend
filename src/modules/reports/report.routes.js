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
    const [summary, byChannel, topProducts] = await Promise.all([
      prisma.order.aggregate({ where, _sum: { total: true, discount: true, tax: true }, _count: true, _avg: { total: true } }),
      prisma.order.groupBy({ by: ["channel"], where, _sum: { total: true }, _count: true, orderBy: { _sum: { total: "desc" } } }),
      prisma.orderItem.groupBy({ by: ["productId"], where: { order: where }, _sum: { quantity: true, total: true }, orderBy: { _sum: { total: "desc" } }, take: 20 }),
    ]);
    const products = await prisma.product.findMany({ where: { id: { in: topProducts.map(({ productId }) => productId) }, companyId }, select: { id: true, name: true, sku: true } });
    const names = new Map(products.map((row) => [row.id, row]));
    return sendSuccess(response, { data: { summary, byChannel, topProducts: topProducts.map((row) => ({ ...row, product: names.get(row.productId) })) } });
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
      prisma.invoice.aggregate({ where: { companyId, status: { not: "VOID" }, ...(Object.keys(range).length ? { createdAt: range } : {}) }, _sum: { total: true, paid: true }, _count: true }),
      prisma.debt.aggregate({ where: { companyId, outstanding: { gt: 0 } }, _sum: { outstanding: true }, _count: true }),
      prisma.cashbox.aggregate({ where: { companyId, status: "ACTIVE" }, _sum: { balance: true } }),
    ]); return sendSuccess(response, { data: { payments, invoices, debts, cashBalance: cash._sum.balance || 0 } });
  })); return router;
}
