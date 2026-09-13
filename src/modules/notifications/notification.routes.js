import { Router } from "express";
import { z } from "zod";
import { requirePermission, requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { NotFoundError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
const params = z.object({ id: z.uuid() });
const query = z.object({ status: z.enum(["UNREAD", "READ", "ARCHIVED"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const create = z.object({ employeeId: z.uuid().nullable().optional(), type: z.enum(["INFO", "SUCCESS", "WARNING", "ERROR", "ACTION_REQUIRED"]).optional(),
  title: z.string().trim().min(2).max(160), message: z.string().trim().min(2).max(2000), module: z.string().max(50).optional(),
  actionUrl: z.string().max(500).optional(), metadata: z.record(z.string(), z.unknown()).optional() });
export function createNotificationRouter({ prisma }) {
  const router = Router();
  router.get("/", validate({ query }), asyncHandler(async (request, response) => {
    const modules = request.auth.user.modules;
    const base = { companyId: request.tenant.companyId, AND: [
      { OR: [{ employeeId: request.auth.employeeId }, { employeeId: null }] },
      { OR: [{ module: null }, { module: { in: modules } }] },
    ] };
    const employeeId = request.auth.employeeId; const requestedStatus = request.validated.query.status;
    const statusWhere = requestedStatus === "UNREAD" ? { OR: [{ employeeId, status: "UNREAD" }, { employeeId: null, status: "UNREAD", reads: { none: { employeeId } } }] }
      : requestedStatus === "READ" ? { OR: [{ employeeId, status: "READ" }, { employeeId: null, reads: { some: { employeeId } } }] }
        : requestedStatus === "ARCHIVED" ? { status: "ARCHIVED" } : {};
    const unreadWhere = { ...base, OR: [{ employeeId, status: "UNREAD" }, { employeeId: null, status: "UNREAD", reads: { none: { employeeId } } }] };
    const [rows, unread] = await Promise.all([prisma.notification.findMany({ where: { ...base, ...statusWhere },
      include: { reads: { where: { employeeId }, select: { readAt: true } } }, orderBy: { createdAt: "desc" }, take: request.validated.query.limit || 50 }),
      prisma.notification.count({ where: unreadWhere })]);
    const data = rows.map(({ reads, ...row }) => ({ ...row, status: row.employeeId ? row.status : reads.length ? "READ" : row.status,
      readAt: row.employeeId ? row.readAt : reads[0]?.readAt || null }));
    return sendSuccess(response, { data, meta: { unread } });
  }));
  router.post("/", requireRole("OWNER", "ADMIN"), requirePermission("settings.create"), validate({ body: create }), asyncHandler(async (request, response) => {
    if (request.validated.body.employeeId) {
      const exists = await prisma.employee.count({ where: { id: request.validated.body.employeeId, companyId: request.tenant.companyId } });
      if (!exists) throw new NotFoundError("Employee not found");
    }
    const data = await prisma.notification.create({ data: { ...request.validated.body, companyId: request.tenant.companyId } });
    await writeAudit(prisma, request, { action: "CREATE", entity: "Notification", entityId: data.id, after: data });
    return sendSuccess(response, { statusCode: 201, data });
  }));
  router.patch("/:id/read", validate({ params }), asyncHandler(async (request, response) => {
    const item = await prisma.notification.findFirst({ where: { id: request.params.id, companyId: request.tenant.companyId,
      OR: [{ employeeId: request.auth.employeeId }, { employeeId: null }] } });
    if (!item || (item.module && !request.auth.user.modules.includes(item.module))) throw new NotFoundError("Notification not found");
    if (item.employeeId) await prisma.notification.update({ where: { id: item.id }, data: { status: "READ", readAt: new Date() } });
    else await prisma.notificationRead.upsert({ where: { notificationId_employeeId: { notificationId: item.id, employeeId: request.auth.employeeId } },
      create: { notificationId: item.id, employeeId: request.auth.employeeId }, update: { readAt: new Date() } });
    return sendSuccess(response, { data: { read: true } });
  }));
  router.post("/read-all", asyncHandler(async (request, response) => {
    const companyId = request.tenant.companyId; const employeeId = request.auth.employeeId; const modules = request.auth.user.modules;
    const broadcast = await prisma.notification.findMany({ where: { companyId, employeeId: null, status: "UNREAD",
      OR: [{ module: null }, { module: { in: modules } }], reads: { none: { employeeId } } }, select: { id: true } });
    const [own, reads] = await prisma.$transaction([
      prisma.notification.updateMany({ where: { companyId, employeeId, status: "UNREAD", OR: [{ module: null }, { module: { in: modules } }] },
        data: { status: "READ", readAt: new Date() } }),
      prisma.notificationRead.createMany({ data: broadcast.map(({ id }) => ({ notificationId: id, employeeId })), skipDuplicates: true }),
    ]); return sendSuccess(response, { data: { updated: own.count + reads.count } });
  })); return router;
}
