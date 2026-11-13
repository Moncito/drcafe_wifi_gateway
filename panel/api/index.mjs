// src/app.ts
import express2 from "express";
import { existsSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/db.ts
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
var SCHEMA = `
CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','barista')),
  pass_hash     TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One daily batch per business date (unless voided) + any number of extras.
-- state: pending (waiting for the router to confirm every code) -> on_router -> printed; or void
CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY,
  business_date TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('daily','extra')),
  solo_count    INTEGER NOT NULL,
  group_count   INTEGER NOT NULL,
  dur_seconds   INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','on_router','printed','void')),
  request_id    TEXT NOT NULL UNIQUE,
  created_by    INTEGER REFERENCES staff(id),
  created_at    INTEGER NOT NULL,
  pushed_at     INTEGER,
  printed_at    INTEGER,
  printed_by    INTEGER REFERENCES staff(id),
  last_error    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS batches_one_daily
  ON batches(business_date) WHERE kind = 'daily' AND state != 'void';

-- code is unique for all time, so an old slip can never match a new code.
CREATE TABLE IF NOT EXISTS codes (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL CHECK (type IN ('S','G')),
  serial         INTEGER NOT NULL,
  business_date  TEXT NOT NULL,
  batch_id       INTEGER NOT NULL REFERENCES batches(id),
  dur_seconds    INTEGER NOT NULL,
  on_router      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','active','expired','void')),
  first_login_at INTEGER,
  ends_at        INTEGER,
  expired_at     INTEGER,
  voided_at      INTEGER,
  voided_by      INTEGER REFERENCES staff(id),
  UNIQUE (business_date, type, serial)
);
CREATE INDEX IF NOT EXISTS codes_batch ON codes(batch_id);
CREATE INDEX IF NOT EXISTS codes_day ON codes(business_date, status);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  staff_id INTEGER REFERENCES staff(id),
  action   TEXT NOT NULL,
  code     TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);

-- Work for the router. The router calls in every ~20 s, receives the open jobs,
-- and the next report shows whether they took effect (then done_at is set).
CREATE TABLE IF NOT EXISTS router_jobs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('add','del','kick')),
  code       TEXT NOT NULL,
  arg        TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  sent_count INTEGER NOT NULL DEFAULT 0,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS router_jobs_open ON router_jobs(done_at, created_at);

-- Last thing the router reported (devices online, router facts).
CREATE TABLE IF NOT EXISTS router_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  reported_at INTEGER NOT NULL,
  info        TEXT NOT NULL,
  active      TEXT NOT NULL
);
`;
function wrap(exec) {
  return {
    async all(sql, ...args) {
      return (await exec(sql, args)).rows.map((r) => ({ ...r }));
    },
    async get(sql, ...args) {
      const rows = (await exec(sql, args)).rows;
      return rows[0] ? { ...rows[0] } : void 0;
    },
    async run(sql, ...args) {
      const r = await exec(sql, args);
      return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected };
    }
  };
}
async function openDb(url, authToken) {
  if (url.startsWith("file:")) mkdirSync(dirname(url.slice(5)), { recursive: true });
  const client = createClient({ url, authToken: authToken || void 0, intMode: "number" });
  await client.executeMultiple("PRAGMA foreign_keys = ON;");
  await client.executeMultiple(SCHEMA);
  const base = wrap((sql, args) => client.execute({ sql, args }));
  let chain = Promise.resolve();
  const db = {
    ...base,
    tx(fn) {
      const run = async () => {
        const t = await client.transaction("write");
        const inner = { ...wrap((sql, args) => t.execute({ sql, args })), tx: (f) => f(inner) };
        try {
          const out = await fn(inner);
          await t.commit();
          return out;
        } catch (e) {
          await t.rollback().catch(() => void 0);
          throw e;
        } finally {
          t.close();
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => void 0);
      return p;
    },
    close: () => client.close()
  };
  return db;
}

// src/web/routes.ts
import express from "express";

// src/codes.ts
import { randomInt } from "node:crypto";
var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var CODE_RE = /^[SG][A-HJKMNP-Z2-9]{5}$/;
function randomCode(type) {
  let c = type;
  for (let i = 0; i < 5; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}
function serialLabel(type, serial) {
  return `${type}-${String(serial).padStart(3, "0")}`;
}
function parseSerial(input) {
  const m = input.trim().toUpperCase().match(/^([SG])\s*-?\s*0*(\d{1,4})$/);
  if (!m) return null;
  return { type: m[1], serial: Number(m[2]) };
}
function normaliseCode(input) {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}
function routerComment(durSeconds) {
  return `drc;dur=${durSeconds};`;
}
function parseRouterComment(comment) {
  const out = {};
  if (!comment || !comment.startsWith("drc;")) return out;
  for (const part of comment.split(";")) {
    const [k, v] = part.split("=");
    if (v === void 0 || !/^\d+$/.test(v)) continue;
    if (k === "dur" || k === "start" || k === "end" || k === "exp") out[k] = Number(v);
  }
  return out;
}
function qrLoginUrl(base, code) {
  return `${base}?username=${code}&password=${code}`;
}

// src/router/protocol.ts
var ProtocolError = class extends Error {
};
var clean = (s) => s.replace(/[|\r\n]/g, " ").trim();
function parseReport(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  if (lines[0] !== "v1") throw new ProtocolError("unknown report version");
  const report = {
    info: { identity: "", board: "", version: "", backupComment: "", groupDevices: "", rateLimit: "", idleTimeout: "" },
    users: [],
    active: []
  };
  for (const line of lines.slice(1)) {
    const f = line.split("|");
    if (f[0] === "i") {
      report.info = {
        identity: f[1] ?? "",
        board: f[2] ?? "",
        version: f[3] ?? "",
        backupComment: f[4] ?? "",
        groupDevices: f[5] ?? "",
        rateLimit: f[6] ?? "",
        idleTimeout: f[7] ?? ""
      };
    } else if (f[0] === "u" && CODE_RE.test(f[1] ?? "")) {
      report.users.push({ id: f[1], name: f[1], disabled: f[2] === "1", comment: f[3] ?? "", profile: "" });
    } else if (f[0] === "a" && CODE_RE.test(f[1] ?? "")) {
      report.active.push({
        id: `${f[1]}|${f[3] ?? ""}`,
        user: f[1],
        address: f[2] ?? "",
        mac: (f[3] ?? "").toUpperCase(),
        uptime: f[4] ?? "",
        sessionTimeLeft: f[5] ?? "",
        hostName: f[6] ?? ""
      });
    }
  }
  return report;
}
function formatCommands(cmds) {
  const out = ["ok"];
  for (const c of cmds) {
    if (c.kind === "add") out.push(["add", c.code, clean(c.profile), clean(c.limitUptime), clean(c.comment)].join("|"));
    else if (c.kind === "del") out.push(["del", c.code].join("|"));
    else out.push(["kick", c.code, clean(c.mac)].join("|"));
  }
  return out.join("\n") + "\n";
}

// src/services/audit.ts
async function audit(db, action, opts = {}) {
  await db.run(
    "INSERT INTO audit (at, staff_id, action, code, detail) VALUES (?, ?, ?, ?, ?)",
    opts.at ?? Date.now(),
    opts.staffId ?? null,
    action,
    opts.code ?? null,
    opts.detail ?? null
  );
}
function recentActivity(db, limit, actions) {
  const filter = actions?.length ? `WHERE a.action IN (${actions.map(() => "?").join(",")})` : "";
  return db.all(`
    SELECT a.id, a.at, a.action, a.code, a.detail, s.display_name AS staff_name, c.serial, c.type
    FROM audit a
    LEFT JOIN staff s ON s.id = a.staff_id
    LEFT JOIN codes c ON c.code = a.code
    ${filter}
    ORDER BY a.at DESC, a.id DESC LIMIT ?`, ...actions ?? [], limit);
}

// src/services/auth.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
var SESSION_MS = 14 * 36e5;
var N = 16384;
var STAFF_COLS = "id, username, display_name, role, active, created_at, last_login_at";
function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(got, expected);
}
function validatePassword(pw) {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  return null;
}
async function staffCount(db) {
  return (await db.get("SELECT COUNT(*) AS n FROM staff")).n;
}
function listStaff(db) {
  return db.all(`SELECT ${STAFF_COLS} FROM staff ORDER BY role, display_name`);
}
function getStaff(db, id) {
  return db.get(`SELECT ${STAFF_COLS} FROM staff WHERE id = ?`, id);
}
async function createStaff(db, s, byId) {
  const username = s.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new Error("Username: 2\u201332 letters, numbers, dot, dash or underscore.");
  if (!s.displayName.trim()) throw new Error("Name is required.");
  const pwErr = validatePassword(s.password);
  if (pwErr) throw new Error(pwErr);
  if (await db.get("SELECT 1 FROM staff WHERE username = ?", username)) throw new Error("That username is taken.");
  const r = await db.run(
    "INSERT INTO staff (username, display_name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    username,
    s.displayName.trim(),
    s.role,
    hashPassword(s.password),
    Date.now()
  );
  await audit(db, "staff_added", { staffId: byId, detail: `${s.displayName.trim()} (${s.role})` });
  return r.lastInsertRowid;
}
async function activeAdminCount(db) {
  return (await db.get("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND active = 1")).n;
}
async function updateStaff(db, id, ch, byId) {
  const s = await getStaff(db, id);
  if (!s) throw new Error("No such staff account.");
  const losesAdmin = s.role === "admin" && s.active === 1 && (ch.role && ch.role !== "admin" || ch.active === false);
  if (losesAdmin && await activeAdminCount(db) <= 1) throw new Error("There must always be at least one active owner/admin account.");
  if (ch.role) await db.run("UPDATE staff SET role = ? WHERE id = ?", ch.role, id);
  if (ch.active !== void 0) {
    await db.run("UPDATE staff SET active = ? WHERE id = ?", ch.active ? 1 : 0, id);
    if (!ch.active) await db.run("DELETE FROM sessions WHERE staff_id = ?", id);
  }
  if (ch.password !== void 0) {
    const err = validatePassword(ch.password);
    if (err) throw new Error(err);
    await db.run("UPDATE staff SET pass_hash = ? WHERE id = ?", hashPassword(ch.password), id);
    await db.run("DELETE FROM sessions WHERE staff_id = ?", id);
    await audit(db, "password_reset", { staffId: byId, detail: s.display_name });
  }
  if (ch.role || ch.active !== void 0) {
    await audit(db, "staff_changed", { staffId: byId, detail: `${s.display_name}: ${ch.role ? "role " + ch.role : ""}${ch.active !== void 0 ? ch.active ? " enabled" : " disabled" : ""}`.trim() });
  }
}
var failures = /* @__PURE__ */ new Map();
async function login(db, username, password) {
  const key = username.trim().toLowerCase();
  const f = failures.get(key);
  if (f && f.until > Date.now()) return { error: "Too many wrong passwords. Wait 2 minutes and try again." };
  const row = await db.get("SELECT * FROM staff WHERE username = ?", key);
  const ok = row && row.active === 1 && verifyPassword(password, row.pass_hash);
  if (!ok || !row) {
    const n = (f?.n ?? 0) + 1;
    failures.set(key, { n, until: n >= 5 ? Date.now() + 12e4 : 0 });
    await audit(db, "login_failed", { detail: key });
    return { error: "Wrong username or password." };
  }
  failures.delete(key);
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await db.run("DELETE FROM sessions WHERE expires_at < ?", now);
  await db.run("INSERT INTO sessions (token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)", token, row.id, now, now + SESSION_MS);
  await db.run("UPDATE staff SET last_login_at = ? WHERE id = ?", now, row.id);
  await audit(db, "login", { staffId: row.id });
  return { token, staff: await getStaff(db, row.id) };
}
function sessionStaff(db, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return Promise.resolve(void 0);
  return db.get(`
    SELECT s.id, s.username, s.display_name, s.role, s.active, s.created_at, s.last_login_at
    FROM sessions x JOIN staff s ON s.id = x.staff_id
    WHERE x.token = ? AND x.expires_at > ? AND s.active = 1`, token, Date.now());
}
async function logout(db, token) {
  if (token) await db.run("DELETE FROM sessions WHERE token = ?", token);
}

// src/time.ts
var MANILA_OFFSET_MS = 8 * 36e5;
var DAY_MS = 864e5;
var CLOSED_FROM_HOUR = 1;
var CLOSED_UNTIL_HOUR = 5;
function manila(ms) {
  const t = new Date(ms + MANILA_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    s: t.getUTCSeconds(),
    dow: t.getUTCDay()
  };
}
var pad = (n) => String(n).padStart(2, "0");
function businessDate(ms) {
  const p = manila(ms - CLOSED_UNTIL_HOUR * 36e5);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function isClosedWindow(ms) {
  const h = manila(ms).h;
  return h >= CLOSED_FROM_HOUR && h < CLOSED_UNTIL_HOUR;
}
function dateStartMs(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - MANILA_OFFSET_MS;
}
function closingMs(date) {
  return dateStartMs(date) + DAY_MS + 36e5;
}
function routerEpochToMs(epoch) {
  return epoch * 1e3 - MANILA_OFFSET_MS;
}
function shiftOf(ms) {
  const h = manila(ms).h;
  return h >= CLOSED_UNTIL_HOUR && h < 16 ? "morning" : "night";
}
var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatClock(ms) {
  const p = manila(ms);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${pad(p.mi)} ${p.h < 12 ? "AM" : "PM"}`;
}
function formatDateLong(date) {
  const p = manila(dateStartMs(date));
  return `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}
function formatDateShort(date) {
  const p = manila(dateStartMs(date));
  return `${DAYS[p.dow].slice(0, 3)}, ${MONTHS[p.m - 1]} ${p.d}`;
}
function formatWhen(ms, now) {
  if (businessDate(ms) === businessDate(now)) return `Today, ${formatClock(ms)}`;
  const p = manila(ms);
  return `${MONTHS[p.m - 1]} ${p.d}, ${formatClock(ms)}`;
}
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 6e4));
  return `${Math.floor(total / 60)}h ${pad(total % 60)}m`;
}

