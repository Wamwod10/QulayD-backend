import "dotenv/config";
import { defineConfig } from "prisma/config";

const fallbackDatabaseUrl = "postgresql://postgres:postgres@localhost:5432/qulay?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.js",
  },
  datasource: {
    // Migrations must use a session-capable (non-pooler) URL when available.
    // Runtime application connections continue to use DATABASE_URL.
    url:
      process.env.PRISMA_MIGRATE_DATABASE_URL ||
      process.env.DIRECT_DATABASE_URL ||
      process.env.DATABASE_URL ||
      fallbackDatabaseUrl,
  },
});
