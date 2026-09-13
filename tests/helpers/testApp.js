import { createApp } from "../../src/app.js";

export function createTestApp({ database = { ok: true, latencyMs: 1 } } = {}) {
  return createApp({
    databaseHealthCheck: async () => database,
  });
}

export default createTestApp;
