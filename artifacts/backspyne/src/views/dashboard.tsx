// The dashboard: what this relay is hearing, right now.
//
// Everything on this page is read from the one console data provider and stated in the relay's
// own vocabulary. Navigation is a link rather than a callback, so a view can be opened in a
// new tab and every panel here stays readable on its own.

import { Link } from 'wouter';
import {
  ArrowDownToLine, BarChart3, ChevronRight, Cpu, FileDown, Gauge, Radio, RefreshCw, Shield, Signal,
  TrendingDown, TrendingUp,
} from 'lucide-react';

import { CountBars, DeviceDetails, DeviceRows, NodeList, RelayChecklist, SignalChart, SignalScope } from '../components/console';
import { useConsoleData } from '../lib/console-data';
import { ShareReportLink } from '../components/share-report';
import { clientReportUrl } from '../lib/reports';
import { VIEW_PATHS } from '../lib/types';

/**
 * The assessment, shown on screen. Every number here comes from the shared assessment module
 * that also renders the printable client report, so the document and the screen it came from
 * cannot disagree about what was measured.
 */
export function MeasurementAssessment() {
  const { assessment, operatorName, siteLabel } = useConsoleData();
  const { channelPlan, security, vendors, signals, totals, findings } = assessment;
  return <div className="assessment-grid">
    <section className="panel assessment-card" data-testid="assessment-channel-plan">
      <div className="panel-header"><div><div className="panel-title">Channel plan</div><div className="panel-subtitle">{channelPlan.distinctChannels} distinct channels · {channelPlan.withoutChannel} access points reported no channel</div></div><Radio size={15} className="panel-glyph" /></div>
      <CountBars entries={channelPlan.bands.map(entry => [entry.band, entry.count] as [string, number])} emptyMessage="No access point reported a channel yet." testId="assessment-band-split" />
      <CountBars entries={channelPlan.busiest.map(entry => [`Channel ${entry.channel}`, entry.count] as [string, number])} emptyMessage="No busy channels to rank yet." testId="assessment-busiest-channels" />
      <p className="assessment-note">A band is inferred from the channel number by convention, 1–14 as 2.4 GHz and 15 upwards as 5 GHz, and anything ambiguous is reported as unclassified. 5 GHz and 6 GHz share their numbering, so a 6 GHz network can be counted inside 5 GHz here. {channelPlan.busiest[0] ? ` The busiest observed channel, ${channelPlan.busiest[0].channel}, carries ${channelPlan.busiest[0].count} access points.` : ''}</p>
    </section>
    <section className="panel assessment-card" data-testid="assessment-security">      <div className="panel-header"><div><div className="panel-title">Encryption posture</div><div className="panel-subtitle">{security.accessPoints} access points · {security.assessed ? `${security.reported} described a security mode` : 'no mode was described'}</div></div><Shield size={15} className="panel-glyph" /></div>
      {security.assessed
        ? <CountBars entries={[['Reported an encryption mode', security.secured], ['Reported no encryption', security.open], ...(security.unreported > 0 ? [['Reported no readable mode', security.unreported] as [string, number]] : [])]} emptyMessage="No reported security modes." testId="assessment-security-split" />
        : <p className="assessment-empty" data-testid="assessment-security-split">{security.accessPoints} access points are in scope and this adapter described a security mode for none of them, so protected and open access points cannot be told apart here. A relay whose adapter reports the mode — Windows through netsh, or Linux through NetworkManager — fills this section.</p>}
      {security.open > 0 && <p className="assessment-note warn">{security.open} access point{security.open === 1 ? '' : 's'} advertise no encryption. That is a statement about those access points, not about anything connected to them.</p>}
      {security.openNetworks.length > 0 && <ul className="open-networks" data-testid="assessment-open-networks">{security.openNetworks.map(network => <li key={`${network.ssid}-${network.channel}`}><span>{network.ssid || 'name not advertised'}</span><small>{network.channel ? `channel ${network.channel}` : 'channel not reported'}</small></li>)}</ul>}
      {security.unreported > 0 && security.assessed && <p className="assessment-note">{security.unreported} access point{security.unreported === 1 ? '' : 's'} described no mode this relay could read. Those are counted as not reported rather than assumed protected.</p>}
      {security.assessed && <p className="assessment-note">Encryption mode is declared by the access point itself. A reported mode is not evidence that a network is well configured or authorized.</p>}
    </section>
    <section className="panel assessment-card" data-testid="assessment-vendors">
      <div className="panel-header"><div><div className="panel-title">Vendor inventory</div><div className="panel-subtitle">{vendors.labelled} of {totals.devices} radios carry a vendor label</div></div><Cpu size={15} className="panel-glyph" /></div>
      <CountBars entries={vendors.byBasis.map(entry => [entry.label, entry.count] as [string, number])} emptyMessage="No observations to label yet." testId="assessment-vendor-basis" />
      <CountBars entries={vendors.top.map(entry => [entry.vendor, entry.count] as [string, number])} emptyMessage="No vendor could be attributed yet." testId="assessment-top-vendors" />
      <p className="assessment-note">{vendors.masked} of {totals.devices} radios report an address the host operating system masked. A masked address carries no manufacturer information at all, so those rows can never show a vendor, and they are not extra devices.</p>
    </section>
    <section className="panel assessment-card" data-testid="assessment-signals">
      <div className="panel-header"><div><div className="panel-title">Level distribution</div><div className="panel-subtitle">{signals.reported} of {totals.devices} radios reported a level in dBm</div></div><Signal size={15} className="panel-glyph" /></div>
      <div className="assessment-stats"><div><div className="eyebrow">Strongest</div><strong>{signals.strongest === null ? '—' : `${signals.strongest} dBm`}</strong></div><div><div className="eyebrow">Median</div><strong>{signals.median === null ? '—' : `${signals.median} dBm`}</strong></div><div><div className="eyebrow">Weakest</div><strong>{signals.weakest === null ? '—' : `${signals.weakest} dBm`}</strong></div></div>
      <CountBars entries={signals.buckets.map(bucket => [bucket.label, bucket.count] as [string, number])} emptyMessage="No numeric level was reported." testId="assessment-signal-buckets" />
      {signals.missing > 0 && <p className="assessment-note">{signals.missing} radios reported link quality as a percentage instead of dBm. Those observations are left out of this distribution rather than converted, because the two are not the same measurement.</p>}
    </section>
    <section className="panel assessment-card" data-testid="assessment-quality">
      <div className="panel-header"><div><div className="panel-title">Observation quality</div><div className="panel-subtitle">{totals.devices} radios in the current scope</div></div><Gauge size={15} className="panel-glyph" /></div>
      <div className="assessment-stats"><div><div className="eyebrow">Last minute</div><strong>{totals.fresh}</strong></div><div><div className="eyebrow">Last five minutes</div><strong>{totals.idle}</strong></div><div><div className="eyebrow">No longer current</div><strong>{totals.ghost}</strong></div></div>
      <CountBars entries={[['Address usable for a vendor lookup', totals.devices - vendors.masked], ['Address hidden by the host OS', vendors.masked]]} emptyMessage="No observations yet." testId="assessment-address-quality" />
      <p className="assessment-note">A radio the relay reported within the last minute is current, up to five minutes is idle, and anything older stays in scope as history. Older rows are the same devices seen earlier, not new ones.</p>
    </section>
    <section className="panel assessment-card assessment-wide" data-testid="assessment-findings">
      <div className="panel-header"><div><div className="panel-title">Findings</div><div className="panel-subtitle">{findings.length} statement{findings.length === 1 ? '' : 's'} this data supports, each with what it does not mean</div></div><button className="btn btn-primary" data-testid="button-client-report-sensing" onClick={() => window.open(clientReportUrl(siteLabel, operatorName), '_blank', 'noopener')}><FileDown size={14} /> Prepare client report</button></div>
      <ol className="findings">{findings.map(finding => <li key={finding.id} className={`finding ${finding.severity}`} data-testid={`finding-${finding.id}`}><span className="chip">{finding.severity === 'attention' ? 'Needs a look' : 'Context'}</span><h3>{finding.title}</h3><p>{finding.detail}</p></li>)}</ol>
      <p className="assessment-note">The client report is this same assessment as a printable document: sectioned so it can be cited, with the method and its limits printed after the findings. On a plan without reporting it carries a trial notice.</p>
      <ShareReportLink siteLabel={siteLabel} operatorName={operatorName} />
    </section>
  </div>;
}

