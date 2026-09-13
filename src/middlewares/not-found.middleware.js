import { NotFoundError } from "../shared/errors/NotFoundError.js";

export function notFoundMiddleware(request, _response, next) {
  next(new NotFoundError(`Route ${request.method} ${request.originalUrl} was not found`, {
    method: request.method,
    path: request.originalUrl,
  }));
}

export default notFoundMiddleware;
