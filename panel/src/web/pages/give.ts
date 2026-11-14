import QRCode from "qrcode";
import { qrLoginUrl, serialLabel } from "../../codes.ts";
import type { CodeRow, poolStatus } from "../../services/batches.ts";
import type { RouterStatus } from "../../services/routerlink.ts";
import { html, raw, type Safe } from "../html.ts";
import { flash, type Flash } from "../layout.ts";

export interface GiveData {
  now: number;
  pool: Awaited<ReturnType<typeof poolStatus>>;
  sync: RouterStatus;
  /** the code just given, shown big with its QR */
  shown: CodeRow | null;
  wifiName: string;
  qrBase: string;
  closed: boolean;
  flash: Flash;
}

const qr = (text: string) => QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#14100D", light: "#FFFFFF" } });
/** Standard Wi-Fi QR: phones offer to join the network when scanned (open network). */
const wifiQrText = (ssid: string) => `WIFI:T:nopass;S:${ssid.replace(/([\\;,:"])/g, "\\$1")};;`;

export async function giveMain(d: GiveData): Promise<Safe> {
  if (d.shown) {
    const c = d.shown;
    const [loginQr, joinQr] = await Promise.all([qr(qrLoginUrl(d.qrBase, c.code)), qr(wifiQrText(d.wifiName))]);
    return html`
<div class="page-head">
  <div class="stack-4">
    <span class="eyebrow">Show this screen to the customer</span>
    <h1 class="title">Wi‑Fi for your customer</h1>
  </div>
  <div class="actions"><a class="btn btn-primary btn-lg" href="/give">Done · give another</a></div>
</div>
<section class="card give-card">
  <div class="give-steps">
    <div class="give-step give-step-small">
      <span class="give-n">1</span>
      <div class="give-qr give-qr-small" role="img" aria-label="QR code to join ${d.wifiName}">${raw(joinQr)}</div>
      <p><strong>Join the Wi‑Fi</strong><br>Scan with the phone camera, or pick <strong>${d.wifiName}</strong> in Wi‑Fi settings.</p>
    </div>
    <div class="give-step">
      <span class="give-n">2</span>
      <div class="give-qr" role="img" aria-label="QR code to log in with ${c.code}">${raw(loginQr)}</div>
      <p><strong>Then scan to log in</strong>, or type the code when the login page opens:</p>
      <span class="give-code mono">${c.code}</span>
      <span class="muted small">${c.type === "G" ? "Group code · up to 7 devices" : "Solo code · 1 device"} · 3 hours from first login · works until 1:00 AM tonight · ${serialLabel(c.type, c.serial)}</span>
    </div>
  </div>
</section>
<p class="muted small">The code is also on the customer's phone after login. If they lose it, look it up under Look up &amp; devices.</p>
<script src="/static/js/forms.js"></script>`;
  }

  const ready = (t: "S" | "G") => d.pool[t].ready;
  const btn = (t: "S" | "G", title: string, sub: string) => html`
    <form method="post" action="/give" class="give-form" data-busy="Getting a code…">
      <input type="hidden" name="type" value="${t}">
      <button type="submit" class="give-btn${t === "G" ? " give-btn-group" : ""}" ${d.closed || !ready(t) ? "disabled" : ""}>
        <span class="give-btn-title">${title}</span>
        <span class="give-btn-sub">${sub}</span>
        <span class="give-btn-ready">${ready(t) ? `${ready(t)} ready` : "Getting codes ready…"}</span>
      </button>
    </form>`;
  return html`
<div class="page-head">
  <div class="stack-4">
    <span class="eyebrow">No paper needed</span>
    <h1 class="title">Give Wi‑Fi</h1>
  </div>
</div>
${flash(d.flash)}
${d.closed ? html`<div class="notice notice-warn"><span class="dot dot-warn"></span><span><strong>Closed (1:00–5:00 AM).</strong> Codes can be given again from 5:00 AM.</span></div>` : ""}
${!d.sync.ok ? html`<div class="notice notice-err"><span class="dot dot-err"></span><span><strong>Router not checking in.</strong> Codes already ready still work; new ones are added when the router is back.</span></div>` : ""}
<div class="give-grid">
  ${btn("S", "Solo", "1 device · 3 hours")}
  ${btn("G", "Group", "Up to 7 devices · 3 hours")}
</div>
<p class="muted">Tap once per order. A big QR code appears for the customer to scan with their phone. The code works until 1:00 AM tonight.</p>
<script src="/static/js/forms.js"></script>`;
}
