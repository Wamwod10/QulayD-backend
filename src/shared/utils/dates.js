export function nowIso() {
  return new Date().toISOString();
}

export function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

export function dateKeyForTimeZone(date = new Date(), timeZone = "Asia/Tashkent") {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return representedAsUtc - date.getTime();
}

export function zonedDateTimeToUtc(dateKey, timeZone = "Asia/Tashkent", { hour = 0, minute = 0, second = 0, millisecond = 0 } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) return new Date(dateKey);
  const [, year, month, day] = match;
  let guess = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, second, millisecond));
  try {
    let offset = timeZoneOffsetMs(guess, timeZone);
    let result = new Date(guess.getTime() - offset);
    const correctedOffset = timeZoneOffsetMs(result, timeZone);
    if (correctedOffset !== offset) result = new Date(guess.getTime() - correctedOffset);
    return result;
  } catch {
    return guess;
  }
}

export function dayRangeForTimeZone(date = new Date(), timeZone = "Asia/Tashkent") {
  const key = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dateKeyForTimeZone(date instanceof Date ? date : new Date(date), timeZone);
  const start = zonedDateTimeToUtc(key, timeZone);
  const nextKeyDate = new Date(`${key}T12:00:00.000Z`);
  nextKeyDate.setUTCDate(nextKeyDate.getUTCDate() + 1);
  const nextKey = nextKeyDate.toISOString().slice(0, 10);
  const end = zonedDateTimeToUtc(nextKey, timeZone);
  return { key, start, end };
}
