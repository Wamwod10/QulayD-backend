import { describe, expect, it, vi } from "vitest";
import { tenantContext, tenantWhere } from "../../src/middlewares/tenant.middleware.js";

describe("tenant isolation", () => {
  it("takes company identity only from the authenticated session", () => {
    const request = { auth: { companyId: "company-a" }, body: { companyId: "company-b" }, query: { companyId: "company-b" } };
    const next = vi.fn(); tenantContext(request, {}, next);
    expect(request.tenant).toEqual({ companyId: "company-a" }); expect(next).toHaveBeenCalledWith();
  });
  it("cannot be overridden by a caller supplied company filter", () => {
    expect(tenantWhere({ tenant: { companyId: "company-a" } }, { companyId: "company-b", status: "ACTIVE" }))
      .toEqual({ companyId: "company-a", status: "ACTIVE" });
  });
});
