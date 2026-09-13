import { createContactSubrouter, createTenantCrudRouter } from "../../shared/crud/index.js";
import { customerCreateSchema } from "./customer.validation.js";
export const createCustomerRouter = ({ prisma }) => {
  const router = createTenantCrudRouter({ prisma, model: "customer", entity: "Customer", module: "partners", createSchema: customerCreateSchema,
    searchFields: ["name", "code", "phone", "email"], filterFields: ["status"], include: { contacts: true } });
  router.use("/:id/contacts", createContactSubrouter({ prisma, parentModel: "customer", parentField: "customerId", entity: "Customer" }));
  return router;
};
