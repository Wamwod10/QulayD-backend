import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission, requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { createUserController } from "./user.controller.js";
import { createUserRepository } from "./user.repository.js";
import { createUserService } from "./user.service.js";
import { employeeCreateSchema, employeePasswordSchema, employeeUpdateSchema } from "./user.validation.js";
const params = z.object({ id: z.uuid() });
const query = z.object({ page: z.coerce.number().positive().optional(), limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().max(200).optional(), sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(),
  status: z.enum(["INVITED", "ACTIVE", "BLOCKED", "TERMINATED"]).optional() });
export function createUserRouter({ prisma }) {
  const router = Router(); const c = createUserController(createUserService(createUserRepository(prisma)), prisma);
  router.use(requireModule("settings"));
  router.get("/", requirePermission("settings.read"), validate({ query }), asyncHandler(c.list));
  router.get("/:id", requirePermission("settings.read"), validate({ params }), asyncHandler(c.find));
  router.post("/", requireRole("OWNER", "ADMIN"), validate({ body: employeeCreateSchema }), asyncHandler(c.create));
  router.patch("/:id", requireRole("OWNER", "ADMIN"), validate({ params, body: employeeUpdateSchema }), asyncHandler(c.update));
  router.delete("/:id", requireRole("OWNER", "ADMIN"), validate({ params }), asyncHandler(c.remove));
  router.post("/:id/reset-password", requireRole("OWNER", "ADMIN"), validate({ params, body: employeePasswordSchema }), asyncHandler(c.resetPassword));
  return router;
}
