import QRCode from "qrcode";
import { qrLoginUrl, serialLabel } from "../../codes.ts";
import type { Batch, CodeRow } from "../../services/batches.ts";
import { formatDateLong, formatDateShort } from "../../time.ts";
import { html, raw, type Safe } from "../html.ts";
import { SLIPS_PER_PAGE } from "./print.ts";

const durText = (s: number) => (s % 3600 === 0 ? `${s / 3600} hr${s === 3600 ? "" : "s"}` : `${Math.round(s / 60)} min`);

/** QR as inline SVG path (sharp at any print resolution). */
async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#000000", light: "#ffffff" } });
}

/**
 * Print-ready A4 sheet: 4 × 12 slips per page, dashed cut lines, black & white.
 * `onlyPage` (1-based) prints just that page (reprint).
 */
export async function sheetPage(opts: { batch: Batch; codes: CodeRow[]; wifiName: string; qrBase: string; onlyPage?: number }): Promise<Safe> {
  const codes = opts.codes.filter((c) => c.status !== "void");
  const total = Math.max(1, Math.ceil(codes.length / SLIPS_PER_PAGE));
  const pageNums = opts.onlyPage && opts.onlyPage >= 1 && opts.onlyPage <= total ? [opts.onlyPage] : Array.from({ length: total }, (_, i) => i + 1);
  const qrs = new Map<string, string>();
  for (const c of codes) qrs.set(c.code, await qrSvg(qrLoginUrl(opts.qrBase, c.code)));
  const dateLabel = formatDateLong(opts.batch.business_date);
  // each slip names its day, so slips printed ahead are not handed out early
  const slipDate = formatDateShort(opts.batch.business_date);

  const sheets = pageNums.map((p) => {
    const slice = codes.slice((p - 1) * SLIPS_PER_PAGE, p * SLIPS_PER_PAGE);
    const first = slice[0], last = slice[slice.length - 1];
    const range = first && last ? `${serialLabel(first.type, first.serial)} to ${serialLabel(last.type, last.serial)}` : "";
    return html`
<section class="sheet">
  <header class="sheet-head">
    <span><strong>Don Robert Café</strong> · Wi‑Fi slips · ${dateLabel}${opts.batch.kind === "extra" ? " · extra" : ""}</span>
    <span>Page ${p} of ${total} · ${range} · cut along the dashed lines</span>
  </header>
  <div class="sheet-grid">
    ${Array.from({ length: SLIPS_PER_PAGE }, (_, i) => {
      const c = slice[i];
      if (!c) return html`<div class="slip slip-empty"></div>`;
      return html`<div class="slip">
        <div class="slip-qr">${raw(qrs.get(c.code)!)}</div>
        <div class="slip-text">
          <div class="slip-top"><span class="slip-label">${c.type === "S" ? "SOLO" : "GROUP · 7"}</span><span class="slip-serial">${serialLabel(c.type, c.serial)}</span></div>
          <span class="slip-code">${c.code}</span>
          <span class="slip-small slip-wifi">${opts.wifiName}</span>
          <span class="slip-small"><strong>${durText(c.dur_seconds)}</strong> · ${slipDate} until 1 AM</span>
        </div>
      </div>`;
    })}
  </div>
</section>`;
  });

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wi‑Fi slips ${dateLabel}</title>
<link rel="stylesheet" href="/static/css/sheet.css">
</head>
<body>
<div class="toolbar no-print">
  <a href="/print" class="tb-btn">← Back</a>
  <span>${codes.length} slips · ${pageNums.length === total ? `${total} page${total > 1 ? "s" : ""}` : `page ${pageNums[0]} of ${total} only`} · A4, scale 100%, no "fit to page"</span>
  <button type="button" class="tb-btn tb-primary" id="print">Print</button>
</div>
${sheets}
<form id="printed" method="post" action="/batches/${opts.batch.id}/printed" hidden></form>
<script src="/static/js/sheet.js"></script>
</body>
</html>`;
}
