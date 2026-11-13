import { randomUUID } from "node:crypto";
import type { Batch, CodeRow, DaySummary } from "../../services/batches.ts";
import type { Settings } from "../../services/settings.ts";
import { formatClock, formatDateLong, formatDateShort } from "../../time.ts";
import { html, type Safe } from "../html.ts";
import { flash, type Flash } from "../layout.ts";

export const SLIPS_PER_PAGE = 48;

export interface PrintData {
  date: string;
  closed: boolean;
  settings: Settings;
  isAdmin: boolean;
  batches: (Batch & { codes: CodeRow[]; by: string | null })[];
  routerOk: boolean;
  history: DaySummary[];
  flash: Flash;
}

const pages = (n: number) => Math.ceil(n / SLIPS_PER_PAGE);
const hours = (s: number) => {
  const h = s / 3600;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(s / 60)} minutes`;
};

function previewPages(codes: { type: string }[]): Safe {
  const n = Math.max(1, pages(codes.length));
  return html`<div class="preview-pages">${Array.from({ length: n }, (_, p) => {
    const slice = codes.slice(p * SLIPS_PER_PAGE, (p + 1) * SLIPS_PER_PAGE);
    return html`<div class="preview-page-wrap"><div class="preview-page">${Array.from({ length: SLIPS_PER_PAGE }, (_, i) => {
      const t = slice[i]?.type;
      return html`<div class="pv ${t === "S" ? "pv-s" : t === "G" ? "pv-g" : ""}"></div>`;
    })}</div><span class="muted small">Page ${p + 1}</span></div>`;
  })}</div>`;
}

const STATE_TEXT: Record<Batch["state"], string> = {
  pending: "Waiting for router",
  on_router: "On router · not printed",
  printed: "Printed",
  void: "Void",
};

function batchCard(b: PrintData["batches"][number], isAdmin: boolean): Safe {
  const live = b.codes.filter((c) => c.status !== "void");
  const n = b.codes.length;
  const p = pages(n);
  return html`
  <div class="batch-row">
    <div class="stack-4">
      <strong>${b.kind === "daily" ? "Daily batch" : "Extra slips"} · ${b.solo_count} S + ${b.group_count} G</strong>
      <span class="muted small">Created ${formatClock(b.created_at)}${b.by ? ` by ${b.by}` : ""} · ${p} page${p > 1 ? "s" : ""} · ${hours(b.dur_seconds)} per code${live.length !== n ? ` · ${n - live.length} voided` : ""}</span>
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

export function printMain(d: PrintData): Safe {
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
      <p>Today's batch already exists (${daily.solo_count} S + ${daily.group_count} G, ${STATE_TEXT[daily.state].toLowerCase()}). Reprint it below, or use <a href="#extra">Ran out today?</a> for more.</p>`
    : html`
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
      <td>${h.printed_by ?? "–"}</td></tr>`)}</tbody>
  </table></div>
</section>` : ""}
<script src="/static/js/forms.js"></script>`;
}
