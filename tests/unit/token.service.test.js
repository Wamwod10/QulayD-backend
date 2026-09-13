import { describe, expect, it } from "vitest";
import { createAccessToken, createRefreshToken, hashToken, verifyAccessToken, verifyRefreshToken } from "../../src/modules/auth/token.service.js";

const identity = { employeeId: "00000000-0000-4000-8000-000000000001", companyId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003", tokenVersion: 2 };

describe("token service", () => {
  it("issues scoped access tokens", () => {
    const payload = verifyAccessToken(createAccessToken(identity));
    expect(payload).toMatchObject({ sub: identity.employeeId, companyId: identity.companyId, sessionId: identity.sessionId, tokenVersion: 2, type: "access" });
  });
  it("does not accept a refresh token as an access token", () => {
    expect(() => verifyAccessToken(createRefreshToken(identity))).toThrow("Token is invalid or expired");
  });
  it("verifies refresh tokens and hashes deterministically", () => {
    const token = createRefreshToken(identity); expect(verifyRefreshToken(token).type).toBe("refresh"); expect(hashToken(token)).toBe(hashToken(token));
  });
});
