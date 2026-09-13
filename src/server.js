import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { disconnectDatabase } from "./database/prisma.js";

const app = createApp();
const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT, apiPrefix: env.API_PREFIX }, "Qulay API started");
});

server.requestTimeout = 30_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 60_000;

let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");

  const forceTimer = setTimeout(() => {
    logger.fatal({ signal }, "Graceful shutdown timed out");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  server.close(async (serverError) => {
    try {
      await disconnectDatabase();
      if (serverError) {
        logger.error({ error: serverError }, "HTTP server failed to close cleanly");
        process.exitCode = 1;
      } else {
        process.exitCode = exitCode;
      }
    } catch (error) {
      logger.error({ error }, "Database failed to disconnect cleanly");
      process.exitCode = 1;
    } finally {
      clearTimeout(forceTimer);
    }
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (error) => {
  logger.fatal({ error }, "Unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});

export { app, server, shutdown };
