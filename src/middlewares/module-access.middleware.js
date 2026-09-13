import { AuthorizationError } from "../shared/errors/index.js";

export function requireModule(module) {
  return (request, _response, next) => {
    if ((request.auth?.user?.modules || []).includes(module)) return next();
    return next(new AuthorizationError("Module is not enabled for this employee", { module }));
  };
}
