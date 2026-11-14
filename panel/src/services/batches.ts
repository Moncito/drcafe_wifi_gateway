import { randomCode, serialLabel, type CodeStatus, type CodeType } from "../codes.ts";
import type { DB } from "../db.ts";
import { addDays, businessDate, formatDateShort, isClosedWindow } from "../time.ts";
import { audit } from "./audit.ts";
import { getSettings } from "./settings.ts";

export interface Batch {
  id: number;
  business_date: string;
  kind: "daily" | "extra";
  solo_count: number;
  group_count: number;
  dur_seconds: number;
  state: "pending" | "on_router" | "printed" | "void";
  request_id: string;
  created_by: number | null;
  created_at: number;
  pushed_at: number | null;
  printed_at: number | null;
  printed_by: number | null;
  last_error: string | null;
}

export interface CodeRow {
  id: number;
  code: string;
  type: CodeType;
  serial: number;
  business_date: string;
  batch_id: number;
  dur_seconds: number;
  on_router: number;
  status: CodeStatus;
  first_login_at: number | null;
  ends_at: number | null;
  expired_at: number | null;
  voided_at: number | null;
}

export class UserError extends Error {}

const MAX_PER_TYPE = 600;

export function getBatch(db: DB, id: number) {
  return db.get<Batch>("SELECT * FROM batches WHERE id = ?", id);
}
export function dailyBatch(db: DB, date: string) {
  return db.get<Batch>("SELECT * FROM batches WHERE business_date = ? AND kind = 'daily' AND state != 'void'", date);
}
export function batchesForDate(db: DB, date: string) {
  return db.all<Batch>("SELECT * FROM batches WHERE business_date = ? ORDER BY id", date);
}
/** Codes in print order: solo first, then group, by serial. */
export function codesForBatch(db: DB, batchId: number) {
  return db.all<CodeRow>("SELECT * FROM codes WHERE batch_id = ? ORDER BY type DESC, serial", batchId);
}
export function findCode(db: DB, code: string) {
  return db.get<CodeRow>("SELECT * FROM codes WHERE code = ?", code);
}
export function findBySerial(db: DB, date: string, type: CodeType, serial: number) {
  return db.get<CodeRow>("SELECT * FROM codes WHERE business_date = ? AND type = ? AND serial = ?", date, type, serial);
}
export function codesBySerialRange(db: DB, date: string, type: CodeType, from: number, to: number) {
  return db.all<CodeRow>("SELECT * FROM codes WHERE business_date = ? AND type = ? AND serial BETWEEN ? AND ? ORDER BY serial", date, type, from, to);
}

/**
 * Make slips: allocate serials and unique codes (state "pending"). The router
 * picks them up on its next call (every ~20 s) and the batch becomes
 * "on_router" once the router reports every code. Idempotent per requestId:
 * a double-clicked or retried form returns the batch it already made.
 */
export async function createBatch(
  db: DB,
  opts: { kind: "daily" | "extra"; solo: number; group: number; requestId: string; staffId: number; day?: "today" | "tomorrow"; now?: number },
): Promise<Batch> {
  const now = opts.now ?? Date.now();
  const same = await db.get<Batch>("SELECT * FROM batches WHERE request_id = ?", opts.requestId);
  if (same) return same;

  const date = batchDate(opts.day ?? "today", now);
  const solo = Math.trunc(opts.solo), group = Math.trunc(opts.group);
  if (!(solo >= 0 && group >= 0 && solo <= MAX_PER_TYPE && group <= MAX_PER_TYPE)) throw new UserError(`Counts must be between 0 and ${MAX_PER_TYPE}.`);
  if (solo + group === 0) throw new UserError("Choose at least one slip.");
  if (opts.kind === "daily" && (await dailyBatch(db, date))) throw new UserError(`The batch for ${formatDateShort(date)} already exists. Use “Ran out?” for extra slips, or reprint a page.`);

  const dur = (await getSettings(db)).durSeconds;
  return db.tx(async (t) => {
    const r = await t.run(`INSERT INTO batches (business_date, kind, solo_count, group_count, dur_seconds, request_id, created_by, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, date, opts.kind, solo, group, dur, opts.requestId, opts.staffId, now);
    const batchId = r.lastInsertRowid;
    for (const [type, count] of [["S", solo], ["G", group]] as const) {
      if (!count) continue;
      const max = (await t.get<{ m: number | null }>("SELECT MAX(serial) AS m FROM codes WHERE business_date = ? AND type = ?", date, type))!.m ?? 0;
      // pick unique codes: generate, then drop any that already exist (for all time)
      const picked = new Set<string>();
      while (picked.size < count) {
        const want: string[] = [];
        while (want.length < (count - picked.size) * 2) {
          const c = randomCode(type);
          if (!picked.has(c) && !want.includes(c)) want.push(c);
        }
        const taken = new Set((await t.all<{ code: string }>(`SELECT code FROM codes WHERE code IN (${want.map(() => "?").join(",")})`, ...want)).map((x) => x.code));
        for (const c of want) if (!taken.has(c) && picked.size < count) picked.add(c);
      }
      // insert in chunks (one round trip per 100 codes, fast on a cloud database)
      const list = [...picked];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const args = chunk.flatMap((c, j) => [c, type, max + i + j + 1, date, batchId, dur]);
        await t.run(`INSERT INTO codes (code, type, serial, business_date, batch_id, dur_seconds) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(",")}`, ...args);
      }
    }
    await audit(t, "batch_created", { staffId: opts.staffId, detail: `#${batchId} ${opts.kind}: ${solo} solo + ${group} group`, at: now });
    return (await t.get<Batch>("SELECT * FROM batches WHERE id = ?", batchId))!;
  });
}

