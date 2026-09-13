import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import swaggerUi from "swagger-ui-express";
import { parse } from "yaml";

import { env } from "./env.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const specificationPath = resolve(currentDirectory, "../../docs/openapi.yaml");

let cachedSpecification;

export function getOpenApiSpecification() {
  if (!cachedSpecification) {
    cachedSpecification = parse(readFileSync(specificationPath, "utf8"));
  }
  return cachedSpecification;
}

export function installSwagger(app) {
  if (!env.SWAGGER_ENABLED) return;
  const specification = getOpenApiSpecification();
  app.get("/docs/openapi.json", (_request, response) => response.json(specification));
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(specification, {
      customSiteTitle: "Qulay API",
      swaggerOptions: { displayRequestDuration: true, persistAuthorization: true },
    }),
  );
}

export default installSwagger;
