/** Inclusive start, exclusive end, both UTC milliseconds. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Pull one time window out of a query. Weeks start on Monday, UTC.
 * No cue returns null. The leftmost cue wins; a longer cue wins a tie.
 */
export function parseTimeWindow(query: string, now: Date): TimeWindow | null {
  const text = query.toLowerCase();
  const hits: Array<{ index: number; length: number; window: TimeWindow }> = [];
  const consider = (index: number, length: number, window: TimeWindow | null) => {
    if (!window || index < 0) return;
    hits.push({ index, length, window });
  };

  for (const match of text.matchAll(new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`, "g"))) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    consider(match.index ?? -1, match[0].length, utcDayWindow(year, month - 1, day));
  }

  const monthDay = new RegExp(
    `\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    "g",
  );
  for (const match of text.matchAll(monthDay)) {
    const month = monthIndex(match[1] ?? "");
    const day = Number(match[2]);
    const explicit = match[3] ? Number(match[3]) : undefined;
    if (month == null) continue;
    const year = yearForDay(month, day, now, explicit);
    consider(match.index ?? -1, match[0].length, utcDayWindow(year, month, day));
  }

  const dayMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})(?:\\s+(\\d{4}))?\\b`,
    "g",
  );
  for (const match of text.matchAll(dayMonth)) {
    const day = Number(match[1]);
    const month = monthIndex(match[2] ?? "");
    const explicit = match[3] ? Number(match[3]) : undefined;
    if (month == null) continue;
    const year = yearForDay(month, day, now, explicit);
    consider(match.index ?? -1, match[0].length, utcDayWindow(year, month, day));
  }

  const inMonth = new RegExp(`\\bin\\s+(${MONTH})(?:\\s+(\\d{4}))?\\b`, "g");
  for (const match of text.matchAll(inMonth)) {
    const month = monthIndex(match[1] ?? "");
    if (month == null) continue;
    const year = yearForMonth(month, now, match[2] ? Number(match[2]) : undefined);
    consider(match.index ?? -1, match[0].length, utcMonthWindow(year, month));
  }

  const monthYear = new RegExp(`\\b(${MONTH})\\s+(\\d{4})\\b`, "g");
  for (const match of text.matchAll(monthYear)) {
    const month = monthIndex(match[1] ?? "");
    if (month == null) continue;
    consider(match.index ?? -1, match[0].length, utcMonthWindow(Number(match[2]), month));
  }

  consider(indexOf(text, /\byesterday\b/), "yesterday".length, shiftDays(startOfUtcDay(now), -1, 1));
  consider(indexOf(text, /\btoday\b/), "today".length, shiftDays(startOfUtcDay(now), 0, 1));
  consider(indexOf(text, /\btomorrow\b/), "tomorrow".length, shiftDays(startOfUtcDay(now), 1, 1));
  consider(indexOf(text, /\blast week\b/), "last week".length, shiftDays(startOfUtcWeek(now), -7, 7));
  consider(indexOf(text, /\bthis week\b/), "this week".length, shiftDays(startOfUtcWeek(now), 0, 7));
  consider(indexOf(text, /\blast month\b/), "last month".length, adjacentMonth(now, -1));
  consider(indexOf(text, /\bthis month\b/), "this month".length, adjacentMonth(now, 0));

  hits.sort((left, right) => left.index - right.index || right.length - left.length);
  return hits[0]?.window ?? null;
}

export function eventInstant(occurrenceTime: string | null, mentionedAt: string): number | null {
  const raw = occurrenceTime ?? mentionedAt;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export function inTimeWindow(ms: number, window: TimeWindow): boolean {
  return ms >= window.startMs && ms < window.endMs;
}

function indexOf(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match?.index ?? -1;
}

function monthIndex(word: string): number | null {
  const key = word.slice(0, 3);
  const index = MONTH_INDEX[key];
  return index == null ? null : index;
}

function yearForMonth(month: number, now: Date, explicit: number | undefined): number {
  if (explicit != null) return explicit;
  const start = Date.UTC(now.getUTCFullYear(), month, 1);
  return start <= now.getTime() ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function yearForDay(month: number, day: number, now: Date, explicit: number | undefined): number {
  if (explicit != null) return explicit;
  const start = Date.UTC(now.getUTCFullYear(), month, day);
  return start <= now.getTime() ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function utcDayWindow(year: number, month: number, day: number): TimeWindow | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const startMs = Date.UTC(year, month, day);
  const probe = new Date(startMs);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return { startMs, endMs: Date.UTC(year, month, day + 1) };
}

function utcMonthWindow(year: number, month: number): TimeWindow | null {
  if (!Number.isInteger(year) || month < 0 || month > 11) return null;
  return { startMs: Date.UTC(year, month, 1), endMs: Date.UTC(year, month + 1, 1) };
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function startOfUtcWeek(now: Date): number {
  const day = startOfUtcDay(now);
  const weekday = new Date(day).getUTCDay();
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;
  return day - sinceMonday * 86_400_000;
}

function shiftDays(startMs: number, offsetDays: number, lengthDays: number): TimeWindow {
  const start = startMs + offsetDays * 86_400_000;
  return { startMs: start, endMs: start + lengthDays * 86_400_000 };
}

function adjacentMonth(now: Date, delta: number): TimeWindow {
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1);
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta + 1, 1);
  return { startMs, endMs };
}
