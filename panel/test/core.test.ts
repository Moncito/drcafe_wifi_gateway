import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_RE, parseRouterComment, parseSerial, qrLoginUrl, randomCode } from "../src/codes.ts";
import { openDb, type DB } from "../src/db.ts";
import { MockRouter } from "../src/router/mock.ts";
import { formatCommands, parseCommands, parseReport } from "../src/router/protocol.ts";
import { createStaff } from "../src/services/auth.ts";
import { codesForBatch, createBatch, getBatch, markPrinted, UserError, voidCodes } from "../src/services/batches.ts";
import { getRouterStatus, handleRouterReport, queueKick, tokenMatches } from "../src/services/routerlink.ts";
import { dayCounts } from "../src/services/stats.ts";
import { businessDate, closingMs, isClosedWindow, msToRouterEpoch, routerEpochToMs } from "../src/time.ts";

// 10:00 AM Manila, Sat Nov 14 2026
const T10AM = Date.UTC(2026, 10, 14, 2, 0, 0);
const profiles = { soloProfile: "solo-3h", groupProfile: "group-3h" };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "drc-test-"));
  const db = await openDb("file:" + join(dir, "t.db").replace(/\\/g, "/"));
  let now = T10AM;
  const router = new MockRouter({ dataDir: null, simulate: false, now: () => now });
  const staffId = await createStaff(db, { username: "owner", displayName: "Owner", role: "admin", password: "password123" }, null);
  /** one router check-in, like drc-cloud-sync */
  const checkIn = async () => router.apply(await handleRouterReport(db, profiles, router.report(), now));
  const cleanup = () => { db.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may keep the file locked a moment */ } };
  return { db, router, staffId, checkIn, setNow: (t: number) => { now = t; }, cleanup };
}

let rid = 0;
const reqId = () => `00000000-0000-4000-8000-${String(++rid).padStart(12, "0")}`;

test("codes: format, serials, QR link", () => {
  for (let i = 0; i < 2000; i++) {
    assert.match(randomCode("S"), CODE_RE);
    assert.match(randomCode("G"), CODE_RE);
  }
  assert.doesNotMatch("S0OIL1", CODE_RE);
  assert.deepEqual(parseSerial("S-042"), { type: "S", serial: 42 });
  assert.deepEqual(parseSerial("g7"), { type: "G", serial: 7 });
  assert.equal(parseSerial("X-1"), null);
  assert.equal(qrLoginUrl("http://192.168.88.1/login", "S3K7PW"), "http://192.168.88.1/login?username=S3K7PW&password=S3K7PW");
  assert.deepEqual(parseRouterComment("drc;dur=10800;start=100;end=10900;"), { dur: 10800, start: 100, end: 10900 });
  assert.deepEqual(parseRouterComment("Sainty laptop"), {});
});

test("time: business day and closed window (Manila)", () => {
  assert.equal(businessDate(T10AM), "2026-11-14");
  const halfPast12am = Date.UTC(2026, 10, 14, 16, 30); // 00:30 Nov 15 Manila
  assert.equal(businessDate(halfPast12am), "2026-11-14");
  assert.equal(isClosedWindow(halfPast12am), false);
  assert.equal(isClosedWindow(Date.UTC(2026, 10, 14, 17, 30)), true); // 01:30
  assert.equal(isClosedWindow(Date.UTC(2026, 10, 14, 21, 0)), false); // 05:00
  assert.equal(closingMs("2026-11-14"), Date.UTC(2026, 10, 14, 17, 0));
  assert.equal(routerEpochToMs(msToRouterEpoch(T10AM)), T10AM);
});

