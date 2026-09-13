import crypto from "node:crypto";
import { ConflictError, ValidationError } from "../errors/index.js";
export const requestFingerprint = (request) => crypto.createHash("sha256").update(JSON.stringify({ method: request.method, path: request.originalUrl, body: request.body })).digest("hex");
export async function acquireIdempotency(prisma, companyId, key, fingerprint) {
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw new ValidationError("Invalid Idempotency-Key header");
  const current = await prisma.idempotencyKey.findUnique({ where: { companyId_key: { companyId, key } } });
  if (current) {
    if (current.requestHash !== fingerprint) throw new ConflictError("Idempotency key was used for another request");
    if (current.responseBody && current.responseCode) return { replay: true, record: current };
    if (current.lockedUntil && current.lockedUntil > new Date()) throw new ConflictError("Identical request is still being processed");
    return { replay: false, record: await prisma.idempotencyKey.update({ where: { id: current.id }, data: { lockedUntil: new Date(Date.now() + 30_000) } }) };
  }
  return { replay: false, record: await prisma.idempotencyKey.create({ data: { companyId, key, method: "", path: "", requestHash: fingerprint,
    lockedUntil: new Date(Date.now() + 30_000), expiresAt: new Date(Date.now() + 86_400_000) } }) };
}
