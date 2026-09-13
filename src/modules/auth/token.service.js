import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { AuthenticationError } from "../../shared/errors/index.js";

const signOptions = { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, algorithm: "HS256" };

export function createAccessToken({ employeeId, companyId, sessionId, tokenVersion }) {
  return jwt.sign({ companyId, sessionId, tokenVersion, type: "access" }, env.JWT_ACCESS_SECRET,
    { ...signOptions, subject: employeeId, expiresIn: env.JWT_ACCESS_TTL });
}

export function createRefreshToken({ employeeId, companyId, sessionId, tokenVersion }) {
  return jwt.sign(
    { companyId, sessionId, tokenVersion, type: "refresh", nonce: crypto.randomUUID() },
    env.JWT_REFRESH_SECRET,
    { ...signOptions, subject: employeeId, expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d` },
  );
}

function verify(token, secret, type) {
  try {
    const payload = jwt.verify(token, secret, signOptions);
    if (payload.type !== type || !payload.sub || !payload.companyId || !payload.sessionId) {
      throw new AuthenticationError("Invalid token payload");
    }
    return payload;
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("Token is invalid or expired");
  }
}

export const verifyAccessToken = (token) => verify(token, env.JWT_ACCESS_SECRET, "access");
export const verifyRefreshToken = (token) => verify(token, env.JWT_REFRESH_SECRET, "refresh");
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
export const createOpaqueToken = () => crypto.randomBytes(32).toString("base64url");
export const refreshExpiryDate = () => new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);
