import type { DB } from "../db.ts";

export interface Settings {
  /** Clock time per code, seconds. Written into each new code's comment. */
  durSeconds: number;
  soloPerDay: number;
  groupPerDay: number;
  extraSolo: number;
  extraGroup: number;
}

const DEFAULTS: Settings = { durSeconds: 3 * 3600, soloPerDay: 150, groupPerDay: 30, extraSolo: 20, extraGroup: 5 };

export async function getSettings(db: DB): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out = { ...DEFAULTS };
  for (const r of rows) {
    if (r.key in out && /^\d+$/.test(r.value)) (out as Record<string, number>)[r.key] = Number(r.value);
  }
  return out;
}

export async function saveSettings(db: DB, s: Partial<Settings>) {
  for (const [k, v] of Object.entries(s)) {
    if (!(k in DEFAULTS) || typeof v !== "number" || !Number.isInteger(v) || v < 0) continue;
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v));
  }
}
