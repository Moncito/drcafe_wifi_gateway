import type { DB } from "../db.ts";
import { addDays, dateStartMs, manila, shiftOf } from "../time.ts";

export interface DayCounts { solo_total: number; solo_used: number; group_total: number; group_used: number }

export async function dayCounts(db: DB, date: string): Promise<DayCounts> {
  return (await db.get<DayCounts>(`
    SELECT
      COALESCE(SUM(type = 'S' AND status != 'void'), 0) AS solo_total,
      COALESCE(SUM(type = 'S' AND first_login_at IS NOT NULL), 0) AS solo_used,
      COALESCE(SUM(type = 'G' AND status != 'void'), 0) AS group_total,
      COALESCE(SUM(type = 'G' AND first_login_at IS NOT NULL), 0) AS group_used
    FROM codes WHERE business_date = ?`, date))!;
}

/** Café hours 5 AM … midnight (index 0 = 5 AM … 19 = 12 AM). */
export const HOURS = Array.from({ length: 20 }, (_, i) => (i + 5) % 24);

export function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? "a" : "p"}`;
}

export interface HourBar { hour: number; label: string; n: number; shift: "morning" | "night" }
export interface ShiftCounts { morning: { S: number; G: number }; night: { S: number; G: number } }

export async function usageByHour(db: DB, date: string): Promise<{ bars: HourBar[]; shifts: ShiftCounts }> {
  const rows = await db.all<{ type: "S" | "G"; first_login_at: number }>(
    "SELECT type, first_login_at FROM codes WHERE business_date = ? AND first_login_at IS NOT NULL", date);
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
 * same weekday over the 4 weeks before (only weeks that had slips). null when
 * there is no history yet.
 */
export async function usualByHour(db: DB, date: string): Promise<Map<number, number> | null> {
  const dates = [1, 2, 3, 4].map((w) => addDays(date, -7 * w));
  const rows = await db.all<{ business_date: string; first_login_at: number | null }>(
    `SELECT business_date, first_login_at FROM codes WHERE business_date IN (${dates.map(() => "?").join(",")})`, ...dates);
  const weeks = new Set(rows.map((r) => r.business_date)).size;
  if (!weeks) return null;
  const per = new Map<number, number>();
  for (const r of rows) if (r.first_login_at) per.set(manila(r.first_login_at).h, (per.get(manila(r.first_login_at).h) ?? 0) + 1);
  return new Map([...per].map(([h, n]) => [h, n / weeks]));
}

/** Today's slips the router still has to add (made, not void, not used, not on the router yet). */
export async function routerBacklog(db: DB, date: string): Promise<{ total: number; onRouter: number }> {
  const r = await db.get<{ total: number; onr: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(on_router = 1 OR status != 'unused'), 0) AS onr
       FROM codes WHERE business_date = ? AND status != 'void'`, date);
  return { total: r?.total ?? 0, onRouter: r?.onr ?? 0 };
}

// ---- Reports ------------------------------------------------------------------

export interface ReportDay {
  date: string; dow: number;
  soloUsed: number; groupUsed: number; soloMade: number; groupMade: number;
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
  const rows = await db.all<{ business_date: string; type: "S" | "G"; status: string; first_login_at: number | null }>(
    "SELECT business_date, type, status, first_login_at FROM codes WHERE business_date BETWEEN ? AND ?", prevFirst, lastDate);
  const byDate = new Map<string, ReportDay>();
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    byDate.set(date, { date, dow: manila(dateStartMs(date) + 12 * 3600_000).dow, soloUsed: 0, groupUsed: 0, soloMade: 0, groupMade: 0, morning: 0, night: 0 });
  }
  const heat = Array.from({ length: 7 }, () => HEAT_HOURS.map(() => 0));
  let prevTotal = 0;
  for (const r of rows) {
    const d = byDate.get(r.business_date);
    if (!d) { if (r.first_login_at) prevTotal++; continue; }
    if (r.status !== "void") r.type === "S" ? d.soloMade++ : d.groupMade++;
    if (!r.first_login_at) continue;
    r.type === "S" ? d.soloUsed++ : d.groupUsed++;
    shiftOf(r.first_login_at) === "morning" ? d.morning++ : d.night++;
    const hi = HEAT_HOURS.indexOf(manila(r.first_login_at).h);
    if (hi >= 0) heat[d.dow]![hi]!++;
  }
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
