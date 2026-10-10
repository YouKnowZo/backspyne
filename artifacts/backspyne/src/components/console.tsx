// The console's shared furniture.
//
// Everything here is presentational: it takes what it needs as props and owns no data. The
// two exceptions are deliberate — Sidebar reads the nav labels and counts it displays, and
// Topbar reads the signed-in operator's name — because those are properties of the shell, not
// of the data layer.

import {
  Activity, Archive, Bluetooth, Check, CheckCircle2, CircleHelp, Cpu, CreditCard,
  LayoutDashboard, LogOut, Menu, Minus, Network, Radar, Radio, RefreshCw, Search, Signal,
  Star, Wifi, X,
} from 'lucide-react';
import { Link } from 'wouter';
import { useUser } from '@clerk/react';

import { ageSecondsFrom, ageText, evidenceTier, liveText, newestTimestamp } from '../lib/format';
import { NAV_VIEWS, VIEW_PATHS, type ApiStatus, type NavView, type RFDevice, type ScanNode } from '../lib/types';

/** A radio, drawn as the kind of radio it is. Decorative: the row states the protocol. */
export function AppIcon({ protocol, className = '' }: { protocol: RFDevice['protocol']; className?: string }) {
  if (protocol === 'BLE') return <Bluetooth className={className} aria-hidden="true" />;
  if (protocol === 'WiFi') return <Wifi className={className} aria-hidden="true" />;
  return <Radio className={className} aria-hidden="true" />;
}

export function Brand() {
  return <div className="brand"><div className="brand-mark"><Radar size={16} aria-hidden="true" /></div><div className="brand-copy"><div className="brand-name">Back<span>Spyne</span></div><div className="brand-credit">by PaperBagExpress</div></div></div>;
}

/**
 * The console's navigation. Each view has its own address, so an item is a real link:
 * keyboard, middle-click and Cmd/Ctrl-click all behave the way a link should, and a reload
 * returns to the view the operator was reading.
 */
/**
 * How each view presents itself in the navigation. Keyed by NavView so a view added to the
 * vocabulary without a label and an icon is a type error rather than a missing menu item.
 */
const NAV_ITEMS: Record<NavView, { label: string; icon: typeof Radio }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  ledger: { label: 'Device ledger', icon: Archive },
  sensing: { label: 'Assessment', icon: Activity },
  nodes: { label: 'Relays', icon: Network },
  hardware: { label: 'Hardware', icon: Cpu },
  billing: { label: 'Plan & billing', icon: CreditCard },
};

