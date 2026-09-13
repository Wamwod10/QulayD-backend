import { AuthorizationError } from "../shared/errors/index.js";

export function tenantContext(request, _response, next) {
  if (!request.auth?.companyId) return next(new AuthorizationError("Tenant context is missing"));
  request.tenant = Object.freeze({ companyId: request.auth.companyId });
  return next();
}

export const tenantWhere = (request, where = {}) => ({ ...where, companyId: request.tenant.companyId });
