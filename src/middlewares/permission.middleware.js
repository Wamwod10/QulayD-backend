import { AuthorizationError } from "../shared/errors/index.js";

export function requirePermission(...required) {
  return (request, _response, next) => {
    const roles = request.auth?.user?.roles || [];
    if (roles.includes("OWNER") || roles.includes("ADMIN")) return next();
    const owned = new Set(request.auth?.user?.permissions || []);
    if (required.every((permission) => owned.has(permission))) return next();
    return next(new AuthorizationError("Required permission is missing", { required }));
  };
}

export function requireAnyPermission(...required) {
  return (request, _response, next) => {
    const roles = request.auth?.user?.roles || [];
    if (roles.includes("OWNER") || roles.includes("ADMIN")) return next();
    const owned = new Set(request.auth?.user?.permissions || []);
    if (required.some((permission) => owned.has(permission))) return next();
    return next(new AuthorizationError("Required permission is missing", { anyOf: required }));
  };
}

export function requireRole(...required) {
  return (request, _response, next) => {
    const roles = request.auth?.user?.roles || [];
    return required.some((role) => roles.includes(role))
      ? next() : next(new AuthorizationError("Required role is missing", { required }));
  };
}
