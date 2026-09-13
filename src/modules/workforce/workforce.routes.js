import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission, requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
const employeeType = z.object({ code: z.string().trim().min(2).max(40).toUpperCase(), name: z.string().trim().min(2).max(120),
  isSystem: z.boolean().optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() });
const kpi = z.object({ employeeId: z.uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), baseSalary: z.number().min(0),
  target: z.number().min(0).optional(), actual: z.number().min(0).optional(), kpiBonus: z.number().min(0).optional(), salesBonus: z.number().min(0).optional(), penalties: z.number().min(0).optional() });
const salary = z.object({ employeeId: z.uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), baseSalary: z.number().min(0), bonus: z.number().min(0).optional(),
  adjustments: z.number(), penalties: z.number().min(0).optional() });
const params = z.object({ id: z.uuid() });
export function createWorkforceRouter({ prisma }) {
  const router = Router();
  router.use("/employee-types", createTenantCrudRouter({ prisma, model: "employeeType", entity: "EmployeeType", module: "settings",
    createSchema: employeeType, searchFields: ["name", "code"], filterFields: ["status"], softDelete: false }));
  router.get("/kpis", requireModule("reports"), requirePermission("reports.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.employeeKpi.findMany({ where: { companyId: request.tenant.companyId }, include: { employee: { select: { id: true, name: true, title: true } } }, orderBy: [{ month: "desc" }, { createdAt: "desc" }], take: 1000 }) })));
  router.put("/kpis", requireModule("reports"), requireRole("OWNER", "ADMIN"), validate({ body: kpi }), asyncHandler(async (request, response) => {
    const input = request.validated.body; if (!(await prisma.employee.count({ where: { id: input.employeeId, companyId: request.tenant.companyId, deletedAt: null } }))) throw new ValidationError("Employee is invalid");
    const data = await prisma.employeeKpi.upsert({ where: { employeeId_month: { employeeId: input.employeeId, month: input.month } }, create: { ...input, companyId: request.tenant.companyId }, update: input });
    await writeAudit(prisma, request, { action: "UPSERT", entity: "EmployeeKpi", entityId: data.id, after: data }); return sendSuccess(response, { data });
  }));
  router.get("/salary-payments", requireModule("finance"), requirePermission("finance.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.salaryPayment.findMany({ where: { companyId: request.tenant.companyId }, include: { employee: { select: { id: true, name: true, title: true } } }, orderBy: [{ month: "desc" }, { createdAt: "desc" }], take: 1000 }) })));
  router.post("/salary-payments", requireModule("finance"), requirePermission("finance.create"), validate({ body: salary }), asyncHandler(async (request, response) => {
    const input = request.validated.body; if (!(await prisma.employee.count({ where: { id: input.employeeId, companyId: request.tenant.companyId, deletedAt: null } }))) throw new ValidationError("Employee is invalid");
    const total = input.baseSalary + (input.bonus || 0) + input.adjustments - (input.penalties || 0); const data = await prisma.salaryPayment.create({ data: { ...input, companyId: request.tenant.companyId, total } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "SalaryPayment", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.post("/salary-payments/:id/approve", requireModule("finance"), requirePermission("finance.approve"), validate({ params }), asyncHandler(async (request, response) => {
    const current = await prisma.salaryPayment.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId } }); if (!current) throw new NotFoundError("Salary payment not found");
    const data = await prisma.salaryPayment.update({ where: { id: current.id }, data: { status: "COMPLETED", paidAt: new Date() } });
    await writeAudit(prisma, request, { action: "APPROVE", entity: "SalaryPayment", entityId: data.id, before: current, after: data }); return sendSuccess(response, { data });
  })); return router;
}
