import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "../db.ts";
import { audit } from "./audit.ts";

export type Role = "admin" | "barista";
export interface Staff { id: number; username: string; display_name: string; role: Role; active: number; created_at: number; last_login_at: number | null }

const SESSION_MS = 14 * 3600_000; // one long shift
const N = 16384;
const STAFF_COLS = "id, username, display_name, role, active, created_at, last_login_at";

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(got, expected);
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export async function staffCount(db: DB): Promise<number> {
  return (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM staff"))!.n;
}

export function listStaff(db: DB): Promise<Staff[]> {
  return db.all<Staff>(`SELECT ${STAFF_COLS} FROM staff ORDER BY role, display_name`);
}

export function getStaff(db: DB, id: number): Promise<Staff | undefined> {
  return db.get<Staff>(`SELECT ${STAFF_COLS} FROM staff WHERE id = ?`, id);
}

export async function createStaff(db: DB, s: { username: string; displayName: string; role: Role; password: string }, byId: number | null): Promise<number> {
  const username = s.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new Error("Username: 2–32 letters, numbers, dot, dash or underscore.");
  if (!s.displayName.trim()) throw new Error("Name is required.");
  const pwErr = validatePassword(s.password);
  if (pwErr) throw new Error(pwErr);
  if (await db.get("SELECT 1 FROM staff WHERE username = ?", username)) throw new Error("That username is taken.");
  const r = await db.run("INSERT INTO staff (username, display_name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    username, s.displayName.trim(), s.role, hashPassword(s.password), Date.now());
  await audit(db, "staff_added", { staffId: byId, detail: `${s.displayName.trim()} (${s.role})` });
  return r.lastInsertRowid;
}

async function activeAdminCount(db: DB): Promise<number> {
  return (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND active = 1"))!.n;
}

export async function updateStaff(db: DB, id: number, ch: { role?: Role; active?: boolean; password?: string }, byId: number) {
  const s = await getStaff(db, id);
  if (!s) throw new Error("No such staff account.");
  const losesAdmin = s.role === "admin" && s.active === 1 && ((ch.role && ch.role !== "admin") || ch.active === false);
  if (losesAdmin && (await activeAdminCount(db)) <= 1) throw new Error("There must always be at least one active owner/admin account.");
  if (ch.role) await db.run("UPDATE staff SET role = ? WHERE id = ?", ch.role, id);
  if (ch.active !== undefined) {
    await db.run("UPDATE staff SET active = ? WHERE id = ?", ch.active ? 1 : 0, id);
    if (!ch.active) await db.run("DELETE FROM sessions WHERE staff_id = ?", id);
  }
  if (ch.password !== undefined) {
    const err = validatePassword(ch.password);
    if (err) throw new Error(err);
    await db.run("UPDATE staff SET pass_hash = ? WHERE id = ?", hashPassword(ch.password), id);
    await db.run("DELETE FROM sessions WHERE staff_id = ?", id);
    await audit(db, "password_reset", { staffId: byId, detail: s.display_name });
  }
  if (ch.role || ch.active !== undefined) {
    await audit(db, "staff_changed", { staffId: byId, detail: `${s.display_name}: ${ch.role ? "role " + ch.role : ""}${ch.active !== undefined ? (ch.active ? " enabled" : " disabled") : ""}`.trim() });
  }
}

// --- login throttling: 5 failures per username -> 2 minute wait (per server instance)
const failures = new Map<string, { n: number; until: number }>();

export async function login(db: DB, username: string, password: string): Promise<{ token: string; staff: Staff } | { error: string }> {
  const key = username.trim().toLowerCase();
  const f = failures.get(key);
  if (f && f.until > Date.now()) return { error: "Too many wrong passwords. Wait 2 minutes and try again." };
  const row = await db.get<Staff & { pass_hash: string }>("SELECT * FROM staff WHERE username = ?", key);
  const ok = row && row.active === 1 && verifyPassword(password, row.pass_hash);
  if (!ok || !row) {
    const n = (f?.n ?? 0) + 1;
    failures.set(key, { n, until: n >= 5 ? Date.now() + 120_000 : 0 });
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
  return { token, staff: (await getStaff(db, row.id))! };
}

export function sessionStaff(db: DB, token: string | undefined): Promise<Staff | undefined> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return Promise.resolve(undefined);
  return db.get<Staff>(`
    SELECT s.id, s.username, s.display_name, s.role, s.active, s.created_at, s.last_login_at
    FROM sessions x JOIN staff s ON s.id = x.staff_id
    WHERE x.token = ? AND x.expires_at > ? AND s.active = 1`, token, Date.now());
}

export async function logout(db: DB, token: string | undefined) {
  if (token) await db.run("DELETE FROM sessions WHERE token = ?", token);
}
