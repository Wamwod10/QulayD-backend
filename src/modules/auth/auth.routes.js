import { Router } from "express";
import { env } from "../../config/env.js";
import { createApiRateLimiter } from "../../middlewares/rate-limit.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { createAuthController } from "./auth.controller.js";
import { createAuthRepository } from "./auth.repository.js";
import { createAuthService } from "./auth.service.js";
import { authSchemas } from "./auth.validation.js";

export function createAuthRouter({ prisma, authenticate }) {
  const router = Router();
  const controller = createAuthController(createAuthService(createAuthRepository(prisma)));
  const limiter = createApiRateLimiter({ limit: env.AUTH_RATE_LIMIT_MAX, windowMs: 60_000 });
  router.post("/register-owner", limiter, validate(authSchemas.registerOwner), asyncHandler(controller.register));
  router.post("/login", limiter, validate(authSchemas.login), asyncHandler(controller.login));
  router.post("/pin", limiter, validate(authSchemas.pinLogin), asyncHandler(controller.pinLogin));
  router.post("/refresh", limiter, validate(authSchemas.refresh), asyncHandler(controller.refresh));
  router.post("/forgot-password", limiter, validate(authSchemas.forgot), asyncHandler(controller.forgotPassword));
  router.post("/reset-password", limiter, validate(authSchemas.reset), asyncHandler(controller.resetPassword));
  router.get("/me", authenticate, asyncHandler(controller.me));
  router.post("/logout", authenticate, asyncHandler(controller.logout));
  router.post("/change-password", authenticate, validate(authSchemas.change), asyncHandler(controller.changePassword));
  router.get("/sessions", authenticate, asyncHandler(controller.sessions));
  router.delete("/sessions/:id", authenticate, asyncHandler(controller.revokeSession));
  return router;
}
