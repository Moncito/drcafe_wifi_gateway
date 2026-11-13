import { timingSafeEqual } from "node:crypto";
import { parseRouterComment, routerComment } from "../codes.ts";
import type { DB } from "../db.ts";
import { formatCommands, parseReport, type RouterCommand } from "../router/protocol.ts";
import type { RouterActive, RouterInfo } from "../router/types.ts";
import { businessDate, closingMs, isClosedWindow, routerEpochToMs } from "../time.ts";
import { audit } from "./audit.ts";
import type { CodeRow } from "./batches.ts";

/** Router counts as connected if it reported within this time. */
const FRESH_MS = 90_000;
/** Max add commands per call, so the router script stays quick. */
const MAX_ADDS = 150;

export interface RouterStatus {
  ok: boolean;
  lastOkAt: number | null;
  lastTryAt: number | null;
  error: string | null;
  active: RouterActive[];
  info: RouterInfo | null;
}

export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = (header ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m || !token) return false;
  const a = Buffer.from(m[1]!.trim()), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function getRouterStatus(db: DB, now = Date.now()): Promise<RouterStatus> {
  const row = await db.get<{ reported_at: number; info: string; active: string }>("SELECT reported_at, info, active FROM router_state WHERE id = 1");
  if (!row) return { ok: false, lastOkAt: null, lastTryAt: now, error: "The router hasn't checked in yet. Is drc-cloud-sync installed and the café internet up?", active: [], info: null };
  const ok = now - row.reported_at < FRESH_MS;
  const mins = Math.round((now - row.reported_at) / 60_000);
  return {
    ok,
    lastOkAt: row.reported_at,
    lastTryAt: now,
    error: ok ? null : `The router last checked in ${mins < 1 ? "a minute" : `${mins} minute${mins === 1 ? "" : "s"}`} ago. Café internet or router may be down.`,
    active: ok ? (JSON.parse(row.active) as RouterActive[]) : [],
    info: JSON.parse(row.info) as RouterInfo,
  };
}

export async function queueKick(db: DB, code: string, mac: string, staffId: number, now = Date.now()) {
  await db.run("INSERT INTO router_jobs (kind, code, arg, created_at) VALUES ('kick', ?, ?, ?)", code, mac, now);
  await audit(db, "disconnect", { staffId, code, at: now });
}

/**
 * The router's check-in (POST /api/router/sync). Records what it reports and
 * answers with the work it should do. Everything is idempotent: a lost answer
 * just means the same work is sent again on the next check-in.
 */
export async function handleRouterReport(db: DB, profiles: { soloProfile: string; groupProfile: string }, text: string, now = Date.now()): Promise<string> {
  const rep = parseReport(text);
  const today = businessDate(now);
  const onRouter = new Map(rep.users.map((u) => [u.name, u]));
  const devices = new Map<string, number>();
  for (const a of rep.active) devices.set(a.user, (devices.get(a.user) ?? 0) + 1);

  await db.run(`INSERT INTO router_state (id, reported_at, info, active) VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET reported_at = excluded.reported_at, info = excluded.info, active = excluded.active`,
    now, JSON.stringify(rep.info), JSON.stringify(rep.active));

  const codes = await db.all<CodeRow>("SELECT * FROM codes WHERE business_date = ?", today);

  await db.tx(async (t) => {
    const setOn: number[] = [], setOff: number[] = [];
    for (const c of codes) {
      const u = onRouter.get(c.code);
      if (u && !c.on_router) { setOn.push(c.id); c.on_router = 1; }
      if (!u && c.on_router) { setOff.push(c.id); c.on_router = 0; }
      if (!u || (c.status !== "unused" && c.status !== "active")) continue;
      const st = parseRouterComment(u.comment);
      if (st.start === undefined) continue;
      const startMs = routerEpochToMs(st.start);
      const endMs = st.end !== undefined ? routerEpochToMs(st.end) : startMs + c.dur_seconds * 1000;
      if (c.status === "unused") {
        await t.run("UPDATE codes SET status = 'active', first_login_at = ?, ends_at = ? WHERE id = ?", startMs, endMs, c.id);
        c.status = "active";
        const n = devices.get(c.code) ?? 1;
        await audit(t, "first_login", {
          code: c.code, at: startMs,
          detail: c.type === "G" ? `First login · ${n} of 7 devices` : `First login · ${Math.round((c.dur_seconds / 3600) * 10) / 10} hours start`,
        });
      }
      if (st.exp !== undefined || (u.disabled && now >= endMs)) {
        const expMs = st.exp !== undefined ? routerEpochToMs(st.exp) : endMs;
        await t.run("UPDATE codes SET status = 'expired', expired_at = ? WHERE id = ?", expMs, c.id);
        c.status = "expired";
        await audit(t, "expired", { code: c.code, at: expMs, detail: `Expired · ${Math.round(c.dur_seconds / 360) / 10} hours used` });
      }
    }
    for (const [ids, v] of [[setOn, 1], [setOff, 0]] as const) {
      for (let i = 0; i < ids.length; i += 200) {
        const part = ids.slice(i, i + 200);
        await t.run(`UPDATE codes SET on_router = ? WHERE id IN (${part.map(() => "?").join(",")})`, v, ...part);
      }
    }
    // batches whose every code the router has confirmed become printable
    await t.run(`UPDATE batches SET state = 'on_router', pushed_at = ?, last_error = NULL
                 WHERE state = 'pending' AND business_date = ?
                   AND NOT EXISTS (SELECT 1 FROM codes c WHERE c.batch_id = batches.id AND c.status != 'void' AND c.on_router = 0)`, now, today);
    // codes from earlier days still marked active stopped at that day's 1:00 AM closing
    const stale = await t.all<{ id: number; business_date: string }>("SELECT id, business_date FROM codes WHERE status = 'active' AND business_date < ?", today);
    for (const s of stale) await t.run("UPDATE codes SET status = 'expired', expired_at = ? WHERE id = ?", closingMs(s.business_date), s.id);
  });

  // ---- work for the router -------------------------------------------------
  const cmds: RouterCommand[] = [];
  for (const c of codes) {
    if (c.status === "void" && onRouter.has(c.code)) cmds.push({ kind: "del", code: c.code });
  }
  if (!isClosedWindow(now)) {
    let adds = 0;
    for (const c of codes) {
      if (c.status === "void" || onRouter.has(c.code) || adds >= MAX_ADDS) continue;
      if (c.status !== "unused") continue; // a used code that vanished from the router is not re-created
      cmds.push({
        kind: "add", code: c.code,
        profile: c.type === "S" ? profiles.soloProfile : profiles.groupProfile,
        // solo: uptime cap = clock time (drc-login keeps it in step). group: no cap, the clock rule ends it.
        limitUptime: c.type === "S" ? `${c.dur_seconds}s` : "0s",
        comment: routerComment(c.dur_seconds),
      });
      adds++;
    }
  }
  const kicks = await db.all<{ id: number; code: string; arg: string | null }>(
    "SELECT id, code, arg FROM router_jobs WHERE kind = 'kick' AND done_at IS NULL AND created_at > ?", now - 10 * 60_000);
  for (const k of kicks) cmds.push({ kind: "kick", code: k.code, mac: k.arg ?? "" });
  if (kicks.length) {
    await db.run(`UPDATE router_jobs SET done_at = ?, sent_at = ?, sent_count = sent_count + 1 WHERE id IN (${kicks.map(() => "?").join(",")})`, now, now, ...kicks.map((k) => k.id));
  }
  await db.run("DELETE FROM router_jobs WHERE created_at < ?", now - 7 * 86_400_000);
  return formatCommands(cmds);
}
