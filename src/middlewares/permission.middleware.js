import { AuthorizationError } from "../shared/errors/index.js";
import { workspaceAllowsPermission } from "../shared/constants/workspaces.js";

function hasPermission(request, permission) {
  const roles = request.auth?.user?.roles || [];
  if (roles.includes("OWNER") || roles.includes("ADMIN")) return true;
  const owned = new Set(request.auth?.user?.permissions || []);
  const modules = request.auth?.user?.modules || [];
  return owned.has(permission) || workspaceAllowsPermission(modules, permission);
}

export function requirePermission(...required) {
  return (request, _response, next) => {
    if (required.every((permission) => hasPermission(request, permission))) return next();
    return next(new AuthorizationError("Required permission is missing", { required }));
  };
}

export function requireAnyPermission(...required) {
  return (request, _response, next) => {
    if (required.some((permission) => hasPermission(request, permission))) return next();
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
