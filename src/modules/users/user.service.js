import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";
import { NotFoundError, ValidationError } from "../../shared/errors/index.js";
import { paginationMeta, parsePagination } from "../../shared/pagination/index.js";
import { publicEmployee } from "../auth/auth.service.js";

export function createUserService(repository) {
  return {
    async list(companyId, query) {
      const page = parsePagination(query, { allowedSortFields: ["createdAt", "updatedAt", "name", "lastLoginAt"] });
      const where = {};
      if (query.status) where.status = query.status;
      if (page.search) where.OR = ["name", "login", "phone", "email"].map((field) => ({ [field]: { contains: page.search, mode: "insensitive" } }));
      const result = await repository.list(companyId, { where, skip: page.skip, take: page.take, orderBy: { [page.sortBy || "createdAt"]: page.sortOrder } });
      return { data: result.data.map(publicEmployee), meta: paginationMeta({ ...page, total: result.total }) };
    },
    async find(companyId, id) { const value = await repository.find(companyId, id); if (!value) throw new NotFoundError("Employee not found"); return publicEmployee(value); },
    async create(companyId, input, actorRoles) {
      const { password, pin, roleIds, modules = [], ...data } = input;
      const assignedCodes = (await repository.roleCodes(companyId, roleIds)).map(({ code }) => code);
      if (!actorRoles.includes("OWNER") && assignedCodes.some((code) => ["OWNER", "ADMIN"].includes(code))) throw new ValidationError("Only an owner can assign privileged roles");
      const value = await repository.create(companyId, {
        ...data, passwordHash: await bcrypt.hash(password, env.BCRYPT_ROUNDS),
        pinHash: pin ? await bcrypt.hash(pin, env.BCRYPT_ROUNDS) : undefined,
      }, roleIds, modules);
      if (!value) throw new ValidationError("A role, branch, warehouse or employee type is invalid");
      return publicEmployee(value);
    },
    async update(companyId, id, input, actorRoles) {
      const { pin, roleIds, modules, ...data } = input;
      const target = await repository.find(companyId, id);
      if (target?.roles.some(({ role }) => role.code === "OWNER") && !actorRoles.includes("OWNER")) throw new ValidationError("Only an owner can modify another owner");
      if (roleIds) {
        const assignedCodes = (await repository.roleCodes(companyId, roleIds)).map(({ code }) => code);
        if (!actorRoles.includes("OWNER") && assignedCodes.some((code) => ["OWNER", "ADMIN"].includes(code))) throw new ValidationError("Only an owner can assign privileged roles");
      }
      if (pin) data.pinHash = await bcrypt.hash(pin, env.BCRYPT_ROUNDS);
      const result = await repository.update(companyId, id, data, roleIds, modules);
      if (!result) throw new NotFoundError("Employee not found");
      if (result.invalidRoles) throw new ValidationError("One or more roles are invalid");
      if (result.invalidAssignment) throw new ValidationError("Branch, warehouse or employee type is invalid");
      return { before: publicEmployee(result.before), data: publicEmployee(result.employee) };
    },
    async remove(companyId, id, actorRoles, actorEmployeeId) {
      const target = await repository.find(companyId, id);
      if (!target) throw new NotFoundError("Employee not found");
      if (target.id === actorEmployeeId) throw new ValidationError("You cannot remove your own active account");
      if (target.roles.some(({ role }) => role.code === "OWNER")) throw new ValidationError("Owner account cannot be removed");
      if (!actorRoles.includes("OWNER") && target.roles.some(({ role }) => role.code === "ADMIN")) throw new ValidationError("Only an owner can remove an administrator");
      const result = await repository.archive(companyId, id);
      if (!result) throw new NotFoundError("Employee not found");
      return { before: publicEmployee(result.before), data: publicEmployee(result.employee) };
    },
    async resetPassword(companyId, id, input, actorRoles) {
      const target = await repository.find(companyId, id);
      if (target?.roles.some(({ role }) => role.code === "OWNER") && !actorRoles.includes("OWNER")) throw new ValidationError("Only an owner can reset an owner password");
      const hash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
      const result = await repository.resetPassword(companyId, id, hash, input.mustChangePassword ?? true);
      if (!result.count) throw new NotFoundError("Employee not found");
    },
  };
}
