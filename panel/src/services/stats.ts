import type { DB } from "../db.ts";
import { addDays, businessDate, closingMs, dateStartMs, manila, shiftOf } from "../time.ts";

/** A café day runs 05:00 – 01:00; first logins in that window count for the day. */
export function dayWindow(date: string): [number, number] {
  return [dateStartMs(date) + 5 * 3600_000, closingMs(date)];
}

export interface Stock {
  /** printed slips not used yet and still valid (they carry over day to day) */
  solo: number; group: number;
  /** of those, how many stop within 7 days */
  expiringSoon: number;
  /** codes first used today (printed or given on screen) */
  soloUsedToday: number; groupUsedToday: number;
  /** codes given on screen today */
  givenToday: number;
}

export async function stock(db: DB, date: string, now = Date.now()): Promise<Stock> {
  const [from, to] = dayWindow(date);
  const r = await db.get<{ s: number; g: number; soon: number; su: number; gu: number; given: number }>(`
    SELECT
      COALESCE(SUM(c.status = 'unused' AND c.valid_until > ? AND b.pool = 0 AND c.type = 'S'), 0) AS s,
      COALESCE(SUM(c.status = 'unused' AND c.valid_until > ? AND b.pool = 0 AND c.type = 'G'), 0) AS g,
      COALESCE(SUM(c.status = 'unused' AND c.valid_until > ? AND b.pool = 0 AND c.valid_until <= ?), 0) AS soon,
      COALESCE(SUM(c.first_login_at BETWEEN ? AND ? AND c.type = 'S'), 0) AS su,
      COALESCE(SUM(c.first_login_at BETWEEN ? AND ? AND c.type = 'G'), 0) AS gu,
      COALESCE(SUM(c.issued_at BETWEEN ? AND ?), 0) AS given
    FROM codes c JOIN batches b ON b.id = c.batch_id
    WHERE c.status IN ('unused', 'active', 'expired')`,
    now, now, now, now + 7 * 86_400_000, from, to, from, to, from, to);
  return { solo: r!.s, group: r!.g, expiringSoon: r!.soon, soloUsedToday: r!.su, groupUsedToday: r!.gu, givenToday: r!.given };
}

/** Café hours 5 AM … midnight (index 0 = 5 AM … 19 = 12 AM). */
export const HOURS = Array.from({ length: 20 }, (_, i) => (i + 5) % 24);

