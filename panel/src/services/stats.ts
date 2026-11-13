import type { DB } from "../db.ts";
import { manila, shiftOf } from "../time.ts";

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
