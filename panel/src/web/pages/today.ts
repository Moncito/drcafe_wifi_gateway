import { serialLabel, type CodeType } from "../../codes.ts";
import type { AuditRow } from "../../services/audit.ts";
import type { Batch } from "../../services/batches.ts";
import type { DayCounts, HourBar, ShiftCounts } from "../../services/stats.ts";
import type { RouterStatus } from "../../services/routerlink.ts";
import { closingMs, formatClock, formatDateLong, formatDateShort, shiftOf } from "../../time.ts";
import { html, raw, type Safe } from "../html.ts";

export interface TodayData {
  now: number;
  date: string;
  counts: DayCounts;
  bars: HourBar[];
  /** usual first logins per hour on this weekday (null: no history yet) */
  usual: Map<number, number> | null;
  shifts: ShiftCounts;
  batches: Batch[];
  batchBy: string | null;
  /** today's slips: how many the router has (or were used) out of all made */
  backlog: { total: number; onRouter: number };
  tomorrow: { date: string; batch: Batch | null };
  activity: AuditRow[];
  sync: RouterStatus;
  isAdmin: boolean;
}

const EVENT_TEXT: Record<string, string> = {
  first_login: "First login",
  expired: "Expired",
  void: "Voided",
  disconnect: "Device disconnected",
  batch_created: "Slips created",
  batch_pushed: "Codes added to router",
  batch_push_failed: "Router problem",
  batch_printed: "Slips printed",
};

export function activityText(a: AuditRow): string {
  const base = a.detail ?? EVENT_TEXT[a.action] ?? a.action;
  if (a.action === "void") return `Voided by ${a.staff_name ?? "?"}${a.detail ? ` · ${a.detail}` : ""}`;
  if (a.action === "disconnect") return `Device disconnected by ${a.staff_name ?? "?"}`;
  if (a.staff_name && a.action.startsWith("batch_")) return `${EVENT_TEXT[a.action]} · ${base} · ${a.staff_name}`;
  return base;
}

const hourName = (label: string) => label.replace("a", " AM").replace("p", " PM");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** RouterOS uptime ("1w2d03:04:05", "28m36s") to seconds; null if unknown. */
export function uptimeSeconds(s: string): number | null {
  if (!s) return null;
  let t = 0;
  const unit: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let found = false;
  const rest = s.replace(/(\d+)([wdhms])/g, (_, n: string, u: string) => { t += Number(n) * unit[u]!; found = true; return ""; });
  const hms = rest.match(/(\d+):(\d+):(\d+)/);
  if (hms) { t += Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]); found = true; }
  return found ? t : null;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${plural(m, "minute")} ago`;
  return `${plural(Math.round(m / 60), "hour")} ago`;
}

function ring(used: number, total: number, label: string): Safe {
  const c = 2 * Math.PI * 34;
  const p = total ? Math.min(1, used / total) : 0;
  return html`<svg class="ring" viewBox="0 0 84 84" role="img" aria-label="${label}">
    <circle class="ring-bg" cx="42" cy="42" r="34"></circle>
    ${p > 0 ? html`<circle class="ring-fg" cx="42" cy="42" r="34" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}"></circle>` : ""}
    <text x="42" y="47" text-anchor="middle">${Math.round(p * 100)}%</text></svg>`;
}

function slipCard(kind: "Solo" | "Group", used: number, total: number, lowAt: number): Safe {
  const left = total - used;
  const low = total > 0 && left <= lowAt;
  return html`<div class="card ring-card${low ? " is-low" : ""}">
    ${ring(used, total, `${used} of ${total} ${kind.toLowerCase()} slips used`)}
    <div class="stack-6">
      <span class="stat-label">${kind} slips${low ? " · running low" : ""}</span>
      <span class="stat-num">${left} <small>left</small></span>
      ${low ? html`<a class="small low-link" href="/print#extra">Print more →</a>` : html`<span class="stat-sub">${used} of ${total} used</span>`}
    </div>
  </div>`;
}

function statusBar(d: TodayData): Safe {
  const daily = d.batches.find((b) => b.kind === "daily" && b.state !== "void");
  const side = d.sync.lastOkAt ? `Router ${d.sync.ok ? "connected" : "last seen"} · checked in ${ago(d.now - d.sync.lastOkAt)}` : "Router has not checked in yet";
  const missing = d.backlog.total - d.backlog.onRouter;
  let cls = "", dot = "dot-ok", main: Safe, progress: Safe | "" = "";
  if (!d.sync.ok) {
    cls = "is-err"; dot = "dot-err";
    main = html`<span><strong>Router not checking in.</strong> Check the café power and internet. Slips made now wait in the cloud and go on the router when it's back.</span>`;
  } else if (missing > 0) {
    main = html`<span><strong>Adding today's slips to the router</strong> · ${d.backlog.onRouter} of ${d.backlog.total} · Print appears when all are on</span>`;
    progress = html`<div class="progress" role="progressbar" aria-label="Slips on the router" aria-valuemin="0" aria-valuemax="${d.backlog.total}" aria-valuenow="${d.backlog.onRouter}"><div style="width:${Math.round((d.backlog.onRouter / Math.max(1, d.backlog.total)) * 100)}%"></div></div>`;
  } else if (!daily) {
    cls = "is-warn"; dot = "dot-warn";
    main = html`<span><strong>No batch for today yet.</strong> ${d.isAdmin ? html`<a href="/print">Make today's slips</a>` : "Ask the owner to print today's slips, or print extra slips."}</span>`;
  } else {
    const extras = d.batches.filter((b) => b.kind === "extra" && b.state !== "void").length;
    main = html`<span><strong>Today's batch ${daily.state === "printed" ? `printed${daily.printed_at ? ` at ${formatClock(daily.printed_at)}` : ""}` : "is on the router, ready to print"}</strong>${d.batchBy ? ` by ${d.batchBy}` : ""} · ${daily.solo_count + daily.group_count} slips${extras ? ` · ${plural(extras, "extra print")}` : ""} · codes stop at 1:00 AM</span>`;
  }
  return html`<section class="status-bar ${cls}" aria-label="Router and batch status">
    <div class="status-top">
      <div class="status-main"><span class="dot ${dot}"></span>${main}</div>
      <span class="status-side">${side}</span>
    </div>
    ${progress}
  </section>`;
}

