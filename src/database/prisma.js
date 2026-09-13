import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const globalDatabase = globalThis;

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    errorFormat: env.NODE_ENV === "production" ? "minimal" : "pretty",
  });
}

export function getPrisma() {
  if (!globalDatabase.__qulayPrisma) {
    globalDatabase.__qulayPrisma = createPrismaClient();
  }
  return globalDatabase.__qulayPrisma;
}

export async function connectDatabase() {
  const prisma = getPrisma();
  await prisma.$connect();
  logger.info("PostgreSQL connection established");
  return prisma;
}

export async function disconnectDatabase() {
  if (!globalDatabase.__qulayPrisma) return;
  await globalDatabase.__qulayPrisma.$disconnect();
  globalDatabase.__qulayPrisma = undefined;
  logger.info("PostgreSQL connection closed");
}

export function setPrismaForTests(client) {
  if (env.NODE_ENV !== "test") {
    throw new Error("setPrismaForTests can only be used in the test environment");
  }
  globalDatabase.__qulayPrisma = client;
}

export default getPrisma;
