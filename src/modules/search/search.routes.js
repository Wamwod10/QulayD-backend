import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middlewares/validate.middleware.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
const query = z.object({ q: z.string().trim().min(2).max(120), limit: z.coerce.number().int().min(1).max(20).optional() });
export function createSearchRouter({ prisma }) {
  const router = Router(); router.get("/", validate({ query }), asyncHandler(async (request, response) => {
    const { q, limit = 8 } = request.validated.query; const companyId = request.tenant.companyId; const modules = new Set(request.auth.user.modules);
    const permissions = new Set(request.auth.user.permissions); const elevated = request.auth.user.roles.some((role) => ["OWNER", "ADMIN"].includes(role));
    const can = (module, permission) => modules.has(module) && (elevated || permissions.has(permission));
    const jobs = [];
    if (can("inventory", "inventory.read")) jobs.push(prisma.product.findMany({ where: { companyId, deletedAt: null, OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q } }, { barcodes: { some: { barcode: { contains: q } } } }] },
      select: { id: true, name: true, sku: true }, take: limit }).then((rows) => rows.map((row) => ({ type: "product", title: row.name, subtitle: row.sku, url: `/products/${row.id}` }))));
    if (can("sales", "sales.read")) jobs.push(prisma.order.findMany({ where: { companyId, OR: [{ number: { contains: q, mode: "insensitive" } }, { customer: { name: { contains: q, mode: "insensitive" } } }] },
      select: { id: true, number: true, customer: { select: { name: true } } }, take: limit }).then((rows) => rows.map((row) => ({ type: "order", title: row.number, subtitle: row.customer?.name, url: `/orders/${row.id}` }))));
    if (can("partners", "partners.read")) jobs.push(Promise.all([
      prisma.customer.findMany({ where: { companyId, deletedAt: null, OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] }, select: { id: true, name: true, phone: true }, take: limit }),
      prisma.supplier.findMany({ where: { companyId, deletedAt: null, OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] }, select: { id: true, name: true, phone: true }, take: limit }),
    ]).then(([customers, suppliers]) => [...customers.map((row) => ({ type: "customer", title: row.name, subtitle: row.phone, url: `/customers/${row.id}` })),
      ...suppliers.map((row) => ({ type: "supplier", title: row.name, subtitle: row.phone, url: `/suppliers/${row.id}` }))]));
    if (can("settings", "settings.read")) jobs.push(prisma.employee.findMany({ where: { companyId, deletedAt: null, OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] },
      select: { id: true, name: true, title: true }, take: limit }).then((rows) => rows.map((row) => ({ type: "employee", title: row.name, subtitle: row.title, url: `/settings/employees/${row.id}` }))));
    return sendSuccess(response, { data: (await Promise.all(jobs)).flat().slice(0, limit * 4) });
  })); return router;
}
