import { resolveRequestId } from "../shared/utils/identifiers.js";

export function requestIdMiddleware(request, response, next) {
  const requestId = resolveRequestId(request.get("x-request-id"));
  request.id = requestId;
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
}

export default requestIdMiddleware;
