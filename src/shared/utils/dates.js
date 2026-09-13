export function nowIso() {
  return new Date().toISOString();
}

export function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}
