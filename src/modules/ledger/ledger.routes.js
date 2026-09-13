import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
const query = z.object({ page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(), account: z.string().max(80).optional(),
  customerId: z.uuid().optional(), supplierId: z.uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const rateSchema = z.object({ base: z.string().length(3).toUpperCase(), quote: z.string().length(3).toUpperCase(), rate: z.number().positive(),
  source: z.string().trim().max(100).optional(), effectiveAt: z.coerce.date() });
export function createLedgerRouter({ prisma }) {
  const router = Router(); router.use(requireModule("finance")); router.use(requirePermission("finance.read"));
  router.get("/", validate({ query }), asyncHandler(async (request, response) => {
    const page = parsePagination(request.validated.query, { allowedSortFields: ["occurredAt", "createdAt", "amount", "account"] });
    const where = { companyId: request.tenant.companyId }; const q = request.validated.query;
    for (const field of ["account", "customerId", "supplierId"]) if (q[field]) where[field] = q[field];
    if (q.from || q.to) where.occurredAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
    const [data, total] = await prisma.$transaction([prisma.ledgerEntry.findMany({ where, include: { customer: true, supplier: true },
      skip: page.skip, take: page.take, orderBy: { [page.sortBy || "occurredAt"]: page.sortOrder } }), prisma.ledgerEntry.count({ where })]);
    return sendSuccess(response, { data, meta: paginationMeta({ ...page, total }) });
  }));
  router.get("/debts", validate({ query }), asyncHandler(async (request, response) => {
    const q = request.validated.query; const where = { companyId: request.tenant.companyId, outstanding: { gt: 0 } };
    if (q.customerId) where.customerId = q.customerId; if (q.supplierId) where.supplierId = q.supplierId;
    const data = await prisma.debt.findMany({ where, include: { customer: true, supplier: true, invoice: true }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }], take: 1000 });
    const total = data.reduce((sum, row) => sum + Number(row.outstanding), 0);
    return sendSuccess(response, { data, meta: { totalOutstanding: total } });
  }));
  router.get("/cash-transactions", validate({ query }), asyncHandler(async (request, response) => sendSuccess(response, {
    data: await prisma.cashTransaction.findMany({ where: { companyId: request.tenant.companyId }, include: { cashbox: true, shift: true }, orderBy: { createdAt: "desc" }, take: 1000 }),
  })));
  router.get("/currency-rates", asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.currencyRate.findMany({
    where: { companyId: request.tenant.companyId }, orderBy: { effectiveAt: "desc" }, take: 500,
  }) })));
  router.post("/currency-rates", requirePermission("finance.update"), validate({ body: rateSchema }), asyncHandler(async (request, response) => {
    const data = await prisma.currencyRate.create({ data: { ...request.validated.body, companyId: request.tenant.companyId } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "CurrencyRate", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  return router;
}
