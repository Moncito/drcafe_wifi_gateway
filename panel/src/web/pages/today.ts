import { serialLabel, type CodeType } from "../../codes.ts";
import type { AuditRow } from "../../services/audit.ts";
import type { Batch } from "../../services/batches.ts";
import type { DayCounts, HourBar, ShiftCounts } from "../../services/stats.ts";
import type { RouterStatus } from "../../services/routerlink.ts";
import { closingMs, formatClock, formatDateLong, formatDuration, shiftOf } from "../../time.ts";
import { html, type Safe } from "../html.ts";
import { routerStatus } from "./parts.ts";

export interface TodayData {
  now: number;
  date: string;
  counts: DayCounts;
  bars: HourBar[];
  shifts: ShiftCounts;
  batches: Batch[];
  batchBy: string | null;
  activity: AuditRow[];
  sync: RouterStatus;
  isAdmin: boolean;
}

const pct = (a: number, b: number) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);

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

export function todayMain(d: TodayData): Safe {
  const daily = d.batches.find((b) => b.kind === "daily" && b.state !== "void");
  const pending = d.batches.filter((b) => b.state === "pending");
  const extras = d.batches.filter((b) => b.kind === "extra" && b.state !== "void");
  const online = d.sync.active;
  const onlineS = online.filter((a) => a.user.startsWith("S")).length;
  const onlineG = online.length - onlineS;
  const toClose = closingMs(d.date) - d.now;
  const max = Math.max(1, ...d.bars.map((b) => b.n));
  const busiest = d.bars.reduce<HourBar | null>((m, b) => (b.n > (m?.n ?? 0) ? b : m), null);
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

${daily
  ? html`<div class="notice"><span class="dot dot-ok"></span><span><strong>Today's batch ${daily.state === "printed" ? `printed at ${formatClock(daily.printed_at!)}` : daily.state === "on_router" ? "is on the router (not printed yet)" : "is still being added to the router"}</strong>${d.batchBy ? ` by ${d.batchBy}` : ""} · ${daily.solo_count + daily.group_count} slips (${daily.solo_count} S + ${daily.group_count} G)${extras.length ? ` · ${extras.length} extra print${extras.length > 1 ? "s" : ""}` : ""} · all codes stop at <strong>1:00 AM</strong></span></div>`
  : html`<div class="notice notice-warn"><span class="dot dot-warn"></span><span><strong>No batch for today yet.</strong> ${d.isAdmin ? html`<a href="/print">Create and print today's slips</a>` : "Ask the owner to print today's slips, or print extra slips."}</span></div>`}
${pending.length ? html`<div class="notice notice-err"><span class="dot dot-err"></span><span><strong>${pending.length} batch${pending.length > 1 ? "es are" : " is"} waiting for the router.</strong> Those slips start working within about 20 seconds of the router's next check-in. <a href="/print">Open Print slips</a></span></div>` : ""}

<div class="stat-grid">
  <div class="card stat">
    <span class="stat-label">Solo slips used</span>
    <span class="stat-num">${d.counts.solo_used} <small>/ ${d.counts.solo_total}</small></span>
    <div class="meter"><div style="width:${pct(d.counts.solo_used, d.counts.solo_total)}%"></div></div>
    <span class="stat-sub">${soloLeft} left${soloLeft <= 10 && d.counts.solo_total ? " · running low" : ""}</span>
  </div>
  <div class="card stat">
    <span class="stat-label">Group slips used</span>
    <span class="stat-num">${d.counts.group_used} <small>/ ${d.counts.group_total}</small></span>
    <div class="meter"><div style="width:${pct(d.counts.group_used, d.counts.group_total)}%"></div></div>
    <span class="stat-sub">${groupLeft} left${groupLeft <= 3 && d.counts.group_total ? " · running low" : ""}</span>
  </div>
  <div class="card stat">
    <span class="stat-label">Devices online now</span>
    <span class="stat-num">${d.sync.ok ? online.length : "–"}</span>
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
      ${d.bars.map((b) => html`<div class="bar-col"><span class="bar-n">${b.n || ""}</span><div class="bar bar-${b.shift}" style="height:${Math.round((b.n / max) * 130)}px"></div></div>`)}
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
      <span class="mono act-serial">${a.serial !== null && a.type ? serialLabel(a.type as CodeType, a.serial) : ""}</span>
      <span class="mono act-code">${a.code ?? ""}</span>
      <span class="act-text">${activityText(a)}</span>
    </div>`) : html`<p class="muted">Nothing yet today.</p>`}
</section>`;
}
