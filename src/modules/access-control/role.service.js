import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/index.js";
export const createRoleService = (repository) => ({
  list: repository.list,
  permissions: repository.permissions,
  async create(companyId, input) { const value = await repository.create(companyId, input); if (!value) throw new ValidationError("Unknown permission code"); return value; },
  async update(companyId, id, input) { const value = await repository.update(companyId, id, input); if (!value) throw new NotFoundError("Custom role not found"); if (value.invalidPermissions) throw new ValidationError("Unknown permission code"); return value; },
  async delete(companyId, id) { const value = await repository.delete(companyId, id); if (!value.count) throw new ConflictError("Role is system-defined, assigned, or missing"); },
});
