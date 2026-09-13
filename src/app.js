import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import path from "node:path";
import helmet from "helmet";
import morgan from "morgan";

import { createCorsOptions } from "./config/cors.js";
import { env } from "./config/env.js";
import { createHttpLogStream } from "./config/logger.js";
import { installSwagger } from "./config/swagger.js";
import {
  createApiRateLimiter,
  errorMiddleware,
  notFoundMiddleware,
  requestIdMiddleware,
} from "./middlewares/index.js";
import { createApiRouter } from "./routes/index.js";
import { sendSuccess } from "./shared/responses/successResponse.js";

const HTTP_LOG_FORMAT = ":method :url :status :response-time ms requestId=:request-id";

export function createApp(dependencies = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(requestIdMiddleware);
  morgan.token("request-id", (request) => request.id || "-");
  app.use(morgan(HTTP_LOG_FORMAT, {
    stream: createHttpLogStream(),
    skip: () => env.NODE_ENV === "test",
  }));
  app.use(helmet({
    contentSecurityPolicy: env.SWAGGER_ENABLED ? false : undefined,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors(createCorsOptions()));
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: env.BODY_LIMIT, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));
  app.use("/uploads", express.static(path.resolve(env.UPLOAD_DIR), { dotfiles: "deny", fallthrough: false, immutable: true, maxAge: "7d" }));

  app.get("/", (_request, response) => sendSuccess(response, {
    data: {
      service: "qulay-backend",
      api: env.API_PREFIX,
      documentation: env.SWAGGER_ENABLED ? "/docs" : null,
    },
  }));

  installSwagger(app);
  app.use(env.API_PREFIX, createApiRateLimiter(), createApiRouter(dependencies));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

export default createApp;
