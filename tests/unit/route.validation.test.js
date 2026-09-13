import { describe, expect, it } from "vitest";
import { routeTemplateSchema } from "../../src/modules/routes/route.validation.js";

const id = (last) => `00000000-0000-4000-8000-00000000000${last}`;
describe("route validation", () => {
  it("rejects duplicate customers and stop order values", () => {
    const result = routeTemplateSchema.safeParse({ name: "Monday", stops: [
      { customerId: id(1), stopOrder: 1 }, { customerId: id(1), stopOrder: 1 },
    ] });
    expect(result.success).toBe(false);
  });
});
