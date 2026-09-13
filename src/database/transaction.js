import { getPrisma } from "./prisma.js";

export async function withTransaction(operation, {
  isolationLevel = "Serializable",
  maxWait = 5_000,
  timeout = 15_000,
} = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Transaction operation must be a function");
  }

  return getPrisma().$transaction(operation, {
    isolationLevel,
    maxWait,
    timeout,
  });
}

export default withTransaction;
