/**
 * Renders a client-ready assessment document.
 *
 * The output is a single self-contained HTML file: no scripts, no network fonts, no
 * external stylesheets, so it prints and archives identically to how it was generated.
 * Every value that originates from a radio or an operator is escaped, because a network
 * name or vendor label is attacker-controlled text that lands inside a document an
 * operator may send to a client.
 */

import type { Assessment, AssessmentFinding } from "@workspace/assessment";

export interface ReportMeta {
  operatorName: string;
  planName: string;
  /** True when the plan does not include client-ready export; the document is marked. */
  trial: boolean;
  generatedAt: Date;
  relays: Array<{ name: string; lastHeartbeat: Date | null }>;
  /** How many stored observations the model was built from, before any page limit. */
  considered: number;
  siteLabel: string;
  /**
   * Set when the reader opened a share link rather than the operator's own copy. The footer
   * then says so and prints when the link stops working, because a shared document should
   * never be mistaken for a permanent one.
   */
  sharedUntil?: Date | null;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes a value for HTML text or attribute context. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function dbm(value: number | null): string {
  return value === null ? "not reported" : `${value} dBm`;
}

function percent(part: number, whole: number): string {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function timestamp(value: Date): string {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * The report's one memorable element: a ruler of the observed signal range. It shows the
 * middle half of the observations as a band and the median as a notch, so a reader sees
 * at a glance how far away the neighbourhood is — without it ever being labelled as
 * distance.
 */
function signalRuler(assessment: Assessment): string {
  const { median, p25, p75, strongest, weakest, reported } = assessment.signals;
  if (reported === 0 || median === null) {
    return `<p class="empty">No observation reported a numeric signal strength, so the received signal range cannot be drawn.</p>`;
  }
  const low = -95;
  const high = -25;
  const scale = (value: number) => Math.max(0, Math.min(100, ((high - value) / (high - low)) * 100));
  const band = p25 !== null && p75 !== null ? `<rect x="${scale(p75).toFixed(2)}%" y="26" width="${(scale(p25) - scale(p75)).toFixed(2)}%" height="26" />` : "";
  const marks: Array<[string, number | null]> = [
    ["strongest", strongest],
    ["median", median],
    ["weakest", weakest],
  ];
  return `<figure class="ruler">
  <svg viewBox="0 0 100 82" preserveAspectRatio="none" role="img" aria-label="Received signal range from ${escapeHtml(dbm(strongest))} strongest to ${escapeHtml(dbm(weakest))} weakest, median ${escapeHtml(dbm(median))}">
    <rect class="ruler-track" x="0" y="26" width="100" height="26" />
    ${band}
    ${marks
      .map(([, value]) => (value === null ? "" : `<line class="ruler-tick" x1="${scale(value).toFixed(2)}%" x2="${scale(value).toFixed(2)}%" y1="16" y2="62" />`))
      .join("")}
    <line class="ruler-median" x1="${scale(median).toFixed(2)}%" x2="${scale(median).toFixed(2)}%" y1="8" y2="70" />
  </svg>
  <div class="ruler-scale">${[-30, -50, -70, -90].map((value) => `<span style="left:${scale(value).toFixed(2)}%">${value}</span>`).join("")}</div>
  <div class="ruler-legend">
    <span><b>${escapeHtml(dbm(strongest))}</b> strongest observed</span>
    <span><b>${escapeHtml(dbm(median))}</b> median</span>
    <span><b>${escapeHtml(dbm(weakest))}</b> weakest observed</span>
  </div>
  <figcaption>The shaded band holds the middle half of reported observations. Signal strength is relative to the relay's own antenna: it is not distance, and it is not a measure of how many people are present.</figcaption>
</figure>`;
}

function barRows(rows: Array<{ label: string; value: number; note?: string }>, total: number, empty: string): string {
  if (!rows.length) return `<p class="empty">${escapeHtml(empty)}</p>`;
  const largest = Math.max(...rows.map((row) => row.value), 1);
  return `<table class="bars"><tbody>${rows
    .map(
      (row) => `<tr>
      <th scope="row">${escapeHtml(row.label)}</th>
      <td class="bar-cell"><span class="bar" style="width:${((row.value / largest) * 100).toFixed(1)}%"></span></td>
      <td class="bar-value">${row.value}${row.note ? ` <small>${escapeHtml(row.note)}</small>` : ""}</td>
      <td class="bar-share">${escapeHtml(percent(row.value, total))}</td>
    </tr>`,
    )
    .join("")}</tbody></table>`;
}

function findingBlock(finding: AssessmentFinding): string {
  return `<li class="finding ${finding.severity}">
    <span class="chip">${finding.severity === "attention" ? "Needs a look" : "Context"}</span>
    <h3>${escapeHtml(finding.title)}</h3>
    <p>${escapeHtml(finding.detail)}</p>
  </li>`;
}

/** Builds the printable document. */
export function renderAssessmentReport(assessment: Assessment, meta: ReportMeta): string {
  const { totals, channelPlan, security, vendors, signals } = assessment;
  const generated = timestamp(meta.generatedAt);
  const relayList = meta.relays.length
    ? meta.relays
        .map((relay) => `${escapeHtml(relay.name)}${relay.lastHeartbeat ? ` (last contact ${escapeHtml(timestamp(relay.lastHeartbeat))})` : " (no contact recorded)"}`)
        .join(" · ")
    : "No relay is currently registered to this account";

  const channelRows = channelPlan.channels.slice(0, 12).map((entry) => ({ label: `Channel ${entry.channel}`, value: entry.count, note: entry.band }));
  const bandRows = channelPlan.bands.map((entry) => ({ label: entry.band, value: entry.count }));
  const basisRows = vendors.byBasis.map((entry) => ({ label: entry.label, value: entry.count }));
  const vendorRows = vendors.top.map((entry) => ({ label: entry.vendor, value: entry.count }));
  const bucketRows = signals.buckets.map((entry) => ({ label: entry.label, value: entry.count }));

  const securityBlock = security.assessed
    ? `<p>${security.accessPoints} access points were in scope. ${security.reported} described a security mode${
        security.unreported > 0
          ? `; ${security.unreported} described no mode this relay could read, and those are counted as not reported rather than assumed protected`
          : ""
      }.</p>
      <div class="split">
        <div><span class="figure">${security.secured}</span><span class="figure-label">reported an encryption mode</span></div>
        <div><span class="figure">${security.open}</span><span class="figure-label">reported no encryption</span></div>
        <div><span class="figure">${security.unreported}</span><span class="figure-label">reported no readable mode</span></div>
      </div>
      ${
        security.openNetworks.length
          ? `<table class="plain"><thead><tr><th scope="col">Network name</th><th scope="col">Channel</th></tr></thead><tbody>${security.openNetworks
              .map((network) => `<tr><td>${escapeHtml(network.ssid || "name not advertised")}</td><td>${escapeHtml(network.channel ?? "—")}</td></tr>`)
              .join("")}</tbody></table>`
          : ""
      }`
    : `<p class="empty">${security.accessPoints} access points were in scope, and this relay's host adapter described a security mode for none of them, so encryption could not be assessed from these observations. A relay whose adapter reports the mode — Windows through netsh, or Linux through NetworkManager — fills this section.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>BackSpyne wireless assessment — ${escapeHtml(meta.siteLabel)}</title>
<style>
  :root {
    --paper: #fbfaf7;
    --ink: #111c1e;
    --muted: #5c6b6a;
    --rule: #d9dedc;
    --brand: #0f5f59;
    --attention: #8a5210;
    --data: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --prose: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html { background: #eceeec; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.62 var(--prose); }
  .sheet { max-width: 190mm; margin: 0 auto; padding: 26px 22px 60px; }
  header.masthead { border-bottom: 3px solid var(--ink); padding-bottom: 14px; }
  .brandline { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .brandline strong { font: 700 13px/1 var(--data); letter-spacing: .22em; text-transform: uppercase; }
  .brandline span { font: 12px var(--data); color: var(--muted); letter-spacing: .06em; }
  h1 { font: 700 34px/1.1 var(--prose); letter-spacing: -.02em; margin: 18px 0 6px; max-width: 22ch; }
  .standfirst { margin: 0; color: var(--muted); font-size: 14px; max-width: 62ch; }
  .trial { margin: 20px 0 0; border: 1px solid var(--attention); border-left-width: 5px; background: #fdf6ec; padding: 12px 14px; }
  .trial strong { display: block; font: 700 12px/1.4 var(--data); letter-spacing: .1em; text-transform: uppercase; color: var(--attention); }
  .trial p { margin: 6px 0 0; font-size: 13px; color: #513009; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px 22px; margin: 20px 0 0; }
  .meta div { border-top: 1px solid var(--rule); padding-top: 8px; }
  .meta dt { font: 11px var(--data); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .meta dd { margin: 5px 0 0; font: 13px/1.5 var(--data); }
  section { margin-top: 40px; }
  .section-head { display: flex; align-items: baseline; gap: 12px; border-bottom: 1px solid var(--rule); padding-bottom: 8px; }
  .section-head span { font: 700 12px/1 var(--data); letter-spacing: .18em; color: var(--brand); }
  h2 { font: 600 19px/1.2 var(--prose); margin: 0; letter-spacing: -.01em; }
  h3 { font: 600 15px/1.35 var(--prose); margin: 0 0 4px; }
  p { margin: 10px 0 0; max-width: 70ch; }
  .figure-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 18px; margin-top: 18px; }
  .figure { display: block; font: 700 27px/1 var(--data); letter-spacing: -.02em; }
  .figure-label { display: block; margin-top: 6px; font: 11px/1.5 var(--data); color: var(--muted); letter-spacing: .04em; }
  .ruler { margin: 20px 0 0; padding: 0; }
  .ruler svg { width: 100%; height: 78px; display: block; overflow: visible; }
  .ruler-track { fill: #e7ebe9; }
  .ruler rect:not(.ruler-track) { fill: rgba(15, 95, 89, .22); }
  .ruler-tick { stroke: var(--ink); stroke-width: .8; }
  .ruler-median { stroke: var(--brand); stroke-width: 1.6; }
  .ruler-scale { position: relative; height: 15px; margin-top: 5px; }
  .ruler-scale span { position: absolute; transform: translateX(-50%); font: 10px var(--data); color: var(--muted); }
  .ruler-legend { display: flex; flex-wrap: wrap; gap: 6px 20px; margin-top: 10px; font: 11px var(--data); color: var(--muted); }
  .ruler-legend b { color: var(--ink); }
  figcaption { margin-top: 8px; font-size: 12px; color: var(--muted); max-width: 74ch; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  .bars th[scope=row] { text-align: left; font: 12px var(--data); padding: 5px 12px 5px 0; white-space: nowrap; vertical-align: middle; }
  .bars td { padding: 5px 0; vertical-align: middle; }
  .bar-cell { width: 46%; }
  .bar { display: block; height: 9px; background: var(--brand); min-width: 2px; }
  .bar-value { width: 92px; text-align: right; font: 12px var(--data); }
  .bar-value small { color: var(--muted); }
  .bar-share { width: 52px; text-align: right; font: 11px var(--data); color: var(--muted); }
  .plain th { text-align: left; font: 11px var(--data); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--rule); padding: 6px 10px 6px 0; }
  .plain td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--rule); font: 13px var(--data); }
  .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 18px; margin-top: 18px; }
  ul.findings { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 16px; }
  .finding { border-left: 3px solid var(--rule); padding: 2px 0 2px 14px; }
  .finding.attention { border-color: var(--attention); }
  .chiptext, .chip { font: 700 10px/1 var(--data); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .finding.attention .chip { color: var(--attention); }
  .finding p { margin: 5px 0 0; font-size: 13.5px; color: #2c3a3a; }
  .empty { font: 13px var(--data); color: var(--muted); border-left: 3px solid var(--rule); padding-left: 12px; }
  ol.limits { margin: 16px 0 0; padding-left: 20px; }
  ol.limits li { margin-bottom: 9px; font-size: 13.5px; color: #2c3a3a; max-width: 78ch; }
  footer.colophon { margin-top: 44px; border-top: 3px solid var(--ink); padding-top: 12px; display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; font: 11px/1.7 var(--data); color: var(--muted); }
  @media print {
    html { background: #fff; }
    body { font-size: 10.4pt; }
    .sheet { max-width: none; padding: 0; }
    section { break-inside: avoid; }
    .finding, table, .ruler { break-inside: avoid; }
    footer.colophon { break-inside: avoid; }
    .trial { background: #fdf6ec !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .bar, .ruler rect:not(.ruler-track) { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @page { margin: 16mm; }
</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="brandline"><strong>BackSpyne</strong><span>Wireless assessment · report</span></div>
    <h1>What this relay measured nearby, and what it does not mean.</h1>
    <p class="standfirst">A descriptive record of WiFi access points and Bluetooth advertisers observed from an authorized local relay at one vantage point, with the limits of these methods stated alongside the numbers.</p>
    ${meta.trial ? `      <div class="trial"><strong>Trial report</strong><p>This document was produced on the ${escapeHtml(meta.planName)} plan and carries this notice. A paid plan removes it and increases the number of relays, the history kept, and the documents you can hand over.</p></div>` : ""}
    <dl class="meta">
      <div><dt>Prepared for</dt><dd>${escapeHtml(meta.operatorName)}</dd></div>
      <div><dt>Site</dt><dd>${escapeHtml(meta.siteLabel)}</dd></div>
      <div><dt>Generated</dt><dd>${escapeHtml(generated)}</dd></div>
      <div><dt>Observations modelled</dt><dd>${meta.considered}</dd></div>
      <div><dt>Plan</dt><dd>${escapeHtml(meta.planName)}</dd></div>
      <div><dt>Relays</dt><dd>${relayList}</dd></div>
    </dl>
  </header>

  <section>
    <div class="section-head"><span>01</span><h2>What was measured</h2></div>
    <div class="figure-grid">
      <div><span class="figure">${totals.wifi}</span><span class="figure-label">WiFi access points</span></div>
      <div><span class="figure">${totals.ble}</span><span class="figure-label">BLE advertisers</span></div>
      <div><span class="figure">${totals.fresh}</span><span class="figure-label">seen in the last minute</span></div>
      <div><span class="figure">${totals.ghost}</span><span class="figure-label">no longer current</span></div>
    </div>
    <p>${escapeHtml(
      totals.devices
        ? `The relay reported ${totals.devices} unique radio addresses (${totals.wifi} WiFi, ${totals.ble} Bluetooth LE). Nearby client devices are not listed by these methods unless they advertise, and address rotation on modern phones means a phone may appear under more than one address or not at all.`
        : "No observations were stored for this account, so this document describes nothing yet.",
    )}</p>
    <p>${escapeHtml(
      totals.devices
        ? `${vendors.labelled} of ${totals.devices} addresses carry a vendor label (${percent(vendors.labelled, totals.devices)}). ${vendors.masked} reported an address their operating system masked, which cannot be attributed at all.`
        : "Start the local relay and confirm the console reports observations before preparing an assessment.",
    )}</p>
  </section>

  <section>
    <div class="section-head"><span>02</span><h2>Channel occupancy</h2></div>
    ${
      channelPlan.channels.length
        ? `<p>${channelPlan.distinctChannels} distinct channels carried access points in this scan. Channel numbers imply a band by convention; 5 GHz and 6 GHz share numbering, so anything ambiguous is reported as unclassified.</p>
           ${barRows(channelRows, totals.wifi, "No access point reported a channel.")}
           <h3 style="margin-top:22px">Band split</h3>
           ${barRows(bandRows, totals.wifi, "No band could be inferred from the reported channels.")}`
        : `<p class="empty">No access point reported a channel number, so occupancy cannot be described.</p>`
    }
  </section>

  <section>
    <div class="section-head"><span>03</span><h2>Encryption posture</h2></div>
    ${securityBlock}
  </section>

  <section>
    <div class="section-head"><span>04</span><h2>Who is transmitting</h2></div>
    <p>Vendor labels come from the registration block of a hardware address prefix or from a Bluetooth company code. A network name that contains a brand is treated as a hint and never as evidence.</p>
    ${barRows(basisRows, totals.devices, "No vendor evidence was recorded.")}
    ${vendors.top.length ? `<h3 style="margin-top:22px">Most frequently observed vendors</h3>${barRows(vendorRows, totals.devices, "")}` : ""}
  </section>

  <section>
    <div class="section-head"><span>05</span><h2>Received signal range</h2></div>
    ${signalRuler(assessment)}
    <h3 style="margin-top:24px">Distribution</h3>
    ${barRows(bucketRows, signals.reported, "No observation reported a numeric signal strength.")}
    ${signals.missing ? `<p>${signals.missing} of ${totals.devices} observations reported no numeric level. Those host adapters expose a link-quality percentage instead, which this report does not convert into a signal figure.</p>` : ""}
  </section>

  <section>
    <div class="section-head"><span>06</span><h2>Findings</h2></div>
    <ul class="findings">${assessment.findings.map(findingBlock).join("")}</ul>
  </section>

  <section>
    <div class="section-head"><span>07</span><h2>Method and limits</h2></div>
    <ol class="limits">${assessment.limits.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ol>
  </section>

  <footer class="colophon">
    <span>BackSpyne · generated ${escapeHtml(generated)}</span>
    <span>Measurement record only · no images, audio, or client-device inventory</span>
    ${meta.sharedUntil ? `<span>Shared copy · this link stops working ${escapeHtml(timestamp(meta.sharedUntil))}</span>` : ""}
  </footer>
</div>
</body>
</html>`;
}
