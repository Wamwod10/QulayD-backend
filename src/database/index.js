import { env } from "../config/env.js";
import { getPrisma } from "./prisma.js";

export async function checkDatabaseConnection({
  timeoutMs = env.DATABASE_HEALTH_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  let timer;

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Database health check timed out")), timeoutMs);
      timer.unref?.();
    });
    await Promise.race([
      getPrisma().$queryRaw`SELECT 1`,
      timeout,
    ]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Database health check failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export {
  connectDatabase,
  disconnectDatabase,
  getPrisma,
  setPrismaForTests,
} from "./prisma.js";
export { withTransaction } from "./transaction.js";
