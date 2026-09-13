import { disconnectDatabase, getPrisma } from "../src/database/prisma.js";
import { logger } from "../src/config/logger.js";
import { ensurePermissionCatalog } from "../src/modules/access-control/access-control.bootstrap.js";

async function seed() {
  const permissions = await ensurePermissionCatalog(getPrisma());
  logger.info({ count: permissions.length }, "QULAY permission catalog seeded");
}

seed()
  .catch((error) => {
    logger.error({ error }, "Database seed failed");
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
