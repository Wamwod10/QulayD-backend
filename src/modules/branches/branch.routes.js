import { createTenantCrudRouter } from "../../shared/crud/index.js";
import { branchCreateSchema } from "./branch.validation.js";
export const createBranchRouter = ({ prisma }) => createTenantCrudRouter({
  prisma, model: "branch", entity: "Branch", module: "settings", createSchema: branchCreateSchema,
  searchFields: ["name", "code", "address"], filterFields: ["status"],
});
