import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { createOrderController } from "./order.controller.js";
import { createOrderService } from "./order.service.js";
import { orderCreateSchema, orderUpdateSchema, transitionSchema } from "./order.validation.js";
const params = z.object({ id: z.uuid() });
const query = z.object({ page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(), sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(),
  status: z.string().max(40).optional(), warehouseId: z.uuid().optional(), customerId: z.uuid().optional(), agentId: z.uuid().optional(), channel: z.string().max(40).optional() });
export function createOrderRouter({ prisma }) {
  const router = Router(); const c = createOrderController(createOrderService(prisma), prisma); router.use(requireModule("sales"));
  router.get("/", requirePermission("sales.read"), validate({ query }), asyncHandler(c.list));
  router.get("/:id", requirePermission("sales.read"), validate({ params }), asyncHandler(c.find));
  router.post("/", requirePermission("sales.create"), validate({ body: orderCreateSchema }), asyncHandler(c.create));
  router.patch("/:id", requirePermission("sales.update"), validate({ params, body: orderUpdateSchema }), asyncHandler(c.update));
  const actions = [["confirm", c.confirm, "sales.approve"], ["picking/start", c.startPicking, "sales.update"],
    ["picking/complete", c.completePicking, "sales.update"], ["packing/complete", c.pack, "sales.update"],
    ["ready", c.ready, "sales.update"], ["complete", c.complete, "sales.update"], ["cancel", c.cancel, "sales.update"]];
  for (const [path, handler, permission] of actions) router.post(`/:id/${path}`, requirePermission(permission), validate({ params, body: transitionSchema }), asyncHandler(handler));
  return router;
}
