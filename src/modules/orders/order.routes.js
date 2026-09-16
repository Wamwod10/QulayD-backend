import { Router } from "express";
import { z } from "zod";
import { requireAnyModule, requireModule } from "../../middlewares/module-access.middleware.js";
import { requireAnyPermission, requirePermission } from "../../middlewares/permission.middleware.js";
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
  const router = Router(); const c = createOrderController(createOrderService(prisma), prisma);

  // Fulfillment transitions belong to the same canonical Order state machine, but warehouse users
  // must not need broad sales.update permission just to perform their assigned warehouse work.
  for (const [path, handler] of [["picking/start", c.startPicking], ["picking/complete", c.completePicking], ["packing/complete", c.pack], ["ready", c.ready]]) {
    router.post(`/:id/${path}`, requireAnyModule("sales", "fulfillment"), requireAnyPermission("sales.update", "fulfillment.update"), validate({ params, body: transitionSchema }), asyncHandler(handler));
  }

  router.use(requireModule("sales"));
  router.get("/", requirePermission("sales.read"), validate({ query }), asyncHandler(c.list));
  router.get("/:id", requirePermission("sales.read"), validate({ params }), asyncHandler(c.find));
  router.post("/", requirePermission("sales.create"), validate({ body: orderCreateSchema }), asyncHandler(c.create));
  router.patch("/:id", requirePermission("sales.update"), validate({ params, body: orderUpdateSchema }), asyncHandler(c.update));
  for (const [path, handler, permission] of [["confirm", c.confirm, "sales.approve"], ["complete", c.complete, "sales.update"], ["cancel", c.cancel, "sales.update"]]) {
    router.post(`/:id/${path}`, requirePermission(permission), validate({ params, body: transitionSchema }), asyncHandler(handler));
  }
  return router;
}