export function Sidebar({ view, mobileOpen, onClose, devices, nodes, liveMode, apiConnected, apiStatus }: { view: NavView; mobileOpen: boolean; onClose: () => void; devices: RFDevice[]; nodes: ScanNode[]; liveMode: boolean; apiConnected: boolean; apiStatus: ApiStatus }) {
  const counts: Partial<Record<NavView, string>> = {
    ledger: String(devices.length).padStart(2, '0'),
    nodes: String(nodes.length).padStart(2, '0'),
  };
  const items = NAV_VIEWS.map(id => ({ id, ...NAV_ITEMS[id], count: counts[id] }));
  return <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
    <Brand />
    <div className="nav-label eyebrow">Operator console</div>
    <nav className="nav-list">
      {items.map(({ id, label, icon: Icon, count }) => <Link key={id} href={VIEW_PATHS[id]} data-testid={`nav-${id}`} aria-current={view === id ? 'page' : undefined} className={`nav-button ${view === id ? 'active' : ''}`} onClick={onClose}><Icon aria-hidden="true" /><span>{label}</span>{count && <span className="nav-count">{count}</span>}</Link>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="adapter-card">
        <div className="adapter-line"><span className={`pulse-dot ${liveMode ? '' : 'amber'}`} /> <span>Adapter status</span><span style={{ marginLeft: 'auto', color: liveMode ? 'hsl(var(--primary))' : apiStatus === 'error' || apiStatus === 'unavailable' ? 'hsl(var(--accent))' : 'hsl(var(--muted-foreground))', fontSize: 10 }}>{liveMode ? 'LIVE' : apiStatus === 'error' ? 'DATA ERROR' : apiStatus === 'unavailable' ? 'OFFLINE' : apiConnected ? 'READY' : 'CHECKING'}</span></div>
        <p className="adapter-caption">{liveMode ? 'Signed node telemetry is connected to this operator session.' : apiStatus === 'error' ? 'The operator API could not read scan data. Check the database connection; relay state is unavailable.' : apiStatus === 'unavailable' ? 'Operator API is unavailable. Reconnect to load persisted telemetry.' : apiConnected ? 'Operator API is connected; waiting for an authorized node heartbeat.' : 'Checking operator API and authorized relay status.'}</p>
      </div>
      <div className="disclaimer"><strong>Authorized environments only.</strong><br />Scan only where you hold permission to measure. CSI research is experimental and is not validated for safety, identity, or health use. See <a href="/legal">Legal &amp; privacy</a>.</div>
    </div>
  </aside>;
}

export function Topbar({ view, scanning, apiStatus, onOpenMenu, sessionId, onSignOut }: { view: NavView; scanning: boolean; apiStatus: ApiStatus; onOpenMenu: () => void; sessionId: string | null; onSignOut: () => Promise<void> }) {
  const { user } = useUser();
  const titles: Record<NavView, [string, string]> = { dashboard: ['Overview', 'Local radio environment'], ledger: ['Device ledger', 'Every radio observed from this account'], sensing: ['Assessment', 'Measured from relay observations only'], nodes: ['Relays', 'The scanners reporting for you'], hardware: ['Hardware', 'What this machine can measure'], billing: ['Plan and billing', 'Relays, history, and reporting'] };
  const operatorName = user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Operator';
  return <header className="topbar">
    <div className="topbar-context"><button className="menu-button" aria-label="Open navigation" data-testid="button-open-menu" onClick={onOpenMenu}><Menu size={20} aria-hidden="true" /></button><div className="context-line" /><div><div className="context-title">{titles[view][0]}</div><div className="context-sub">{titles[view][1]}</div></div></div>
     <div className="topbar-actions"><div className="connection"><span className="pulse-dot" /> {sessionId ? 'Session active' : 'Session not persisted'}</div><button type="button" data-testid="button-global-scan" className={`btn scan-toggle ${scanning ? 'is-scanning' : ''} ${apiStatus === 'error' || apiStatus === 'unavailable' ? 'scan-error' : ''}`} aria-live="polite" title={scanning ? 'Authorized node heartbeat received' : apiStatus === 'error' ? 'BackSpyne could not read scan state from its data service' : apiStatus === 'unavailable' ? 'The operator API is unavailable' : apiStatus === 'checking' ? 'Checking the operator API' : 'No authorized relay heartbeat has been received'}>{scanning ? <><Activity size={14} aria-hidden="true" /> Relay active</> : apiStatus === 'error' ? <><CircleHelp size={14} aria-hidden="true" /> Data service error</> : apiStatus === 'unavailable' ? <><Minus size={14} aria-hidden="true" /> API unavailable</> : apiStatus === 'checking' ? <><RefreshCw size={14} aria-hidden="true" /> Checking</> : <><Minus size={14} aria-hidden="true" /> Awaiting relay</>}</button><div className="operator-menu"><div className="avatar" title={operatorName}>{operatorName.slice(0, 2).toUpperCase()}</div><button className="session-button" data-testid="button-sign-out" onClick={() => void onSignOut()}><LogOut size={13} aria-hidden="true" /> Sign out</button></div></div>
  </header>;
}

export function SignalChart({ values = [], emptyMessage = 'No sighting history for this target.' }: { values?: number[]; emptyMessage?: string }) {
  if (values.length < 2) return <div className="chart-empty">{emptyMessage}</div>;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${112 - ((value - 45) / 50) * 88}`).join(' ');
  const area = `0,112 ${points} 100,112`;
  return <svg className="chart" viewBox="0 0 100 132" preserveAspectRatio="none" role="img" aria-label="Signal history chart">
    <defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop className="chart-stop-top" offset="0%" /><stop className="chart-stop-bottom" offset="100%" /></linearGradient></defs>
    {[18, 48, 78, 108].map(y => <line key={y} className="chart-grid" x1="0" x2="100" y1={y} y2={y} />)}
    <polygon className="chart-area" points={area} /><polyline className="chart-line" points={points} />
    <text className="chart-label" x="0" y="128">−60m</text><text className="chart-label" x="44" y="128">−30m</text><text className="chart-label" x="94" y="128">now</text>
  </svg>;
}

export function MetricCard({ label, value, note, icon: Icon, accent = false }: { label: string; value: string; note: string; icon: typeof Signal; accent?: boolean }) {
  return <div className="metric-card" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-top"><span>{label}</span><span className="metric-icon" aria-hidden="true"><Icon /></span></div><div className="metric-value">{value}<small>{accent ? 'LIVE' : ''}</small></div><div className="metric-note">{note}</div></div>;
}

/**
 * The level scale is shared by the console and by the printable client report, so a bar on
 * screen and a bar on paper mean the same thing. Range: -25 dBm (left) to -95 dBm (right).
 */
const SCOPE_HIGH_DBM = -25;
const SCOPE_LOW_DBM = -95;

function scopeOffset(dbm: number) {
  return Math.max(0, Math.min(100, ((SCOPE_HIGH_DBM - dbm) / (SCOPE_HIGH_DBM - SCOPE_LOW_DBM)) * 100));
}

function scopePercentile(levels: number[], fraction: number) {
  if (!levels.length) return null;
  return levels[Math.min(levels.length - 1, Math.max(0, Math.round((levels.length - 1) * fraction)))];
}

/**
 * Every level the relay reported, drawn where it was measured. One radio is one mark at one
 * value, so this reads as a distribution of received levels and never as a map: the sweeping
 * polar display it replaced has been removed on purpose, because these adapters measure no
 * bearing and a target placed at an angle implied a measurement that does not exist.
 */
export function SignalScope({ devices, selectedId, onSelect }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void }) {
  const measured = devices.filter((device): device is RFDevice & { signal: number } => device.signal !== null && device.status !== 'ghost');
  const levels = measured.map(device => device.signal).sort((left, right) => left - right);
  const p25 = scopePercentile(levels, 0.25);
  const median = scopePercentile(levels, 0.5);
  const p75 = scopePercentile(levels, 0.75);
  if (!levels.length) return <div className="scope-empty">No radio has reported a numeric level yet, so there is nothing to plot. Adapters that publish link quality as a percentage are shown as a percentage and are never converted into dBm here.</div>;
  return <div className="scope" data-testid="panel-signal-scope">
    <div className="scope-track" role="img" aria-label={`Received level distribution: strongest ${levels[levels.length - 1]} dBm, median ${median} dBm, weakest ${levels[0]} dBm, across ${levels.length} radios`}>
      {p25 !== null && p75 !== null && <span className="scope-band" style={{ left: `${scopeOffset(p75)}%`, width: `${scopeOffset(p25) - scopeOffset(p75)}%` }} />}
      {measured.map(device => <button key={device.id} type="button" data-testid={`scope-mark-${device.id}`} title={`${device.mac} · ${device.signal} dBm · ${device.vendor}`} aria-label={`${device.vendor} at ${device.signal} dBm`} className={`scope-mark ${device.protocol === 'BLE' ? 'ble' : 'wifi'} ${device.id === selectedId ? 'selected' : ''}`} style={{ left: `${scopeOffset(device.signal)}%` }} onClick={() => onSelect(device.id)} />)}
      {median !== null && <span className="scope-median" style={{ left: `${scopeOffset(median)}%` }} />}
    </div>
    <div className="scope-axis">{[-30, -40, -50, -60, -70, -80, -90].map(value => <span key={value} style={{ left: `${scopeOffset(value)}%` }}>{value}</span>)}</div>
    <div className="scope-readouts">
      <div><span className="eyebrow">Strongest</span><strong>{levels[levels.length - 1]}<small>dBm</small></strong></div>
      <div><span className="eyebrow">Median</span><strong>{median}<small>dBm</small></strong></div>
      <div><span className="eyebrow">Weakest</span><strong>{levels[0]}<small>dBm</small></strong></div>
      <div><span className="eyebrow">Plotted</span><strong>{levels.length}<small>of {devices.length} radios</small></strong></div>
    </div>
    <p className="scope-caption">Each mark is one radio at the level this relay heard it, so density is information: overlapping marks mean many radios at that level. Received level is relative to this relay's antenna and is not distance, direction, or occupancy. The shaded band holds the middle half of the plotted values.</p>
  </div>;
}

export function DeviceDetails({ device }: { device: RFDevice }) {
  const reportedName = liveText(device.details.localName, liveText(device.details.name, ''));
  const ssid = liveText(device.details.ssid, '');
  const security = liveText(device.details.security, '');
  const manufacturerData = device.details.manufacturerData && typeof device.details.manufacturerData === 'object'
    ? Object.entries(device.details.manufacturerData as Record<string, unknown>).map(([id, value]) => `${id}: ${String(value)}`)
    : [];
  const serviceUuids = Array.isArray(device.details.serviceUuids) ? device.details.serviceUuids.filter((uuid): uuid is string => typeof uuid === 'string') : [];
  const values: Array<[string, string]> = [
    ['Device class', device.deviceType], ['Vendor evidence', device.vendorBasis], ['Address type', device.addressType],
    ...(device.addressMasked ? [['Address handling', 'Real radio address hidden by the host OS'] as [string, string]] : []),
    ...(typeof device.details.advertisedVendorHint === 'string' && device.details.advertisedVendorHint ? [['Vendor hint (reported name)', `${device.details.advertisedVendorHint} (self-reported; not verified)`] as [string, string]] : []),
    ...(device.vendorCategory ? [['Vendor category', device.vendorCategory] as [string, string]] : []),
    ...(device.vendorOui ? [['OUI prefix', `${device.vendorOui} (hardware address prefix, not a model)`] as [string, string]] : []),
    ...(typeof device.evidenceQuality === 'number' ? [['Label evidence quality', `${device.evidenceQuality}/100 · ${evidenceTier(device.evidenceQuality)}`] as [string, string]] : []),
    ...(ssid ? [['WiFi network name', ssid] as [string, string]] : []),
    ...(reportedName ? [['BLE advertised name', reportedName] as [string, string]] : []),
    ...(typeof device.details.advertisedManufacturer === 'string' ? [['BLE manufacturer code', `${device.details.advertisedManufacturer} (advertising hint)`] as [string, string]] : []),
    ...(security ? [['WiFi security', security] as [string, string]] : []),
    ['Radio address', device.mac], ['Protocol', device.protocol], ['Channel', device.channel],
    ['Signal', device.signal === null ? 'Not reported' : `${device.signal} dBm`],
    ['Signal quality', device.signalQualityPercent === null ? 'Not reported' : `${device.signalQualityPercent}%`],
    ['First observed', device.firstSeen], ['Last observed', device.lastSeen], ['Scanner node', device.node],
  ];
  return <section className="panel device-details" data-testid={`device-details-${device.id}`}>
    <div className="panel-header"><div><div className="panel-title">Device details</div><div className="panel-subtitle">{device.vendor} · {device.deviceType} · {device.mac}</div></div><span className={`hardware-status ${device.vendor === 'Unknown vendor' ? 'limited' : 'connected'}`}>{device.vendor === 'Unknown vendor' ? 'limited identity' : 'vendor evidence'}</span></div>
    <div className="device-details-grid">{values.map(([label, value]) => <div className="device-detail" key={label}><span>{label}</span><strong>{value}</strong></div>)}
      {serviceUuids.length > 0 && <div className="device-detail device-detail-wide"><span>Advertised service UUIDs</span><strong>{serviceUuids.join(', ')}</strong></div>}
      {manufacturerData.length > 0 && <div className="device-detail device-detail-wide"><span>Manufacturer data (hex)</span><strong>{manufacturerData.join(' · ')}</strong></div>}
    </div>
    <p className="device-details-note">{device.addressMasked ? 'This host operating system hid the real radio address, so no manufacturer can be attributed and the visible prefix is not a real assignment. Nearby access points are commonly reported this way, and they are not extra devices. Label evidence quality scores only how a vendor label was derived; it is not a probability that the device is nearby, nor an identity.' : 'Vendor data is based on a globally assigned address prefix or a BLE advertiser company code. A radio name/network name is self-reported and does not establish an exact product model or a nearby person’s identity. Label evidence quality scores only how the vendor label was derived; it is not a probability that the device is nearby, nor an identity.'}</p>
  </section>;
}

/**
 * One row per radio. The row itself is reachable and openable by keyboard, because selecting a
 * target is the console's most common action and it must not require a mouse.
 */
export function DeviceRows({ devices, selectedId, onSelect, onFavorite }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void; onFavorite: (id: string) => void }) {
  if (!devices.length) return <div className="empty-state"><Search size={23} aria-hidden="true" /><h3>No targets in this slice</h3><p>Try a different query or include ghost targets.</p></div>;
  return <><div className="list-head" aria-hidden="true"><span /><span>Target</span><span>Protocol</span><span>Signal</span><span>State</span><span /></div><div className="device-list">{devices.map(device => <div key={device.id} data-testid={`row-device-${device.id}`} role="button" tabIndex={0} aria-pressed={device.id === selectedId} className={`device-row ${device.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(device.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(device.id); } }}>
    <div className="device-icon"><AppIcon protocol={device.protocol} /></div><div><div className="device-name">{device.vendor}</div><div className="device-mac">{device.deviceType} · {liveText(device.details.ssid, liveText(device.details.localName, liveText(device.details.name, device.mac)))}</div></div><div><div className="device-name" style={{ fontWeight: 500 }}>{device.protocol}</div><div className="device-meta">{device.channel}</div></div><div className="signal-cell">{device.signal === null ? '—' : `${device.signal} dBm`}{device.signalQualityPercent !== null && <span> {device.signalQualityPercent}%</span>}<span className="signal-bar">{device.signal !== null && <b style={{ width: `${Math.max(8, Math.min(100, 100 - (Math.abs(device.signal) - 35) * 1.65))}%` }} />}</span></div><div className={`state ${device.status}`}>{device.status}</div><button className="icon-button" aria-label={device.favorite ? 'Remove favorite' : 'Add favorite'} data-testid={`button-favorite-${device.id}`} onClick={event => { event.stopPropagation(); onFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} aria-hidden="true" /></button>
  </div>)}</div></>;
}