// src/services/settings.ts
var DEFAULTS = { durSeconds: 3 * 3600, soloPerDay: 150, groupPerDay: 30, extraSolo: 20, extraGroup: 5 };
async function getSettings(db) {
  const rows = await db.all("SELECT key, value FROM settings");
  const out = { ...DEFAULTS };
  for (const r of rows) {
    if (r.key in out && /^\d+$/.test(r.value)) out[r.key] = Number(r.value);
  }
  return out;
}
async function saveSettings(db, s) {
  for (const [k, v] of Object.entries(s)) {
    if (!(k in DEFAULTS) || typeof v !== "number" || !Number.isInteger(v) || v < 0) continue;
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v));
  }
}

// src/services/batches.ts
var UserError = class extends Error {
};
var MAX_PER_TYPE = 600;
function getBatch(db, id) {
  return db.get("SELECT * FROM batches WHERE id = ?", id);
}
function dailyBatch(db, date) {
  return db.get("SELECT * FROM batches WHERE business_date = ? AND kind = 'daily' AND state != 'void'", date);
}
function batchesForDate(db, date) {
  return db.all("SELECT * FROM batches WHERE business_date = ? ORDER BY id", date);
}
function codesForBatch(db, batchId) {
  return db.all("SELECT * FROM codes WHERE batch_id = ? ORDER BY type DESC, serial", batchId);
}
function findCode(db, code) {
  return db.get("SELECT * FROM codes WHERE code = ?", code);
}
function findBySerial(db, date, type, serial) {
  return db.get("SELECT * FROM codes WHERE business_date = ? AND type = ? AND serial = ?", date, type, serial);
}
function codesBySerialRange(db, date, type, from, to) {
  return db.all("SELECT * FROM codes WHERE business_date = ? AND type = ? AND serial BETWEEN ? AND ? ORDER BY serial", date, type, from, to);
}
async function createBatch(db, opts) {
  const now = opts.now ?? Date.now();
  const same = await db.get("SELECT * FROM batches WHERE request_id = ?", opts.requestId);
  if (same) return same;
  if (isClosedWindow(now)) throw new UserError("The caf\xE9 is closed (1:00\u20135:00 AM). Codes made now would be deleted by the router. Make the batch after 5:00 AM.");
  const date = businessDate(now);
  const solo = Math.trunc(opts.solo), group = Math.trunc(opts.group);
  if (!(solo >= 0 && group >= 0 && solo <= MAX_PER_TYPE && group <= MAX_PER_TYPE)) throw new UserError(`Counts must be between 0 and ${MAX_PER_TYPE}.`);
  if (solo + group === 0) throw new UserError("Choose at least one slip.");
  if (opts.kind === "daily" && await dailyBatch(db, date)) throw new UserError("Today's batch already exists. Use \u201CRan out today?\u201D for extra slips, or reprint a page.");
  const dur = (await getSettings(db)).durSeconds;
  return db.tx(async (t) => {
    const r = await t.run(`INSERT INTO batches (business_date, kind, solo_count, group_count, dur_seconds, request_id, created_by, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, date, opts.kind, solo, group, dur, opts.requestId, opts.staffId, now);
    const batchId = r.lastInsertRowid;
    for (const [type, count] of [["S", solo], ["G", group]]) {
      if (!count) continue;
      const max = (await t.get("SELECT MAX(serial) AS m FROM codes WHERE business_date = ? AND type = ?", date, type)).m ?? 0;
      const picked = /* @__PURE__ */ new Set();
      while (picked.size < count) {
        const want = [];
        while (want.length < (count - picked.size) * 2) {
          const c = randomCode(type);
          if (!picked.has(c) && !want.includes(c)) want.push(c);
        }
        const taken = new Set((await t.all(`SELECT code FROM codes WHERE code IN (${want.map(() => "?").join(",")})`, ...want)).map((x) => x.code));
        for (const c of want) if (!taken.has(c) && picked.size < count) picked.add(c);
      }
      const list = [...picked];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const args = chunk.flatMap((c, j) => [c, type, max + i + j + 1, date, batchId, dur]);
        await t.run(`INSERT INTO codes (code, type, serial, business_date, batch_id, dur_seconds) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(",")}`, ...args);
      }
    }
    await audit(t, "batch_created", { staffId: opts.staffId, detail: `#${batchId} ${opts.kind}: ${solo} solo + ${group} group`, at: now });
    return await t.get("SELECT * FROM batches WHERE id = ?", batchId);
  });
}
async function markPrinted(db, batchId, staffId) {
  const b = await getBatch(db, batchId);
  if (!b) throw new UserError("No such batch.");
  if (b.state === "pending") throw new UserError("Not all codes are on the router yet; wait for them before printing.");
  if (b.state === "void") throw new UserError("This batch was voided.");
  const first = b.state === "on_router";
  await db.run("UPDATE batches SET state = 'printed', printed_at = COALESCE(printed_at, ?), printed_by = COALESCE(printed_by, ?) WHERE id = ?", Date.now(), staffId, batchId);
  await audit(db, "batch_printed", { staffId, detail: `#${batchId}${first ? "" : " (reprint)"}` });
}
async function voidCodes(db, codes, staffId, reason, now = Date.now()) {
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
function pastDays(db, limit) {
  return db.all(`
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

// src/services/routerlink.ts
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var FRESH_MS = 9e4;
var MAX_ADDS = 150;
function tokenMatches(header, token) {
  const m = (header ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m || !token) return false;
  const a = Buffer.from(m[1].trim()), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual2(a, b);
}
async function getRouterStatus(db, now = Date.now()) {
  const row = await db.get("SELECT reported_at, info, active FROM router_state WHERE id = 1");
  if (!row) return { ok: false, lastOkAt: null, lastTryAt: now, error: "The router hasn't checked in yet. Is drc-cloud-sync installed and the caf\xE9 internet up?", active: [], info: null };
  const ok = now - row.reported_at < FRESH_MS;
  const mins = Math.round((now - row.reported_at) / 6e4);
  return {
    ok,
    lastOkAt: row.reported_at,
    lastTryAt: now,
    error: ok ? null : `The router last checked in ${mins < 1 ? "a minute" : `${mins} minute${mins === 1 ? "" : "s"}`} ago. Caf\xE9 internet or router may be down.`,
    active: ok ? JSON.parse(row.active) : [],
    info: JSON.parse(row.info)
  };
}
async function queueKick(db, code, mac, staffId, now = Date.now()) {
  await db.run("INSERT INTO router_jobs (kind, code, arg, created_at) VALUES ('kick', ?, ?, ?)", code, mac, now);
  await audit(db, "disconnect", { staffId, code, at: now });
}
async function handleRouterReport(db, profiles, text, now = Date.now()) {
  const rep = parseReport(text);
  const today = businessDate(now);
  const onRouter = new Map(rep.users.map((u) => [u.name, u]));
  const devices = /* @__PURE__ */ new Map();
  for (const a of rep.active) devices.set(a.user, (devices.get(a.user) ?? 0) + 1);
  await db.run(
    `INSERT INTO router_state (id, reported_at, info, active) VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET reported_at = excluded.reported_at, info = excluded.info, active = excluded.active`,
    now,
    JSON.stringify(rep.info),
    JSON.stringify(rep.active)
  );
  const codes = await db.all("SELECT * FROM codes WHERE business_date = ?", today);
  await db.tx(async (t) => {
    const setOn = [], setOff = [];
    for (const c of codes) {
      const u = onRouter.get(c.code);
      if (u && !c.on_router) {
        setOn.push(c.id);
        c.on_router = 1;
      }
      if (!u && c.on_router) {
        setOff.push(c.id);
        c.on_router = 0;
      }
      if (!u || c.status !== "unused" && c.status !== "active") continue;
      const st = parseRouterComment(u.comment);
      if (st.start === void 0) continue;
      const startMs = routerEpochToMs(st.start);
      const endMs = st.end !== void 0 ? routerEpochToMs(st.end) : startMs + c.dur_seconds * 1e3;
      if (c.status === "unused") {
        await t.run("UPDATE codes SET status = 'active', first_login_at = ?, ends_at = ? WHERE id = ?", startMs, endMs, c.id);
        c.status = "active";
        const n = devices.get(c.code) ?? 1;
        await audit(t, "first_login", {
          code: c.code,
          at: startMs,
          detail: c.type === "G" ? `First login \xB7 ${n} of 7 devices` : `First login \xB7 ${Math.round(c.dur_seconds / 3600 * 10) / 10} hours start`
        });
      }
      if (st.exp !== void 0 || u.disabled && now >= endMs) {
        const expMs = st.exp !== void 0 ? routerEpochToMs(st.exp) : endMs;
        await t.run("UPDATE codes SET status = 'expired', expired_at = ? WHERE id = ?", expMs, c.id);
        c.status = "expired";
        await audit(t, "expired", { code: c.code, at: expMs, detail: `Expired \xB7 ${Math.round(c.dur_seconds / 360) / 10} hours used` });
      }
    }
    for (const [ids, v] of [[setOn, 1], [setOff, 0]]) {
      for (let i = 0; i < ids.length; i += 200) {
        const part = ids.slice(i, i + 200);
        await t.run(`UPDATE codes SET on_router = ? WHERE id IN (${part.map(() => "?").join(",")})`, v, ...part);
      }
    }
    await t.run(`UPDATE batches SET state = 'on_router', pushed_at = ?, last_error = NULL
                 WHERE state = 'pending' AND business_date = ?
                   AND NOT EXISTS (SELECT 1 FROM codes c WHERE c.batch_id = batches.id AND c.status != 'void' AND c.on_router = 0)`, now, today);
    const stale = await t.all("SELECT id, business_date FROM codes WHERE status = 'active' AND business_date < ?", today);
    for (const s of stale) await t.run("UPDATE codes SET status = 'expired', expired_at = ? WHERE id = ?", closingMs(s.business_date), s.id);
  });
  const cmds = [];
  for (const c of codes) {
    if (c.status === "void" && onRouter.has(c.code)) cmds.push({ kind: "del", code: c.code });
  }
  if (!isClosedWindow(now)) {
    let adds = 0;
    for (const c of codes) {
      if (c.status === "void" || onRouter.has(c.code) || adds >= MAX_ADDS) continue;
      if (c.status !== "unused") continue;
      cmds.push({
        kind: "add",
        code: c.code,
        profile: c.type === "S" ? profiles.soloProfile : profiles.groupProfile,
        // solo: uptime cap = clock time (drc-login keeps it in step). group: no cap, the clock rule ends it.
        limitUptime: c.type === "S" ? `${c.dur_seconds}s` : "0s",
        comment: routerComment(c.dur_seconds)
      });
      adds++;
    }
  }
  const kicks = await db.all(
    "SELECT id, code, arg FROM router_jobs WHERE kind = 'kick' AND done_at IS NULL AND created_at > ?",
    now - 10 * 6e4
  );
  for (const k of kicks) cmds.push({ kind: "kick", code: k.code, mac: k.arg ?? "" });
  if (kicks.length) {
    await db.run(`UPDATE router_jobs SET done_at = ?, sent_at = ?, sent_count = sent_count + 1 WHERE id IN (${kicks.map(() => "?").join(",")})`, now, now, ...kicks.map((k) => k.id));
  }
  await db.run("DELETE FROM router_jobs WHERE created_at < ?", now - 7 * 864e5);
  return formatCommands(cmds);
}

// src/services/stats.ts
async function dayCounts(db, date) {
  return await db.get(`
    SELECT
      COALESCE(SUM(type = 'S' AND status != 'void'), 0) AS solo_total,
      COALESCE(SUM(type = 'S' AND first_login_at IS NOT NULL), 0) AS solo_used,
      COALESCE(SUM(type = 'G' AND status != 'void'), 0) AS group_total,
      COALESCE(SUM(type = 'G' AND first_login_at IS NOT NULL), 0) AS group_used
    FROM codes WHERE business_date = ?`, date);
}
var HOURS = Array.from({ length: 20 }, (_, i) => (i + 5) % 24);
function hourLabel(h) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? "a" : "p"}`;
}
async function usageByHour(db, date) {
  const rows = await db.all(
    "SELECT type, first_login_at FROM codes WHERE business_date = ? AND first_login_at IS NOT NULL",
    date
  );
  const perHour = /* @__PURE__ */ new Map();
  const shifts = { morning: { S: 0, G: 0 }, night: { S: 0, G: 0 } };
  for (const r of rows) {
    const h = manila(r.first_login_at).h;
    perHour.set(h, (perHour.get(h) ?? 0) + 1);
    shifts[shiftOf(r.first_login_at)][r.type]++;
  }
  const bars = HOURS.filter((h) => h >= 7 || h === 0 || (perHour.get(h) ?? 0) > 0).map((h) => ({ hour: h, label: hourLabel(h), n: perHour.get(h) ?? 0, shift: h >= 5 && h < 16 ? "morning" : "night" }));
  return { bars, shifts };
}

// src/web/html.ts
var Safe = class {
  value;
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
};
var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);
function render(v) {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === void 0 || v === false) return "";
  return esc(String(v));
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Safe(out);
}
var raw = (s) => new Safe(s);

