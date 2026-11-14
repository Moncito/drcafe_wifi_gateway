import { serialLabel } from "../../codes.ts";
import type { RouterActive } from "../../router/types.ts";
import { validDate, type CodeRow } from "../../services/batches.ts";
import type { RouterStatus } from "../../services/routerlink.ts";
import { businessDate, closingMs, formatClock, formatDateShort, formatDuration } from "../../time.ts";
import { html, type Safe } from "../html.ts";
import { flash, type Flash } from "../layout.ts";
import { routerStatus, statusBadge, typePill } from "./parts.ts";

export interface LookupData {
  now: number;
  q: string;
  today: string;
  result: CodeRow | null;
  notFound: boolean;
  devices: RouterActive[];
  online: (RouterActive & { serial: string; type: "S" | "G"; endsAt: number | null })[];
  sync: RouterStatus;
  isAdmin: boolean;
  flash: Flash;
}

const back = (q: string) => `/lookup${q ? `?q=${encodeURIComponent(q)}` : ""}`;

function deviceName(a: RouterActive): string {
  return a.hostName || a.mac || "Device";
}

function disconnectBtn(a: RouterActive, q: string, small = false): Safe {
  return html`<form method="post" action="/devices/disconnect" data-confirm="It is disconnected at the router's next check-in (about 20 seconds). It can log in again with the same code while time is left." data-confirm-title="Disconnect this device?" data-confirm-ok="Disconnect" data-confirm-facts="${JSON.stringify([["Device", deviceName(a)], ["Code", a.user]])}">
    <input type="hidden" name="id" value="${a.id}"><input type="hidden" name="user" value="${a.user}"><input type="hidden" name="back" value="${back(q)}">
    <button class="btn btn-light${small ? " btn-sm" : ""}" type="submit">Disconnect</button></form>`;
}

export function lookupMain(d: LookupData): Safe {
  const c = d.result;
  // ends 3 h after first login, or at 1:00 AM closing if that comes first
  const closing = c?.first_login_at ? closingMs(businessDate(c.first_login_at)) : 0;
  const end = c?.ends_at ? Math.min(c.ends_at, closing) : null;
  const endsAtClosing = !!c?.ends_at && c.ends_at > closing;
  const left = (endsAt: number | null) => (endsAt ? Math.max(0, endsAt - d.now) : null);
  const online = [...d.online].sort((a, b) => (left(a.endsAt) ?? 9e15) - (left(b.endsAt) ?? 9e15));
  return html`
<div class="page-head"><div class="stack-4">
  <span class="eyebrow">“My Wi‑Fi isn't working”</span>
  <h1 class="title">Look up a code</h1>
</div></div>
${flash(d.flash)}

<form method="get" action="/lookup" class="lookup-form">
  <label for="lq" class="sr-only">Code or serial</label>
  <input id="lq" name="q" type="text" value="${d.q}" placeholder="S3K7PW or S-042" autocomplete="off" autofocus class="mono lookup-input">
  <button type="submit" class="btn btn-primary btn-lg">Look up</button>
</form>

${d.notFound ? html`<div class="notice notice-warn"><span class="dot dot-warn"></span><span>No slip found for <strong class="mono">${d.q}</strong>. Check the code on the slip, or search by its serial (e.g. S-042). Serials search today's slips.</span></div>` : ""}

${c ? html`
<section class="card">
  <div class="card-head wrap">
    <div class="actions">
      <span class="mono big-code">${c.code}</span>
      ${typePill(c.type)}
      ${statusBadge(c.status)}
    </div>
    ${d.isAdmin && c.status !== "void" ? html`<form method="post" action="/codes/${c.code}/void" data-confirm="It stops working right away and its devices are disconnected. This can't be undone." data-confirm-title="Void ${c.code}?" data-confirm-ok="Void code" data-danger>
      <input type="hidden" name="back" value="${back(d.q)}">
      <button class="btn btn-danger-outline" type="submit">Void this code</button></form>` : ""}
  </div>
  <div class="facts">
    <div><span>Serial</span><strong class="mono">${serialLabel(c.type, c.serial)}</strong></div>
    <div><span>${c.issued_at ? "Given on screen" : "Printed"}</span><strong>${c.issued_at ? formatClock(c.issued_at) : c.business_date === d.today ? "Today" : formatDateShort(c.business_date)}</strong></div>
    ${c.status === "unused" ? html`<div><span>Valid until</span><strong>${formatDateShort(validDate(c.valid_until))}</strong></div>` : ""}
    <div><span>First login</span><strong>${c.first_login_at ? formatClock(c.first_login_at) : "Not used yet"}</strong></div>
    <div><span>Ends</span><strong>${end ? html`${formatClock(end)}${endsAtClosing ? " (closing)" : ""}${c.status === "active" ? html` <small class="muted">(${formatDuration(left(end)!)} left)</small>` : ""}` : "3 h after first login, or 1:00 AM"}</strong></div>
    <div><span>Devices</span><strong>${d.devices.length} of ${c.type === "G" ? 7 : 1}</strong></div>
  </div>
  ${c.status === "unused" && !c.on_router ? html`<p class="err-text">This code is not on the router yet. It is added at the router's next check-in (about 20 seconds).</p>` : ""}
  ${c.status === "expired" && !c.first_login_at ? html`<p class="muted">This slip expired unused on ${formatDateShort(validDate(c.valid_until))}. The customer needs a new slip.</p>` : ""}
  ${c.status === "expired" && c.first_login_at ? html`<p class="muted">Time is up${c.expired_at ? ` (${formatClock(c.expired_at)})` : ""}. The customer needs a new slip with a new drink.</p>` : ""}
  ${c.status === "void" ? html`<p class="muted">This slip was voided${c.voided_at ? ` at ${formatClock(c.voided_at)}` : ""}.</p>` : ""}
  ${d.devices.length ? html`<div class="list">${d.devices.map((a) => html`
    <div class="list-row">
      <span class="grow">${deviceName(a)}</span>
      <span class="mono muted">${a.address}</span>
      <span class="muted">online ${a.uptime}</span>
      ${disconnectBtn(a, d.q)}
    </div>`)}</div>` : ""}
</section>` : ""}

<section class="card">
  <div class="card-head">
    <h2>Devices online now · ${online.length}</h2>
    <span class="muted small">Sorted by least time left</span>
  </div>
  ${routerStatus(d.sync, d.now)}
  <div class="table-scroll"><table class="table">
    <thead><tr><th>Code</th><th>Serial</th><th>Type</th><th>Device</th><th>Time left</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${online.length ? online.map((o) => {
      const l = left(o.endsAt);
      return html`<tr>
        <td><a class="mono" href="/lookup?q=${o.user}">${o.user}</a></td>
        <td class="mono muted">${o.serial}</td>
        <td>${o.type === "G" ? "Group" : "Solo"}</td>
        <td class="muted">${deviceName(o)} · ${o.address.replace(/^192\.168/, "")}</td>
        <td class="${l !== null && l < 30 * 60_000 ? "warn-text" : ""}">${l !== null ? formatDuration(l) : "–"}</td>
        <td>${disconnectBtn(o, d.q, true)}</td></tr>`;
    }) : html`<tr><td colspan="6" class="muted">No devices online.</td></tr>`}</tbody>
  </table></div>
</section>
<script src="/static/js/forms.js"></script>`;
}
