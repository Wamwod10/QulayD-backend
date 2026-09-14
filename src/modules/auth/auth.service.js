import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthenticationError, ConflictError } from "../../shared/errors/index.js";
import { MODULES } from "../../shared/constants/permissions.js";
import { WORKSPACE_MODULES } from "../../shared/constants/workspaces.js";
import {
  createAccessToken, createOpaqueToken, createRefreshToken, hashToken,
  refreshExpiryDate, verifyRefreshToken,
} from "./token.service.js";

const defaultSettings = () => ({
  company: { currency: "UZS", language: "uz", timezone: "Asia/Tashkent" },
  modules: Object.fromEntries(MODULES.map((module) => [module, !WORKSPACE_MODULES.includes(module)])),
  employeeWorkspaces: Object.fromEntries(WORKSPACE_MODULES.map((module) => [module, false])),
  sales: { allowNegativeStock: false, autoConfirmOrders: false },
  inventory: { reservations: true, lowStockAlerts: true, requireAdjustmentApproval: true },
  notifications: { lowStock: true, overdueDebt: true, payment: true, newOrder: true },
});

function isCompanyActive(company) {
  if (!company || !["ACTIVE", "TRIAL"].includes(company.status)) return false;
  return company.status !== "TRIAL" || !company.trialEndsAt || company.trialEndsAt > new Date();
}

export function publicEmployee(employee) {
  const roles = employee.roles?.map(({ role }) => role.code) ?? [];
  const permissions = [...new Set(employee.roles?.flatMap(({ role }) =>
    role.permissions.map(({ permission }) => permission.code)) ?? [])];
  const modules = employee.modules?.filter((entry) => entry.enabled).map((entry) => entry.module) ?? [];
  return {
    id: employee.id, companyId: employee.companyId, branchId: employee.branchId,
    warehouseId: employee.warehouseId, employeeTypeId: employee.employeeTypeId, login: employee.login, phone: employee.phone,
    email: employee.email, name: employee.name, title: employee.title, status: employee.status,
    branch: employee.branch ? { id: employee.branch.id, name: employee.branch.name, code: employee.branch.code } : undefined,
    warehouse: employee.warehouse ? { id: employee.warehouse.id, name: employee.warehouse.name, code: employee.warehouse.code } : undefined,
    employeeType: employee.employeeType ? { id: employee.employeeType.id, code: employee.employeeType.code, name: employee.employeeType.name } : undefined,
    mustChangePassword: employee.mustChangePassword, roles, primaryRole: roles[0] ?? "EMPLOYEE",
    permissions, modules: roles.includes("OWNER") || roles.includes("ADMIN") ? MODULES : modules,
    company: employee.company ? {
      id: employee.company.id, name: employee.company.name, plan: employee.company.plan, status: employee.company.status,
    } : undefined,
  };
}