// src/web/layout.ts
var ICONS = {
  today: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  lookup: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'
};
var NAV = [
  { key: "today", href: "/", label: "Today" },
  { key: "print", href: "/print", label: "Print slips" },
  { key: "lookup", href: "/lookup", label: "Look up & devices" },
  { key: "settings", href: "/settings", label: "Settings & staff", adminOnly: true }
];
function doc(title, body, opts = {}) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? html`<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${title} · Don Robert Café Wi‑Fi</title>
<link rel="icon" href="/static/img/app-icon.png">
<link rel="apple-touch-icon" href="/static/img/app-icon.png">
<link rel="manifest" href="/static/manifest.webmanifest">
<meta name="theme-color" content="#14100D">
<link rel="stylesheet" href="/static/css/app.css">
</head>
<body class="${opts.bodyClass ?? ""}">
${body}
</body>
</html>`;
}
function flash(f) {
  return html`${f.ok ? html`<div class="flash flash-ok" role="status">${f.ok}</div>` : ""}${f.err ? html`<div class="flash flash-err" role="alert">${f.err}</div>` : ""}`;
}
function appPage(opts) {
  const isAdmin = opts.staff.role === "admin";
  const nav = NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => {
    const current = n.key === opts.active;
    return html`<a href="${n.href}" class="nav-link${current ? " is-current" : ""}"${current ? raw(' aria-current="page"') : ""}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${raw(ICONS[n.key])}</svg>${n.label}</a>`;
  });
  return doc(opts.title, html`
<div class="app">
  <nav class="nav" aria-label="Admin">
    <img src="/static/img/logo.png" alt="Don Robert Café" class="nav-logo">
    <div class="nav-links">${nav}</div>
    <div class="nav-foot">
      <span class="nav-user">${opts.staff.display_name}</span>
      <span class="nav-role">${isAdmin ? "Owner / admin" : "Barista"}</span>
      <form method="post" action="/logout"><button type="submit" class="link-btn">Log out</button></form>
    </div>
  </nav>
  <main class="main">${opts.main}</main>
</div>`, { refreshSeconds: opts.refreshSeconds });
}

