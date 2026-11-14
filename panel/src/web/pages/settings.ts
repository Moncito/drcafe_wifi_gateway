import type { Staff } from "../../services/auth.ts";
import type { Settings } from "../../services/settings.ts";
import type { RouterStatus } from "../../services/routerlink.ts";
import { formatWhen } from "../../time.ts";
import { html, raw, type Safe } from "../html.ts";
import { flash, type Flash } from "../layout.ts";

export interface SettingsData {
  now: number;
  settings: Settings;
  staff: Staff[];
  me: Staff;
  sync: RouterStatus;
  routerKind: "router" | "mock";
  wifiName: string;
  flash: Flash;
}

const ADMIN_CAN = "Everything: print batches, void slips, reports, settings, staff";
const BARISTA_CAN = "Print extra slips, look up codes, disconnect devices";

/** "drc last backup 2026-11-14 01:15:03 drc-auto-sat" -> "2026-11-14 01:15" */
function backupText(comment: string): string {
  const m = comment.match(/(\d{4}-\d{2}-\d{2}|[a-z]{3}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : "No automatic backup yet";
}

export function settingsMain(d: SettingsData): Safe {
  const s = d.settings;
  const info = d.sync.info;
  const field = (id: keyof Settings | "durMinutes", label: string, value: number, hint: string, attrs = 'min="0" max="600"') =>
    html`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="number" value="${value}" ${raw(attrs)}><span class="hint">${hint}</span></div>`;
  return html`
<div class="page-head"><div class="stack-4">
  <span class="eyebrow">Owner only</span>
  <h1 class="title">Settings &amp; staff</h1>
</div></div>
${flash(d.flash)}

<div class="row">
  <section class="card grow-3">
    <h2>Wi‑Fi rules</h2>
    <form method="post" action="/settings" class="stack-14">
      <div class="rule-grid">
        ${field("durMinutes", "Time per code (minutes)", Math.round(s.durSeconds / 60), "Counted like a clock from first login. 180 = 3 hours", 'min="15" max="1200" step="15"')}
        ${field("soloPerDay", "Solo slips per print", s.soloPerDay, "Suggested amount on the Print page")}
        ${field("groupPerDay", "Group slips per print", s.groupPerDay, "Unused slips carry over for 30 days")}
        ${field("extraSolo", "“+ solo” button adds", s.extraSolo, "Quick print when stock runs low", 'min="1" max="200"')}
        ${field("extraGroup", "“+ group” button adds", s.extraGroup, "Extra group slips", 'min="1" max="100"')}
      </div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">Save rules</button>
        <span class="muted small">Changes apply to the next batch of slips.</span>
      </div>
    </form>
    <h3 class="sub">Set on the router</h3>
    <p class="muted small">These are part of the router configuration (Phase 1 scripts) and are shown here for reference.</p>
    <div class="rule-grid">
      <div class="ro"><span>Codes in use stop at</span><strong>1:00 AM</strong><small>Closing; unused slips carry over for 30 days</small></div>
      <div class="ro"><span>Speed per device</span><strong>${info?.rateLimit || "–"}</strong><small>Download / upload</small></div>
      <div class="ro"><span>Devices per group code</span><strong>${info?.groupDevices || "–"}</strong><small>Solo codes are always 1 device</small></div>
      <div class="ro"><span>Idle logout</span><strong>${info?.idleTimeout || "–"}</strong><small>Time is kept when they log back in</small></div>
    </div>
  </section>

  <section class="card card-dark grow-2">
    <h2>Router</h2>
    ${d.sync.ok
      ? html`<div class="status-line ok"><span class="dot dot-ok"></span>Checking in${d.routerKind === "mock" ? " (mock router, for testing)" : ""}</div>`
      : html`<div class="status-line bad"><span class="dot dot-err"></span>Not checking in</div><p class="small">${d.sync.error ?? ""}</p>`}
    <div class="dl">
      <div><span>Model</span><span>${info?.board || "–"}</span></div>
      <div><span>RouterOS</span><span>${info?.version || "–"}</span></div>
      <div><span>Name</span><span>${info?.identity || "–"}</span></div>
      <div><span>Customer Wi‑Fi</span><span>${d.wifiName}</span></div>
      <div><span>Last backup</span><span>${info ? backupText(info.backupComment) : "–"}</span></div>
    </div>
    <p class="small dim">The router saves a backup itself every night at 1:15 AM and keeps the last 7 days (Files: drc-auto-mon … drc-auto-sun). To copy one off the router: Winbox → Files → drag to the laptop.</p>
  </section>
</div>

<section class="card">
  <div class="card-head"><h2>Staff accounts</h2></div>
  <div class="table-scroll"><table class="table">
    <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Can do</th><th>Last login</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${d.staff.map((st) => html`<tr class="${st.active ? "" : "dimmed"}">
      <td><strong>${st.display_name}</strong>${st.id === d.me.id ? html` <small class="muted">(you)</small>` : ""}${st.active ? "" : html` <small class="muted">(disabled)</small>`}</td>
      <td class="mono">${st.username}</td>
      <td><span class="role role-${st.role}">${st.role === "admin" ? "Admin" : "Barista"}</span></td>
      <td class="muted">${st.role === "admin" ? ADMIN_CAN : BARISTA_CAN}</td>
      <td class="muted">${st.last_login_at ? formatWhen(st.last_login_at, d.now) : "Never"}</td>
      <td><details class="row-menu"><summary class="btn btn-light btn-sm">Manage</summary>
        <div class="menu-body">
          <form method="post" action="/staff/${st.id}" class="inline-form">
            <input type="hidden" name="op" value="password">
            <label class="sr-only" for="np${st.id}">New password</label>
            <input id="np${st.id}" name="password" type="password" placeholder="New password (8+)" minlength="8" required autocomplete="new-password">
            <button class="btn btn-outline btn-sm" type="submit">Set password</button>
          </form>
          <form method="post" action="/staff/${st.id}"><input type="hidden" name="op" value="role"><input type="hidden" name="role" value="${st.role === "admin" ? "barista" : "admin"}">
            <button class="btn btn-outline btn-sm" type="submit">Make ${st.role === "admin" ? "barista" : "admin"}</button></form>
          <form method="post" action="/staff/${st.id}"><input type="hidden" name="op" value="${st.active ? "disable" : "enable"}">
            <button class="btn ${st.active ? "btn-danger-outline" : "btn-outline"} btn-sm" type="submit">${st.active ? "Disable account" : "Enable account"}</button></form>
        </div></details></td>
    </tr>`)}</tbody>
  </table></div>

  <details class="add-staff">
    <summary class="btn btn-outline">Add staff</summary>
    <form method="post" action="/staff" class="form-grid">
      <div class="field"><label for="sn">Name</label><input id="sn" name="displayName" required placeholder="Barista – Morning"></div>
      <div class="field"><label for="su">Username</label><input id="su" name="username" required placeholder="morning" autocomplete="off"></div>
      <div class="field"><label for="sr">Role</label><select id="sr" name="role"><option value="barista">Barista</option><option value="admin">Admin / owner</option></select></div>
      <div class="field"><label for="sp">Password (8+)</label><input id="sp" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="btn btn-primary span-2" type="submit">Add account</button>
    </form>
  </details>
</section>
<script src="/static/js/forms.js"></script>`;
}

