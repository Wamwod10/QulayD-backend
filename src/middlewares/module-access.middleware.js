import { AuthorizationError } from "../shared/errors/index.js";
import { workspaceAllowsModule } from "../shared/constants/workspaces.js";

export function requireModule(module) {
  return (request, _response, next) => {
    const modules = request.auth?.user?.modules || [];
    if (modules.includes(module) || workspaceAllowsModule(modules, module)) return next();
    return next(new AuthorizationError("Module is not enabled for this employee", { module }));
  };
}
