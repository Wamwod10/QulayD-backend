import { ZodError } from "zod";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AppError } from "../shared/errors/AppError.js";
import { errorResponse } from "../shared/responses/errorResponse.js";

function normalizeError(error) {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError("Request validation failed", {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      details: {
        fields: error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }

  if (error?.type === "entity.parse.failed") {
    return new AppError("Request body contains invalid JSON", {
      statusCode: 400,
      code: "INVALID_JSON",
    });
  }

  if (error?.type === "entity.too.large") {
    return new AppError("Request body is too large", {
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  }

  if (error?.code === "LIMIT_FILE_SIZE") {
    return new AppError("Uploaded file is too large", { statusCode: 413, code: "UPLOAD_TOO_LARGE" });
  }

  if (String(error?.code || "").startsWith("LIMIT_")) {
    return new AppError("Invalid multipart upload", { statusCode: 422, code: "INVALID_UPLOAD" });
  }

  if (error?.code === "P2002") {
    return new AppError("A record with the same unique value already exists", {
      statusCode: 409,
      code: "UNIQUE_CONSTRAINT_VIOLATION",
      details: { fields: error.meta?.target || [] },
    });
  }

  if (error?.code === "P2025") {
    return new AppError("Requested resource was not found", {
      statusCode: 404,
      code: "NOT_FOUND",
    });
  }

  if (error?.code === "P2003") {
    return new AppError("Referenced resource does not exist", { statusCode: 422, code: "FOREIGN_KEY_CONSTRAINT" });
  }

  if (error?.code === "P2034") {
    return new AppError("Transaction conflicted with another request; retry safely", { statusCode: 409, code: "TRANSACTION_CONFLICT" });
  }

  if (Number.isInteger(error?.statusCode) && error?.code) {
    return new AppError(error.message, {
      statusCode: error.statusCode,
      code: error.code,
      details: error.details,
    });
  }

  return new AppError("Internal server error", {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    cause: error,
    isOperational: false,
  });
}

export function errorMiddleware(error, request, response, _next) {
  const normalized = normalizeError(error);
  const logPayload = {
    requestId: response.locals.requestId || request.id,
    method: request.method,
    path: request.originalUrl,
    statusCode: normalized.statusCode,
    code: normalized.code,
    error,
  };

  if (normalized.statusCode >= 500) logger.error(logPayload, "Request failed");
  else logger.warn(logPayload, "Request rejected");

  const revealDetails = normalized.isOperational || env.NODE_ENV !== "production";
  response.status(normalized.statusCode).json(errorResponse({
    code: normalized.code,
    message: normalized.message,
    details: revealDetails ? normalized.details : undefined,
    requestId: response.locals.requestId || request.id,
  }));
}

export { normalizeError };
export default errorMiddleware;
