import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requireRole } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { createRoleController } from "./role.controller.js";
import { createRoleRepository } from "./role.repository.js";
import { createRoleService } from "./role.service.js";
import { roleCreateSchema, roleUpdateSchema } from "./role.validation.js";
const params = z.object({ id: z.uuid() });
export function createAccessControlRouter({ prisma }) {
  const router = Router(); const c = createRoleController(createRoleService(createRoleRepository(prisma)), prisma);
  router.use(requireModule("settings")); router.use(requireRole("OWNER", "ADMIN"));
  router.get("/permissions", asyncHandler(c.permissions)); router.get("/roles", asyncHandler(c.list));
  router.post("/roles", validate({ body: roleCreateSchema }), asyncHandler(c.create));
  router.patch("/roles/:id", validate({ params, body: roleUpdateSchema }), asyncHandler(c.update));
  router.delete("/roles/:id", validate({ params }), asyncHandler(c.delete));
  return router;
}
