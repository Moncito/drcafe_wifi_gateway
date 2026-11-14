import express, { type NextFunction, type Request, type Response } from "express";
import { CODE_RE, normaliseCode, parseSerial, serialLabel, type CodeType } from "../codes.ts";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { ProtocolError } from "../router/protocol.ts";
import { audit, recentActivity } from "../services/audit.ts";
import {
  createStaff, listStaff, login, logout, sessionStaff, staffCount, updateStaff, type Role, type Staff,
} from "../services/auth.ts";
import {
  codesBySerialRange, codesForBatch, createBatch, ensurePool, findBySerial, findCode, getBatch, isAdvance, issueCode, markPrinted,
  poolStatus, UserError, voidCodes, type CodeRow,
} from "../services/batches.ts";
import { getRouterStatus, handleRouterReport, queueKick, tokenMatches } from "../services/routerlink.ts";
import { getSettings, saveSettings } from "../services/settings.ts";
import { dayWindow, drinkCounts, recentPrints, report, routerBacklog, saveDrinkCount, stock, usageByHour, usualByHour } from "../services/stats.ts";
import { addDays, businessDate, closingMs, isClosedWindow } from "../time.ts";
import { html } from "./html.ts";
import { appPage, type Flash } from "./layout.ts";
import { loginPage, setupPage } from "./pages/login.ts";
import { lookupMain } from "./pages/lookup.ts";
import { giveMain } from "./pages/give.ts";
import { printMain } from "./pages/print.ts";
import { reportsMain } from "./pages/reports.ts";
import { settingsMain } from "./pages/settings.ts";
import { sheetPage } from "./pages/sheet.ts";
import { todayMain } from "./pages/today.ts";

const COOKIE = "drc_session";

export interface Ctx { db: () => Promise<DB>; cfg: Config }

function cookieToken(req: Request): string | undefined {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m?.[1];
}
const isHttps = (req: Request) => req.secure || req.headers["x-forwarded-proto"] === "https";
const cookieAttrs = (req: Request) => `HttpOnly; SameSite=Lax; Path=/${isHttps(req) ? "; Secure" : ""}`;

const me = (res: Response) => res.locals.staff as Staff;
const dbOf = (res: Response) => res.locals.db as DB;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const int = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
const msg = (s: string) => encodeURIComponent(s.slice(0, 300));
const readFlash = (req: Request): Flash => ({ ok: str(req.query.ok) || undefined, err: str(req.query.err) || undefined });
/** Only allow redirects back into this app. */
const safeBack = (v: unknown, fallback: string) => {
  const s = str(v);
  return s.startsWith("/") && !s.startsWith("//") ? s : fallback;
};
const withMsg = (to: string, kind: "ok" | "err", text: string) => {
  const [path, hash] = to.split("#") as [string, string | undefined];
  return `${path}${path.includes("?") ? "&" : "?"}${kind}=${msg(text)}${hash ? `#${hash}` : ""}`;
};