export function createAuthService(repository) {
  async function issue(employee, device, requestContext) {
    const sessionId = crypto.randomUUID();
    const identity = { employeeId: employee.id, companyId: employee.companyId, sessionId, tokenVersion: employee.tokenVersion };
    const refreshToken = createRefreshToken(identity);
    await repository.createSession({
      id: sessionId, companyId: employee.companyId, employeeId: employee.id,
      refreshTokenHash: hashToken(refreshToken), deviceId: device.deviceId,
      deviceName: device.deviceName, userAgent: requestContext.userAgent,
      ipAddress: requestContext.ipAddress, expiresAt: refreshExpiryDate(),
    });
    return { accessToken: createAccessToken(identity), refreshToken, user: publicEmployee(employee) };
  }

  async function authenticate(identifier, secret, field) {
    const employee = await repository.findByIdentifier(identifier);
    const hash = field === "pin" ? employee?.pinHash : employee?.passwordHash;
    if (!employee || !hash || !(await bcrypt.compare(secret, hash))) {
      throw new AuthenticationError(field === "pin" ? "PIN is incorrect" : "Login credentials are incorrect");
    }
    if (employee.status !== "ACTIVE" || !isCompanyActive(employee.company)) {
      throw new AuthenticationError("Account is not active");
    }
    await repository.updateEmployee(employee.id, { lastLoginAt: new Date() });
    return employee;
  }

  return {
    async registerOwner(input, context) {
      const existing = await repository.findByIdentifier(input.login || input.phone || input.email);
      if (existing) throw new ConflictError("An account with this identifier already exists");
      const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
      const { employee } = await repository.createCompanyOwner({
        company: { name: input.companyName, status: "TRIAL", trialEndsAt: new Date(Date.now() + 14 * 86_400_000) },
        employee: { name: input.name, login: input.login, phone: input.phone, email: input.email, passwordHash },
        settings: defaultSettings(),
      });
      return issue(employee, input, context);
    },
    async login(input, context) {
      const employee = await authenticate(input.identifier, input.password, "password");
      return issue(employee, input, context);
    },
    async loginWithPin(input, context) {
      const employee = await authenticate(input.identifier, input.pin, "pin");
      return issue(employee, input, context);
    },
    async refresh(token, context) {
      const payload = verifyRefreshToken(token);
      const [session, employee] = await Promise.all([
        repository.findSession(payload.sessionId), repository.findById(payload.sub),
      ]);
      const invalid = !session || session.revokedAt || session.expiresAt <= new Date()
        || session.employeeId !== payload.sub || session.refreshTokenHash !== hashToken(token)
        || !employee || employee.status !== "ACTIVE" || !isCompanyActive(employee.company)
        || employee.tokenVersion !== payload.tokenVersion;
      if (invalid) {
        if (session?.employeeId) await repository.revokeAllSessions(session.employeeId, "REFRESH_TOKEN_REUSE");
        throw new AuthenticationError("Refresh token is invalid or expired");
      }
      const identity = { employeeId: employee.id, companyId: employee.companyId, sessionId: session.id, tokenVersion: employee.tokenVersion };
      const refreshToken = createRefreshToken(identity);
      await repository.rotateSession(session.id, {
        refreshTokenHash: hashToken(refreshToken), lastUsedAt: new Date(),
        userAgent: context.userAgent, ipAddress: context.ipAddress,
      });
      return { accessToken: createAccessToken(identity), refreshToken, user: publicEmployee(employee) };
    },
    async logout(sessionId) { if (sessionId) await repository.revokeSession(sessionId); },
    async changePassword(employeeId, input) {
      const employee = await repository.findById(employeeId);
      if (!employee || !(await bcrypt.compare(input.currentPassword, employee.passwordHash))) {
        throw new AuthenticationError("Current password is incorrect");
      }
      const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);
      await repository.updateEmployee(employeeId, { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } });
      await repository.revokeAllSessions(employeeId, "PASSWORD_CHANGED");
    },
    async forgotPassword(identifier) {
      const employee = await repository.findByIdentifier(identifier);
      if (!employee || employee.status !== "ACTIVE") return null;
      const token = createOpaqueToken();
      await repository.createResetToken({
        employeeId: employee.id, tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
      });
      if (env.PASSWORD_RESET_WEBHOOK_URL) {
        try {
          await fetch(env.PASSWORD_RESET_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ event: "password.reset.requested", employee: { id: employee.id, name: employee.name, email: employee.email, phone: employee.phone },
              token, resetUrl: env.FRONTEND_RESET_URL ? `${env.FRONTEND_RESET_URL.replace(/\/$/, "")}?token=${encodeURIComponent(token)}` : undefined,
              expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES }), signal: AbortSignal.timeout(5_000) });
        } catch (error) { logger.error({ err: error, employeeId: employee.id }, "Password reset webhook delivery failed"); }
      }
      return token;
    },
    async resetPassword(input) {
      const reset = await repository.findResetToken(hashToken(input.token));
      if (!reset || reset.usedAt || reset.expiresAt <= new Date()) throw new AuthenticationError("Reset token is invalid or expired");
      const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);
      await repository.updateEmployee(reset.employeeId, { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } });
      await repository.useResetToken(reset.id);
      await repository.revokeAllSessions(reset.employeeId, "PASSWORD_RESET");
    },
    listSessions: repository.listSessions,
    revokeSession: repository.revokeOwnSession,
  };
}
