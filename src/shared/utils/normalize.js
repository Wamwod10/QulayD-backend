export function normalizePhone(value = "") {
  return String(value).replace(/[^\d+]/g, "").trim();
}

export function normalizeText(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

export function normalizeCode(value = "") {
  return normalizeText(value).toUpperCase();
}