// src/web/pages/login.ts
function shell(form) {
  return html`
<div class="login">
  <section class="login-brand">
    <img src="/static/img/logo.png" alt="Don Robert Café" class="login-logo">
    <div class="login-pitch">
      <span class="eyebrow eyebrow-light">Wi‑Fi admin</span>
      <h2>Today's slips, devices online and settings, in one place.</h2>
      <p>Works on the café network only, even when the internet is down.</p>
    </div>
  </section>
  <section class="login-form-wrap">${form}</section>
</div>`;
}
function loginPage(opts) {
  return doc("Log in", shell(html`
    <form method="post" action="/login" class="login-form">
      <div class="stack-6">
        <h1 class="title">Log in</h1>
        <p class="muted">Baristas and the owner each have their own account.</p>
      </div>
      ${opts.error ? html`<div class="flash flash-err" role="alert">${opts.error}</div>` : ""}
      <div class="field">
        <label for="u">Username</label>
        <input id="u" name="username" type="text" autocomplete="username" required autofocus value="${opts.username ?? ""}">
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit" class="btn btn-primary btn-lg">Log in</button>
      <p class="muted small center">Forgot your password? Ask the owner to reset it.</p>
    </form>`));
}
function setupPage(opts) {
  return doc("First-time setup", shell(html`
    <form method="post" action="/setup" class="login-form">
      <div class="stack-6">
        <h1 class="title">Welcome</h1>
        <p class="muted">No accounts yet. Create the owner account. It can add baristas later.</p>
      </div>
      ${opts.error ? html`<div class="flash flash-err" role="alert">${opts.error}</div>` : ""}
      <div class="field"><label for="n">Name</label><input id="n" name="displayName" required value="Owner"></div>
      <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required value="owner"></div>
      <div class="field"><label for="p">Password (8+ characters)</label><input id="p" name="password" type="password" autocomplete="new-password" required minlength="8"></div>
      <button type="submit" class="btn btn-primary btn-lg">Create owner account</button>
    </form>`));
}

// src/web/pages/parts.ts
function routerStatus(s, now) {
  if (s.ok && s.lastOkAt) {
    const ago = Math.round((now - s.lastOkAt) / 1e3);
    return html`<p class="router-line"><span class="dot dot-ok"></span>Router connected · checked in ${ago < 5 ? "just now" : `${ago}s ago`}</p>`;
  }
  if (!s.lastTryAt) return html`<p class="router-line"><span class="dot dot-warn"></span>Connecting to the router…</p>`;
  return html`<div class="notice notice-err" role="alert"><span class="dot dot-err"></span><span><strong>Router not checking in.</strong> Numbers below may be out of date. ${s.error ?? ""}</span></div>`;
}
function typePill(t) {
  return html`<span class="pill ${t === "G" ? "pill-group" : "pill-solo"}">${t === "G" ? "GROUP" : "SOLO"}</span>`;
}
var STATUS_TEXT = { unused: "Unused", active: "Active", expired: "Expired", void: "Void" };
function statusBadge(s) {
  return html`<span class="status status-${s}"><span class="dot"></span>${STATUS_TEXT[s]}</span>`;
}

