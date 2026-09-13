import { createContactSubrouter, createTenantCrudRouter } from "../../shared/crud/index.js";
import { supplierCreateSchema } from "./supplier.validation.js";
export const createSupplierRouter = ({ prisma }) => {
  const router = createTenantCrudRouter({ prisma, model: "supplier", entity: "Supplier", module: "partners", createSchema: supplierCreateSchema,
    searchFields: ["name", "code", "phone", "email"], filterFields: ["status"], include: { contacts: true } });
  router.use("/:id/contacts", createContactSubrouter({ prisma, parentModel: "supplier", parentField: "supplierId", entity: "Supplier" }));
  return router;
};
