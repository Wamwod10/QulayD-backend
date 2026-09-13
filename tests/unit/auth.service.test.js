import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { createAuthService } from "../../src/modules/auth/auth.service.js";

const employee = (company) => ({ id: "employee", companyId: "company", status: "ACTIVE", tokenVersion: 0,
  passwordHash: bcrypt.hashSync("Password1", 10), company, roles: [], modules: [] });

describe("auth service account state", () => {
  it("rejects an expired trial company", async () => {
    const repository = { findByIdentifier: vi.fn().mockResolvedValue(employee({ status: "TRIAL", trialEndsAt: new Date(Date.now() - 1_000) })) };
    await expect(createAuthService(repository).login({ identifier: "owner", password: "Password1" }, {}))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
  it("rejects suspended companies even with a valid password", async () => {
    const repository = { findByIdentifier: vi.fn().mockResolvedValue(employee({ status: "SUSPENDED" })) };
    await expect(createAuthService(repository).login({ identifier: "owner", password: "Password1" }, {}))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});
