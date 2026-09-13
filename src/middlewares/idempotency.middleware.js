import { acquireIdempotency, requestFingerprint } from "../shared/idempotency/idempotency.service.js";
export function createIdempotencyMiddleware(prisma) {
  return async function idempotency(request, response, next) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
    const key = request.get("idempotency-key"); if (!key) return next();
    try {
      const acquired = await acquireIdempotency(prisma, request.tenant.companyId, key, requestFingerprint(request));
      if (acquired.replay) return response.status(acquired.record.responseCode).json(acquired.record.responseBody);
      const original = response.json.bind(response); let body;
      response.json = (value) => { body = value; return original(value); };
      response.once("finish", () => {
        if (!body || response.statusCode >= 500) return;
        prisma.idempotencyKey.update({ where: { id: acquired.record.id }, data: { method: request.method, path: request.originalUrl,
          responseCode: response.statusCode, responseBody: JSON.parse(JSON.stringify(body)), lockedUntil: null } }).catch(() => {});
      });
      return next();
    } catch (error) { return next(error); }
  };
}
