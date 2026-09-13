import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("OpenAPI document", () => {
  it("is valid YAML with the core public and protected contracts", () => {
    const document = parse(fs.readFileSync(new URL("../../docs/openapi.yaml", import.meta.url), "utf8"));
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/api/v1/auth/login"].post.security).toEqual([]);
    expect(document.paths["/api/v1/orders"].post).toBeTruthy();
    expect(document.paths["/api/v1/pos/sales"].post).toBeTruthy();
    expect(document.components.securitySchemes.BearerAuth).toBeTruthy();
  });
});
