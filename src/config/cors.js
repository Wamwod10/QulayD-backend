import { env } from "./env.js";

function corsDeniedError(origin) {
  const error = new Error("Origin is not allowed by CORS policy");
  error.statusCode = 403;
  error.code = "CORS_ORIGIN_DENIED";
  error.details = { origin };
  return error;
}

export function createCorsOptions(config = env) {
  const allowedOrigins = new Set(config.CORS_ORIGINS || []);

  return {
    credentials: config.CORS_CREDENTIALS,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Branch-Id",
      "X-Company-Id",
      "X-Request-Id",
    ],
    exposedHeaders: ["X-Request-Id", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
    maxAge: 86_400,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) {
        callback(null, true);
        return;
      }
      callback(corsDeniedError(origin));
    },
  };
}

export default createCorsOptions;
