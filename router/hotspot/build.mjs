// Builds the MikroTik hotspot folder from src/:
//   node router/hotspot/build.mjs
// -> router/hotspot/drc-hotspot/   (upload this folder's files to the router)
// -> router/hotspot/preview/       (same pages with sample values, open in a browser)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const out = join(here, "drc-hotspot");
const prev = join(here, "preview");
const read = (f) => readFileSync(join(src, f), "utf8").replace(/\r\n/g, "\n");

// partials.html holds <!--NAME--> blocks
const partials = {};
read("partials.html").split(/<!--([A-Z_]+)-->\n?/).forEach((chunk, i, arr) => {
  if (i % 2 === 1 && arr[i] !== "END") partials[arr[i]] = arr[i + 1].trim();
});
const inject = {
  ...partials,
  STYLE: read("style.css"),
  COMMON: read("common.js"),
  MD5: read("md5.js"),
};
for (const [k, v] of Object.entries(inject)) {
  if (k !== "HEAD" && v.includes("$(")) throw new Error(`${k} contains "$(" which MikroTik would treat as a variable`);
}

const PAGES = ["login.html", "alogin.html", "status.html", "logout.html", "error.html"];
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "img"), { recursive: true });
const built = {};
for (const p of PAGES) {
  let html = read(p).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => {
    if (!(k in inject)) throw new Error(`${p}: unknown {{${k}}}`);
    return inject[k];
  });
  if (/\{\{[A-Za-z0-9_]+\}\}/.test(html)) throw new Error(`${p}: placeholder left unreplaced`);
  built[p] = html;
  writeFileSync(join(out, p), html.replace(/\n/g, "\r\n"));
}
if (!built["login.html"].includes("function hexMD5")) throw new Error("login.html: MD5 missing");
copyFileSync(join(src, "errors.txt"), join(out, "errors.txt"));
// same behaviour as MikroTik's defaults (HTTP 302 redirects), copied as-is
for (const f of ["redirect.html", "rlogin.html"]) writeFileSync(join(out, f), read(f).replace(/\n/g, "\r\n"));
copyFileSync(join(src, "img", "logo.png"), join(out, "img", "logo.png"));

// ---- preview: a small evaluator for $(if)/$(elif)/$(else)/$(endif)/$(var) ----
function render(tpl, vars) {
  const tokens = tpl.split(/(\$\((?:if|elif) [^)]*\)|\$\(else\)|\$\(endif\))/);
  const test = (cond) => {
    const m = cond.match(/^(\S+)\s*(==|!=)\s*['"]?([^'"]*)['"]?$/);
    if (m) return m[2] === "==" ? (vars[m[1]] ?? "") === m[3] : (vars[m[1]] ?? "") !== m[3];
    return !!vars[cond.trim()];
  };
  let outStr = "";
  const stack = []; // {active, done, parentActive}
  const active = () => stack.every((s) => s.active);
  for (const t of tokens) {
    let m;
    if ((m = t.match(/^\$\(if (.*)\)$/))) { const parent = active(); const v = parent && test(m[1]); stack.push({ active: v, done: v }); }
    else if ((m = t.match(/^\$\(elif (.*)\)$/))) { const s = stack.at(-1); const v = !s.done && test(m[1]); s.active = v; s.done ||= v; }
    else if (t === "$(else)") { const s = stack.at(-1); s.active = !s.done; s.done = true; }
    else if (t === "$(endif)") stack.pop();
    else if (active()) outStr += t.replace(/\$\(([a-z0-9-]+)\)/g, (_, k) => vars[k] ?? "");
  }
  return outStr;
}
const base = {
  "link-login-only": "#login", "link-login": "login.html", "link-logout": "logout.html", "link-status": "status-solo.html",
  "link-orig": "http://example.com/", "link-redirect": "http://example.com/", "chap-id": "\\357", "chap-challenge": "\\201\\002\\377",
  "refresh-timeout": "", "uptime": "1h12m", "ip": "192.168.88.57",
};
const scenarios = {
  "login": ["login.html", {}],
  "login-error": ["login.html", { error: "That code doesn't work. It may be mistyped, its time may be up, or it may be from another day. Check the slip, or ask the barista.", username: "S3K7PW" }],
  "alogin": ["alogin.html", { username: "S3K7PW" }],
  "status-solo": ["status.html", { username: "S3K7PW", "session-time-left": "2h47m10s" }],
  "status-group": ["status.html", { username: "G4Q2XE", "session-time-left": "" }],
  "status-low": ["status.html", { username: "S3K7PW", "session-time-left": "14m30s" }],
  "status-up": ["status.html", { username: "S3K7PW", "session-time-left": "0s" }],
  "logout": ["logout.html", { username: "S3K7PW" }],
  "error": ["error.html", { error: "The Wi-Fi is full right now. Please ask the barista." }],
};
rmSync(prev, { recursive: true, force: true });
mkdirSync(join(prev, "img"), { recursive: true });
copyFileSync(join(src, "img", "logo.png"), join(prev, "img", "logo.png"));
for (const [name, [page, vars]] of Object.entries(scenarios)) {
  writeFileSync(join(prev, `${name}.html`), render(built[page], { ...base, ...vars }));
}
const sizes = PAGES.map((p) => `${p} ${(Buffer.byteLength(built[p]) / 1024).toFixed(1)} KB`).join(", ");
console.log(`built router/hotspot/drc-hotspot (${sizes}) + ${Object.keys(scenarios).length} previews`);