export function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? "a" : "p"}`;
}

export interface HourBar { hour: number; label: string; n: number; shift: "morning" | "night" }
export interface ShiftCounts { morning: { S: number; G: number }; night: { S: number; G: number } }

function firstLogins(db: DB, date: string) {
  const [from, to] = dayWindow(date);
  return db.all<{ type: "S" | "G"; first_login_at: number }>(
    "SELECT type, first_login_at FROM codes WHERE first_login_at BETWEEN ? AND ?", from, to);
}

export async function usageByHour(db: DB, date: string): Promise<{ bars: HourBar[]; shifts: ShiftCounts }> {
  const rows = await firstLogins(db, date);
  const perHour = new Map<number, number>();
  const shifts: ShiftCounts = { morning: { S: 0, G: 0 }, night: { S: 0, G: 0 } };
  for (const r of rows) {
    const h = manila(r.first_login_at).h;
    perHour.set(h, (perHour.get(h) ?? 0) + 1);
    shifts[shiftOf(r.first_login_at)][r.type]++;
  }
  // show 7a–12a always, plus 5–6 AM only if something happened then
  const bars = HOURS
    .filter((h) => h >= 7 || h === 0 || (perHour.get(h) ?? 0) > 0)
    .map((h) => ({ hour: h, label: hourLabel(h), n: perHour.get(h) ?? 0, shift: (h >= 5 && h < 16 ? "morning" : "night") as "morning" | "night" }));
  return { bars, shifts };
}

/**
 * The usual number of first logins per hour on this weekday: the average of the
 * same weekday over the 4 weeks before (only weeks that had any). null when
 * there is no history yet.
 */
export async function usualByHour(db: DB, date: string): Promise<Map<number, number> | null> {
  const per = new Map<number, number>();
  let weeks = 0;
  for (const w of [1, 2, 3, 4]) {
    const rows = await firstLogins(db, addDays(date, -7 * w));
    if (!rows.length) continue;
    weeks++;
    for (const r of rows) per.set(manila(r.first_login_at).h, (per.get(manila(r.first_login_at).h) ?? 0) + 1);
  }
  if (!weeks) return null;
  return new Map([...per].map(([h, n]) => [h, n / weeks]));
}

/** Printed slips the router still has to add (unused, valid, not on the router yet). */
export async function routerBacklog(db: DB, date: string, now = Date.now()): Promise<{ total: number; onRouter: number }> {
  const r = await db.get<{ total: number; onr: number }>(`
    SELECT COUNT(*) AS total, COALESCE(SUM(c.on_router), 0) AS onr
      FROM codes c JOIN batches b ON b.id = c.batch_id
     WHERE b.pool = 0 AND c.status = 'unused' AND c.valid_until > ? AND c.business_date <= ?`, now, date);
  return { total: r?.total ?? 0, onRouter: r?.onr ?? 0 };
}

// ---- Reports ------------------------------------------------------------------

export interface ReportDay {
  date: string; dow: number;
  soloUsed: number; groupUsed: number;
  /** slips printed that day */
  printed: number;
  /** printed slips that reached their validity unused that day (paper wasted) */
  wasted: number;
  given: number;
  morning: number; night: number;
}

export interface Report {
  days: ReportDay[];
  /** [weekday 0=Sun][hour index in HEAT_HOURS] first logins */
  heat: number[][];
  prevTotal: number;
}

/** Café hours shown in the heatmap: 7 AM … 12 AM */
export const HEAT_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0];

export async function report(db: DB, lastDate: string, days: number): Promise<Report> {
  const first = addDays(lastDate, -(days - 1));
  const prevFirst = addDays(first, -days);
  const from = dayWindow(prevFirst)[0], to = dayWindow(lastDate)[1];
  const byDate = new Map<string, ReportDay>();
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    byDate.set(date, { date, dow: manila(dateStartMs(date) + 12 * 3600_000).dow, soloUsed: 0, groupUsed: 0, printed: 0, wasted: 0, given: 0, morning: 0, night: 0 });
  }
  const heat = Array.from({ length: 7 }, () => HEAT_HOURS.map(() => 0));
  let prevTotal = 0;

  const used = await db.all<{ type: "S" | "G"; first_login_at: number }>(
    "SELECT type, first_login_at FROM codes WHERE first_login_at BETWEEN ? AND ?", from, to);
  for (const r of used) {
    const d = byDate.get(businessDate(r.first_login_at));
    if (!d) { prevTotal++; continue; }
    r.type === "S" ? d.soloUsed++ : d.groupUsed++;
    shiftOf(r.first_login_at) === "morning" ? d.morning++ : d.night++;
    const hi = HEAT_HOURS.indexOf(manila(r.first_login_at).h);
    if (hi >= 0) heat[d.dow]![hi]!++;
  }
  const printed = await db.all<{ business_date: string; n: number }>(`
    SELECT c.business_date, COUNT(*) AS n FROM codes c JOIN batches b ON b.id = c.batch_id
     WHERE b.pool = 0 AND c.business_date BETWEEN ? AND ? GROUP BY c.business_date`, first, lastDate);
  for (const p of printed) { const d = byDate.get(p.business_date); if (d) d.printed = p.n; }
  const wasted = await db.all<{ expired_at: number }>(`
    SELECT c.expired_at FROM codes c JOIN batches b ON b.id = c.batch_id
     WHERE b.pool = 0 AND c.status = 'expired' AND c.first_login_at IS NULL AND c.expired_at BETWEEN ? AND ?`, dayWindow(first)[0], to);
  for (const w of wasted) { const d = byDate.get(businessDate(w.expired_at - 1)); if (d) d.wasted++; }
  const given = await db.all<{ issued_at: number }>("SELECT issued_at FROM codes WHERE issued_at BETWEEN ? AND ?", dayWindow(first)[0], to);
  for (const g of given) { const d = byDate.get(businessDate(g.issued_at)); if (d) d.given++; }
  return { days: [...byDate.values()], heat, prevTotal };
}

export interface DrinkCount { business_date: string; shift: "morning" | "night"; drinks: number }

export function drinkCounts(db: DB, from: string, to: string) {
  return db.all<DrinkCount>("SELECT business_date, shift, drinks FROM shift_drinks WHERE business_date BETWEEN ? AND ?", from, to);
}

export async function saveDrinkCount(db: DB, date: string, shift: "morning" | "night", drinks: number | null, staffId: number) {
  if (drinks === null) {
    await db.run("DELETE FROM shift_drinks WHERE business_date = ? AND shift = ?", date, shift);
    return;
  }
  await db.run(`INSERT INTO shift_drinks (business_date, shift, drinks, staff_id, saved_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(business_date, shift) DO UPDATE SET drinks = excluded.drinks, staff_id = excluded.staff_id, saved_at = excluded.saved_at`,
    date, shift, drinks, staffId, Date.now());
}

// ---- Print page: recent prints ------------------------------------------------------

export interface PrintRow {
  id: number; created_at: number; created_by: string | null; state: string;
  solo_count: number; group_count: number; dur_seconds: number;
  valid_until: number; unused: number; used: number; voided: number; total: number;
}

/** Printed batches of the last 30 days, newest first, with how many slips are left in each. */
export function recentPrints(db: DB, now = Date.now()) {
  return db.all<PrintRow>(`
    SELECT b.id, b.created_at, s.display_name AS created_by, b.state, b.solo_count, b.group_count, b.dur_seconds,
      MAX(c.valid_until) AS valid_until,
      COALESCE(SUM(c.status = 'unused' AND c.valid_until > ?), 0) AS unused,
      COALESCE(SUM(c.first_login_at IS NOT NULL), 0) AS used,
      COALESCE(SUM(c.status = 'void'), 0) AS voided,
      COUNT(c.id) AS total
    FROM batches b JOIN codes c ON c.batch_id = b.id LEFT JOIN staff s ON s.id = b.created_by
    WHERE b.pool = 0 AND b.created_at > ?
    GROUP BY b.id ORDER BY b.id DESC LIMIT 30`, now, now - 31 * 86_400_000);
}