export function NodeList({ nodes }: { nodes: ScanNode[] }) {
  return <div className="node-list">{nodes.map(node => <div className="node-card" key={node.id} data-testid={`card-node-${node.id}`}><div className="node-card-top"><span className="node-name">{node.name}</span><span className={`state ${node.status === 'online' ? 'active' : 'ghost'}`}>{node.status}</span></div><div className="node-address">{node.address} · {node.role}</div><div className="node-meta"><span>{node.devices} targets observed</span><span>{node.lastSeen}</span></div></div>)}</div>;
}

type ChecklistState = 'ok' | 'warn' | 'blocked';

export function RelayChecklist({ nodes, devices, apiStatus }: { nodes: ScanNode[]; devices: RFDevice[]; apiStatus: ApiStatus }) {
  const online = nodes.filter(node => node.status === 'online');
  const newestHeartbeat = newestTimestamp(nodes.map(node => node.lastSeenTimestamp));
  const newestObservation = newestTimestamp(devices.map(device => device.lastSeenTimestamp));
  const heartbeatAge = ageSecondsFrom(newestHeartbeat);
  const observationAge = ageSecondsFrom(newestObservation);
  const apiOk = apiStatus === 'connected';
  const relayRegistered = nodes.length > 0;
  const relayOnline = online.length > 0 && heartbeatAge !== null && heartbeatAge < 45;
  const measurementsFlowing = observationAge !== null && observationAge < 300;
  const allGreen = apiOk && relayOnline && measurementsFlowing;
  const steps: Array<{ label: string; detail: string; state: ChecklistState }> = [
    { label: 'Operator API reachable', state: apiOk ? 'ok' : apiStatus === 'checking' ? 'warn' : 'blocked', detail: apiOk ? 'The signed-in operator API answered the last request.' : apiStatus === 'checking' ? 'Checking the operator API…' : apiStatus === 'unavailable' ? 'The operator API is unavailable or not configured, so relay status cannot be confirmed.' : 'The last API request failed, so the readings below may be stale.' },
    { label: 'Authorized relay registered', state: relayRegistered ? 'ok' : 'blocked', detail: relayRegistered ? `${nodes.length} relay${nodes.length === 1 ? '' : 's'} registered to this account.` : 'No relay is registered to this account yet. A relay registers itself on its first successful upload.' },
    { label: 'Relay sending heartbeats', state: relayOnline ? 'ok' : relayRegistered ? 'warn' : 'blocked', detail: relayOnline ? `Newest heartbeat ${ageText(newestHeartbeat)} from ${online[0].name}.` : relayRegistered ? `Last heartbeat ${ageText(newestHeartbeat)}. Start or restart the relay on the machine that has the radio adapter.` : 'Waiting for a first heartbeat.' },
    { label: 'Measurements arriving', state: measurementsFlowing ? 'ok' : 'warn', detail: measurementsFlowing ? `${devices.length} targets in scope · newest observation ${ageText(newestObservation)}.` : relayOnline ? 'A relay is online but nothing was stored in the last five minutes. Check that the adapter is enabled and that the relay log shows collected observations.' : 'No measured observation has been stored yet.' },
  ];
  const stateMark = (state: ChecklistState) => state === 'ok' ? <Check size={12} aria-hidden="true" /> : state === 'warn' ? <Minus size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />;
  return <section className="panel checklist" data-testid="relay-checklist">
    <div className="panel-header"><div><div className="panel-title">Relay connection</div><div className="panel-subtitle">Scanning runs on your own machine, not in the browser</div></div><span className={`hardware-status ${allGreen ? 'connected' : 'limited'}`}>{allGreen ? 'ALL GREEN' : 'SETUP NEEDED'}</span></div>
    {allGreen
      ? <div className="checklist-summary" data-testid="relay-checklist-summary"><CheckCircle2 size={14} aria-hidden="true" /><span>Relay online · heartbeat {ageText(newestHeartbeat)} · newest observation {ageText(newestObservation)} · {devices.length} targets in scope.</span></div>
      : <div className="checklist-steps" data-testid="relay-checklist-steps">{steps.map(step => <div className={`checklist-step ${step.state}`} key={step.label} data-testid={`relay-step-${step.label.toLowerCase().replaceAll(' ', '-')}`}><span className="checklist-mark">{stateMark(step.state)}</span><div><strong>{step.label}</strong><span>{step.detail}</span></div></div>)}</div>}
    <RelayGuide />
  </section>;
}