test("protocol: router report and answer round-trip; junk ignored", () => {
  const r = parseReport("v1\ni|hAP|hAP ax S|7.25.1|drc last backup x|7|5M/5M|5m\nu|S3K7PW|0|\nu|K7P42X|0|\nu|G4Q2XE|1|drc;dur=600;start=1;end=601;exp=700;\na|G4Q2XE|192.168.88.5|aa:bb:cc:dd:ee:ff|1m|2m|Phone\n");
  assert.equal(r.info.version, "7.25.1");
  assert.deepEqual(r.users.map((u) => u.name), ["S3K7PW", "G4Q2XE"]); // K7P42X is not a café code
  assert.equal(r.users[1]!.disabled, true);
  assert.equal(r.active[0]!.mac, "AA:BB:CC:DD:EE:FF");
  assert.throws(() => parseReport("hello"));
  const answer = formatCommands([
    { kind: "add", code: "S3K7PW", profile: "solo-3h", limitUptime: "10800s", comment: "drc;dur=10800;" },
    { kind: "del", code: "G4Q2XE" },
    { kind: "kick", code: "G4Q2XE", mac: "AA:BB:CC:DD:EE:FF" },
  ]);
  assert.equal(answer, "ok\nadd|S3K7PW|solo-3h|10800s|drc;dur=10800;\ndel|G4Q2XE\nkick|G4Q2XE|AA:BB:CC:DD:EE:FF\n");
  assert.equal(parseCommands(answer).length, 3);
  assert.equal(tokenMatches("Bearer abcdefghijklmnopqrstuvwxyz123456", "abcdefghijklmnopqrstuvwxyz123456"), true);
  assert.equal(tokenMatches("Bearer wrong", "abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(tokenMatches(undefined, "abcdefghijklmnopqrstuvwxyz123456"), false);
});

test("batch: created pending, router adds at check-in, then printable; no duplicates", async () => {
  const { db, router, staffId, checkIn, cleanup } = await setup();
  try {
    const b = await createBatch(db, { kind: "daily", solo: 150, group: 30, requestId: reqId(), staffId, now: T10AM });
    assert.equal(b.state, "pending");
    const codes = await codesForBatch(db, b.id);
    assert.equal(codes.length, 180);
    assert.equal(new Set(codes.map((c) => c.code)).size, 180);
    assert.equal(codes[0]!.serial, 1);
    assert.equal(codes[149]!.serial, 150);
    assert.equal(codes[150]!.type, "G");
    assert.equal(codes[179]!.serial, 30);
    await assert.rejects(markPrinted(db, b.id, staffId), UserError, "can't print before the router has them");

    await checkIn(); // router receives 150 adds (the limit per check-in)
    await checkIn(); // reports them, receives the remaining 30
    await checkIn(); // reports all
    assert.equal(router.users().length, 180);
    assert.equal((await getBatch(db, b.id))!.state, "on_router");
    await markPrinted(db, b.id, staffId);
    assert.equal((await getBatch(db, b.id))!.state, "printed");
    await checkIn();
    assert.equal(router.users().length, 180, "nothing added twice");

    // same request again (double click / retry) -> same batch
    const again = await createBatch(db, { kind: "daily", solo: 150, group: 30, requestId: b.request_id, staffId, now: T10AM });
    assert.equal(again.id, b.id);
    await assert.rejects(createBatch(db, { kind: "daily", solo: 1, group: 0, requestId: reqId(), staffId, now: T10AM }), UserError);
    const x = await createBatch(db, { kind: "extra", solo: 20, group: 0, requestId: reqId(), staffId, now: T10AM });
    const xc = await codesForBatch(db, x.id);
    assert.equal(xc[0]!.serial, 151);
    assert.equal(xc[19]!.serial, 170);
  } finally { cleanup(); }
});

test("batch: refused in the 1–5 AM closed window", async () => {
  const { db, staffId, cleanup } = await setup();
  try {
    await assert.rejects(createBatch(db, { kind: "daily", solo: 1, group: 0, requestId: reqId(), staffId, now: Date.UTC(2026, 10, 14, 18, 0) }), /closed/);
  } finally { cleanup(); }
});

test("lost answers are harmless: the next check-in sends the same work again", async () => {
  const { db, router, staffId, cleanup } = await setup();
  try {
    const b = await createBatch(db, { kind: "extra", solo: 5, group: 0, requestId: reqId(), staffId, now: T10AM });
    await handleRouterReport(db, profiles, router.report(), T10AM); // answer lost on the way back
    router.apply(await handleRouterReport(db, profiles, router.report(), T10AM));
    router.apply(await handleRouterReport(db, profiles, router.report(), T10AM));
    assert.equal(router.users().length, 5);
    assert.equal((await getBatch(db, b.id))!.state, "on_router");
  } finally { cleanup(); }
});

test("first login, devices, clock expiry, status", async () => {
  const { db, router, staffId, checkIn, setNow, cleanup } = await setup();
  try {
    const b = await createBatch(db, { kind: "extra", solo: 3, group: 1, requestId: reqId(), staffId, now: T10AM });
    await checkIn(); await checkIn();
    const [s1, , , g1] = await codesForBatch(db, b.id);
    router.login(s1!.code);
    router.login(g1!.code);
    await checkIn();
    const row = (await db.get<{ status: string; first_login_at: number; ends_at: number }>("SELECT * FROM codes WHERE code = ?", s1!.code))!;
    assert.equal(row.status, "active");
    assert.equal(row.ends_at - row.first_login_at, 3 * 3600_000);
    assert.deepEqual({ ...(await dayCounts(db, "2026-11-14")) }, { solo_total: 3, solo_used: 1, group_total: 1, group_used: 1 });
    const st = await getRouterStatus(db, T10AM + 1000);
    assert.equal(st.ok, true);
    assert.equal(st.active.length, 2);
    assert.equal((await getRouterStatus(db, T10AM + 5 * 60_000)).ok, false, "stale after 90 s");

    setNow(T10AM + 3 * 3600_000 + 1000);
    await checkIn();
    assert.equal((await db.get<{ status: string }>("SELECT status FROM codes WHERE code = ?", g1!.code))!.status, "expired");
  } finally { cleanup(); }
});

test("void deletes on the router and kicks devices; disconnect kicks one device", async () => {
  const { db, router, staffId, checkIn, cleanup } = await setup();
  try {
    const b = await createBatch(db, { kind: "extra", solo: 2, group: 1, requestId: reqId(), staffId, now: T10AM });
    await checkIn(); await checkIn();
    const codes = await codesForBatch(db, b.id);
    const g = codes.find((c) => c.type === "G")!;
    const d1 = router.login(g.code);
    router.login(g.code);
    router.login(codes[0]!.code);
    await checkIn();

    await queueKick(db, g.code, d1.mac, staffId, T10AM);
    await checkIn();
    assert.equal(router.active().filter((a) => a.user === g.code).length, 1, "only that device kicked");

    await voidCodes(db, [codes[0]!], staffId, "test", T10AM);
    await checkIn();
    assert.equal(router.users().some((u) => u.name === codes[0]!.code), false);
    assert.equal(router.active().some((a) => a.user === codes[0]!.code), false);
    await checkIn();
    assert.equal((await db.get<{ on_router: number }>("SELECT on_router FROM codes WHERE id = ?", codes[0]!.id))!.on_router, 0);
  } finally { cleanup(); }
});

test("closed window: no adds sent to the router", async () => {
  const { db, router, staffId, cleanup } = await setup();
  try {
    await createBatch(db, { kind: "extra", solo: 2, group: 0, requestId: reqId(), staffId, now: Date.UTC(2026, 10, 14, 16, 50) }); // 00:50
    const answer = await handleRouterReport(db, profiles, router.report(), Date.UTC(2026, 10, 14, 17, 10)); // 01:10
    assert.equal(answer, "ok\n");
  } finally { cleanup(); }
});
