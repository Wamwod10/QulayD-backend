import { rateLimit } from "express-rate-limit";

import { env } from "../config/env.js";
import { errorResponse } from "../shared/responses/errorResponse.js";

export function createApiRateLimiter({
  windowMs = env.RATE_LIMIT_WINDOW_MS,
  limit = env.RATE_LIMIT_MAX,
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (request) => request.method === "OPTIONS" || request.path.endsWith("/health"),
    handler: (_request, response) => response.status(429).json(errorResponse({
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please try again later.",
      requestId: response.locals.requestId,
    })),
  });
}

export default createApiRateLimiter;