// src/web/pages/lookup.ts
var back = (q) => `/lookup${q ? `?q=${encodeURIComponent(q)}` : ""}`;
function deviceName(a) {
  return a.hostName || a.mac || "Device";
}
function disconnectBtn(a, q, small = false) {
  return html`<form method="post" action="/devices/disconnect" data-confirm="Disconnect this device? It happens at the router's next check-in (about 20 seconds). It can log in again with the same code while time is left.">
    <input type="hidden" name="id" value="${a.id}"><input type="hidden" name="user" value="${a.user}"><input type="hidden" name="back" value="${back(q)}">
    <button class="btn btn-light${small ? " btn-sm" : ""}" type="submit">Disconnect</button></form>`;
}
function lookupMain(d) {
  const c = d.result;
  const closing = c ? closingMs(c.business_date) : 0;
  const end = c?.ends_at ? Math.min(c.ends_at, closing) : null;
  const endsAtClosing = !!c?.ends_at && c.ends_at > closing;
  const left = (endsAt) => endsAt ? Math.max(0, endsAt - d.now) : null;
  const online = [...d.online].sort((a, b) => (left(a.endsAt) ?? 9e15) - (left(b.endsAt) ?? 9e15));
  return html`
<div class="page-head"><div class="stack-4">
  <span class="eyebrow">“My Wi‑Fi isn't working”</span>
  <h1 class="title">Look up a code</h1>
</div></div>
${flash(d.flash)}

<form method="get" action="/lookup" class="lookup-form">
  <label for="lq" class="sr-only">Code or serial</label>
  <input id="lq" name="q" type="text" value="${d.q}" placeholder="S3K7PW or S-042" autocomplete="off" autofocus class="mono lookup-input">
  <button type="submit" class="btn btn-primary btn-lg">Look up</button>
</form>

${d.notFound ? html`<div class="notice notice-warn"><span class="dot dot-warn"></span><span>No slip found for <strong class="mono">${d.q}</strong>. Check the code on the slip, or search by its serial (e.g. S-042). Serials search today's slips.</span></div>` : ""}

${c ? html`
<section class="card">
  <div class="card-head wrap">
    <div class="actions">
      <span class="mono big-code">${c.code}</span>
      ${typePill(c.type)}
      ${statusBadge(c.status)}
    </div>
    ${d.isAdmin && c.status !== "void" ? html`<form method="post" action="/codes/${c.code}/void" data-confirm="Void ${c.code}? It stops working now and its devices are disconnected.">
      <input type="hidden" name="back" value="${back(d.q)}">
      <button class="btn btn-danger-outline" type="submit">Void this code</button></form>` : ""}
  </div>
  <div class="facts">
    <div><span>Serial</span><strong class="mono">${serialLabel(c.type, c.serial)}</strong></div>
    <div><span>Day</span><strong>${c.business_date === d.today ? "Today" : formatDateShort(c.business_date)}</strong></div>
    <div><span>First login</span><strong>${c.first_login_at ? formatClock(c.first_login_at) : "Not used yet"}</strong></div>
    <div><span>Ends</span><strong>${end ? html`${formatClock(end)}${endsAtClosing ? " (closing)" : ""}${c.status === "active" ? html` <small class="muted">(${formatDuration(left(end))} left)</small>` : ""}` : "3 h after first login, or 1:00 AM"}</strong></div>
    <div><span>Devices</span><strong>${d.devices.length} of ${c.type === "G" ? 7 : 1}</strong></div>
  </div>
  ${c.status === "unused" && !c.on_router ? html`<p class="err-text">This code is not on the router yet. It is added at the router's next check-in (about 20 seconds).</p>` : ""}
  ${c.status === "expired" ? html`<p class="muted">Time is up${c.expired_at ? ` (${formatClock(c.expired_at)})` : ""}. The customer needs a new slip with a new drink.</p>` : ""}
  ${c.status === "void" ? html`<p class="muted">This slip was voided${c.voided_at ? ` at ${formatClock(c.voided_at)}` : ""}.</p>` : ""}
  ${d.devices.length ? html`<div class="list">${d.devices.map((a) => html`
    <div class="list-row">
      <span class="grow">${deviceName(a)}</span>
      <span class="mono muted">${a.address}</span>
      <span class="muted">online ${a.uptime}</span>
      ${disconnectBtn(a, d.q)}
    </div>`)}</div>` : ""}
</section>` : ""}

<section class="card">
  <div class="card-head">
    <h2>Devices online now · ${online.length}</h2>
    <span class="muted small">Sorted by least time left</span>
  </div>
  ${routerStatus(d.sync, d.now)}
  <div class="table-scroll"><table class="table">
    <thead><tr><th>Code</th><th>Serial</th><th>Type</th><th>Device</th><th>Time left</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${online.length ? online.map((o) => {
    const l = left(o.endsAt);
    return html`<tr>
        <td><a class="mono" href="/lookup?q=${o.user}">${o.user}</a></td>
        <td class="mono muted">${o.serial}</td>
        <td>${o.type === "G" ? "Group" : "Solo"}</td>
        <td class="muted">${deviceName(o)} · ${o.address.replace(/^192\.168/, "")}</td>
        <td class="${l !== null && l < 30 * 6e4 ? "warn-text" : ""}">${l !== null ? formatDuration(l) : "\u2013"}</td>
        <td>${disconnectBtn(o, d.q, true)}</td></tr>`;
  }) : html`<tr><td colspan="6" class="muted">No devices online.</td></tr>`}</tbody>
  </table></div>
</section>
<script src="/static/js/forms.js"></script>`;
}

// src/web/pages/print.ts
import { randomUUID } from "node:crypto";
var SLIPS_PER_PAGE = 48;
var pages = (n) => Math.ceil(n / SLIPS_PER_PAGE);
var hours = (s) => {
  const h = s / 3600;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(s / 60)} minutes`;
};
function previewPages(codes) {
  const n = Math.max(1, pages(codes.length));
  return html`<div class="preview-pages">${Array.from({ length: n }, (_, p) => {
    const slice = codes.slice(p * SLIPS_PER_PAGE, (p + 1) * SLIPS_PER_PAGE);
    return html`<div class="preview-page-wrap"><div class="preview-page">${Array.from({ length: SLIPS_PER_PAGE }, (_2, i) => {
      const t = slice[i]?.type;
      return html`<div class="pv ${t === "S" ? "pv-s" : t === "G" ? "pv-g" : ""}"></div>`;
    })}</div><span class="muted small">Page ${p + 1}</span></div>`;
  })}</div>`;
}
var STATE_TEXT = {
  pending: "Waiting for router",
  on_router: "On router \xB7 not printed",
  printed: "Printed",
  void: "Void"
};
function batchCard(b, isAdmin) {
  const live = b.codes.filter((c) => c.status !== "void");
  const n = b.codes.length;
  const p = pages(n);
  return html`
  <div class="batch-row">
    <div class="stack-4">
      <strong>${b.kind === "daily" ? "Daily batch" : "Extra slips"} · ${b.solo_count} S + ${b.group_count} G</strong>
      <span class="muted small">Created ${formatClock(b.created_at)}${b.by ? ` by ${b.by}` : ""} · ${p} page${p > 1 ? "s" : ""} · ${hours(b.dur_seconds)} per code${live.length !== n ? ` \xB7 ${n - live.length} voided` : ""}</span>
      ${b.state === "pending" ? html`<span class="small warn-text">On the router: ${live.filter((c) => c.on_router).length} of ${live.length}. Slips can be printed once all are there (usually within 20–40 seconds). This page refreshes by itself.</span>` : ""}
    </div>
    <span class="state state-${b.state}">${STATE_TEXT[b.state]}</span>
    <div class="actions">
      ${b.state === "on_router" || b.state === "printed" ? html`
        <a class="btn ${b.state === "on_router" ? "btn-primary" : "btn-outline"}" href="/batches/${b.id}/sheet">${b.state === "printed" ? "Reprint" : "Open print sheet"}</a>
        ${p > 1 ? html`<form method="get" action="/batches/${b.id}/sheet" class="inline-form">
          <label class="sr-only" for="pg${b.id}">Page</label>
          <select id="pg${b.id}" name="page">${Array.from({ length: p }, (_, i) => html`<option value="${i + 1}">Page ${i + 1}</option>`)}</select>
          <button class="btn btn-outline" type="submit">Reprint a page</button></form>` : ""}` : ""}
      ${isAdmin && b.state !== "void" ? html`<form method="post" action="/batches/${b.id}/void" data-confirm="Void ALL ${live.length} remaining slips in this batch? They stop working immediately and devices on them are disconnected.">
        <button class="btn btn-danger-outline" type="submit">Void batch</button></form>` : ""}
    </div>
  </div>`;
}
function printMain(d) {
  const daily = d.batches.find((b) => b.kind === "daily" && b.state !== "void");
  const s = d.settings;
  const planned = [...Array(s.soloPerDay).fill({ type: "S" }), ...Array(s.groupPerDay).fill({ type: "G" })];
  return html`
<div class="page-head">
  <div class="stack-4">
    <span class="eyebrow">${d.isAdmin ? "Done once each morning" : "Extra slips for today"}</span>
    <h1 class="title">Print slips</h1>
  </div>
</div>
${flash(d.flash)}
${d.closed ? html`<div class="notice notice-warn"><span class="dot dot-warn"></span><span><strong>Closed (1:00–5:00 AM).</strong> The router deletes all codes in this window, so no slips can be made until 5:00 AM.</span></div>` : ""}

<div class="row">
  ${d.isAdmin ? html`
  <section class="card grow-1">
    <h2>New day's batch</h2>
    ${daily ? html`
      <p>Today's batch already exists (${daily.solo_count} S + ${daily.group_count} G, ${STATE_TEXT[daily.state].toLowerCase()}). Reprint it below, or use <a href="#extra">Ran out today?</a> for more.</p>` : html`
    <form method="post" action="/batches" class="stack-14" data-busy="Creating codes…">
      <input type="hidden" name="kind" value="daily">
      <input type="hidden" name="requestId" value="${randomUUID()}">
      <div class="form-grid">
        <div class="field span-2"><label>Date</label><div class="static-field">${formatDateLong(d.date)}</div></div>
        <div class="field"><label for="ps">Solo slips (S)</label><input id="ps" name="solo" type="number" min="0" max="600" value="${s.soloPerDay}" class="mono" data-count></div>
        <div class="field"><label for="pg">Group slips (G)</label><input id="pg" name="group" type="number" min="0" max="600" value="${s.groupPerDay}" class="mono" data-count></div>
      </div>
      <div class="summary-box">
        <div><span>Total</span><strong data-total>${s.soloPerDay + s.groupPerDay} slips · ${pages(s.soloPerDay + s.groupPerDay)} A4 pages</strong></div>
        <div><span>Each code</span><strong>${hours(s.durSeconds)} from first login</strong></div>
        <div><span>All codes stop</span><strong>1:00 AM closing</strong></div>
      </div>
      <button type="submit" class="btn btn-primary btn-lg" ${d.closed ? "disabled" : ""}>Create codes &amp; print</button>
      <p class="muted small">The router adds the codes at its next check-in (about 20 seconds). The print sheet opens only when every code is on the router.</p>
      ${d.routerOk ? "" : html`<p class="err-text small">The router hasn't checked in recently. Codes will wait until it does.</p>`}
    </form>`}
  </section>` : ""}

  <section class="grow-1 stack-14">
    <h2>Preview</h2>
    ${previewPages(daily ? daily.codes : planned)}
    <div class="legend"><span><i class="sw sw-morning"></i>Solo slip</span><span><i class="sw sw-night"></i>Group slip</span></div>

    <div class="card" id="extra">
      <h2>Ran out today?</h2>
      <p class="muted">Print extra slips for today. Serials continue from the last one.</p>
      <div class="actions">
        ${[["solo", s.extraSolo, 0], ["group", 0, s.extraGroup]].map(([label, so, gr]) => html`
          <form method="post" action="/batches" data-busy="Creating codes…">
            <input type="hidden" name="kind" value="extra">
            <input type="hidden" name="requestId" value="${randomUUID()}">
            <input type="hidden" name="solo" value="${so}"><input type="hidden" name="group" value="${gr}">
            <button class="btn btn-outline" type="submit" ${d.closed ? "disabled" : ""}>+${label === "solo" ? so : gr} ${label}</button>
          </form>`)}
      </div>
      ${d.isAdmin ? html`
      <details class="void-box">
        <summary class="btn btn-danger-outline">Void slips…</summary>
        <form method="post" action="/void-range" class="form-grid" data-confirm="Void these slips? They stop working immediately.">
          <div class="field"><label for="vt">Type</label><select id="vt" name="type"><option value="S">Solo (S)</option><option value="G">Group (G)</option></select></div>
          <div class="field"><label for="vf">From serial</label><input id="vf" name="from" type="number" min="1" required></div>
          <div class="field"><label for="vto">To serial</label><input id="vto" name="to" type="number" min="1" required></div>
          <div class="field"><label for="vr">Reason</label><input id="vr" name="reason" placeholder="e.g. stack lost"></div>
          <button class="btn btn-danger span-2" type="submit">Void today's slips in this range</button>
        </form>
      </details>` : ""}
    </div>
  </section>
</div>

<section class="card">
  <h2>Today's prints</h2>
  ${d.batches.length ? d.batches.map((b) => batchCard(b, d.isAdmin)) : html`<p class="muted">Nothing printed today yet.</p>`}
</section>

${d.isAdmin ? html`
<section class="card">
  <h2>Past batches</h2>
  <div class="table-scroll"><table class="table">
    <thead><tr><th>Date</th><th>Printed</th><th>Solo used</th><th>Group used</th><th>Printed by</th></tr></thead>
    <tbody>${d.history.map((h) => html`<tr>
      <td><strong>${formatDateShort(h.business_date)}</strong></td>
      <td>${h.daily}${h.extra ? ` + ${h.extra} extra` : ""}</td>
      <td>${h.solo_used} / ${h.solo_total}${h.business_date === d.date ? " (so far)" : ""}</td>
      <td>${h.group_used} / ${h.group_total}${h.business_date === d.date ? " (so far)" : ""}</td>
      <td>${h.printed_by ?? "\u2013"}</td></tr>`)}</tbody>
  </table></div>
</section>` : ""}
<script src="/static/js/forms.js"></script>`;
}

// src/web/pages/settings.ts
var ADMIN_CAN = "Everything: print batches, void slips, reports, settings, staff";
var BARISTA_CAN = "Print extra slips, look up codes, disconnect devices";
function backupText(comment) {
  const m = comment.match(/(\d{4}-\d{2}-\d{2}|[a-z]{3}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : "No automatic backup yet";
}
function settingsMain(d) {
  const s = d.settings;
  const info = d.sync.info;
  const field = (id, label, value, hint, attrs = 'min="0" max="600"') => html`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="number" value="${value}" ${raw(attrs)}><span class="hint">${hint}</span></div>`;
  return html`
<div class="page-head"><div class="stack-4">
  <span class="eyebrow">Owner only</span>
  <h1 class="title">Settings &amp; staff</h1>
</div></div>
${flash(d.flash)}

<div class="row">
  <section class="card grow-3">
    <h2>Wi‑Fi rules</h2>
    <form method="post" action="/settings" class="stack-14">
      <div class="rule-grid">
        ${field("durMinutes", "Time per code (minutes)", Math.round(s.durSeconds / 60), "Counted like a clock from first login. 180 = 3 hours", 'min="15" max="1200" step="15"')}
        ${field("soloPerDay", "Solo slips per day", s.soloPerDay, `S-001 to S-${String(s.soloPerDay).padStart(3, "0")}`)}
        ${field("groupPerDay", "Group slips per day", s.groupPerDay, `G-001 to G-${String(s.groupPerDay).padStart(3, "0")}`)}
        ${field("extraSolo", "\u201C+ solo\u201D button adds", s.extraSolo, "Extra slips when today runs out", 'min="1" max="200"')}
        ${field("extraGroup", "\u201C+ group\u201D button adds", s.extraGroup, "Extra group slips", 'min="1" max="100"')}
      </div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">Save rules</button>
        <span class="muted small">Changes apply to the next batch of slips.</span>
      </div>
    </form>
    <h3 class="sub">Set on the router</h3>
    <p class="muted small">These are part of the router configuration (Phase 1 scripts) and are shown here for reference.</p>
    <div class="rule-grid">
      <div class="ro"><span>All codes stop at</span><strong>1:00 AM</strong><small>Closing; unused slips are deleted</small></div>
      <div class="ro"><span>Speed per device</span><strong>${info?.rateLimit || "\u2013"}</strong><small>Download / upload</small></div>
      <div class="ro"><span>Devices per group code</span><strong>${info?.groupDevices || "\u2013"}</strong><small>Solo codes are always 1 device</small></div>
      <div class="ro"><span>Idle logout</span><strong>${info?.idleTimeout || "\u2013"}</strong><small>Time is kept when they log back in</small></div>
    </div>
  </section>

  <section class="card card-dark grow-2">
    <h2>Router</h2>
    ${d.sync.ok ? html`<div class="status-line ok"><span class="dot dot-ok"></span>Checking in${d.routerKind === "mock" ? " (mock router, for testing)" : ""}</div>` : html`<div class="status-line bad"><span class="dot dot-err"></span>Not checking in</div><p class="small">${d.sync.error ?? ""}</p>`}
    <div class="dl">
      <div><span>Model</span><span>${info?.board || "\u2013"}</span></div>
      <div><span>RouterOS</span><span>${info?.version || "\u2013"}</span></div>
      <div><span>Name</span><span>${info?.identity || "\u2013"}</span></div>
      <div><span>Customer Wi‑Fi</span><span>${d.wifiName}</span></div>
      <div><span>Last backup</span><span>${info ? backupText(info.backupComment) : "\u2013"}</span></div>
    </div>
    <p class="small dim">The router saves a backup itself every night at 1:15 AM and keeps the last 7 days (Files: drc-auto-mon … drc-auto-sun). To copy one off the router: Winbox → Files → drag to the laptop.</p>
  </section>
</div>

<section class="card">
  <div class="card-head"><h2>Staff accounts</h2></div>
  <div class="table-scroll"><table class="table">
    <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Can do</th><th>Last login</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${d.staff.map((st) => html`<tr class="${st.active ? "" : "dimmed"}">
      <td><strong>${st.display_name}</strong>${st.id === d.me.id ? html` <small class="muted">(you)</small>` : ""}${st.active ? "" : html` <small class="muted">(disabled)</small>`}</td>
      <td class="mono">${st.username}</td>
      <td><span class="role role-${st.role}">${st.role === "admin" ? "Admin" : "Barista"}</span></td>
      <td class="muted">${st.role === "admin" ? ADMIN_CAN : BARISTA_CAN}</td>
      <td class="muted">${st.last_login_at ? formatWhen(st.last_login_at, d.now) : "Never"}</td>
      <td><details class="row-menu"><summary class="btn btn-light btn-sm">Manage</summary>
        <div class="menu-body">
          <form method="post" action="/staff/${st.id}" class="inline-form">
            <input type="hidden" name="op" value="password">
            <label class="sr-only" for="np${st.id}">New password</label>
            <input id="np${st.id}" name="password" type="password" placeholder="New password (8+)" minlength="8" required autocomplete="new-password">
            <button class="btn btn-outline btn-sm" type="submit">Set password</button>
          </form>
          <form method="post" action="/staff/${st.id}"><input type="hidden" name="op" value="role"><input type="hidden" name="role" value="${st.role === "admin" ? "barista" : "admin"}">
            <button class="btn btn-outline btn-sm" type="submit">Make ${st.role === "admin" ? "barista" : "admin"}</button></form>
          <form method="post" action="/staff/${st.id}"><input type="hidden" name="op" value="${st.active ? "disable" : "enable"}">
            <button class="btn ${st.active ? "btn-danger-outline" : "btn-outline"} btn-sm" type="submit">${st.active ? "Disable account" : "Enable account"}</button></form>
        </div></details></td>
    </tr>`)}</tbody>
  </table></div>

  <details class="add-staff">
    <summary class="btn btn-outline">Add staff</summary>
    <form method="post" action="/staff" class="form-grid">
      <div class="field"><label for="sn">Name</label><input id="sn" name="displayName" required placeholder="Barista – Morning"></div>
      <div class="field"><label for="su">Username</label><input id="su" name="username" required placeholder="morning" autocomplete="off"></div>
      <div class="field"><label for="sr">Role</label><select id="sr" name="role"><option value="barista">Barista</option><option value="admin">Admin / owner</option></select></div>
      <div class="field"><label for="sp">Password (8+)</label><input id="sp" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="btn btn-primary span-2" type="submit">Add account</button>
    </form>
  </details>
</section>
<script src="/static/js/forms.js"></script>`;
}

// src/web/pages/sheet.ts
import QRCode from "qrcode";
var durText = (s) => s % 3600 === 0 ? `${s / 3600} hr${s === 3600 ? "" : "s"}` : `${Math.round(s / 60)} min`;
async function qrSvg(url) {
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#000000", light: "#ffffff" } });
}
async function sheetPage(opts) {
  const codes = opts.codes.filter((c) => c.status !== "void");
  const total = Math.max(1, Math.ceil(codes.length / SLIPS_PER_PAGE));
  const pageNums = opts.onlyPage && opts.onlyPage >= 1 && opts.onlyPage <= total ? [opts.onlyPage] : Array.from({ length: total }, (_, i) => i + 1);
  const qrs = /* @__PURE__ */ new Map();
  for (const c of codes) qrs.set(c.code, await qrSvg(qrLoginUrl(opts.qrBase, c.code)));
  const dateLabel = formatDateLong(opts.batch.business_date);
  const sheets = pageNums.map((p) => {
    const slice = codes.slice((p - 1) * SLIPS_PER_PAGE, p * SLIPS_PER_PAGE);
    const first = slice[0], last = slice[slice.length - 1];
    const range = first && last ? `${serialLabel(first.type, first.serial)} to ${serialLabel(last.type, last.serial)}` : "";
    return html`
<section class="sheet">
  <header class="sheet-head">
    <span><strong>Don Robert Café</strong> · Wi‑Fi slips · ${dateLabel}${opts.batch.kind === "extra" ? " \xB7 extra" : ""}</span>
    <span>Page ${p} of ${total} · ${range} · cut along the dashed lines</span>
  </header>
  <div class="sheet-grid">
    ${Array.from({ length: SLIPS_PER_PAGE }, (_, i) => {
      const c = slice[i];
      if (!c) return html`<div class="slip slip-empty"></div>`;
      return html`<div class="slip">
        <div class="slip-qr">${raw(qrs.get(c.code))}</div>
        <div class="slip-text">
          <div class="slip-top"><span class="slip-label">${c.type === "S" ? "SOLO" : "GROUP \xB7 7"}</span><span class="slip-serial">${serialLabel(c.type, c.serial)}</span></div>
          <span class="slip-code">${c.code}</span>
          <span class="slip-small slip-wifi">${opts.wifiName}</span>
          <span class="slip-small"><strong>${durText(c.dur_seconds)}</strong> · today until 1:00 AM</span>
        </div>
      </div>`;
    })}
  </div>
</section>`;
  });
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wi‑Fi slips ${dateLabel}</title>
<link rel="stylesheet" href="/static/css/sheet.css">
</head>
<body>
<div class="toolbar no-print">
  <a href="/print" class="tb-btn">← Back</a>
  <span>${codes.length} slips · ${pageNums.length === total ? `${total} page${total > 1 ? "s" : ""}` : `page ${pageNums[0]} of ${total} only`} · A4, scale 100%, no "fit to page"</span>
  <button type="button" class="tb-btn tb-primary" id="print">Print</button>
</div>
${sheets}
<form id="printed" method="post" action="/batches/${opts.batch.id}/printed" hidden></form>
<script src="/static/js/sheet.js"></script>
</body>
</html>`;
}