export function buildRoutes(ctx: Ctx) {
  const { cfg } = ctx;
  const r = express.Router();
  const profiles = { soloProfile: cfg.soloProfile, groupProfile: cfg.groupProfile };

  // ---- database for every request ----------------------------------------
  r.use(async (_req, res, next) => {
    res.locals.db = await ctx.db();
    next();
  });

  // ---- router check-in (the MikroTik's drc-cloud-sync script) -------------
  r.post("/api/router/sync", express.text({ type: "*/*", limit: "256kb" }), async (req, res) => {
    if (cfg.routerMode !== "router" || !tokenMatches(req.headers.authorization, cfg.routerToken)) {
      res.status(401).setHeader("WWW-Authenticate", 'Bearer realm="drc-router"');
      res.type("text/plain").send("unauthorized\n");
      return;
    }
    try {
      const answer = await handleRouterReport(dbOf(res), profiles, typeof req.body === "string" ? req.body : "");
      res.type("text/plain").send(answer);
    } catch (e) {
      if (e instanceof ProtocolError) { res.status(400).type("text/plain").send(`error|${e.message}\n`); return; }
      throw e;
    }
  });

  // ---- no cross-site posts --------------------------------------------------
  r.use((req, res, next) => {
    if (req.method === "POST") {
      const origin = req.headers.origin;
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]!.trim();
      let originHost = "";
      try { originHost = origin ? new URL(origin).host : ""; } catch { originHost = "invalid"; }
      if (origin && originHost !== host) { res.status(403).send("Cross-site request blocked"); return; }
    }
    res.setHeader("X-Frame-Options", "DENY");
    // (not "no-referrer": that makes browsers send "Origin: null" on form posts)
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ---- login / setup -------------------------------------------------------
  r.get("/setup", async (_req, res) => {
    if ((await staffCount(dbOf(res))) > 0) return res.redirect("/login");
    res.send(setupPage({}).value);
  });
  r.post("/setup", async (req, res) => {
    const db = dbOf(res);
    if ((await staffCount(db)) > 0) return res.redirect("/login");
    try {
      await createStaff(db, { username: str(req.body.username), displayName: str(req.body.displayName), role: "admin", password: str(req.body.password) }, null);
      res.redirect("/login");
    } catch (e) {
      res.status(400).send(setupPage({ error: (e as Error).message }).value);
    }
  });
  r.get("/login", async (_req, res) => {
    if ((await staffCount(dbOf(res))) === 0) return res.redirect("/setup");
    res.send(loginPage({}).value);
  });
  r.post("/login", async (req, res) => {
    const out = await login(dbOf(res), str(req.body.username), str(req.body.password));
    if ("error" in out) return res.status(401).send(loginPage({ error: out.error, username: str(req.body.username) }).value);
    res.setHeader("Set-Cookie", `${COOKIE}=${out.token}; ${cookieAttrs(req)}`);
    res.redirect("/");
  });
  r.post("/logout", async (req, res) => {
    const db = dbOf(res);
    const t = cookieToken(req);
    const s = await sessionStaff(db, t);
    await logout(db, t);
    if (s) await audit(db, "logout", { staffId: s.id });
    res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
    res.redirect("/login");
  });

  // ---- everything below needs a login --------------------------------------
  r.use(async (req, res, next) => {
    const db = dbOf(res);
    const s = await sessionStaff(db, cookieToken(req));
    if (!s) return res.redirect((await staffCount(db)) === 0 ? "/setup" : "/login");
    res.locals.staff = s;
    next();
  });
  const adminOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (me(res).role !== "admin") { res.status(403).send(appPage({ title: "Not allowed", staff: me(res), active: "today", main: forbidden() }).value); return; }
    next();
  };

  // ---- Today ---------------------------------------------------------------
  r.get("/", async (_req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const date = businessDate(now);
    const [{ bars, shifts }, st, sync, recent, usual, backlog, prints, settings] = await Promise.all([
      usageByHour(db, date), stock(db, date, now), getRouterStatus(db, now),
      recentActivity(db, 40, ["first_login", "expired", "void", "disconnect", "batch_created", "batch_printed", "issued"]),
      usualByHour(db, date), routerBacklog(db, date, now), recentPrints(db, now), getSettings(db),
    ]);
    const [from] = dayWindow(date);
    const activity = recent.filter((a) => a.at >= from).slice(0, 10);
    res.send(appPage({
      title: "Today", staff: me(res), active: "today", refreshSeconds: 30,
      main: todayMain({ now, date, stock: st, bars, usual, shifts, backlog, lastPrint: prints[0] ?? null, activity, sync, settings, isAdmin: me(res).role === "admin" }),
    }).value);
  });

  // ---- Give Wi-Fi (code on screen) -------------------------------------------
  r.get("/give", async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    await ensurePool(db, now);
    const code = str(req.query.code);
    let shown: CodeRow | null = null;
    if (CODE_RE.test(code)) {
      const c = await findCode(db, code);
      // only a code given in the last 15 minutes is shown again (e.g. after a refresh)
      if (c?.issued_at && now - c.issued_at < 15 * 60_000) shown = c;
    }
    const [pool, sync] = await Promise.all([poolStatus(db, now), getRouterStatus(db, now)]);
    res.send(appPage({
      title: "Give Wi‑Fi", staff: me(res), active: "give", refreshSeconds: shown ? undefined : 30,
      main: await giveMain({ now, pool, sync, shown, wifiName: cfg.wifiName, qrBase: cfg.qrLoginUrl, closed: isClosedWindow(now), flash: readFlash(req) }),
    }).value);
  });

  r.post("/give", async (req, res) => {
    const type = str(req.body.type) === "G" ? "G" : "S";
    try {
      const c = await issueCode(dbOf(res), type, me(res).id);
      res.redirect(`/give?code=${c.code}`);
    } catch (e) {
      if (e instanceof UserError) return res.redirect(withMsg("/give", "err", e.message));
      throw e;
    }
  });

  // ---- Print slips -----------------------------------------------------------
  r.get("/print", async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const date = businessDate(now);
    const [settings, prints, st, sync, maxes] = await Promise.all([
      getSettings(db), recentPrints(db, now), stock(db, date, now), getRouterStatus(db, now),
      db.all<{ type: "S" | "G"; m: number }>("SELECT type, MAX(serial) AS m FROM codes GROUP BY type"),
    ]);
    const next = { S: (maxes.find((x) => x.type === "S")?.m ?? 0) + 1, G: (maxes.find((x) => x.type === "G")?.m ?? 0) + 1 };
    res.send(appPage({
      title: "Print slips", staff: me(res), active: "print",
      refreshSeconds: prints.some((b) => b.state === "pending") ? 8 : undefined,
      main: printMain({ now, settings, isAdmin: me(res).role === "admin", prints, stock: st, next, routerOk: sync.ok, flash: readFlash(req) }),
    }).value);
  });

  r.post("/batches", async (req, res) => {
    const isAdmin = me(res).role === "admin";
    const settings = await getSettings(dbOf(res));
    let solo = int(req.body.solo), group = int(req.body.group);
    // baristas print only the preset amounts (the "+ solo" / "+ group" buttons)
    if (!isAdmin && !((solo === settings.extraSolo && group === 0) || (solo === 0 && group === settings.extraGroup))) {
      return res.redirect(withMsg("/print", "err", "Only the owner can print a custom number of slips."));
    }
    if (Number.isNaN(solo)) solo = 0;
    if (Number.isNaN(group)) group = 0;
    const requestId = str(req.body.requestId);
    if (!/^[0-9a-f-]{36}$/.test(requestId)) return res.redirect(withMsg("/print", "err", "Form expired. Please try again."));
    try {
      const batch = await createBatch(dbOf(res), { solo, group, requestId, staffId: me(res).id });
      res.redirect(withMsg("/print", "ok", `${batch.solo_count + batch.group_count} slips created. The router adds them in about 20 seconds, then Print appears.`));
    } catch (e) {
      if (e instanceof UserError) return res.redirect(withMsg("/print", "err", e.message));
      throw e;
    }
  });

  r.get("/batches/:id/sheet", async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const batch = await getBatch(db, int(req.params.id));
    if (!batch || batch.pool) return res.redirect(withMsg("/print", "err", "No such print."));
    if (batch.state === "pending" && !isAdvance(batch, now)) return res.redirect(withMsg("/print", "err", "Not all codes are on the router yet. Wait for the router's next check-in."));
    if (batch.state === "void") return res.redirect(withMsg("/print", "err", "This batch was voided."));
    // only slips that can still be used are printed (used, expired and void ones are skipped)
    const codes = (await codesForBatch(db, batch.id)).filter((c) => c.status === "unused" && c.valid_until > now);
    if (!codes.length) return res.redirect(withMsg("/print", "err", "Every slip in this print has been used or has expired."));
    const page = int(req.query.page);
    res.send((await sheetPage({ batch, codes, wifiName: cfg.wifiName, qrBase: cfg.qrLoginUrl, onlyPage: Number.isNaN(page) ? undefined : page })).value);
  });

  r.post("/batches/:id/printed", async (req, res) => {
    try {
      await markPrinted(dbOf(res), int(req.params.id), me(res).id);
      res.status(204).end();
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  r.post("/batches/:id/void", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const batch = await getBatch(db, int(req.params.id));
    if (!batch) return res.redirect("/print");
    const now = Date.now();
    // only slips still out there; used and expired ones are history
    const codes = (await codesForBatch(db, batch.id)).filter((c) => c.status === "active" || (c.status === "unused" && c.valid_until > now));
    const out = await voidCodes(db, codes, me(res).id, `batch #${batch.id} voided`);
    res.redirect(withMsg("/print", "ok", voidSummary(out.voided.length)));
  });

  r.post("/void-range", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const type = str(req.body.type) === "G" ? "G" : "S";
    const from = int(req.body.from), to = int(req.body.to);
    if (!(from >= 1 && to >= from)) return res.redirect(withMsg("/print", "err", "Enter a serial range like 41 to 60."));
    const codes = await codesBySerialRange(db, type, from, to);
    if (!codes.length) return res.redirect(withMsg("/print", "err", `No usable ${type} slips between ${serialLabel(type, from)} and ${serialLabel(type, to)}.`));
    const reason = `${serialLabel(type, from)} to ${serialLabel(type, to)}${str(req.body.reason) ? ` · ${str(req.body.reason).slice(0, 80)}` : ""}`;
    const out = await voidCodes(db, codes, me(res).id, reason);
    res.redirect(withMsg("/print", "ok", voidSummary(out.voided.length)));
  });

  // ---- Reports (owner) ---------------------------------------------------------
  r.get("/reports", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const range = str(req.query.range) === "30" ? 30 : 7;
    const last = businessDate(now);
    const rep = await report(db, last, range);
    const drinks = await drinkCounts(db, addDays(last, -6), last);
    res.send(appPage({
      title: "Reports", staff: me(res), active: "reports",
      main: reportsMain({ now, today: last, range, report: rep, drinks, flash: readFlash(req) }),
    }).value);
  });

  r.post("/reports/drinks", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const today = businessDate(Date.now());
    const oldest = addDays(today, -6);
    let saved = 0;
    for (const [key, val] of Object.entries(req.body as Record<string, unknown>)) {
      const m = key.match(/^d_(\d{4}-\d{2}-\d{2})_(morning|night)$/);
      if (!m || m[1]! < oldest || m[1]! > today) continue;
      const v = str(val).trim();
      const n = v === "" ? null : int(v);
      if (n !== null && !(n >= 0 && n <= 5000)) return res.redirect(withMsg("/reports#drinks", "err", "Drink counts must be numbers from 0 to 5000."));
      await saveDrinkCount(db, m[1]!, m[2] as "morning" | "night", n, me(res).id);
      saved++;
    }
    res.redirect(withMsg("/reports#drinks", "ok", saved ? "Drink counts saved." : "Nothing to save."));
  });

  // ---- Look up & devices ---------------------------------------------------
  r.get("/lookup", async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const today = businessDate(now);
    const q = str(req.query.q).trim().slice(0, 20);
    let result: CodeRow | null = null;
    if (q) {
      const norm = normaliseCode(q);
      if (CODE_RE.test(norm)) result = (await findCode(db, norm)) ?? null;
      else {
        const s = parseSerial(q);
        if (s) result = (await findBySerial(db, s.type, s.serial)) ?? null;
      }
    }
    const sync = await getRouterStatus(db, now);
    const users = [...new Set(sync.active.map((a) => a.user))];
    const inUse = new Map(users.length ? (await db.all<CodeRow>(`SELECT * FROM codes WHERE code IN (${users.map(() => "?").join(",")})`, ...users)).map((c) => [c.code, c]) : []);
    const online = sync.active.map((a) => {
      const c = inUse.get(a.user);
      // a code ends 3 h after first login OR at that night's 1:00 AM closing, whichever is first
      return { ...a, serial: c ? serialLabel(c.type, c.serial) : "", type: (a.user[0] as CodeType), endsAt: c?.ends_at && c.first_login_at ? Math.min(c.ends_at, closingMs(businessDate(c.first_login_at))) : null };
    });
    res.send(appPage({
      title: "Look up", staff: me(res), active: "lookup", refreshSeconds: q ? undefined : 30,
      main: lookupMain({
        now, q, today, result, notFound: !!q && !result,
        devices: result ? sync.active.filter((a) => a.user === result!.code) : [],
        online, sync, isAdmin: me(res).role === "admin", flash: readFlash(req),
      }),
    }).value);
  });

  r.post("/devices/disconnect", async (req, res) => {
    const back = safeBack(req.body.back, "/lookup");
    const [user, mac] = str(req.body.id).split("|");
    if (!user || !CODE_RE.test(user) || (mac && !/^[0-9A-F:]{17}$/i.test(mac))) return res.redirect(withMsg(back, "err", "Unknown device."));
    await queueKick(dbOf(res), user, mac ?? "", me(res).id);
    res.redirect(withMsg(back, "ok", `Disconnecting the device on ${user} at the router's next check-in (about 20 seconds).`));
  });

  r.post("/codes/:code/void", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const back = safeBack(req.body.back, "/lookup");
    const c = await findCode(db, str(req.params.code));
    if (!c) return res.redirect(withMsg(back, "err", "No such code."));
    const out = await voidCodes(db, [c], me(res).id, "voided from Look up");
    res.redirect(withMsg(back, "ok", voidSummary(out.voided.length)));
  });

  // ---- Settings & staff (admin) --------------------------------------------
  r.get("/settings", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const [settings, staff, sync] = await Promise.all([getSettings(db), listStaff(db), getRouterStatus(db)]);
    res.send(appPage({
      title: "Settings", staff: me(res), active: "settings",
      main: settingsMain({ now: Date.now(), settings, staff, me: me(res), sync, routerKind: cfg.routerMode, wifiName: cfg.wifiName, flash: readFlash(req) }),
    }).value);
  });

  r.post("/settings", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const durMinutes = int(req.body.durMinutes);
    const vals = { soloPerDay: int(req.body.soloPerDay), groupPerDay: int(req.body.groupPerDay), extraSolo: int(req.body.extraSolo), extraGroup: int(req.body.extraGroup) };
    if (!(durMinutes >= 15 && durMinutes <= 1200)) return res.redirect(withMsg("/settings", "err", "Time per code must be 15–1200 minutes."));
    if (Object.values(vals).some((v) => !(v >= 0 && v <= 600))) return res.redirect(withMsg("/settings", "err", "Slip counts must be 0–600."));
    await saveSettings(db, { durSeconds: durMinutes * 60, ...vals });
    await audit(db, "settings_saved", { staffId: me(res).id, detail: `${durMinutes} min, ${vals.soloPerDay} S + ${vals.groupPerDay} G per day` });
    res.redirect(withMsg("/settings", "ok", "Saved. Applies to the next batch."));
  });

  r.post("/staff", adminOnly, async (req, res) => {
    try {
      const role: Role = str(req.body.role) === "admin" ? "admin" : "barista";
      await createStaff(dbOf(res), { username: str(req.body.username), displayName: str(req.body.displayName), role, password: str(req.body.password) }, me(res).id);
      res.redirect(withMsg("/settings", "ok", "Account added."));
    } catch (e) {
      res.redirect(withMsg("/settings", "err", (e as Error).message));
    }
  });

  r.post("/staff/:id", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const id = int(req.params.id);
    const op = str(req.body.op);
    try {
      if (op === "password") await updateStaff(db, id, { password: str(req.body.password) }, me(res).id);
      else if (op === "role") await updateStaff(db, id, { role: str(req.body.role) === "admin" ? "admin" : "barista" }, me(res).id);
      else if (op === "disable") await updateStaff(db, id, { active: false }, me(res).id);
      else if (op === "enable") await updateStaff(db, id, { active: true }, me(res).id);
      else throw new Error("Unknown action.");
      res.redirect(withMsg("/settings", "ok", "Saved."));
    } catch (e) {
      res.redirect(withMsg("/settings", "err", (e as Error).message));
    }
  });

  return r;
}

function voidSummary(n: number): string {
  if (!n) return "Nothing to void (already void).";
  return `Voided ${n} slip${n === 1 ? "" : "s"}. They stop working at the router's next check-in (about 20 seconds).`;
}

function forbidden() {
  return html`<div class="page-head"><h1 class="title">Owner only</h1></div><p>This page is for the owner/admin account.</p><p><a href="/">Back to Today</a></p>`;
}
