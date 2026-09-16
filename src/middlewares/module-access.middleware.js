import { AuthorizationError } from "../shared/errors/index.js";
import { workspaceAllowsModule } from "../shared/constants/workspaces.js";

function hasModule(request, module) {
  const modules = request.auth?.user?.modules || [];
  return modules.includes(module) || workspaceAllowsModule(modules, module);
}

export function requireModule(module) {
  return (request, _response, next) => hasModule(request, module)
    ? next()
    : next(new AuthorizationError("Module is not enabled for this employee", { module }));
}

export function requireAnyModule(...required) {
  return (request, _response, next) => required.some((module) => hasModule(request, module))
    ? next()
    : next(new AuthorizationError("None of the required modules is enabled for this employee", { anyOf: required }));
}