// src/web/pages/today.ts
var pct = (a, b) => b ? Math.min(100, Math.round(a / b * 100)) : 0;
var EVENT_TEXT = {
  first_login: "First login",
  expired: "Expired",
  void: "Voided",
  disconnect: "Device disconnected",
  batch_created: "Slips created",
  batch_pushed: "Codes added to router",
  batch_push_failed: "Router problem",
  batch_printed: "Slips printed"
};
function activityText(a) {
  const base = a.detail ?? EVENT_TEXT[a.action] ?? a.action;
  if (a.action === "void") return `Voided by ${a.staff_name ?? "?"}${a.detail ? ` \xB7 ${a.detail}` : ""}`;
  if (a.action === "disconnect") return `Device disconnected by ${a.staff_name ?? "?"}`;
  if (a.staff_name && a.action.startsWith("batch_")) return `${EVENT_TEXT[a.action]} \xB7 ${base} \xB7 ${a.staff_name}`;
  return base;
}
function todayMain(d) {
  const daily = d.batches.find((b) => b.kind === "daily" && b.state !== "void");
  const pending = d.batches.filter((b) => b.state === "pending");
  const extras = d.batches.filter((b) => b.kind === "extra" && b.state !== "void");
  const online = d.sync.active;
  const onlineS = online.filter((a) => a.user.startsWith("S")).length;
  const onlineG = online.length - onlineS;
  const toClose = closingMs(d.date) - d.now;
  const max = Math.max(1, ...d.bars.map((b) => b.n));
  const busiest = d.bars.reduce((m, b) => b.n > (m?.n ?? 0) ? b : m, null);
  const soloLeft = d.counts.solo_total - d.counts.solo_used;
  const groupLeft = d.counts.group_total - d.counts.group_used;
  return html`
<div class="page-head">
  <div class="stack-4">
    <span class="eyebrow">${formatDateLong(d.date)} · ${shiftOf(d.now) === "morning" ? "Morning shift" : "Night shift"}</span>
    <h1 class="title">Today</h1>
  </div>
  <div class="actions">
    <a class="btn btn-outline" href="/lookup">Look up a code</a>
    <a class="btn btn-primary" href="/print#extra">Print more slips</a>
  </div>
</div>

${routerStatus(d.sync, d.now)}

${daily ? html`<div class="notice"><span class="dot dot-ok"></span><span><strong>Today's batch ${daily.state === "printed" ? `printed at ${formatClock(daily.printed_at)}` : daily.state === "on_router" ? "is on the router (not printed yet)" : "is still being added to the router"}</strong>${d.batchBy ? ` by ${d.batchBy}` : ""} · ${daily.solo_count + daily.group_count} slips (${daily.solo_count} S + ${daily.group_count} G)${extras.length ? ` \xB7 ${extras.length} extra print${extras.length > 1 ? "s" : ""}` : ""} · all codes stop at <strong>1:00 AM</strong></span></div>` : html`<div class="notice notice-warn"><span class="dot dot-warn"></span><span><strong>No batch for today yet.</strong> ${d.isAdmin ? html`<a href="/print">Create and print today's slips</a>` : "Ask the owner to print today's slips, or print extra slips."}</span></div>`}
${pending.length ? html`<div class="notice notice-err"><span class="dot dot-err"></span><span><strong>${pending.length} batch${pending.length > 1 ? "es are" : " is"} waiting for the router.</strong> Those slips start working within about 20 seconds of the router's next check-in. <a href="/print">Open Print slips</a></span></div>` : ""}