function tomorrowLine(d: TodayData): Safe | "" {
  if (!d.isAdmin) return "";
  const b = d.tomorrow.batch;
  const label = formatDateShort(d.tomorrow.date);
  if (b) return html`<div class="ahead-line"><span><strong>Tomorrow (${label}):</strong> ${b.solo_count + b.group_count} slips ${b.state === "printed" ? "made and printed" : "made, not printed yet"} · they work from 5:00 AM</span><a href="/print?day=tomorrow">${b.state === "printed" ? "View" : "Print now"}</a></div>`;
  // remind in the evening, so the owner can print before leaving
  if (shiftOf(d.now) === "night") return html`<div class="ahead-line"><span><strong>Tomorrow's slips aren't made yet.</strong> You can make and print them tonight; they start working at 5:00 AM.</span><a href="/print?day=tomorrow">Print tomorrow's slips</a></div>`;
  return "";
}

function hourChart(d: TodayData): Safe {
  const usualMax = d.usual ? Math.max(0, ...d.bars.map((b) => d.usual!.get(b.hour) ?? 0)) : 0;
  const max = Math.max(1, usualMax, ...d.bars.map((b) => b.n));
  const nowH = new Date(d.now + 8 * 3600_000).getUTCHours();
  const busiest = d.bars.reduce<HourBar | null>((m, b) => (b.n > (m?.n ?? 0) ? b : m), null);
  const idle = busiest ? `Busiest so far: ${hourName(busiest.label)} (${plural(busiest.n, "slip")}) · tap a bar` : "No slips used yet today · tap a bar for details";
  const nowIdx = d.bars.findIndex((b) => b.hour === nowH);
  return html`<div class="chart">
    <span class="chart-tip" aria-live="polite">${idle}</span>
    <div class="chart-bars" role="img" aria-label="${`Slips used per hour today. ${d.bars.filter((b) => b.n).map((b) => `${hourName(b.label)}: ${b.n}`).join(", ") || "None yet."}`}">
      ${d.bars.map((b, i) => {
        const u = d.usual?.get(b.hour);
        const future = nowIdx >= 0 && i > nowIdx;
        const tip = future
          ? `${hourName(b.label)} · not yet${u !== undefined ? ` · usually ${Math.round(u)}` : ""}`
          : `${hourName(b.label)} · ${plural(b.n, "slip")}${u !== undefined ? ` · usually ${Math.round(u)}` : ""}`;
        return html`<button type="button" class="chart-bar${i === nowIdx ? " is-now" : ""}" data-tip="${tip}" aria-label="${tip}">
          ${u !== undefined ? html`<span class="usual" style="bottom:${Math.round((u / max) * 150)}px"></span>` : ""}
          <span class="b b-${b.shift}" style="height:${b.n ? Math.max(3, Math.round((b.n / max) * 150)) : 0}px"></span></button>`;
      })}
    </div>
    <div class="chart-labels">${d.bars.map((b, i) => html`<span class="${i === nowIdx ? "is-now" : ""}">${b.label}</span>`)}</div>
    <div class="legend">
      <span><i class="sw sw-morning"></i>Morning shift</span><span><i class="sw sw-night"></i>Night shift</span>
      ${d.usual ? html`<span><i class="sw sw-usual"></i>Usual ${formatDateLong(d.date).split(",")[0]}</span>` : ""}
      <span><i class="sw sw-now"></i>Now</span>
    </div>
  </div>`;
}

