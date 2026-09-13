import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../helpers/testApp.js";

describe("system endpoints", () => {
  it("returns process liveness without querying the database", async () => {
    const response = await request(createTestApp()).get("/api/v1/health").expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      status: "ok",
      service: "qulay-backend",
      environment: "test",
    });
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("preserves a valid incoming request identifier", async () => {
    const requestId = "request-12345678";
    const response = await request(createTestApp())
      .get("/api/v1/health")
      .set("X-Request-Id", requestId)
      .expect(200);

    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("returns readiness when PostgreSQL is available", async () => {
    const response = await request(createTestApp({
      database: { ok: true, latencyMs: 4 },
    })).get("/api/v1/ready").expect(200);

    expect(response.body.data.checks.database).toEqual({ status: "up", latencyMs: 4 });
  });

  it("returns 503 when PostgreSQL is unavailable", async () => {
    const response = await request(createTestApp({
      database: { ok: false, latencyMs: 7, error: "connection refused" },
    })).get("/api/v1/ready").expect(503);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: "SERVICE_NOT_READY",
        message: "Service dependencies are not ready",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("connection refused");
  });

  it("returns a structured 404 response", async () => {
    const response = await request(createTestApp()).get("/api/v1/unknown").expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    expect(response.body.requestId).toBeTruthy();
  });

  it("requires authentication for business endpoints", async () => {
    const response = await request(createTestApp()).get("/api/v1/dashboard").expect(401);
    expect(response.body).toMatchObject({ success: false, error: { code: "AUTHENTICATION_REQUIRED" } });
  });

  it("sets baseline security headers", async () => {
    const response = await request(createTestApp()).get("/api/v1/health").expect(200);

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects a browser origin outside the CORS allowlist", async () => {
    const response = await request(createTestApp())
      .get("/api/v1/health")
      .set("Origin", "https://untrusted.example")
      .expect(403);

    expect(response.body.error.code).toBe("CORS_ORIGIN_DENIED");
  });
});
