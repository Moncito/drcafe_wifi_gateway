import type { Staff } from "../services/auth.ts";
import { html, raw, type Safe } from "./html.ts";

export type NavKey = "today" | "print" | "lookup" | "reports" | "settings";

const ICONS: Record<NavKey, string> = {
  today: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  lookup: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  reports: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};

const NAV: { key: NavKey; href: string; label: string; adminOnly?: boolean }[] = [
  { key: "today", href: "/", label: "Today" },
  { key: "print", href: "/print", label: "Print slips" },
  { key: "lookup", href: "/lookup", label: "Look up & devices" },
  { key: "reports", href: "/reports", label: "Reports", adminOnly: true },
  { key: "settings", href: "/settings", label: "Settings & staff", adminOnly: true },
];

export function doc(title: string, body: Safe, opts: { refreshSeconds?: number; bodyClass?: string } = {}): Safe {
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

export interface Flash { ok?: string; err?: string }

export function flash(f: Flash): Safe {
  return html`${f.ok ? html`<div class="flash flash-ok" role="status">${f.ok}</div>` : ""}${f.err ? html`<div class="flash flash-err" role="alert">${f.err}</div>` : ""}`;
}

export function appPage(opts: { title: string; staff: Staff; active: NavKey; main: Safe; refreshSeconds?: number }): Safe {
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
