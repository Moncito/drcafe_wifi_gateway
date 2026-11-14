import { randomUUID } from "node:crypto";
import { validDate, VALID_DAYS, validUntilFor } from "../../services/batches.ts";
import type { Settings } from "../../services/settings.ts";
import type { PrintRow, Stock } from "../../services/stats.ts";
import { formatDateShort, formatWhen } from "../../time.ts";
import { html, type Safe } from "../html.ts";
import { flash, type Flash } from "../layout.ts";

export const SLIPS_PER_PAGE = 48;

export interface PrintData {
  now: number;
  settings: Settings;
  isAdmin: boolean;
  prints: PrintRow[];
  stock: Stock;
  routerOk: boolean;
  flash: Flash;
}

const pages = (n: number) => Math.ceil(n / SLIPS_PER_PAGE);
const hours = (s: number) => {
  const h = s / 3600;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(s / 60)} minutes`;
};

function printRow(b: PrintRow, isAdmin: boolean, now: number): Safe {
  const expired = b.valid_until <= now;
  const p = pages(b.unused);
  const stateText = b.state === "pending" ? "Adding to router" : expired ? "Expired" : b.unused === 0 ? "All used" : b.state === "printed" ? "Printed" : "Ready to print";
  const stateCls = b.state === "pending" ? "pending" : expired || b.unused === 0 ? "void" : b.state === "printed" ? "printed" : "on_router";
  const canPrint = b.state !== "pending" && b.state !== "void" && b.unused > 0 && !expired;
  return html`
  <div class="batch-row" data-batch="${b.id}" data-state="${b.state}" data-count="${b.total}" data-sheet="/batches/${b.id}/sheet">
    <div class="stack-4">
      <strong>${b.solo_count} S + ${b.group_count} G · ${b.unused} left</strong>
      <span class="muted small">Printed ${formatWhen(b.created_at, now)}${b.created_by ? ` by ${b.created_by}` : ""} · ${b.used} used${b.voided ? ` · ${b.voided} voided` : ""} · valid until ${formatDateShort(validDate(b.valid_until))}</span>
      ${b.state === "pending" ? html`<span class="small warn-text">The router is adding these slips (usually 20–40 seconds). This page refreshes by itself.</span>` : ""}
    </div>
    <span class="state state-${stateCls}">${stateText}</span>
    <div class="actions">
      ${canPrint ? html`
        <a class="btn ${b.state === "printed" ? "btn-outline" : "btn-primary"}" href="/batches/${b.id}/sheet">${b.state === "printed" ? "Reprint unused" : "Open print sheet"}</a>
        ${p > 1 ? html`<form method="get" action="/batches/${b.id}/sheet" class="inline-form">
          <label class="sr-only" for="pg${b.id}">Page</label>
          <select id="pg${b.id}" name="page">${Array.from({ length: p }, (_, i) => html`<option value="${i + 1}">Page ${i + 1}</option>`)}</select>
          <button class="btn btn-outline" type="submit">Reprint a page</button></form>` : ""}` : ""}
      ${isAdmin && b.unused > 0 && !expired ? html`<form method="post" action="/batches/${b.id}/void" data-confirm="The ${b.unused} unused slips in this print stop working right away (slips already in use too). This can't be undone." data-confirm-title="Void this print?" data-confirm-ok="Void slips" data-confirm-type="VOID" data-danger>
        <button class="btn btn-danger-outline" type="submit">Void</button></form>` : ""}
    </div>
  </div>`;
}

export function printMain(d: PrintData): Safe {
  const s = d.settings;
  const st = d.stock;
  const until = formatDateShort(validDate(validUntilFor(d.now)));
  const lowS = st.solo <= 20, lowG = st.group <= 5;
  return html`
<div class="page-head">
  <div class="stack-4">
    <span class="eyebrow">Unused slips carry over · valid ${VALID_DAYS} days</span>
    <h1 class="title">Print slips</h1>
  </div>
</div>
${flash(d.flash)}