<div class="stat-grid">
  <div class="card stat">
    <span class="stat-label">Solo slips used</span>
    <span class="stat-num">${d.counts.solo_used} <small>/ ${d.counts.solo_total}</small></span>
    <div class="meter"><div style="width:${pct(d.counts.solo_used, d.counts.solo_total)}%"></div></div>
    <span class="stat-sub">${soloLeft} left${soloLeft <= 10 && d.counts.solo_total ? " \xB7 running low" : ""}</span>
  </div>
  <div class="card stat">
    <span class="stat-label">Group slips used</span>
    <span class="stat-num">${d.counts.group_used} <small>/ ${d.counts.group_total}</small></span>
    <div class="meter"><div style="width:${pct(d.counts.group_used, d.counts.group_total)}%"></div></div>
    <span class="stat-sub">${groupLeft} left${groupLeft <= 3 && d.counts.group_total ? " \xB7 running low" : ""}</span>
  </div>
  <div class="card stat">
    <span class="stat-label">Devices online now</span>
    <span class="stat-num">${d.sync.ok ? online.length : "\u2013"}</span>
    <span class="stat-sub">${onlineS} solo · ${onlineG} on group codes</span>
  </div>
  <div class="card card-dark stat">
    <span class="stat-label">Codes stop at 1:00 AM</span>
    <span class="stat-num">${formatDuration(toClose)}</span>
    <span class="stat-sub">Unused slips are deleted at closing</span>
  </div>
</div>

<div class="row">
  <section class="card grow-2">
    <div class="card-head">
      <h2>Slips used by hour</h2>
      <span class="muted small">${busiest ? `Busiest so far: ${busiest.label.replace("a", " AM").replace("p", " PM")} (${busiest.n} slip${busiest.n === 1 ? "" : "s"})` : "No slips used yet"}</span>
    </div>
    <div class="bars" role="img" aria-label="${`Slips used per hour. ${d.bars.filter((b) => b.n).map((b) => `${b.label}: ${b.n}`).join(", ") || "None yet."}`}">
      ${d.bars.map((b) => html`<div class="bar-col"><span class="bar-n">${b.n || ""}</span><div class="bar bar-${b.shift}" style="height:${Math.round(b.n / max * 130)}px"></div></div>`)}
    </div>
    <div class="bar-labels">${d.bars.map((b) => html`<span>${b.label}</span>`)}</div>
    <div class="legend"><span><i class="sw sw-morning"></i>Morning shift</span><span><i class="sw sw-night"></i>Night shift</span></div>
  </section>

  <section class="card grow-1">
    <h2>By shift</h2>
    <div class="kv-table">
      <div class="kv-head"><span>Shift</span><span>Solo · Group</span></div>
      <div class="kv-row"><span>Morning <small class="muted">7 AM – 4 PM</small></span><strong>${d.shifts.morning.S} · ${d.shifts.morning.G}</strong></div>
      <div class="kv-row"><span>Night <small class="muted">4 PM – 1 AM</small></span><strong>${d.shifts.night.S} · ${d.shifts.night.G}</strong></div>
    </div>
    <p class="hint-box">Compare these with each shift's drink sales on the POS. More slips used than drinks sold means Wi‑Fi is being given away.</p>
  </section>
</div>

<section class="card">
  <h2>Recent activity</h2>
  ${d.activity.length ? d.activity.map((a) => html`
    <div class="activity">
      <span class="act-time">${formatClock(a.at)}</span>
      <span class="mono act-serial">${a.serial !== null && a.type ? serialLabel(a.type, a.serial) : ""}</span>
      <span class="mono act-code">${a.code ?? ""}</span>
      <span class="act-text">${activityText(a)}</span>
    </div>`) : html`<p class="muted">Nothing yet today.</p>`}
</section>`;
}

// src/web/routes.ts
var COOKIE = "drc_session";
function cookieToken(req) {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m?.[1];
}
var isHttps = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
var cookieAttrs = (req) => `HttpOnly; SameSite=Lax; Path=/${isHttps(req) ? "; Secure" : ""}`;
var me = (res) => res.locals.staff;
var dbOf = (res) => res.locals.db;
var str = (v) => typeof v === "string" ? v : "";
var int = (v) => typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
var msg = (s) => encodeURIComponent(s.slice(0, 300));
var readFlash = (req) => ({ ok: str(req.query.ok) || void 0, err: str(req.query.err) || void 0 });
var safeBack = (v, fallback) => {
  const s = str(v);
  return s.startsWith("/") && !s.startsWith("//") ? s : fallback;
};
var withMsg = (path, kind, text) => `${path}${path.includes("?") ? "&" : "?"}${kind}=${msg(text)}`;
function buildRoutes(ctx) {
  const { cfg } = ctx;
  const r = express.Router();
  const profiles = { soloProfile: cfg.soloProfile, groupProfile: cfg.groupProfile };
  r.use(async (_req, res, next) => {
    res.locals.db = await ctx.db();
    next();
  });
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
      if (e instanceof ProtocolError) {
        res.status(400).type("text/plain").send(`error|${e.message}
