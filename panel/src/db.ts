import { createClient, type Client, type InValue, type Transaction } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Database access. libSQL works the same with a local file (development, tests)
 * and with Turso in the cloud (production on Vercel).
 */
export interface DB {
  all<T>(sql: string, ...args: InValue[]): Promise<T[]>;
  get<T>(sql: string, ...args: InValue[]): Promise<T | undefined>;
  run(sql: string, ...args: InValue[]): Promise<{ lastInsertRowid: number; changes: number }>;
  /** Run fn inside one write transaction (all or nothing). */
  tx<T>(fn: (db: DB) => Promise<T>): Promise<T>;
}

const SCHEMA = `
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

-- Drinks sold per shift, typed in from the POS on the Reports page.
CREATE TABLE IF NOT EXISTS shift_drinks (
  business_date TEXT NOT NULL,
  shift         TEXT NOT NULL CHECK (shift IN ('morning', 'night')),
  drinks        INTEGER NOT NULL,
  staff_id      INTEGER,
  saved_at      INTEGER NOT NULL,
  PRIMARY KEY (business_date, shift)
);
`;

/**
 * Columns added after the first release (2026-11-14):
 * - codes.valid_until: unused slips carry over and stop at this time (30 days after printing).
 *   Older codes keep their old rule: they stopped at their own day's 1:00 AM closing.
 * - codes.issued_at / issued_by: a code shown on screen with "Give Wi-Fi".
 * - batches.pool: codes kept on the router for "Give Wi-Fi" (never printed).
 */
async function migrate(client: Client) {
  const cols = async (table: string) => new Set((await client.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name)));
  const c = await cols("codes");
  if (!c.has("valid_until")) {
    await client.execute("ALTER TABLE codes ADD COLUMN valid_until INTEGER");
    // closing of the code's own day: 01:00 Manila the next day = 17:00 UTC on business_date
    await client.execute("UPDATE codes SET valid_until = (CAST(strftime('%s', business_date) AS INTEGER) + 17 * 3600) * 1000 WHERE valid_until IS NULL");
  }
  if (!c.has("issued_at")) await client.execute("ALTER TABLE codes ADD COLUMN issued_at INTEGER");
  if (!c.has("issued_by")) await client.execute("ALTER TABLE codes ADD COLUMN issued_by INTEGER");
  if (!(await cols("batches")).has("pool")) await client.execute("ALTER TABLE batches ADD COLUMN pool INTEGER NOT NULL DEFAULT 0");
  await client.execute("CREATE INDEX IF NOT EXISTS codes_live ON codes(status, valid_until)");
}

function wrap(exec: (sql: string, args: InValue[]) => Promise<{ rows: unknown[]; lastInsertRowid?: bigint; rowsAffected: number }>): Omit<DB, "tx"> {
  return {
    async all<T>(sql: string, ...args: InValue[]) {
      return (await exec(sql, args)).rows.map((r) => ({ ...(r as object) })) as T[];
    },
    async get<T>(sql: string, ...args: InValue[]) {
      const rows = (await exec(sql, args)).rows;
      return rows[0] ? ({ ...(rows[0] as object) } as T) : undefined;
    },
    async run(sql: string, ...args: InValue[]) {
      const r = await exec(sql, args);
      return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected };
    },
  };
}

export async function openDb(url: string, authToken?: string): Promise<DB & { close(): void }> {
  if (url.startsWith("file:")) mkdirSync(dirname(url.slice(5)), { recursive: true });
  const client: Client = createClient({ url, authToken: authToken || undefined, intMode: "number" });
  await client.executeMultiple("PRAGMA foreign_keys = ON;");
  await client.executeMultiple(SCHEMA);
  await migrate(client);
  const base = wrap((sql, args) => client.execute({ sql, args }));
  // libSQL serialises writes; a simple queue keeps local transactions from overlapping
  let chain: Promise<unknown> = Promise.resolve();
  const db: DB & { close(): void } = {
    ...base,
    tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
      const run = async () => {
        const t: Transaction = await client.transaction("write");
        const inner: DB = { ...wrap((sql, args) => t.execute({ sql, args })), tx: (f) => f(inner) };
        try {
          const out = await fn(inner);
          await t.commit();
          return out;
        } catch (e) {
          await t.rollback().catch(() => undefined);
          throw e;
        } finally {
          t.close();
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
    close: () => client.close(),
  };
  return db;
}
