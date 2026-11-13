// All café times are Manila time (UTC+8, no daylight saving), computed without
// relying on the counter PC's own time zone setting.
const MANILA_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;

/** The café day runs 07:00 – 01:00. 01:00 – 05:00 is the closed window. */
export const CLOSED_FROM_HOUR = 1;
export const CLOSED_UNTIL_HOUR = 5;

export interface ManilaParts { y: number; m: number; d: number; h: number; mi: number; s: number; dow: number }

export function manila(ms: number): ManilaParts {
  const t = new Date(ms + MANILA_OFFSET_MS);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), dow: t.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Business date (YYYY-MM-DD): times before 05:00 belong to the previous day. */
export function businessDate(ms: number): string {
  const p = manila(ms - CLOSED_UNTIL_HOUR * 3600_000);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function isClosedWindow(ms: number): boolean {
  const h = manila(ms).h;
  return h >= CLOSED_FROM_HOUR && h < CLOSED_UNTIL_HOUR;
}

/** UTC ms of 00:00 Manila on a business date. */
export function dateStartMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - MANILA_OFFSET_MS;
}

/** UTC ms of the 1:00 AM closing that ends a business date. */
export function closingMs(date: string): number {
  return dateStartMs(date) + DAY_MS + 3600_000;
}

/** Router stores "Manila wall clock seconds since 1970 counted as UTC" (see router/src/drc-epoch.rsc). */
export function routerEpochToMs(epoch: number): number {
  return epoch * 1000 - MANILA_OFFSET_MS;
}
export function msToRouterEpoch(ms: number): number {
  return Math.floor((ms + MANILA_OFFSET_MS) / 1000);
}

export function shiftOf(ms: number): "morning" | "night" {
  const h = manila(ms).h;
  return h >= CLOSED_UNTIL_HOUR && h < 16 ? "morning" : "night";
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatClock(ms: number): string {
  const p = manila(ms);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${pad(p.mi)} ${p.h < 12 ? "AM" : "PM"}`;
}

/** "Saturday, Nov 14, 2026" */
export function formatDateLong(date: string): string {
  const p = manila(dateStartMs(date));
  return `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/** "Sat, Nov 14" */
export function formatDateShort(date: string): string {
  const p = manila(dateStartMs(date));
  return `${DAYS[p.dow]!.slice(0, 3)}, ${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Today, 6:30 PM" / "Nov 13, 10:14 PM" */
export function formatWhen(ms: number, now: number): string {
  if (businessDate(ms) === businessDate(now)) return `Today, ${formatClock(ms)}`;
  const p = manila(ms);
  return `${MONTHS[p.m - 1]} ${p.d}, ${formatClock(ms)}`;
}

/** "6h 18m" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(total / 60)}h ${pad(total % 60)}m`;
}

export function addDays(date: string, n: number): string {
  return businessDate(dateStartMs(date) + n * DAY_MS + 12 * 3600_000);
}