export function Dashboard() {
  const {
    devices, nodes, assessment, operatorName, siteLabel, selectedId, select, toggleFavorite,
    liveMode: scanning, apiConnected, apiStatus, trail,
  } = useConsoleData();
  const selected = devices.find(d => d.id === selectedId);
  const visibleDevices = devices.filter(d => d.status !== 'ghost');
  const activeNodes = nodes.filter(node => node.status === 'online').length;

  const signalSamples = trail.flatMap(sighting => typeof sighting.signalDbm === 'number' && Number.isFinite(sighting.signalDbm) ? [sighting.signalDbm] : []);
  const historyValues = signalSamples.length > 1 ? [...signalSamples].reverse().map(value => Math.abs(value)) : [];
  const latestSampleDbm = signalSamples.length ? signalSamples[0] : null;
  const oldestSampleDbm = signalSamples.length ? signalSamples[signalSamples.length - 1] : null;
  const latestSampleText = latestSampleDbm === null ? '—' : `${Math.round(latestSampleDbm)} dBm`;
  const oldestSampleText = oldestSampleDbm === null ? '—' : `${Math.round(oldestSampleDbm)} dBm`;
  const sampleSpanMinutes = trail.length < 2 ? null : (() => {
    const newest = new Date(trail[0].observedAt).getTime();
    const oldest = new Date(trail[trail.length - 1].observedAt).getTime();
    return Number.isFinite(newest) && Number.isFinite(oldest) ? Math.max(0, Math.round((newest - oldest) / 60000)) : null;
  })();
  const strengthTrend = latestSampleDbm === null || oldestSampleDbm === null ? null : latestSampleDbm - oldestSampleDbm > 3 ? 'stronger' : oldestSampleDbm - latestSampleDbm > 3 ? 'weaker' : 'steady';
  const historyEmptyMessage = trail.length ? 'Not enough reported signal samples to show a trend' : undefined;
  return <><div className="page-heading"><div><div className="page-kicker">Wireless assessment</div><h1>What this relay is hearing.</h1><p>WiFi access points and Bluetooth advertisers reported by your authorized relay at one vantage point. Standard scanning does not enumerate every nearby client device, and these measurements describe radios, not people.</p></div><div className="header-actions"><button className="btn btn-primary" data-testid="button-client-report-dashboard" onClick={() => window.open(clientReportUrl(siteLabel, operatorName), '_blank', 'noopener')}><FileDown size={14} /> Prepare client report</button><button className="btn" data-testid="button-refresh-dashboard" onClick={() => window.location.reload()}><RefreshCw size={14} /> Refresh view</button></div></div>
     <div className="signal-banner"><Shield /><span><strong>Authorized environment only.</strong> {scanning ? 'Signed observations from an authorized local node are flowing into this session.' : apiStatus === 'error' ? 'The API returned an error reading scan data; the relay status cannot be confirmed. The database connection must be repaired before scans can be stored.' : apiStatus === 'unavailable' ? 'The operator API is unavailable, so relay status cannot be checked.' : nodes.length ? 'An authorized node is registered, but it has not reported an observation yet. Check its local bridge permissions and logs.' : apiConnected ? 'The operator API is connected, but no local relay is connected. Start the bridge from Hardware scan.' : 'Checking operator API and authorized relay status.'} This dashboard lists WiFi APs/BLE advertisers only, not all nearby phones or people.</span><Link className="banner-action" href={VIEW_PATHS.hardware}>Hardware scan <ChevronRight size={14} /></Link></div>
     <RelayChecklist nodes={nodes} devices={devices} apiStatus={apiStatus} />
     <section className="panel hero-plate" data-testid="panel-live-summary">
       <div className="hero-head"><div><div className="panel-title">What this relay is hearing</div><div className="panel-subtitle">{scanning ? 'Signed observations are arriving from an authorized relay' : nodes.length ? 'A relay is registered but has not reported an observation yet' : 'No relay is registered to this account yet'}</div></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'RELAY REPORTING' : 'AWAITING RELAY'}</div></div>
       <div className="hero-readouts">
         <div><span className="eyebrow">Radios in scope</span><strong>{assessment.totals.devices}</strong><small>{activeNodes} relay{activeNodes === 1 ? '' : 's'} reporting</small></div>
         <div><span className="eyebrow">WiFi access points</span><strong>{assessment.totals.wifi}</strong><small>{assessment.channelPlan.distinctChannels} distinct channels</small></div>
         <div><span className="eyebrow">BLE advertisers</span><strong>{assessment.totals.ble}</strong><small>{assessment.vendors.labelled} with a vendor label</small></div>
         <div><span className="eyebrow">Reported in the last minute</span><strong>{assessment.totals.fresh}</strong><small>{assessment.totals.ghost} no longer current</small></div>
       </div>
       {assessment.findings.filter(finding => finding.severity === 'attention').slice(0, 1).map(finding => <p className="hero-finding" key={finding.id} data-testid={`hero-finding-${finding.id}`}><span className="chip">Needs a look</span>{finding.title} — {finding.detail}</p>)}
     </section>
    <div className="main-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Levels observed</div><div className="panel-subtitle">One mark per radio · no bearing or distance is measured</div></div></div><SignalScope devices={devices} selectedId={selectedId} onSelect={select} /></section>
       <section className="panel"><div className="panel-header"><div><div className="panel-title">Signal history</div><div className="panel-subtitle">{selected ? `${selected.vendor} · ${selected.mac}` : 'Select a radio to follow its reported level'}</div></div><BarChart3 size={16} style={{ color: 'hsl(var(--muted-foreground))' }} /></div><div className="history"><SignalChart values={historyValues} emptyMessage={historyEmptyMessage} />{signalSamples.length > 0 && <div className="history-trend" data-testid="signal-history-trend"><div><div className="eyebrow">Samples</div><strong>{signalSamples.length}</strong></div><div><div className="eyebrow">Latest</div><strong>{latestSampleText}</strong></div><div><div className="eyebrow">Oldest</div><strong>{oldestSampleText}</strong></div><div><div className="eyebrow">Span</div><strong>{sampleSpanMinutes === null ? 'unknown' : `${sampleSpanMinutes} min`}</strong></div><div><div className="eyebrow">Reported strength</div><strong>{strengthTrend === null ? 'single sample' : strengthTrend}{strengthTrend === 'stronger' ? <TrendingUp size={13} /> : strengthTrend === 'weaker' ? <TrendingDown size={13} /> : null}</strong></div></div>}{signalSamples.length > 1 && <p className="history-note">Reported-strength trend compares the newest and oldest dBm readings in this sample set. It is a direction indicator only; RSSI is not a distance, position, occupancy, or person measurement.</p>}<div className="history-summary"><div><div className="eyebrow">Current signal</div><div className="history-value">{selected?.signal ?? '—'}<small>{selected?.signal !== null && selected ? 'dBm' : 'NO MEASUREMENT'}</small></div></div><div style={{ textAlign: 'right' }}><div className="eyebrow">Proximity</div><div className="history-value" style={{ fontSize: 14, marginTop: 7 }}>{selected?.maxProximity ?? '—'}</div></div></div></div></section>
    </div>
    <div className="lower-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Latest discoveries</div><div className="panel-subtitle">{visibleDevices.length} visible targets · sorted by signal</div></div><Link className="btn" data-testid="button-open-ledger" href={VIEW_PATHS.ledger}>Open ledger <ArrowDownToLine size={13} /></Link></div><DeviceRows devices={visibleDevices.slice(0, 4)} selectedId={selectedId} onSelect={select} onFavorite={toggleFavorite} /></section><section className="panel"><div className="panel-header"><div><div className="panel-title">Scan nodes</div><div className="panel-subtitle">Local sensor topology</div></div><Link className="icon-button" data-testid="button-open-nodes" href={VIEW_PATHS.nodes} aria-label="Open relays"><ChevronRight /></Link></div><NodeList nodes={nodes} /></section></div>
    {selected && <DeviceDetails device={selected} />}
  </>;
}
