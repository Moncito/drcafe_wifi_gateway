import { randomUUID } from "node:crypto";
import { randomCode, serialLabel, type CodeStatus, type CodeType } from "../codes.ts";
import type { DB } from "../db.ts";
import { addDays, businessDate, closingMs, isClosedWindow } from "../time.ts";
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
  /** 1 = codes kept on the router for "Give Wi-Fi", never printed */
  pool: number;
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
  /** unused slips stop working at this time (30 days after printing) */
  valid_until: number;
  issued_at: number | null;
  issued_by: number | null;
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
/** The newest code with this serial (serials run on for good, so it's the one in use). */
export function findBySerial(db: DB, type: CodeType, serial: number) {
  return db.get<CodeRow>("SELECT * FROM codes WHERE type = ? AND serial = ? ORDER BY id DESC LIMIT 1", type, serial);
}
/** Codes in a serial range that can still be used (unused and valid, or in use). */
export function codesBySerialRange(db: DB, type: CodeType, from: number, to: number, now = Date.now()) {
  return db.all<CodeRow>(`SELECT * FROM codes WHERE type = ? AND serial BETWEEN ? AND ?
                            AND (status = 'active' OR (status = 'unused' AND valid_until > ?)) ORDER BY serial`, type, from, to, now);
}

/** Unused printed slips keep working until the 1:00 AM closing at the end of this many days. */
export const VALID_DAYS = 30;
export function validUntilFor(now = Date.now()): number {
  return closingMs(addDays(businessDate(now), VALID_DAYS));
}
/** The café day a slip is valid until ("Valid until Dec 14"). */
export function validDate(validUntil: number): string {
  return businessDate(validUntil - 1);
}

/**
 * Make slips: allocate serials and unique codes (state "pending"). The router
 * picks them up on its next call (every ~20 s) and the batch becomes
 * "on_router" once the router reports every code. Unused slips carry over from
 * day to day until they are used or reach their validity (30 days).
 * Serials run on (S-151, S-152 …) and never restart.
 * Idempotent per requestId: a double-clicked or retried form returns the batch it already made.
 */
export async function createBatch(
  db: DB,
  opts: { solo: number; group: number; requestId: string; staffId: number | null; pool?: boolean; now?: number },
): Promise<Batch> {
  const now = opts.now ?? Date.now();
  const same = await db.get<Batch>("SELECT * FROM batches WHERE request_id = ?", opts.requestId);
  if (same) return same;

  const date = businessDate(now);
  const solo = Math.trunc(opts.solo), group = Math.trunc(opts.group);
  if (!(solo >= 0 && group >= 0 && solo <= MAX_PER_TYPE && group <= MAX_PER_TYPE)) throw new UserError(`Counts must be between 0 and ${MAX_PER_TYPE}.`);
  if (solo + group === 0) throw new UserError("Choose at least one slip.");

  const dur = (await getSettings(db)).durSeconds;
  const validUntil = validUntilFor(now);
  return db.tx(async (t) => {
    const r = await t.run(`INSERT INTO batches (business_date, kind, solo_count, group_count, dur_seconds, request_id, created_by, created_at, pool)
                           VALUES (?, 'extra', ?, ?, ?, ?, ?, ?, ?)`, date, solo, group, dur, opts.requestId, opts.staffId, now, opts.pool ? 1 : 0);
    const batchId = r.lastInsertRowid;
    for (const [type, count] of [["S", solo], ["G", group]] as const) {
      if (!count) continue;
      const max = (await t.get<{ m: number | null }>("SELECT MAX(serial) AS m FROM codes WHERE type = ?", type))!.m ?? 0;
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
        const args = chunk.flatMap((c, j) => [c, type, max + i + j + 1, date, batchId, dur, validUntil]);
        await t.run(`INSERT INTO codes (code, type, serial, business_date, batch_id, dur_seconds, valid_until) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",")}`, ...args);
      }
    }
    if (!opts.pool) await audit(t, "batch_created", { staffId: opts.staffId, detail: `#${batchId}: ${solo} solo + ${group} group`, at: now });
    return (await t.get<Batch>("SELECT * FROM batches WHERE id = ?", batchId))!;
  });
}

// ---- Give Wi-Fi (code shown on screen, no paper) ---------------------------------

/** Codes kept ready on the router for "Give Wi-Fi". */
export const POOL_TARGET = { S: 6, G: 3 } as const;

/** Unissued pool codes per type, and how many of them the router already has. */
export async function poolStatus(db: DB, now = Date.now()) {
  const rows = await db.all<{ type: CodeType; n: number; ready: number }>(`
    SELECT c.type, COUNT(*) AS n, COALESCE(SUM(c.on_router), 0) AS ready FROM codes c JOIN batches b ON b.id = c.batch_id
     WHERE b.pool = 1 AND c.status = 'unused' AND c.issued_at IS NULL AND c.valid_until > ? GROUP BY c.type`, now);
  const get = (t: CodeType) => rows.find((r) => r.type === t) ?? { n: 0, ready: 0 };
  return { S: get("S"), G: get("G") };
}

/** Top the pool up so codes are on the router before anyone taps "Give Wi-Fi". */
export async function ensurePool(db: DB, now = Date.now()) {
  const p = await poolStatus(db, now);
  const solo = Math.max(0, POOL_TARGET.S - p.S.n), group = Math.max(0, POOL_TARGET.G - p.G.n);
  if (solo + group === 0) return;
  await createBatch(db, { solo, group, pool: true, staffId: null, requestId: `pool-${randomUUID()}`, now });
}

/**
 * Hand out one code on screen. It works until tonight's 1:00 AM closing
 * (3 hours from first login, like a slip). The pool is topped up afterwards.
 */
export async function issueCode(db: DB, type: CodeType, staffId: number, now = Date.now()): Promise<CodeRow> {
  if (isClosedWindow(now)) throw new UserError("The café is closed (1:00–5:00 AM). Codes given now would stop right away.");
  const until = closingMs(businessDate(now));
  for (let tries = 0; tries < 3; tries++) {
    const c = await db.get<CodeRow>(`
      SELECT c.* FROM codes c JOIN batches b ON b.id = c.batch_id
       WHERE b.pool = 1 AND c.type = ? AND c.status = 'unused' AND c.issued_at IS NULL AND c.on_router = 1 AND c.valid_until > ?
       ORDER BY c.id LIMIT 1`, type, now);
    if (!c) {
      await ensurePool(db, now);
      throw new UserError("No code is ready on the router yet. Wait about 20 seconds and try again. If it keeps happening, check that the router is checking in.");
    }
    const r = await db.run("UPDATE codes SET issued_at = ?, issued_by = ?, valid_until = ? WHERE id = ? AND issued_at IS NULL", now, staffId, until, c.id);
    if (r.changes !== 1) continue; // someone else took it at the same moment
    await audit(db, "issued", { staffId, code: c.code, detail: "Given on screen", at: now });
    await ensurePool(db, now);
    return { ...c, issued_at: now, issued_by: staffId, valid_until: until };
  }
  throw new UserError("Please try again.");
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