/**
 * The café day a new batch is for. Tomorrow's slips can be made and printed at
 * any time (also after closing): they stay in the cloud and the router only gets
 * them when that day starts at 5:00 AM, so the 1:00 AM closing cannot delete them.
 * Today's slips cannot be made in the 1:00–5:00 AM closed window (today is over).
 */
export function batchDate(day: "today" | "tomorrow", now = Date.now()): string {
  const today = businessDate(now);
  if (day === "tomorrow") return addDays(today, 1);
  if (isClosedWindow(now)) throw new UserError("Today's café day ended at the 1:00 AM closing. Make the slips for tomorrow instead (they start working at 5:00 AM).");
  return today;
}

/** A batch for a later day than today: printable before its codes are on the router. */
export function isAdvance(b: Pick<Batch, "business_date">, now = Date.now()): boolean {
  return b.business_date > businessDate(now);
}

/** How many of a batch's (non-void) codes the router has confirmed. */
export async function batchProgress(db: DB, batchId: number): Promise<{ total: number; onRouter: number }> {
  const r = await db.get<{ total: number; onr: number }>(
    "SELECT COUNT(*) AS total, COALESCE(SUM(on_router), 0) AS onr FROM codes WHERE batch_id = ? AND status != 'void'", batchId);
  return { total: r?.total ?? 0, onRouter: r?.onr ?? 0 };
}

export async function markPrinted(db: DB, batchId: number, staffId: number, now = Date.now()) {
  const b = await getBatch(db, batchId);
  if (!b) throw new UserError("No such batch.");
  if (b.state === "pending" && !isAdvance(b, now)) throw new UserError("Not all codes are on the router yet; wait for them before printing.");
  if (b.state === "void") throw new UserError("This batch was voided.");
  const first = b.state !== "printed";
  await db.run("UPDATE batches SET state = 'printed', printed_at = COALESCE(printed_at, ?), printed_by = COALESCE(printed_by, ?) WHERE id = ?", now, staffId, batchId);
  await audit(db, "batch_printed", { staffId, detail: `#${batchId}${first ? "" : " (reprint)"}` });
}

/**
 * Cancel codes. They are marked void at once (the panel shows them as void);
 * the router deletes them and kicks their devices on its next call (~20 s).
 */
export async function voidCodes(db: DB, codes: CodeRow[], staffId: number, reason: string, now = Date.now()): Promise<{ voided: string[] }> {
  const targets = codes.filter((c) => c.status !== "void");
  if (!targets.length) return { voided: [] };
  await db.tx(async (t) => {
    for (let i = 0; i < targets.length; i += 200) {
      const ids = targets.slice(i, i + 200).map((c) => c.id);
      await t.run(`UPDATE codes SET status = 'void', voided_at = ?, voided_by = ? WHERE id IN (${ids.map(() => "?").join(",")})`, now, staffId, ...ids);
    }
    for (const c of targets) await audit(t, "void", { staffId, code: c.code, detail: reason, at: now });
    const batchIds = [...new Set(targets.map((c) => c.batch_id))];
    await t.run(`UPDATE batches SET state = 'void'
                 WHERE state != 'void' AND id IN (${batchIds.map(() => "?").join(",")})
                   AND NOT EXISTS (SELECT 1 FROM codes c WHERE c.batch_id = batches.id AND c.status != 'void')`, ...batchIds);
  });
  return { voided: targets.map((c) => c.code) };
}

export interface DaySummary {
  business_date: string;
  daily: number; extra: number;
  solo_total: number; solo_used: number;
  group_total: number; group_used: number;
  printed_by: string | null;
}

export function pastDays(db: DB, limit: number) {
  return db.all<DaySummary>(`
    SELECT c.business_date,
      SUM(CASE WHEN b.kind = 'daily' AND c.status != 'void' THEN 1 ELSE 0 END) AS daily,
      SUM(CASE WHEN b.kind = 'extra' AND c.status != 'void' THEN 1 ELSE 0 END) AS extra,
      SUM(CASE WHEN c.type = 'S' AND c.status != 'void' THEN 1 ELSE 0 END) AS solo_total,
      SUM(CASE WHEN c.type = 'S' AND c.first_login_at IS NOT NULL THEN 1 ELSE 0 END) AS solo_used,
      SUM(CASE WHEN c.type = 'G' AND c.status != 'void' THEN 1 ELSE 0 END) AS group_total,
      SUM(CASE WHEN c.type = 'G' AND c.first_login_at IS NOT NULL THEN 1 ELSE 0 END) AS group_used,
      (SELECT s.display_name FROM batches d JOIN staff s ON s.id = COALESCE(d.printed_by, d.created_by)
        WHERE d.business_date = c.business_date AND d.kind = 'daily' ORDER BY d.id DESC LIMIT 1) AS printed_by
    FROM codes c JOIN batches b ON b.id = c.batch_id
    GROUP BY c.business_date ORDER BY c.business_date DESC LIMIT ?`, limit);
}

export function rangeLabel(codes: CodeRow[]): string {
  if (!codes.length) return "";
  const first = codes[0]!, last = codes[codes.length - 1]!;
  return `${serialLabel(first.type, first.serial)} to ${serialLabel(last.type, last.serial)}`;
}
