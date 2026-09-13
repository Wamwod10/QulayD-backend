import { describe, expect, it, vi } from "vitest";
import { requireModule } from "../../src/middlewares/module-access.middleware.js";
import { requireAnyPermission, requirePermission } from "../../src/middlewares/permission.middleware.js";
import { publicEmployee } from "../../src/modules/auth/auth.service.js";

const response = {};
describe("access control", () => {
  it("builds the employee access contract from roles and modules", () => {
    const value = publicEmployee({ id: "e", companyId: "c", status: "ACTIVE", roles: [{ role: { code: "EMPLOYEE",
      permissions: [{ permission: { code: "sales.read" } }] } }], modules: [{ module: "sales", enabled: true }, { module: "finance", enabled: false }] });
    expect(value).toMatchObject({ roles: ["EMPLOYEE"], permissions: ["sales.read"], modules: ["sales"] });
  });
  it("blocks missing permission and module", () => {
    const next = vi.fn(); const request = { auth: { user: { roles: ["EMPLOYEE"], permissions: [], modules: [] } } };
    requirePermission("sales.read")(request, response, next); expect(next.mock.calls[0][0].code).toBe("FORBIDDEN");
    next.mockClear(); requireModule("sales")(request, response, next); expect(next.mock.calls[0][0].code).toBe("FORBIDDEN");
  });
  it("allows owner permission bypass but still uses enabled module contract", () => {
    const next = vi.fn(); requirePermission("finance.approve")({ auth: { user: { roles: ["OWNER"] } } }, response, next); expect(next).toHaveBeenCalledWith();
  });
  it("supports endpoints that accept any one of several permissions", () => {
    const next = vi.fn(); const request = { auth: { user: { roles: ["EMPLOYEE"], permissions: ["delivery.update"] } } };
    requireAnyPermission("inventory.create", "delivery.update")(request, response, next);
    expect(next).toHaveBeenCalledWith();
  });
});
