/* Shared helpers, inlined into pages. Never write a dollar sign followed by "(" here. */
var CODE_RE = /^[SG][A-HJKMNP-Z2-9]{5}$/;
var MANILA = 8 * 3600e3;
function cleanCode(v) { return String(v || "").toUpperCase().replace(/[\s\-]+/g, ""); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
/* ms until the next 1:00 AM in Manila (codes stop then), whatever the phone's time zone */
function msToClosing(now) {
  var m = new Date(now + MANILA);
  var c = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate(), 1, 0, 0) - MANILA;
  if (m.getUTCHours() >= 1) c += 86400e3;
  return c - now;
}
/* "4:32 PM" in Manila time */
function manilaClock(t) {
  var m = new Date(t + MANILA), h = m.getUTCHours(), h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + pad2(m.getUTCMinutes()) + (h < 12 ? " AM" : " PM");
}
/* MikroTik durations: "2h47m3s", "1d2h", "45s" -> seconds (null if empty) */
function parseRos(s) {
  if (!s) return null;
  var re = /(\d+)([wdhms])/g, m, t = 0, k = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }, any = false;
  while ((m = re.exec(s))) { t += Number(m[1]) * k[m[2]]; any = true; }
  if (!any && /^\d+:\d+:\d+$/.test(s)) { var p = s.split(":"); t = p[0] * 3600 + p[1] * 60 + Number(p[2]); any = true; }
  return any ? t : null;
}
function el(id) { return document.getElementById(id); }
