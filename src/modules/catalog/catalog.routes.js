import { Router } from "express";
import { z } from "zod";
import { requireModule } from "../../middlewares/module-access.middleware.js";
import { requirePermission } from "../../middlewares/permission.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { asyncHandler } from "../../shared/utils/index.js";
import { categoryCreateSchema } from "./categories/category.validation.js";
import { createProductController } from "./products/product.controller.js";
import { createProductRepository } from "./products/product.repository.js";
import { createProductService } from "./products/product.service.js";
import { productCreateSchema, productUpdateSchema } from "./products/product.validation.js";
import { unitCreateSchema } from "./units/unit.validation.js";

const id = z.object({ id: z.uuid() });
const query = z.object({ page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).optional(), search: z.string().max(200).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(), categoryId: z.uuid().optional(), warehouseId: z.uuid().optional() });

export function createCatalogRouter({ prisma }) {
  const router = Router();
  router.use("/categories", createTenantCrudRouter({ prisma, model: "category", entity: "Category", module: "inventory",
    createSchema: categoryCreateSchema, searchFields: ["name", "code"], filterFields: ["status", "parentId"], tenantRelationFields: { parentId: "category" } }));
  router.use("/units", createTenantCrudRouter({ prisma, model: "unit", entity: "Unit", module: "inventory",
    createSchema: unitCreateSchema, searchFields: ["name", "shortName"], filterFields: ["status"], softDelete: false }));
  const controller = createProductController(createProductService(createProductRepository(prisma)), prisma);
  router.get("/products", requireModule("inventory"), requirePermission("inventory.read"), validate({ query }), asyncHandler(controller.list));
  router.get("/products/:id", requireModule("inventory"), requirePermission("inventory.read"), validate({ params: id }), asyncHandler(controller.find));
  router.post("/products", requireModule("inventory"), requirePermission("inventory.create"), validate({ body: productCreateSchema }), asyncHandler(controller.create));
  router.patch("/products/:id", requireModule("inventory"), requirePermission("inventory.update"), validate({ params: id, body: productUpdateSchema }), asyncHandler(controller.update));
  router.delete("/products/:id", requireModule("inventory"), requirePermission("inventory.delete"), validate({ params: id }), asyncHandler(controller.archive));
  return router;
}
