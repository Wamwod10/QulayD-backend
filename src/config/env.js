import "dotenv/config";
import { z } from "zod";

const DEVELOPMENT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/qulay?schema=public";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(5000),
  API_PREFIX: z.string().trim().regex(/^\/[a-zA-Z0-9/_-]*$/).default("/api/v1"),
  APP_VERSION: z.string().trim().min(1).default("1.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: z.string().trim().default("false"),
  BODY_LIMIT: z.string().trim().regex(/^\d+(\.\d+)?(b|kb|mb)$/i).default("1mb"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  DATABASE_URL: z.string().trim().min(1).default(DEVELOPMENT_DATABASE_URL),
  DATABASE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(3_000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  CORS_CREDENTIALS: booleanFromEnv.default(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  SWAGGER_ENABLED: booleanFromEnv.default(true),
  JWT_ACCESS_SECRET: z.string().min(32).default("development-access-secret-change-me-000000000000"),
  JWT_REFRESH_SECRET: z.string().min(32).default("development-refresh-secret-change-me-00000000000"),
  JWT_ACCESS_TTL: z.string().trim().default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  JWT_ISSUER: z.string().trim().min(1).default("qulay-api"),
  JWT_AUDIENCE: z.string().trim().min(1).default("qulay-web"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  PASSWORD_RESET_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  FRONTEND_RESET_URL: z.string().url().optional().or(z.literal("")),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  UPLOAD_MAX_FILE_SIZE_MB: z.coerce.number().positive().max(50).default(8),
  UPLOAD_DIR: z.string().trim().min(1).default("uploads"),
  UPLOAD_STORAGE_PROVIDER: z.string().optional().default(""),
  UPLOAD_BUCKET: z.string().optional().default(""),
  UPLOAD_PUBLIC_BASE_URL: z.string().optional().default(""),
});

function normalizeApiPrefix(value) {
  const withoutTrailingSlashes = value.replace(/\/+$/, "");
  return withoutTrailingSlashes || "/";
}

function parseTrustProxy(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false" || normalized === "") return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const summary = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${summary}`);
}

if (parsed.data.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  throw new Error("Invalid environment configuration: DATABASE_URL is required in production");
}

if (parsed.data.NODE_ENV === "production"
  && (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET)) {
  throw new Error("Invalid environment configuration: JWT secrets are required in production");
}

export const env = Object.freeze({
  ...parsed.data,
  API_PREFIX: normalizeApiPrefix(parsed.data.API_PREFIX),
  TRUST_PROXY: parseTrustProxy(parsed.data.TRUST_PROXY),
  PASSWORD_RESET_WEBHOOK_URL: parsed.data.PASSWORD_RESET_WEBHOOK_URL || undefined,
  FRONTEND_RESET_URL: parsed.data.FRONTEND_RESET_URL || undefined,
  CORS_ORIGINS: Object.freeze(
    parsed.data.CORS_ORIGIN.split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  ),
});

export { DEVELOPMENT_DATABASE_URL, envSchema };
