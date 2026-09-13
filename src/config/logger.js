import pino from "pino";

import { env } from "./env.js";

const redact = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    "request.headers.authorization",
    "request.headers.cookie",
    "password",
    "passwordHash",
    "pin",
    "pinHash",
    "refreshToken",
    "accessToken",
  ],
  censor: "[REDACTED]",
};

export const logger = pino({
  name: "qulay-backend",
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: {
    service: "qulay-backend",
    version: env.APP_VERSION,
    environment: env.NODE_ENV,
  },
  redact,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createHttpLogStream() {
  return {
    write(message) {
      logger.info({ event: "http_request", line: message.trim() });
    },
  };
}

export default logger;
