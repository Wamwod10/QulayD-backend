import { Router } from "express";

import { createHealthController } from "./health.controller.js";

export function createHealthRouter(dependencies) {
  const router = Router();
  const controller = createHealthController(dependencies);

  router.get("/health", controller.liveness);
  router.get("/ready", controller.readiness);

  return router;
}

export default createHealthRouter;