<div class="stat-grid">
  <div class="card stat${lowS ? " is-low" : ""}"><span class="stat-label">Solo slips in stock${lowS ? " · running low" : ""}</span><span class="stat-num">${st.solo}</span><span class="stat-sub">${pages(st.solo)} A4 page${pages(st.solo) === 1 ? "" : "s"} worth · ${st.soloUsedToday} used today</span></div>
  <div class="card stat${lowG ? " is-low" : ""}"><span class="stat-label">Group slips in stock${lowG ? " · running low" : ""}</span><span class="stat-num">${st.group}</span><span class="stat-sub">${st.groupUsedToday} used today</span></div>
  <div class="card stat"><span class="stat-label">Expiring within 7 days</span><span class="stat-num">${st.expiringSoon}</span><span class="stat-sub">${st.expiringSoon ? "Hand these out first" : "Nothing expiring soon"}</span></div>
</div>

<div class="row">
  ${d.isAdmin ? html`
  <section class="card grow-1">
    <h2>Print new slips</h2>
    <form method="post" action="/batches" class="stack-14" data-busy="Creating codes…" data-confirm="New slips are added to your stock. Unused slips keep working until ${until}." data-confirm-title="Print new slips?" data-confirm-ok="Create slips" data-confirm-facts="slips">
      <input type="hidden" name="requestId" value="${randomUUID()}">
      <div class="form-grid">
        <div class="field"><label for="ps">Solo slips (S)</label><input id="ps" name="solo" type="number" min="0" max="600" value="${s.soloPerDay}" class="mono" data-count></div>
        <div class="field"><label for="pg">Group slips (G)</label><input id="pg" name="group" type="number" min="0" max="600" value="${s.groupPerDay}" class="mono" data-count></div>
      </div>
      <div class="summary-box">
        <div><span>Total</span><strong data-total>${s.soloPerDay + s.groupPerDay} slips · ${pages(s.soloPerDay + s.groupPerDay)} A4 pages</strong></div>
        <div><span>Each code</span><strong>${hours(s.durSeconds)} from first login</strong></div>
        <div><span>Unused slips work until</span><strong>${until} (1:00 AM closing)</strong></div>
      </div>
      <button type="submit" class="btn btn-primary btn-lg">Create codes &amp; print</button>
      <p class="muted small">Tip: one A4 page is 48 slips. Print about what you need for a few days; leftovers are used the next day.</p>
      ${d.routerOk ? "" : html`<p class="err-text small">The router hasn't checked in recently. Codes will wait until it does.</p>`}
    </form>
  </section>` : ""}

  <section class="card grow-1" id="extra">
    <h2>Running low?</h2>
    <p class="muted">Print a few more slips. Serials continue from the last one.</p>
    <div class="actions">
      ${([["solo", s.extraSolo, 0], ["group", 0, s.extraGroup]] as const).map(([label, so, gr]) => html`
        <form method="post" action="/batches" data-busy="Creating codes…">
          <input type="hidden" name="requestId" value="${randomUUID()}">
          <input type="hidden" name="solo" value="${so}"><input type="hidden" name="group" value="${gr}">
          <button class="btn btn-outline" type="submit">+${label === "solo" ? so : gr} ${label}</button>
        </form>`)}
      <a class="btn btn-outline" href="/give">Give Wi‑Fi on screen</a>
    </div>
    ${d.isAdmin ? html`
    <details class="void-box">
      <summary class="btn btn-danger-outline">Void slips…</summary>
      <form method="post" action="/void-range" class="form-grid" data-confirm="These slips stop working right away and devices on them are disconnected. This can't be undone." data-confirm-title="Void these slips?" data-confirm-ok="Void slips" data-confirm-facts="range" data-danger>
        <div class="field"><label for="vt">Type</label><select id="vt" name="type"><option value="S">Solo (S)</option><option value="G">Group (G)</option></select></div>
        <div class="field"><label for="vf">From serial</label><input id="vf" name="from" type="number" min="1" required></div>
        <div class="field"><label for="vto">To serial</label><input id="vto" name="to" type="number" min="1" required></div>
        <div class="field"><label for="vr">Reason</label><input id="vr" name="reason" placeholder="e.g. stack lost"></div>
        <button class="btn btn-danger span-2" type="submit">Void slips in this range</button>
      </form>
    </details>` : ""}
  </section>
</div>

<section class="card">
  <h2>Recent prints</h2>
  ${d.prints.length ? d.prints.map((b) => printRow(b, d.isAdmin, d.now)) : html`<p class="muted">Nothing printed in the last 30 days.</p>`}
</section>
<script src="/static/js/forms.js"></script>`;
}


