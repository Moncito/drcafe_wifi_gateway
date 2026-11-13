// Checks the integer maths used in router/src/drc-epoch.rsc, getf and the
// weekday pick in drc-backup.rsc, by porting them line for line to JS
// (RouterOS "/" on numbers truncates, like Math.trunc).
// Usage: node router/tools/epoch.test.mjs
import assert from "node:assert/strict";

const div = (a, b) => Math.trunc(a / b);
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const strip = (s) => (s[0] === "0" ? Number(s.slice(1)) : Number(s));

function drcEpoch(d, t) {
  let y, m, dd;
  if (d.slice(4, 5) === "-") {
    y = Number(d.slice(0, 4)); m = strip(d.slice(5, 7)); dd = strip(d.slice(8, 10));
  } else {
    m = MONTHS.indexOf(d.slice(0, 3)) + 1; dd = strip(d.slice(4, 6)); y = Number(d.slice(7, 11));
  }
  if (y < 2025) return 0;
  const hh = strip(t.slice(0, 2)), mi = strip(t.slice(3, 5)), ss = strip(t.slice(6, 8));
  if (m <= 2) y = y - 1;
  const era = div(y, 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = div(153 * mp + 2, 5) + (dd - 1);
  const doe = yoe * 365 + div(yoe, 4) - div(yoe, 100) + doy;
  const days = era * 146097 + doe - 719468;
  return days * 86400 + hh * 3600 + (mi * 60 + ss);
}

function getf(c, key) {
  const k = ";" + key + "=";
  const p = c.indexOf(k);
  if (p < 0) return "";
  const s = p + k.length;
  let e = c.indexOf(";", s);
  if (e < 0) e = c.length;
  return c.slice(s, e);
}

function weekday(now) {
  const days = div(now, 86400) + 4;
  return ["sun","mon","tue","wed","thu","fri","sat"][days - div(days, 7) * 7];
}

const pad = (n) => String(n).padStart(2, "0");
let checked = 0;
// every hour-ish from 2025-01-01 to 2040-12-31, plus every month boundary
for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2041, 0, 1); ms += 3_599_000 * 7) {
  const dt = new Date(ms);
  const iso = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  const old = `${MONTHS[dt.getUTCMonth()]}/${pad(dt.getUTCDate())}/${dt.getUTCFullYear()}`;
  const time = `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
  const want = Math.floor(ms / 1000);
  assert.equal(drcEpoch(iso, time), want, `${iso} ${time}`);
  assert.equal(drcEpoch(old, time), want, `${old} ${time}`);
  const wd = ["sun","mon","tue","wed","thu","fri","sat"][dt.getUTCDay()];
  assert.equal(weekday(want), wd, `weekday ${iso}`);
  checked++;
}
assert.equal(drcEpoch("2024-12-31", "23:59:59"), 0, "unset clock guard");
assert.equal(drcEpoch("jan/01/1970", "00:00:10"), 0, "unset clock guard (old format)");

const c = "drc;dur=10800;start=1794600000;end=1794610800;";
assert.equal(getf(c, "dur"), "10800");
assert.equal(getf(c, "start"), "1794600000");
assert.equal(getf(c, "end"), "1794610800");
assert.equal(getf(c, "exp"), "");
assert.equal(getf("drc;end=5", "end"), "5", "no trailing ;");
assert.equal(getf("", "end"), "");

console.log(`ok: ${checked} timestamps x 2 date formats, weekday, getf`);
