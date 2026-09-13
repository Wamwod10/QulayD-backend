import { randomUUID } from "node:crypto";

const SAFE_REQUEST_ID = /^[a-zA-Z0-9._:-]{8,100}$/;

export function createId() {
  return randomUUID();
}

export function resolveRequestId(value) {
  const candidate = String(value || "").trim();
  return SAFE_REQUEST_ID.test(candidate) ? candidate : createId();
}
