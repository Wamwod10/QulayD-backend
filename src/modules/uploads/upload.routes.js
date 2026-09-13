import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireAnyPermission, requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { ValidationError } from "../../shared/errors/index.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { writeAudit } from "../audit/audit.service.js";
import { processImage, removeImage } from "./upload.service.js";
const accepted = new Set(["image/jpeg", "image/png", "image/webp"]);
const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(accepted.has(file.mimetype) ? null : new ValidationError("Only JPG, PNG and WEBP images are supported"), accepted.has(file.mimetype)) });
const body = z.object({ purpose: z.enum(["product", "employee", "company", "delivery-proof", "other"]) }); const params = z.object({ id: z.uuid() });
export function createUploadRouter({ prisma }) {
  const router = Router();
  router.get("/", requirePermission("settings.read"), asyncHandler(async (request, response) => sendSuccess(response, { data: await prisma.upload.findMany({ where: { companyId: request.tenant.companyId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 500 }) })));
  router.post("/images", requireAnyPermission("inventory.create", "settings.update", "delivery.update"), uploader.single("image"), validate({ body }), asyncHandler(async (request, response) => {
    if (!request.file) throw new ValidationError("Image file is required"); const data = await processImage(prisma, request.tenant.companyId, request.auth.employeeId, request.file, request.validated.body.purpose);
    await writeAudit(prisma, request, { action: "UPLOAD", entity: "Upload", entityId: data.id, after: data }); return sendSuccess(response, { statusCode: 201, data });
  }));
  router.delete("/:id", requireAnyPermission("inventory.delete", "settings.delete", "delivery.update"), validate({ params }), asyncHandler(async (request, response) => { await removeImage(prisma, request.tenant.companyId, request.params.id);
    await writeAudit(prisma, request, { action: "DELETE", entity: "Upload", entityId: request.params.id }); return sendSuccess(response, { data: { deleted: true } }); })); return router;
}
