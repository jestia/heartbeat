// Durations and local-time helpers. Everything takes the clock and time zone as arguments.

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Falls back to UTC when the configured zone is missing or misspelled. */
export function safeTimezone(tz: string | undefined): string {
  try {
    if (tz) return new Intl.DateTimeFormat("en-GB", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    // unknown zone name
  }
  return "UTC";
}

export interface LocalParts {
  weekday: string; // "Mon" .. "Sun"
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatters.get(`${key}|${tz}`);
  if (!f) formatters.set(`${key}|${tz}`, (f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...options })));
  return f;
}

export function localParts(t: number, tz: string): LocalParts {
  const parts = formatter("parts", tz, { weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23" }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) };
}

/**
 * The first full hour after `now` whose local time satisfies `match`. Stepping hour by hour
 * keeps this right across daylight-saving changes without any calendar arithmetic.
 */
export function nextLocal(now: number, tz: string, match: (p: LocalParts) => boolean): number {
  const HOUR = 3_600_000;
  for (let t = Math.floor(now / HOUR) * HOUR + HOUR; t <= now + 32 * 24 * HOUR; t += HOUR) {
    if (match(localParts(t, tz))) return t;
  }
  return now + 7 * 24 * HOUR;
}

/** "14 Nov 03:15" */
export function formatWhen(t: number, tz: string): string {
  return formatter("when", tz, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t).replace(",", "");
}

/** "Mon 16:30" */
export function formatDayTime(t: number, tz: string): string {
  return formatter("daytime", tz, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t).replace(",", "");
}

export function monthName(t: number, tz: string): string {
  return formatter("month", tz, { month: "long" }).format(t);
}

/** Same calendar month in the given zone. */
export function sameMonth(a: number, b: number, tz: string): boolean {
  const pa = localParts(a, tz);
  const pb = localParts(b, tz);
  return pa.year === pb.year && pa.month === pb.month;
}