`);
        return;
      }
      throw e;
    }
  });
  r.use((req, res, next) => {
    if (req.method === "POST") {
      const origin = req.headers.origin;
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
      let originHost = "";
      try {
        originHost = origin ? new URL(origin).host : "";
      } catch {
        originHost = "invalid";
      }
      if (origin && originHost !== host) {
        res.status(403).send("Cross-site request blocked");
        return;
      }
    }
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  r.get("/setup", async (_req, res) => {
    if (await staffCount(dbOf(res)) > 0) return res.redirect("/login");
    res.send(setupPage({}).value);
  });
  r.post("/setup", async (req, res) => {
    const db = dbOf(res);
    if (await staffCount(db) > 0) return res.redirect("/login");
    try {
      await createStaff(db, { username: str(req.body.username), displayName: str(req.body.displayName), role: "admin", password: str(req.body.password) }, null);
      res.redirect("/login");
    } catch (e) {
      res.status(400).send(setupPage({ error: e.message }).value);
    }
  });
  r.get("/login", async (_req, res) => {
    if (await staffCount(dbOf(res)) === 0) return res.redirect("/setup");
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
  r.use(async (req, res, next) => {
    const db = dbOf(res);
    const s = await sessionStaff(db, cookieToken(req));
    if (!s) return res.redirect(await staffCount(db) === 0 ? "/setup" : "/login");
    res.locals.staff = s;
    next();
  });
  const adminOnly = (_req, res, next) => {
    if (me(res).role !== "admin") {
      res.status(403).send(appPage({ title: "Not allowed", staff: me(res), active: "today", main: forbidden() }).value);
      return;
    }
    next();
  };
  r.get("/", async (_req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const date = businessDate(now);
    const batches = await batchesForDate(db, date);
    const daily = batches.find((b) => b.kind === "daily" && b.state !== "void");
    const batchBy = daily ? (await db.get("SELECT display_name AS n FROM staff WHERE id = ?", daily.printed_by ?? daily.created_by ?? 0))?.n ?? null : null;
    const [{ bars, shifts }, counts, sync, recent] = await Promise.all([
      usageByHour(db, date),
      dayCounts(db, date),
      getRouterStatus(db, now),
      recentActivity(db, 40, ["first_login", "expired", "void", "disconnect", "batch_created", "batch_printed"])
    ]);
    const activity = recent.filter((a) => businessDate(a.at) === date).slice(0, 10);
    res.send(appPage({
      title: "Today",
      staff: me(res),
      active: "today",
      refreshSeconds: 30,
      main: todayMain({ now, date, counts, bars, shifts, batches, batchBy, activity, sync, isAdmin: me(res).role === "admin" })
    }).value);
  });
  r.get("/print", async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const date = businessDate(now);
    const staffNames = new Map((await listStaff(db)).map((s) => [s.id, s.display_name]));
    const batches = await Promise.all((await batchesForDate(db, date)).map(async (b) => ({ ...b, codes: await codesForBatch(db, b.id), by: staffNames.get(b.created_by ?? 0) ?? null })));
    const [settings, history, sync] = await Promise.all([getSettings(db), pastDays(db, 14), getRouterStatus(db, now)]);
    res.send(appPage({
      title: "Print slips",
      staff: me(res),
      active: "print",
      refreshSeconds: batches.some((b) => b.state === "pending") ? 8 : void 0,
      main: printMain({ date, closed: isClosedWindow(now), settings, isAdmin: me(res).role === "admin", batches, history, routerOk: sync.ok, flash: readFlash(req) })
    }).value);
  });
  r.post("/batches", async (req, res) => {
    const kind = str(req.body.kind) === "daily" ? "daily" : "extra";
    if (kind === "daily" && me(res).role !== "admin") return res.redirect(withMsg("/print", "err", "Only the owner/admin makes the daily batch."));
    const requestId = str(req.body.requestId);
    if (!/^[0-9a-f-]{36}$/.test(requestId)) return res.redirect(withMsg("/print", "err", "Form expired. Please try again."));
    try {
      const batch = await createBatch(dbOf(res), { kind, solo: int(req.body.solo), group: int(req.body.group), requestId, staffId: me(res).id });
      res.redirect(withMsg("/print", "ok", `${batch.solo_count + batch.group_count} codes created. The router adds them at its next check-in; the Print button appears when all are on the router.`));
    } catch (e) {
      if (e instanceof UserError) return res.redirect(withMsg("/print", "err", e.message));
      throw e;
    }
  });
  r.get("/batches/:id/sheet", async (req, res) => {
    const db = dbOf(res);
    const batch = await getBatch(db, int(req.params.id));
    if (!batch || batch.business_date !== businessDate(Date.now())) return res.redirect(withMsg("/print", "err", "Only today's slips can be printed."));
    if (batch.state === "pending") return res.redirect(withMsg("/print", "err", "Not all codes are on the router yet. Wait for the router's next check-in."));
    if (batch.state === "void") return res.redirect(withMsg("/print", "err", "This batch was voided."));
    const page = int(req.query.page);
    res.send((await sheetPage({ batch, codes: await codesForBatch(db, batch.id), wifiName: cfg.wifiName, qrBase: cfg.qrLoginUrl, onlyPage: Number.isNaN(page) ? void 0 : page })).value);
  });
  r.post("/batches/:id/printed", async (req, res) => {
    try {
      await markPrinted(dbOf(res), int(req.params.id), me(res).id);
      res.status(204).end();
    } catch (e) {
      res.status(400).send(e.message);
    }
  });
  r.post("/batches/:id/void", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const batch = await getBatch(db, int(req.params.id));
    if (!batch) return res.redirect("/print");
    const out = await voidCodes(db, await codesForBatch(db, batch.id), me(res).id, `batch #${batch.id} voided`);
    res.redirect(withMsg("/print", "ok", voidSummary(out.voided.length)));
  });
  r.post("/void-range", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const type = str(req.body.type) === "G" ? "G" : "S";
    const from = int(req.body.from), to = int(req.body.to);
    if (!(from >= 1 && to >= from)) return res.redirect(withMsg("/print", "err", "Enter a serial range like 41 to 60."));
    const codes = await codesBySerialRange(db, businessDate(Date.now()), type, from, to);
    if (!codes.length) return res.redirect(withMsg("/print", "err", `No ${type} slips ${from}\u2013${to} today.`));
    const reason = `${serialLabel(type, from)} to ${serialLabel(type, to)}${str(req.body.reason) ? ` \xB7 ${str(req.body.reason).slice(0, 80)}` : ""}`;
    const out = await voidCodes(db, codes, me(res).id, reason);
    res.redirect(withMsg("/print", "ok", voidSummary(out.voided.length)));
  });
  r.get("/lookup", async (req, res) => {
    const db = dbOf(res);
    const now = Date.now();
    const today = businessDate(now);
    const q = str(req.query.q).trim().slice(0, 20);
    let result = null;
    if (q) {
      const norm = normaliseCode(q);
      if (CODE_RE.test(norm)) result = await findCode(db, norm) ?? null;
      else {
        const s = parseSerial(q);
        if (s) result = await findBySerial(db, today, s.type, s.serial) ?? null;
      }
    }
    const sync = await getRouterStatus(db, now);
    const todays = new Map((await db.all("SELECT * FROM codes WHERE business_date = ?", today)).map((c) => [c.code, c]));
    const online = sync.active.map((a) => {
      const c = todays.get(a.user);
      return { ...a, serial: c ? serialLabel(c.type, c.serial) : "", type: a.user[0], endsAt: c?.ends_at ? Math.min(c.ends_at, closingMs(c.business_date)) : null };
    });
    res.send(appPage({
      title: "Look up",
      staff: me(res),
      active: "lookup",
      refreshSeconds: q ? void 0 : 30,
      main: lookupMain({
        now,
        q,
        today,
        result,
        notFound: !!q && !result,
        devices: result ? sync.active.filter((a) => a.user === result.code) : [],
        online,
        sync,
        isAdmin: me(res).role === "admin",
        flash: readFlash(req)
      })
    }).value);
  });
  r.post("/devices/disconnect", async (req, res) => {
    const back2 = safeBack(req.body.back, "/lookup");
    const [user, mac] = str(req.body.id).split("|");
    if (!user || !CODE_RE.test(user) || mac && !/^[0-9A-F:]{17}$/i.test(mac)) return res.redirect(withMsg(back2, "err", "Unknown device."));
    await queueKick(dbOf(res), user, mac ?? "", me(res).id);
    res.redirect(withMsg(back2, "ok", `Disconnecting the device on ${user} at the router's next check-in (about 20 seconds).`));
  });
  r.post("/codes/:code/void", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const back2 = safeBack(req.body.back, "/lookup");
    const c = await findCode(db, str(req.params.code));
    if (!c) return res.redirect(withMsg(back2, "err", "No such code."));
    const out = await voidCodes(db, [c], me(res).id, "voided from Look up");
    res.redirect(withMsg(back2, "ok", voidSummary(out.voided.length)));
  });
  r.get("/settings", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const [settings, staff, sync] = await Promise.all([getSettings(db), listStaff(db), getRouterStatus(db)]);
    res.send(appPage({
      title: "Settings",
      staff: me(res),
      active: "settings",
      main: settingsMain({ now: Date.now(), settings, staff, me: me(res), sync, routerKind: cfg.routerMode, wifiName: cfg.wifiName, flash: readFlash(req) })
    }).value);
  });
  r.post("/settings", adminOnly, async (req, res) => {
    const db = dbOf(res);
    const durMinutes = int(req.body.durMinutes);
    const vals = { soloPerDay: int(req.body.soloPerDay), groupPerDay: int(req.body.groupPerDay), extraSolo: int(req.body.extraSolo), extraGroup: int(req.body.extraGroup) };
    if (!(durMinutes >= 15 && durMinutes <= 1200)) return res.redirect(withMsg("/settings", "err", "Time per code must be 15\u20131200 minutes."));
    if (Object.values(vals).some((v) => !(v >= 0 && v <= 600))) return res.redirect(withMsg("/settings", "err", "Slip counts must be 0\u2013600."));
    await saveSettings(db, { durSeconds: durMinutes * 60, ...vals });
    await audit(db, "settings_saved", { staffId: me(res).id, detail: `${durMinutes} min, ${vals.soloPerDay} S + ${vals.groupPerDay} G per day` });
    res.redirect(withMsg("/settings", "ok", "Saved. Applies to the next batch."));
  });
  r.post("/staff", adminOnly, async (req, res) => {
    try {
      const role = str(req.body.role) === "admin" ? "admin" : "barista";
      await createStaff(dbOf(res), { username: str(req.body.username), displayName: str(req.body.displayName), role, password: str(req.body.password) }, me(res).id);
      res.redirect(withMsg("/settings", "ok", "Account added."));
    } catch (e) {
      res.redirect(withMsg("/settings", "err", e.message));
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
      res.redirect(withMsg("/settings", "err", e.message));
    }
  });
  return r;
}
function voidSummary(n) {
  if (!n) return "Nothing to void (already void).";
  return `Voided ${n} slip${n === 1 ? "" : "s"}. They stop working at the router's next check-in (about 20 seconds).`;
}
function forbidden() {
  return html`<div class="page-head"><h1 class="title">Owner only</h1></div><p>This page is for the owner/admin account.</p><p><a href="/">Back to Today</a></p>`;
}

// src/app.ts
function rootDir() {
  if (existsSync(join(process.cwd(), "public", "css", "app.css"))) return process.cwd();
  return join(dirname2(fileURLToPath(import.meta.url)), "..");
}
function createApp(cfg) {
  let dbPromise = null;
  const db = () => dbPromise ??= openDb(cfg.databaseUrl, cfg.databaseToken).catch((e) => {
    dbPromise = null;
    throw e;
  });
  const app2 = express2();
  app2.disable("x-powered-by");
  app2.set("trust proxy", true);
  app2.use("/static", express2.static(join(rootDir(), "public"), { maxAge: "10m" }));
  app2.use(express2.urlencoded({ extended: false, limit: "20kb" }));
  app2.use(buildRoutes({ db, cfg }));
  app2.use((err, _req, res, _next) => {
    console.error((/* @__PURE__ */ new Date()).toISOString(), err);
    res.status(500).send(`<p style="font-family:sans-serif">Something went wrong: ${String(err.message).replace(/[<>&]/g, "")}</p><p><a href="/">Back</a></p>`);
  });
  return { app: app2, db };
}

// src/config.ts
import { dirname as dirname3, resolve } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var PANEL_DIR = resolve(dirname3(fileURLToPath2(import.meta.url)), "..");
function env(name, fallback = "") {
  const v = process.env[name];
  return v === void 0 || v.trim() === "" ? fallback : v.trim();
}
function loadConfig() {
  const mode = env("ROUTER_MODE", "mock");
  if (mode !== "mock" && mode !== "router") throw new Error(`ROUTER_MODE must be mock or router, got "${mode}"`);
  let databaseUrl = env("DATABASE_URL", env("TURSO_DATABASE_URL", "file:./data/panel.db"));
  if (databaseUrl.startsWith("file:") && !databaseUrl.startsWith("file:/") && !/^file:[A-Za-z]:/.test(databaseUrl)) {
    databaseUrl = "file:" + resolve(PANEL_DIR, databaseUrl.slice(5)).replace(/\\/g, "/");
  }
  const cfg = {
    host: env("PANEL_HOST", "127.0.0.1"),
    port: Number(env("PANEL_PORT", "8080")),
    databaseUrl,
    databaseToken: env("DATABASE_AUTH_TOKEN", env("TURSO_AUTH_TOKEN")),
    routerToken: env("ROUTER_TOKEN"),
    routerMode: mode,
    soloProfile: env("SOLO_PROFILE", "solo-3h"),
    groupProfile: env("GROUP_PROFILE", "group-3h"),
    wifiName: env("WIFI_NAME", "Don Robert Cafe - Free WiFi"),
    qrLoginUrl: env("QR_LOGIN_URL", "http://192.168.88.1/login"),
    mockSimulate: env("MOCK_SIMULATE", "1") === "1"
  };
  if (cfg.routerMode === "router" && cfg.routerToken.length < 32) {
    throw new Error("ROUTER_MODE=router needs ROUTER_TOKEN (32+ random characters, same as on the router)");
  }
  return cfg;
}

// src/vercel.ts
var { app } = createApp(loadConfig());
var vercel_default = app;
export {
  vercel_default as default
};
