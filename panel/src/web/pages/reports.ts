import type { DrinkCount, Report } from "../../services/stats.ts";
import { HEAT_HOURS, hourLabel } from "../../services/stats.ts";
import { formatDateShort } from "../../time.ts";
import { html, raw, type Safe } from "../html.ts";
import { flash, type Flash } from "../layout.ts";

export interface ReportsData {
  now: number;
  today: string;
  range: 7 | 30;
  report: Report;
  drinks: DrinkCount[];
  flash: Flash;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourName = (h: number) => hourLabel(h).replace("a", " AM").replace("p", " PM");

export function reportsMain(d: ReportsData): Safe {
  const days = d.report.days;
  const used = (x: (typeof days)[number]) => x.soloUsed + x.groupUsed;
  const total = days.reduce((a, x) => a + used(x), 0);
  const withSlips = days.filter((x) => x.soloMade + x.groupMade > 0);
  const avg = withSlips.length ? Math.round(total / withSlips.length) : 0;
  const best = days.reduce<(typeof days)[number] | null>((m, x) => (used(x) > (m ? used(m) : 0) ? x : m), null);
  const change = d.report.prevTotal ? Math.round(((total - d.report.prevTotal) / d.report.prevTotal) * 100) : null;

  // busiest hour over the whole range
  const perHour = HEAT_HOURS.map((_, i) => d.report.heat.reduce((a, row) => a + row[i]!, 0));
  const topHourIdx = perHour.reduce((m, n, i) => (n > perHour[m]! ? i : m), 0);
  const peakDays = [0, 1, 2, 3, 4, 5, 6].map((w) => ({ w, n: d.report.heat[w]!.reduce((a, b) => a + b, 0) })).sort((a, b) => b.n - a.n).slice(0, 2).filter((x) => x.n > 0);

  // unused at closing: finished days only
  const finished = days.filter((x) => x.date < d.today && x.soloMade + x.groupMade > 0);
  const unusedOf = (x: (typeof days)[number]) => x.soloMade - x.soloUsed + (x.groupMade - x.groupUsed);
  const avgUnused = finished.length ? Math.round(finished.reduce((a, x) => a + unusedOf(x), 0) / finished.length) : null;
  const lastWeek = finished.slice(-7);
  const unusedMax = Math.max(1, ...lastWeek.map(unusedOf));
  const avgSoloUnused = finished.length ? Math.round(finished.reduce((a, x) => a + (x.soloMade - x.soloUsed), 0) / finished.length) : 0;

  const max = Math.max(10, ...days.map((x) => x.soloUsed + x.groupUsed));
  const heatMax = Math.max(1, ...d.report.heat.flat());

  const kpi = (label: string, value: string, sub: Safe | string) => html`<div class="card stat"><span class="stat-label">${label}</span><span class="stat-num">${value}</span><span class="stat-sub">${sub}</span></div>`;

  // slips vs drinks, newest first, last 7 days
  const drinkOf = (date: string, shift: "morning" | "night") => d.drinks.find((x) => x.business_date === date && x.shift === shift)?.drinks;
  const shiftRows = days.slice(-7).reverse().flatMap((x) => (["night", "morning"] as const).map((shift) => ({ x, shift, slips: shift === "morning" ? x.morning : x.night, drinks: drinkOf(x.date, shift) })))
    .filter((r) => r.x.date <= d.today);

  return html`
<div class="page-head">
  <div class="stack-4">
    <span class="eyebrow">${formatDateShort(days[0]!.date)} – ${formatDateShort(days[days.length - 1]!.date)}</span>
    <h1 class="title">Reports</h1>
  </div>
  <nav class="seg" aria-label="Date range">
    <a class="seg-btn${d.range === 7 ? " is-on" : ""}" href="/reports"${d.range === 7 ? raw(' aria-current="page"') : ""}>7 days</a>
    <a class="seg-btn${d.range === 30 ? " is-on" : ""}" href="/reports?range=30"${d.range === 30 ? raw(' aria-current="page"') : ""}>30 days</a>
  </nav>
</div>
${flash(d.flash)}

<div class="stat-grid">
  ${kpi("Slips used", total.toLocaleString("en-US"), change === null ? `in ${d.range} days` : html`<span class="${change >= 0 ? "kpi-up" : "kpi-down"}">${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}%</span> vs the ${d.range} days before`)}
  ${kpi("Average per day", String(avg), best && used(best) ? `Busiest: ${formatDateShort(best.date)} (${used(best)})` : "No slips used yet")}
  ${kpi("Busiest hour", perHour[topHourIdx] ? hourName(HEAT_HOURS[topHourIdx]!) : "–", peakDays.length ? `Busiest days: ${peakDays.map((p) => WD[p.w]).join(" & ")}` : "Not enough data yet")}
  ${kpi("Unused at closing", avgUnused === null ? "–" : String(avgUnused), "slips deleted per night, on average")}
</div>

<section class="card">
  <div class="card-head"><h2>Slips used per day</h2></div>
  <div class="chart">
    <span class="chart-tip" aria-live="polite">Tap a bar for details</span>
    <div class="chart-bars tall" style="gap:${d.range === 7 ? 18 : 4}px" role="img" aria-label="${`Slips used per day, solo and group. Total ${total}.`}">
      ${days.map((x) => {
        const tip = `${WD[x.dow]} ${formatDateShort(x.date).split(", ")[1]} · ${used(x)} slips (${x.soloUsed} S, ${x.groupUsed} G)`;
        return html`<button type="button" class="chart-bar${x.date === d.today ? " is-now" : ""}" data-tip="${tip}" aria-label="${tip}">
          <span class="b b-group" style="height:${Math.round((x.groupUsed / max) * 180)}px"></span>
          <span class="b b-solo" style="height:${Math.round((x.soloUsed / max) * 180)}px"></span></button>`;
      })}
    </div>
    <div class="chart-labels" style="gap:${d.range === 7 ? 18 : 4}px">${days.map((x, i) => html`<span>${d.range === 7 ? `${WD[x.dow]} ${formatDateShort(x.date).split(" ").pop()}` : i % 5 === 0 || i === days.length - 1 ? formatDateShort(x.date).split(", ")[1] : ""}</span>`)}</div>
    <div class="legend"><span><i class="sw sw-solo"></i>Solo</span><span><i class="sw sw-group"></i>Group</span></div>
  </div>
</section>

<div class="row">
  <section class="card grow-3">
    <div class="card-head"><h2>Busiest hours</h2><span class="muted small">First logins by weekday and hour</span></div>
    <div class="table-scroll">
      <div class="heat" role="img" aria-label="Heatmap of first logins by weekday and hour.">
        ${[1, 2, 3, 4, 5, 6, 0].map((w) => html`<div class="heat-row"><span>${WD[w]}</span>${raw(d.report.heat[w]!.map((n, i) => {
          const lvl = n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / heatMax) * 3.999));
          return `<i class="h${lvl}" title="${WD[w]} ${hourName(HEAT_HOURS[i]!)}: ${n} first login${n === 1 ? "" : "s"}"></i>`;
        }).join(""))}</div>`)}
        <div class="heat-row"><span></span>${raw(HEAT_HOURS.map((h) => `<b>${hourLabel(h)}</b>`).join(""))}</div>
      </div>
    </div>
    <div class="heat-key" style="margin-top:10px"><span>Quiet</span><i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i><span>Busy</span></div>
  </section>

  <section class="card grow-2 stack-14">
    <div class="stack-4"><h2 style="margin:0">Unused at closing</h2><span class="muted small">Slips deleted at 1:00 AM, last ${lastWeek.length || 7} nights</span></div>
    ${lastWeek.length ? lastWeek.map((x) => html`<div class="hbar"><span>${WD[x.dow]} ${formatDateShort(x.date).split(" ").pop()}</span><span class="track"><i style="width:${Math.round((unusedOf(x) / unusedMax) * 100)}%"></i></span><strong>${unusedOf(x)}</strong></div>`) : html`<p class="muted">Shows after the first closing.</p>`}
    ${avgSoloUnused >= 20 ? html`<p class="hint-box"><strong>Idea:</strong> about ${avgSoloUnused} solo slips go unused each night. Printing ${Math.max(0, Math.floor(avgSoloUnused / 10) * 10)} fewer solo slips a day saves paper (Settings › slips per day).</p>` : ""}
  </section>
</div>

<section class="card" id="drinks">
  <div class="card-head"><h2>Slips vs drinks sold</h2><span class="muted small">Type each shift's drink count from UTAK</span></div>
  <form method="post" action="/reports/drinks" class="stack-14" data-busy="Saving…">
    <div class="table-scroll"><table class="table">
      <thead><tr><th>Shift</th><th>Slips used</th><th>Drinks sold</th><th>Difference</th><th>Check</th></tr></thead>
      <tbody>${shiftRows.map((r) => {
        const has = r.drinks !== undefined;
        const diff = has ? r.slips - r.drinks! : null;
        const id = `d_${r.x.date}_${r.shift}`;
        return html`<tr>
          <td><strong>${WD[r.x.dow]} ${formatDateShort(r.x.date).split(" ").pop()}</strong> ${r.shift === "morning" ? "morning" : "night"}</td>
          <td>${r.slips}</td>
          <td><label class="sr-only" for="${id}">Drinks sold, ${formatDateShort(r.x.date)} ${r.shift}</label><input class="drinks-input" id="${id}" name="${id}" inputmode="numeric" pattern="[0-9]*" value="${has ? String(r.drinks) : ""}"></td>
          <td>${diff === null ? "–" : diff > 0 ? `+${diff}` : String(diff)}</td>
          <td>${!has ? html`<span class="badge">Waiting for count</span>` : diff! > 0 ? html`<span class="badge badge-bad">${diff} more slips than drinks</span>` : html`<span class="badge badge-ok">OK</span>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
    <div class="actions"><button class="btn btn-primary" type="submit">Save drink counts</button><span class="muted small">More slips than drinks usually means Wi‑Fi is being given away.</span></div>
  </form>
</section>
<script src="/static/js/forms.js"></script>`;
}