export function RelayGuide() {
  return <div className="checklist-guide">
    <p>A browser cannot enumerate nearby Wi-Fi or Bluetooth radios, so BackSpyne collects through a relay you run yourself on a machine that has the adapter. Fill in <code>scanner/.env</code> once, then start it:</p>
    <div className="checklist-commands"><code>Windows&nbsp;&nbsp;scanner\start.bat</code><code>macOS / Linux&nbsp;&nbsp;./scanner/start.sh</code></div>
    <p>CSI sensing research additionally needs a compatible sensing engine plus CSI-capable hardware, reached through <code>BACKSPYNE_CSI_API_URL</code> and <code>BACKSPYNE_CSI_API_TOKEN</code>. Until that is connected this console stays measurement-only on purpose instead of inventing results.</p>
  </div>;
}

export function CountBars({ entries, emptyMessage, testId }: { entries: Array<[string, number]>; emptyMessage: string; testId: string }) {
  const max = entries.reduce((highest, [, count]) => Math.max(highest, count), 0);
  if (!entries.length) return <p className="assessment-empty" data-testid={testId}>{emptyMessage}</p>;
  return <div className="bar-list" data-testid={testId}>{entries.map(([label, count]) => <div className="bar-row" key={label}><span className="bar-label">{label}</span><span className="bar-track"><b style={{ width: `${max ? Math.max(6, Math.round((count / max) * 100)) : 0}%` }} /></span><span className="bar-count">{count}</span></div>)}</div>;
}
