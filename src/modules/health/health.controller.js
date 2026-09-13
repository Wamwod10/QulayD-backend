import { env } from "../../config/env.js";
import { errorResponse } from "../../shared/responses/errorResponse.js";
import { sendSuccess } from "../../shared/responses/successResponse.js";

export function createHealthController({ databaseHealthCheck }) {
  return {
    liveness(_request, response) {
      return sendSuccess(response, {
        data: {
          status: "ok",
          service: "qulay-backend",
          version: env.APP_VERSION,
          environment: env.NODE_ENV,
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        },
      });
    },

    async readiness(_request, response) {
      const database = await databaseHealthCheck();
      const data = {
        status: database.ok ? "ready" : "not_ready",
        checks: {
          database: {
            status: database.ok ? "up" : "down",
            latencyMs: database.latencyMs,
          },
        },
        timestamp: new Date().toISOString(),
      };

      if (!database.ok) {
        return response.status(503).json(errorResponse({
          code: "SERVICE_NOT_READY",
          message: "Service dependencies are not ready",
          details: data,
          requestId: response.locals.requestId,
        }));
      }

      return sendSuccess(response, { data });
    },
  };
}

export default createHealthController;