function routerHealth(d: TodayData): Safe {
  const info = d.sync.info;
  const up = uptimeSeconds(info?.uptime ?? "");
  const since = up !== null && d.sync.lastOkAt ? d.sync.lastOkAt - up * 1000 : null;
  const recentRestart = up !== null && up < 6 * 3600;
  const backup = info?.backupComment?.match(/(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  const clockOk = info?.clock === "synchronized";
  const row = (k: string, v: Safe | string) => html`<div class="kv-row"><span class="muted">${k}</span><strong>${v}</strong></div>`;
  return html`<section class="card">
    <h2>Router health</h2>
    <div class="kv-table">
      ${row("Last check-in", d.sync.lastOkAt ? html`<span class="${d.sync.ok ? "good" : "bad"}">${ago(d.now - d.sync.lastOkAt)}</span>` : "never")}
      ${since !== null ? row("Running since", `${formatClock(since)}${up! < 86400 ? "" : ` · ${Math.floor(up! / 86400)}d ago`}`) : ""}
      ${info?.clock ? row("Router clock", html`<span class="${clockOk ? "good" : "bad"}">${clockOk ? "Synced" : "Not synced yet"}</span>`) : ""}
      ${row("Last backup", backup ? `${backup[1] === d.date || backup[1] === closingDate(d.date) ? "Today" : formatDateShort(backup[1]!)} ${clock12(Number(backup[2]), backup[3]!)}` : "–")}
    </div>
    ${recentRestart && since !== null ? html`<p class="health-note">The router restarted at ${formatClock(since)}, probably a power cut. Codes and timers are fine.</p>` : ""}
    ${info?.clock && !clockOk ? html`<p class="health-note">The router is waiting for the internet time. Code timers start counting once it's synced.</p>` : ""}
  </section>`;
}

const clock12 = (h: number, mm: string) => `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;

/** The calendar date of the 1:00 AM closing that ends a café day (backups run then). */
function closingDate(date: string): string {
  const t = new Date(closingMs(date) + 8 * 3600_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function todayMain(d: TodayData): Safe {
  const online = d.sync.active;
  const onlineS = online.filter((a) => a.user.startsWith("S")).length;
  const onlineG = online.length - onlineS;

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

${statusBar(d)}
${tomorrowLine(d)}

<div class="stat-grid">
  ${slipCard("Solo", d.counts.solo_used, d.counts.solo_total, 10)}
  ${slipCard("Group", d.counts.group_used, d.counts.group_total, 3)}
  <a class="card stat card-link" href="/lookup">
    <span class="stat-label">Devices online now</span>
    <span class="stat-num">${d.sync.ok ? online.length : "–"}</span>
    ${online.length ? html`<span class="dev-dots" aria-hidden="true">${raw(online.slice(0, 60).map((a) => `<i class="${a.user.startsWith("G") ? "g" : ""}"></i>`).join(""))}</span>` : ""}
    <span class="stat-sub">${onlineS} solo · ${onlineG} on group codes · <span class="low-link" style="color:var(--brown)">See devices →</span></span>
  </a>
  <div class="card card-dark stat">
    <span class="stat-label">Codes stop at 1:00 AM</span>
    <span class="countdown" data-until="${closingMs(d.date)}">${(() => { const m = Math.max(0, Math.round((closingMs(d.date) - d.now) / 60000)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; })()}</span>
    <span class="stat-sub">Unused slips are deleted at closing</span>
  </div>
</div>

<div class="row">
  <section class="card grow-2">
    <div class="card-head"><h2>Slips used by hour</h2></div>
    ${hourChart(d)}
  </section>
  <div class="grow-1 stack-14">
    ${routerHealth(d)}
    <section class="card">
      <h2>By shift</h2>
      <div class="kv-table">
        <div class="kv-head"><span>Shift</span><span>Solo · Group</span></div>
        <div class="kv-row"><span>Morning <small class="muted">7 AM – 4 PM</small></span><strong>${d.shifts.morning.S} · ${d.shifts.morning.G}</strong></div>
        <div class="kv-row"><span>Night <small class="muted">4 PM – 1 AM</small></span><strong>${d.shifts.night.S} · ${d.shifts.night.G}</strong></div>
      </div>
      ${d.isAdmin ? html`<p class="small" style="margin-top:10px"><a href="/reports#drinks">Check slips against drinks sold →</a></p>` : ""}
    </section>
  </div>
</div>

<section class="card">
  <h2>Recent activity</h2>
  ${d.activity.length ? d.activity.map((a) => html`
    <div class="activity">
      <span class="act-time">${formatClock(a.at)}</span>
      <span class="mono act-serial">${a.serial !== null && a.type ? serialLabel(a.type as CodeType, a.serial) : ""}</span>
      <span class="mono act-code">${a.code ?? ""}</span>
      <span class="act-text">${activityText(a)}</span>
    </div>`) : html`<p class="muted">Nothing yet today.</p>`}
</section>
<script src="/static/js/forms.js"></script>`;
}
