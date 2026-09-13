import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { createInvoiceService } from "./invoice.service.js";
const params = z.object({ id: z.uuid() });
const query = z.object({ page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), search: z.string().max(200).optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(), status: z.string().max(30).optional(), customerId: z.uuid().optional(), orderId: z.uuid().optional() });
const invoiceSchema = z.object({ customerId: z.uuid().nullable().optional(), orderId: z.uuid().nullable().optional(), currency: z.string().length(3).toUpperCase().optional(),
  discount: z.number().min(0).optional(), dueAt: z.coerce.date().optional(), items: z.array(z.object({ description: z.string().trim().min(1).max(500), productId: z.uuid().nullable().optional(),
    quantity: z.number().positive(), unitPrice: z.number().min(0), tax: z.number().min(0).optional() })).min(1).max(500) });
export function createInvoiceRouter({ prisma }) {
  const router = Router(); const service = createInvoiceService(prisma); router.use(requireModule("finance"));
  router.get("/", requirePermission("finance.read"), validate({ query }), asyncHandler(async (request, response) => { const result = await service.list(request.tenant.companyId, request.validated.query); return sendSuccess(response, result); }));
  router.get("/:id", requirePermission("finance.read"), validate({ params }), asyncHandler(async (request, response) => sendSuccess(response, { data: await service.find(request.tenant.companyId, request.params.id) })));
  router.post("/", requirePermission("finance.create"), validate({ body: invoiceSchema }), asyncHandler(async (request, response) => { const data = await service.create(request.tenant.companyId, request.validated.body);
    await writeAudit(prisma, request, { action: "CREATE", entity: "Invoice", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data }); }));
  for (const [path, action] of [["issue", "issue"], ["void", "void"]]) router.post(`/:id/${path}`, requirePermission("finance.approve"), validate({ params }), asyncHandler(async (request, response) => {
    const data = await service[action](request.tenant.companyId, request.params.id); await writeAudit(prisma, request, { action: path.toUpperCase(), entity: "Invoice", entityId: data.id, after: data }); return sendSuccess(response, { data });
  })); return router;
}
