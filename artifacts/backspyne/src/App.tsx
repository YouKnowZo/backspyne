import { useEffect, useMemo, useState } from 'react';
import {
  Activity, Antenna, Archive, ArrowDownToLine, BarChart3, Bluetooth,
  CameraOff, Check, CheckCircle2, ChevronRight, CircleHelp, Cpu, Download,
  Eye, ExternalLink, FileDown, Filter, Github, Gauge, LayoutDashboard, MapPin,
  Menu, Mic, Minus, Network, Plus, Radio, Radar, RefreshCw, ScanLine, Search,
  Shield, ShieldCheck, Smartphone,
  Signal, Star, Trash2, Wifi, X, Zap,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

type RFDevice = {
  id: string; mac: string; vendor: string; protocol: 'WiFi' | 'BLE';
  signal: number; maxProximity: string; status: 'active' | 'idle' | 'ghost';
  lastSeen: string; firstSeen: string; node: string; channel: string;
  encrypted: boolean; favorite: boolean;
};
type ScanNode = { id: string; name: string; address: string; status: 'online' | 'offline'; lastSeen: string; devices: number; role: string };
type SensingMetric = { label: string; value: string; unit: string; confidence: number; status: string; trend: string };
type HardwareStatus = 'ready' | 'permission' | 'connected' | 'limited' | 'unsupported';
type HardwareCapability = {
  id: string;
  label: string;
  status: HardwareStatus;
  detail: string;
  use: string;
  action?: 'bluetooth' | 'usb' | 'serial';
};
type HardwareNavigator = Navigator & {
  bluetooth?: {
    getAvailability?: () => Promise<boolean>;
    requestDevice?: (options: { acceptAllDevices: boolean }) => Promise<{ name?: string | null }>;
  };
  usb?: {
    getDevices?: () => Promise<unknown[]>;
    requestDevice?: (options: { filters: unknown[] }) => Promise<unknown>;
  };
  serial?: {
    getPorts?: () => Promise<unknown[]>;
    requestPort?: (options?: { filters?: unknown[] }) => Promise<unknown>;
  };
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
  connection?: { effectiveType?: string; downlink?: number };
};
type NavView = 'dashboard' | 'ledger' | 'sensing' | 'nodes' | 'hardware';

const initialDevices: RFDevice[] = [
  { id: 'dev-01', mac: 'B4:2E:99:1A:72:C0', vendor: 'Apple, Inc.', protocol: 'WiFi', signal: -48, maxProximity: '2.1 m', status: 'active', lastSeen: 'now', firstSeen: 'Today, 08:42', node: 'North relay', channel: 'CH 36', encrypted: true, favorite: true },
  { id: 'dev-02', mac: 'D8:3A:DD:6F:04:91', vendor: 'Samsung Electronics', protocol: 'BLE', signal: -61, maxProximity: '4.8 m', status: 'active', lastSeen: '12 sec ago', firstSeen: 'Today, 09:06', node: 'North relay', channel: '2.4 GHz', encrypted: false, favorite: false },
  { id: 'dev-03', mac: '34:AB:37:80:CC:19', vendor: 'Ubiquiti Networks', protocol: 'WiFi', signal: -67, maxProximity: '7.2 m', status: 'active', lastSeen: '34 sec ago', firstSeen: 'Today, 08:51', node: 'East window', channel: 'CH 11', encrypted: true, favorite: false },
  { id: 'dev-04', mac: '7C:9E:BD:12:66:42', vendor: 'Google LLC', protocol: 'BLE', signal: -73, maxProximity: '11.5 m', status: 'idle', lastSeen: '4 min ago', firstSeen: 'Today, 08:38', node: 'East window', channel: '2.4 GHz', encrypted: false, favorite: true },
  { id: 'dev-05', mac: 'AC:84:C6:90:1F:2E', vendor: 'Raspberry Pi Foundation', protocol: 'WiFi', signal: -78, maxProximity: '14.1 m', status: 'ghost', lastSeen: '18 min ago', firstSeen: 'Yesterday, 17:22', node: 'South door', channel: 'CH 6', encrypted: true, favorite: false },
  { id: 'dev-06', mac: '58:CB:52:23:8B:DE', vendor: 'Espressif Inc.', protocol: 'WiFi', signal: -82, maxProximity: '18.7 m', status: 'ghost', lastSeen: '42 min ago', firstSeen: 'Today, 07:55', node: 'South door', channel: 'CH 1', encrypted: false, favorite: false },
];
const initialNodes: ScanNode[] = [
  { id: 'node-01', name: 'North relay', address: '10.42.0.11', status: 'online', lastSeen: 'now', devices: 31, role: 'Primary scanner' },
  { id: 'node-02', name: 'East window', address: '10.42.0.12', status: 'online', lastSeen: '8 sec ago', devices: 18, role: 'BLE + WiFi' },
  { id: 'node-03', name: 'South door', address: '10.42.0.13', status: 'offline', lastSeen: '42 min ago', devices: 7, role: 'Passive relay' },
];
const sensingMetrics: SensingMetric[] = [
  { label: 'Presence probability', value: '74.8', unit: '%', confidence: 88, status: 'Elevated', trend: '+6.2%' },
  { label: 'Motion index', value: '0.32', unit: 'Δ', confidence: 81, status: 'Low activity', trend: '-12.4%' },
  { label: 'Occupancy estimate', value: '2', unit: 'persons', confidence: 67, status: 'Inferred', trend: '+1' },
  { label: 'Channel noise floor', value: '-92', unit: 'dBm', confidence: 94, status: 'Nominal', trend: '-1.8 dB' },
  { label: 'Signal variance', value: '14.6', unit: 'dB', confidence: 79, status: 'Stable', trend: '+2.1 dB' },
  { label: 'Device churn', value: '3', unit: '/ hour', confidence: 83, status: 'Nominal', trend: '-2' },
];
const chartValues = [61, 64, 59, 68, 67, 72, 69, 74, 71, 76, 73, 79, 77, 82, 80, 84, 81, 78, 83, 86, 84, 88, 85, 87];
const queryClient = new QueryClient();

const initialHardware: HardwareCapability[] = [
  { id: 'bluetooth', label: 'Bluetooth radio', status: 'permission', detail: 'Radio detected. Choose an approved BLE peripheral to connect.', use: 'BLE discovery and local sensor adapters', action: 'bluetooth' },
  { id: 'wifi', label: 'WiFi awareness', status: 'limited', detail: 'The browser can report network state, but cannot enumerate nearby access points.', use: 'Use a local relay or ESP32 adapter for RF observations' },
  { id: 'motion', label: 'Motion sensors', status: 'ready', detail: 'Device motion and orientation APIs are available to this browser.', use: 'Optional device movement context for local sensing' },
  { id: 'camera-mic', label: 'Camera and microphone', status: 'permission', detail: 'Media inputs are present. BackSpyne will not request access automatically.', use: 'Optional operator presence checks; never used for RF sensing' },
  { id: 'usb', label: 'USB devices', status: 'unsupported', detail: 'No browser USB adapter is available until a device is explicitly selected.', use: 'Direct ESP32 or compatible scanner connection', action: 'usb' },
  { id: 'serial', label: 'Serial ports', status: 'unsupported', detail: 'No browser serial adapter is available until a port is explicitly selected.', use: 'Local Python bridge or microcontroller stream', action: 'serial' },
  { id: 'location', label: 'Location', status: 'permission', detail: 'Location is available only after an explicit user permission decision.', use: 'Optional node placement and operator map context' },
  { id: 'battery', label: 'Battery and power', status: 'ready', detail: 'Power state can help tune scan intensity on portable devices.', use: 'Adaptive polling and low-power mode' },
];

async function scanHardwareCapabilities(): Promise<HardwareCapability[]> {
  if (typeof navigator === 'undefined') return initialHardware;
  const hardwareNavigator = navigator as HardwareNavigator;
  const next = initialHardware.map(capability => ({ ...capability }));
  const mediaDevices = hardwareNavigator.mediaDevices;

  if (hardwareNavigator.bluetooth) {
    let available = true;
    try {
      available = hardwareNavigator.bluetooth.getAvailability ? await hardwareNavigator.bluetooth.getAvailability() : true;
    } catch {
      available = true;
    }
    const bluetooth = next.find(capability => capability.id === 'bluetooth');
    if (bluetooth) {
      bluetooth.status = available ? 'permission' : 'unsupported';
      bluetooth.detail = available
        ? 'Radio detected. Choose an approved BLE peripheral to connect.'
        : 'This browser does not report a Bluetooth radio.';
    }
  } else {
    const bluetooth = next.find(capability => capability.id === 'bluetooth');
    if (bluetooth) {
      bluetooth.status = 'unsupported';
      bluetooth.detail = 'Web Bluetooth is not available in this browser.';
    }
  }

  if (mediaDevices?.enumerateDevices) {
    try {
      const media = await mediaDevices.enumerateDevices();
      const cameras = media.filter(device => device.kind === 'videoinput').length;
      const microphones = media.filter(device => device.kind === 'audioinput').length;
      const cameraMic = next.find(capability => capability.id === 'camera-mic');
      if (cameraMic) {
        cameraMic.status = cameras + microphones > 0 ? 'permission' : 'limited';
        cameraMic.detail = cameras + microphones > 0
          ? `${cameras} camera${cameras === 1 ? '' : 's'} and ${microphones} microphone${microphones === 1 ? '' : 's'} reported. Access stays off by default.`
          : 'No camera or microphone inputs were reported.';
      }
    } catch {
      const cameraMic = next.find(capability => capability.id === 'camera-mic');
      if (cameraMic) cameraMic.detail = 'Media inputs could not be enumerated without permission.';
    }
  } else {
    const cameraMic = next.find(capability => capability.id === 'camera-mic');
    if (cameraMic) {
      cameraMic.status = 'unsupported';
      cameraMic.detail = 'Media device APIs are not available in this browser.';
    }
  }

  const motion = next.find(capability => capability.id === 'motion');
  if (motion) {
    const motionAvailable = typeof window !== 'undefined' && ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window);
    motion.status = motionAvailable ? 'ready' : 'unsupported';
    motion.detail = motionAvailable
      ? 'Device motion and orientation APIs are available to this browser.'
      : 'Motion sensors are not exposed by this browser or device.';
  }

  const location = next.find(capability => capability.id === 'location');
  if (location) {
    location.status = 'geolocation' in navigator ? 'permission' : 'unsupported';
    location.detail = 'geolocation' in navigator
      ? 'Location is available only after an explicit user permission decision.'
      : 'Geolocation is not available in this browser.';
  }

  const battery = next.find(capability => capability.id === 'battery');
  if (battery) {
    if (hardwareNavigator.getBattery) {
      try {
        const power = await hardwareNavigator.getBattery();
        battery.status = 'ready';
        battery.detail = `Battery at ${Math.round(power.level * 100)}% · ${power.charging ? 'charging' : 'on battery'} · adaptive polling available.`;
      } catch {
        battery.status = 'limited';
        battery.detail = 'Battery state is present but unavailable without an additional permission.';
      }
    } else {
      battery.status = 'unsupported';
      battery.detail = 'Battery status is not exposed by this browser.';
    }
  }

  const wifi = next.find(capability => capability.id === 'wifi');
  if (wifi && hardwareNavigator.connection?.effectiveType) {
    wifi.detail = `Network link reports ${hardwareNavigator.connection.effectiveType}. Nearby WiFi scanning still requires a local adapter.`;
  }

  if (hardwareNavigator.usb?.getDevices) {
    try {
      const usbDevices = await hardwareNavigator.usb.getDevices();
      const usb = next.find(capability => capability.id === 'usb');
      if (usb) {
        usb.status = usbDevices.length ? 'connected' : 'permission';
        usb.detail = usbDevices.length
          ? `${usbDevices.length} previously approved USB device${usbDevices.length === 1 ? '' : 's'} available.`
          : 'USB is supported. Select an approved adapter to grant access.';
      }
    } catch {
      const usb = next.find(capability => capability.id === 'usb');
      if (usb) usb.status = 'permission';
    }
  }

  if (hardwareNavigator.serial?.getPorts) {
    try {
      const ports = await hardwareNavigator.serial.getPorts();
      const serial = next.find(capability => capability.id === 'serial');
      if (serial) {
        serial.status = ports.length ? 'connected' : 'permission';
        serial.detail = ports.length
          ? `${ports.length} previously approved serial port${ports.length === 1 ? '' : 's'} available.`
          : 'Serial is supported. Select an approved port to grant access.';
      }
    } catch {
      const serial = next.find(capability => capability.id === 'serial');
      if (serial) serial.status = 'permission';
    }
  }

  return next;
}

function AppIcon({ protocol, className = '' }: { protocol: RFDevice['protocol']; className?: string }) {
  return protocol === 'BLE' ? <Bluetooth className={className} /> : <Wifi className={className} />;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><Radar size={16} /></div><div className="brand-copy"><div className="brand-name">Back<span>Spyne</span></div><a className="brand-credit" href="https://github.com/youknowzo" target="_blank" rel="noreferrer">by PaperBagExpress <ExternalLink size={10} /></a></div></div>;
}

function Sidebar({ view, onNavigate, mobileOpen, onClose, devices }: { view: NavView; onNavigate: (view: NavView) => void; mobileOpen: boolean; onClose: () => void; devices: RFDevice[] }) {
  const items: { id: NavView; label: string; icon: typeof Radio; count?: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'ledger', label: 'Device ledger', icon: Archive, count: String(devices.length).padStart(2, '0') },
    { id: 'sensing', label: 'Sensing', icon: Activity },
    { id: 'nodes', label: 'Network nodes', icon: Network, count: '03' },
    { id: 'hardware', label: 'Hardware scan', icon: Cpu },
  ];
  return <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
    <Brand />
    <div className="nav-label eyebrow">Command surface</div>
    <nav className="nav-list">
      {items.map(({ id, label, icon: Icon, count }) => <button key={id} data-testid={`nav-${id}`} className={`nav-button ${view === id ? 'active' : ''}`} onClick={() => { onNavigate(id); onClose(); }}><Icon /><span>{label}</span>{count && <span className="nav-count">{count}</span>}</button>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="adapter-card">
        <div className="adapter-line"><span className="pulse-dot amber" /> <span>Adapter status</span><span style={{ marginLeft: 'auto', color: '#d6b064', fontSize: 10 }}>SIM</span></div>
        <p className="adapter-caption">Telemetry is simulated. Connect a local sensor adapter to begin live collection.</p>
      </div>
      <div className="disclaimer"><strong>Authorized environments only.</strong><br />BackSpyne is a defensive observability surface. Respect local law, consent, and scope.</div>
    </div>
  </aside>;
}

function Topbar({ view, scanning, onToggleScan, onOpenMenu }: { view: NavView; scanning: boolean; onToggleScan: () => void; onOpenMenu: () => void }) {
  const titles: Record<NavView, [string, string]> = { dashboard: ['Operations / overview', 'Local RF environment'], ledger: ['Operations / ledger', 'Discovered device inventory'], sensing: ['Operations / sensing', 'Camera-free inference layer'], nodes: ['Operations / nodes', 'Sensor network topology'], hardware: ['Operations / hardware', 'Device capability bridge'] };
  return <header className="topbar">
    <div className="topbar-context"><button className="menu-button" data-testid="button-open-menu" onClick={onOpenMenu}><Menu size={20} /></button><div className="context-line" /><div><div className="context-title">{titles[view][0]}</div><div className="context-sub">{titles[view][1]}</div></div></div>
    <div className="topbar-actions"><a className="github-link" href="https://github.com/youknowzo" target="_blank" rel="noreferrer"><Github size={14} /> <span>youknowzo</span></a><div className="connection"><span className="pulse-dot" /> Local session · encrypted</div><button data-testid="button-global-scan" className={`btn scan-toggle ${scanning ? 'is-scanning' : ''}`} onClick={onToggleScan}>{scanning ? <><Activity size={14} /> Scanning</> : <><Minus size={14} /> Paused</>}</button><div className="avatar">OP</div></div>
  </header>;
}

function SignalChart({ values = chartValues }: { values?: number[] }) {
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${112 - ((value - 45) / 50) * 88}`).join(' ');
  const area = `0,112 ${points} 100,112`;
  return <svg className="chart" viewBox="0 0 100 132" preserveAspectRatio="none" aria-label="Signal history chart">
    <defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#31c5ba" stopOpacity=".22" /><stop offset="100%" stopColor="#31c5ba" stopOpacity="0" /></linearGradient></defs>
    {[18, 48, 78, 108].map(y => <line key={y} className="chart-grid" x1="0" x2="100" y1={y} y2={y} />)}
    <polygon className="chart-area" points={area} /><polyline className="chart-line" points={points} />
    <text className="chart-label" x="0" y="128">−60m</text><text className="chart-label" x="44" y="128">−30m</text><text className="chart-label" x="94" y="128">now</text>
  </svg>;
}

function MetricCard({ label, value, note, icon: Icon, accent = false }: { label: string; value: string; note: string; icon: typeof Signal; accent?: boolean }) {
  return <div className="metric-card" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon /></span></div><div className="metric-value">{value}<small>{accent ? 'LIVE' : ''}</small></div><div className="metric-note">{note}</div></div>;
}

function RadarView({ devices, selectedId, onSelect }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void }) {
  const positions = [[30, 26], [64, 30], [73, 63], [41, 76], [22, 57], [80, 45]];
  return <div className="radar-wrap">
    <div className="radar"><span className="radar-ring-label top">0°</span><span className="radar-ring-label right">90°</span><span className="radar-ring-label bottom">180°</span><span className="radar-ring-label left">270°</span><span className="radar-center" />
      {devices.map((device, index) => <button key={device.id} data-testid={`radar-target-${device.id}`} aria-label={`Select ${device.vendor}`} className={`target ${device.status === 'ghost' ? 'ghost' : ''} ${device.id === selectedId ? 'selected' : ''}`} style={{ left: `${positions[index % positions.length][0]}%`, top: `${positions[index % positions.length][1]}%` }} onClick={() => onSelect(device.id)}><span className="target-label">{device.id === selectedId ? 'LOCKED' : device.mac.slice(-5)}</span></button>)}
    </div>
    <div className="radar-footer"><div className="legend"><span><i />active</span><span><i className="amber" />locked</span><span><i className="gray" />ghost</span></div><span>radius 25 m · north relay</span></div>
  </div>;
}

function DeviceRows({ devices, selectedId, onSelect, onFavorite }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void; onFavorite: (id: string) => void }) {
  if (!devices.length) return <div className="empty-state"><Search size={23} /><h3>No targets in this slice</h3><p>Try a different query or include ghost targets.</p></div>;
  return <><div className="list-head"><span /><span>Target</span><span>Protocol</span><span>Signal</span><span>State</span><span /></div><div className="device-list">{devices.map(device => <div key={device.id} data-testid={`row-device-${device.id}`} className={`device-row ${device.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(device.id)}>
    <div className="device-icon"><AppIcon protocol={device.protocol} /></div><div><div className="device-name">{device.vendor}</div><div className="device-mac">{device.mac}</div></div><div><div className="device-name" style={{ fontWeight: 500 }}>{device.protocol}</div><div className="device-meta">{device.channel}</div></div><div className="signal-cell">{device.signal}<span className="signal-bar"><b style={{ width: `${Math.max(8, 100 - (Math.abs(device.signal) - 35) * 1.65)}%` }} /></span></div><div className={`state ${device.status}`}>{device.status}</div><button className="icon-button" aria-label={device.favorite ? 'Remove favorite' : 'Add favorite'} data-testid={`button-favorite-${device.id}`} onClick={event => { event.stopPropagation(); onFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} /></button>
  </div>)}</div></>;
}

function NodeList({ nodes }: { nodes: ScanNode[] }) {
  return <div className="node-list">{nodes.map(node => <div className="node-card" key={node.id} data-testid={`card-node-${node.id}`}><div className="node-card-top"><span className="node-name">{node.name}</span><span className={`state ${node.status === 'online' ? 'active' : 'ghost'}`}>{node.status}</span></div><div className="node-address">{node.address} · {node.role}</div><div className="node-meta"><span>{node.devices} targets observed</span><span>{node.lastSeen}</span></div></div>)}</div>;
}

function Dashboard({ devices, nodes, selectedId, scanning, onSelect, onFavorite, onNavigate }: { devices: RFDevice[]; nodes: ScanNode[]; selectedId: string; scanning: boolean; onSelect: (id: string) => void; onFavorite: (id: string) => void; onNavigate: (view: NavView) => void }) {
  const selected = devices.find(d => d.id === selectedId);
  const visibleDevices = devices.filter(d => d.status !== 'ghost');
  return <><div className="page-heading"><div><div className="page-kicker">RF command surface / 01</div><h1>Know what is nearby.</h1><p>One calm view of the local radio environment, with every inference grounded in observable signal.</p></div><div className="header-actions"><button className="btn" data-testid="button-refresh-dashboard" onClick={() => window.location.reload()}><RefreshCw size={14} /> Refresh view</button></div></div>
    <div className="signal-banner"><Shield /><span><strong>Defensive session.</strong> All telemetry shown here is simulated until a real sensor adapter is connected. No cameras. No cloud relay.</span><ChevronRight size={14} style={{ marginLeft: 'auto', color: '#5b8988' }} /></div>
    <div className="stats-grid"><MetricCard label="Nearby targets" value={String(visibleDevices.length).padStart(2, '0')} note="+2 since session start" icon={Radio} accent /><MetricCard label="Tracked now" value={String(devices.filter(d => d.status === 'active').length).padStart(2, '0')} note="Across 2 active nodes" icon={Eye} /><MetricCard label="Signal floor" value="-92" note="dBm · 2.4 GHz baseline" icon={Signal} /><MetricCard label="Protected links" value="68%" note="Encrypted observations" icon={Shield} /></div>
    <div className="main-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Proximity field</div><div className="panel-subtitle">Relative signal position · 25 m radius</div></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'LIVE SWEEP' : 'SWEEP PAUSED'}</div></div><RadarView devices={devices} selectedId={selectedId} onSelect={onSelect} /></section>
      <section className="panel"><div className="panel-header"><div><div className="panel-title">Signal history</div><div className="panel-subtitle">{selected ? `${selected.vendor} · ${selected.mac}` : 'Select a target to lock tracking'}</div></div><BarChart3 size={16} style={{ color: '#6a8c8b' }} /></div><div className="history"><SignalChart values={selected ? chartValues.map((v, i) => Math.max(45, v + (selected.signal + 60) / 2 + (i % 3 - 1) * 3)) : chartValues} /><div className="history-summary"><div><div className="eyebrow">Current signal</div><div className="history-value">{selected?.signal ?? '—'}<small>{selected ? 'dBm' : 'NO LOCK'}</small></div></div><div style={{ textAlign: 'right' }}><div className="eyebrow">Proximity</div><div className="history-value" style={{ fontSize: 14, marginTop: 7 }}>{selected?.maxProximity ?? '—'}</div></div></div></div></section>
    </div>
    <div className="lower-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Latest discoveries</div><div className="panel-subtitle">{visibleDevices.length} visible targets · sorted by signal</div></div><button className="btn" data-testid="button-open-ledger" onClick={() => onNavigate('ledger')}>Open ledger <ArrowDownToLine size={13} /></button></div><DeviceRows devices={visibleDevices.slice(0, 4)} selectedId={selectedId} onSelect={onSelect} onFavorite={onFavorite} /></section><section className="panel"><div className="panel-header"><div><div className="panel-title">Scan nodes</div><div className="panel-subtitle">Local sensor topology</div></div><button className="icon-button" data-testid="button-open-nodes" onClick={() => onNavigate('nodes')}><ChevronRight /></button></div><NodeList nodes={nodes} /></section></div>
  </>;
}

function FilterToolbar({ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, onExport }: { query: string; setQuery: (v: string) => void; protocol: string; setProtocol: (v: string) => void; showGhosts: boolean; setShowGhosts: (v: boolean) => void; onExport: () => void }) {
  return <div className="toolbar"><div className="search-box"><Search /><input data-testid="input-device-search" className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search MAC, vendor, node…" /></div><select data-testid="select-protocol" className="select-filter" value={protocol} onChange={event => setProtocol(event.target.value)}><option value="all">All protocols</option><option value="WiFi">WiFi</option><option value="BLE">BLE</option></select><button data-testid="button-toggle-ghosts" className="toggle-filter" onClick={() => setShowGhosts(!showGhosts)}><span className={`switch ${showGhosts ? 'on' : ''}`} /> include ghosts</button><button className="btn" data-testid="button-export-ledger" onClick={onExport}><Download size={13} /> Export CSV</button></div>;
}

function Ledger({ devices, selectedId, onSelect, onFavorite, onExport }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void; onFavorite: (id: string) => void; onExport: () => void }) {
  const [query, setQuery] = useState(''); const [protocol, setProtocol] = useState('all'); const [showGhosts, setShowGhosts] = useState(false);
  const filtered = useMemo(() => devices.filter(device => (showGhosts || device.status !== 'ghost') && (protocol === 'all' || device.protocol === protocol) && [device.mac, device.vendor, device.node].join(' ').toLowerCase().includes(query.toLowerCase())), [devices, protocol, query, showGhosts]);
  return <><div className="page-heading"><div><div className="page-kicker">Device ledger / 02</div><h1>Every signal leaves a trace.</h1><p>Search, inspect, and mark observations that deserve a closer look. Ghost targets remain available without cluttering the live surface.</p></div><div className="header-actions"><button className="btn btn-primary" data-testid="button-export-ledger-header" onClick={onExport}><FileDown size={14} /> Export ledger</button></div></div><div className="panel view-panel"><FilterToolbar {...{ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, onExport }} /><div className="ledger-table-wrap">{filtered.length ? <table className="ledger-table"><thead><tr><th>Target</th><th>Vendor</th><th>Protocol</th><th>Signal</th><th>Proximity</th><th>Node</th><th>Last seen</th><th>Status</th><th /></tr></thead><tbody>{filtered.map(device => <tr key={device.id} data-testid={`ledger-row-${device.id}`} onClick={() => onSelect(device.id)}><td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><button className="icon-button" data-testid={`ledger-favorite-${device.id}`} onClick={event => { event.stopPropagation(); onFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} /></button><span className="strong">{device.mac}</span></span></td><td>{device.vendor}</td><td>{device.protocol}</td><td>{device.signal} dBm</td><td>{device.maxProximity}</td><td>{device.node}</td><td>{device.lastSeen}</td><td><span className={`state ${device.status}`}>{device.status}</span></td><td><ChevronRight size={14} /></td></tr>)}</tbody></table> : <div className="empty-state"><Filter size={23} /><h3>No matching observations</h3><p>Nothing in the ledger matches the current filters.</p></div>}</div></div></>;
}

function Sensing({ scanning }: { scanning: boolean }) {
  return <><div className="page-heading"><div><div className="page-kicker">Sensing / 03</div><h1>Read the room, quietly.</h1><p>Camera-free environmental inference from changes in radio behavior. This layer surfaces patterns, never identities.</p></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'INFERENCE ACTIVE' : 'INFERENCE PAUSED'}</div></div><div className="signal-banner"><CameraOff /><span><strong>Privacy boundary.</strong> Sensing metrics are simulated and intentionally low-resolution. No images, audio, or biometric signals are collected.</span><CircleHelp size={14} style={{ marginLeft: 'auto' }} /></div><div className="sensing-grid">{sensingMetrics.map(metric => <div className="panel sensing-card" key={metric.label} data-testid={`sensing-${metric.label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-icon"><Gauge size={17} /></div><div className="eyebrow">{metric.label}</div><div className="sensing-value">{metric.value}<span className="sensing-unit">{metric.unit}</span></div><div className="confidence"><span>{metric.status} · {metric.trend}</span><span className="confidence-bar"><i style={{ width: `${metric.confidence}%` }} /></span></div></div>)}</div><div className="panel" style={{ marginTop: 11 }}><div className="panel-header"><div><div className="panel-title">Inference notes</div><div className="panel-subtitle">Model output is local to this browser session</div></div><Zap size={15} style={{ color: '#d3a652' }} /></div><div className="notes-grid"><div className="note-cell"><div className="eyebrow">08:57</div><p style={{ fontSize: 11, color: '#a2b9b5', lineHeight: 1.5, margin: '9px 0 0' }}>Presence probability rose as two active targets converged near the north relay.</p></div><div className="note-cell"><div className="eyebrow">08:44</div><p style={{ fontSize: 11, color: '#a2b9b5', lineHeight: 1.5, margin: '9px 0 0' }}>Channel noise remains within the local baseline. No unusual burst pattern detected.</p></div><div className="note-cell"><div className="eyebrow">08:31</div><p style={{ fontSize: 11, color: '#a2b9b5', lineHeight: 1.5, margin: '9px 0 0' }}>A low-confidence occupancy estimate became available from passive signal variance.</p></div></div></div></>;
}

function Nodes({ nodes, onAdd, onRemove }: { nodes: ScanNode[]; onAdd: (name: string, address: string) => void; onRemove: (id: string) => void }) {
  const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [adding, setAdding] = useState(false);
  const submit = () => { if (name.trim() && address.trim()) { onAdd(name.trim(), address.trim()); setName(''); setAddress(''); setAdding(false); } };
  return <><div className="page-heading"><div><div className="page-kicker">Network topology / 04</div><h1>Know your vantage points.</h1><p>Local relay nodes keep collection scoped, inspectable, and close to the operator.</p></div><button className="btn btn-primary" data-testid="button-add-node" onClick={() => setAdding(!adding)}>{adding ? <X size={14} /> : <Plus size={14} />}{adding ? 'Cancel' : 'Add node'}</button></div><div className="nodes-layout"><section className="panel"><div className="panel-header"><div><div className="panel-title">Registered nodes</div><div className="panel-subtitle">{nodes.filter(n => n.status === 'online').length} online · {nodes.length} total</div></div><Network size={16} style={{ color: '#6a8c8b' }} /></div><div className="node-grid">{nodes.map(node => <div className="node-card" key={node.id} data-testid={`node-detail-${node.id}`}><div className="node-card-top"><span className="node-name">{node.name}</span><button className="icon-button" aria-label={`Remove ${node.name}`} data-testid={`button-remove-node-${node.id}`} onClick={() => onRemove(node.id)}><Trash2 size={13} /></button></div><div className="node-address">{node.address} · {node.role}</div><div className="node-meta"><span className={node.status === 'online' ? 'node-status' : 'node-status offline'}>{node.status === 'online' ? 'heartbeat nominal' : 'last heartbeat'}</span><span>{node.lastSeen}</span></div><div style={{ marginTop: 13, color: '#abc1bd', font: '10px var(--app-font-mono)' }}>{node.devices} <span style={{ color: '#667f80' }}>observations in scope</span></div></div>)}</div></section><section className="panel node-add"><div className="panel-title">Add a local relay</div><p>Register an authorized sensor adapter by its local address. This demo stores node configuration in your browser only.</p>{adding ? <div className="form-grid"><div className="field full"><label htmlFor="node-name">Node label</label><input id="node-name" data-testid="input-node-name" value={name} onChange={e => setName(e.target.value)} placeholder="West hallway" /></div><div className="field full"><label htmlFor="node-address">Local address</label><input id="node-address" data-testid="input-node-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="10.42.0.14" /></div><div className="form-actions field full"><button className="btn" data-testid="button-cancel-node" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" data-testid="button-save-node" onClick={submit}><Check size={14} /> Register node</button></div></div> : <div className="node-hero"><div className="node-hero-title"><Antenna size={15} /> Adapter contract ready</div><p>Awaiting a real sensor adapter. Your scope and authorization boundary stay local to this session.</p></div>}</section></div></>;
}

function CapabilityIcon({ id }: { id: string }) {
  if (id === 'bluetooth') return <Bluetooth />;
  if (id === 'wifi') return <Wifi />;
  if (id === 'camera-mic') return <Mic />;
  if (id === 'location') return <MapPin />;
  if (id === 'motion') return <Activity />;
  if (id === 'battery') return <Smartphone />;
  return <Cpu />;
}

function Hardware({ capabilities, refreshing, onRefresh, onRequest }: { capabilities: HardwareCapability[]; refreshing: boolean; onRefresh: () => void; onRequest: (id: HardwareCapability['id']) => void }) {
  const connected = capabilities.filter(capability => capability.status === 'connected' || capability.status === 'ready').length;
  const supported = capabilities.filter(capability => capability.status !== 'unsupported').length;
  const statusLabel: Record<HardwareStatus, string> = { ready: 'ready', permission: 'permission needed', connected: 'connected', limited: 'limited', unsupported: 'not exposed' };
  return <><div className="page-heading"><div><div className="page-kicker">Hardware bridge / 05</div><h1>Use what is already in hand.</h1><p>BackSpyne checks the current phone or computer, then enables only the capabilities that browser permissions and local hardware safely expose.</p></div><button className="btn btn-primary" data-testid="button-scan-hardware" onClick={onRefresh}>{refreshing ? <><RefreshCw className="spin" size={14} /> Scanning hardware</> : <><ScanLine size={14} /> Scan this device</>}</button></div>
    <div className="signal-banner"><ShieldCheck /><span><strong>Permission-first hardware scan.</strong> No camera, microphone, location, Bluetooth, USB, or serial permission is requested until you choose a specific action.</span><span className="hardware-count">{connected}/{supported} usable</span></div>
    <div className="stats-grid hardware-stats"><MetricCard label="Usable surfaces" value={String(connected).padStart(2, '0')} note="Ready or connected" icon={Cpu} /><MetricCard label="Permission gates" value={String(capabilities.filter(capability => capability.status === 'permission').length).padStart(2, '0')} note="Operator decision required" icon={Shield} /><MetricCard label="RF direct scan" value="RELAY" note="Browser boundary enforced" icon={Radio} /><MetricCard label="Profile" value="LOCAL" note="No cloud hardware relay" icon={Smartphone} /></div>
    <div className="panel hardware-panel"><div className="panel-header"><div><div className="panel-title">Detected capability surface</div><div className="panel-subtitle">Results come from this device and this browser session</div></div><div className="status-pill"><span className="pulse-dot" /> DEVICE-AWARE</div></div><div className="capability-grid">{capabilities.map(capability => <div className={`capability-card ${capability.status}`} key={capability.id} data-testid={`hardware-${capability.id}`}><div className="capability-top"><div className="capability-icon"><CapabilityIcon id={capability.id} /></div><span className={`hardware-status ${capability.status}`}>{statusLabel[capability.status]}</span></div><div className="capability-label">{capability.label}</div><p>{capability.detail}</p><div className="capability-use"><span className="eyebrow">BackSpyne use</span><span>{capability.use}</span></div>{capability.action && <button className="btn capability-action" data-testid={`button-connect-${capability.action}`} onClick={() => onRequest(capability.id)}>{capability.status === 'connected' ? <><CheckCircle2 size={13} /> Connected</> : <><Plus size={13} /> Choose approved device</>}</button>}</div>)}</div></div>
    <div className="panel hardware-note"><div className="panel-header"><div><div className="panel-title">Why nearby WiFi is different</div><div className="panel-subtitle">Browser security boundary</div></div><Wifi size={16} style={{ color: '#6a8c8b' }} /></div><div className="hardware-note-body"><p>Web pages cannot silently enumerate nearby access points or harvest MAC addresses. That is intentional. For authorized RF observations, connect a local Python relay, ESP32/CSI sensor, or approved BLE peripheral through the Network nodes workflow.</p><a className="btn" href="https://github.com/youknowzo" target="_blank" rel="noreferrer"><Github size={13} /> View PaperBagExpress on GitHub <ExternalLink size={12} /></a></div></div>
  </>;
}

function Home() {
  const [view, setView] = useState<NavView>('dashboard'); const [mobileOpen, setMobileOpen] = useState(false); const [scanning, setScanning] = useState(true);
  const [devices, setDevices] = useState<RFDevice[]>(() => { try { const saved = localStorage.getItem('backspyne-devices'); return saved ? JSON.parse(saved) : initialDevices; } catch { return initialDevices; } });
  const [nodes, setNodes] = useState<ScanNode[]>(() => { try { const saved = localStorage.getItem('backspyne-nodes'); return saved ? JSON.parse(saved) : initialNodes; } catch { return initialNodes; } });
  const [hardware, setHardware] = useState<HardwareCapability[]>(initialHardware);
  const [hardwareRefreshing, setHardwareRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState('dev-01');
  useEffect(() => { localStorage.setItem('backspyne-devices', JSON.stringify(devices)); }, [devices]);
  useEffect(() => { localStorage.setItem('backspyne-nodes', JSON.stringify(nodes)); }, [nodes]);
  useEffect(() => { void refreshHardware(); }, []);
  useEffect(() => { if (!scanning) return; const timer = window.setInterval(() => setDevices(current => current.map(device => device.status === 'ghost' ? device : { ...device, signal: Math.max(-88, Math.min(-39, device.signal + (Math.random() > .5 ? 1 : -1))), lastSeen: device.status === 'active' ? 'now' : device.lastSeen })), 3200); return () => window.clearInterval(timer); }, [scanning]);
  const toggleFavorite = (id: string) => setDevices(current => current.map(device => device.id === id ? { ...device, favorite: !device.favorite } : device));
  const addNode = (name: string, address: string) => setNodes(current => [...current, { id: `node-${Date.now()}`, name, address, status: 'online', lastSeen: 'now', devices: 0, role: 'New relay' }]);
  const removeNode = (id: string) => setNodes(current => current.filter(node => node.id !== id));
  const refreshHardware = async () => { setHardwareRefreshing(true); try { setHardware(await scanHardwareCapabilities()); } finally { setHardwareRefreshing(false); } };
  const requestHardware = async (id: HardwareCapability['id']) => {
    const hardwareNavigator = navigator as HardwareNavigator;
    try {
      if (id === 'bluetooth' && hardwareNavigator.bluetooth?.requestDevice) {
        const device = await hardwareNavigator.bluetooth.requestDevice({ acceptAllDevices: true });
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: `${device.name ?? 'Approved BLE peripheral'} selected. BackSpyne can use it through a local adapter.` } : capability));
      }
      if (id === 'usb' && hardwareNavigator.usb?.requestDevice) {
        await hardwareNavigator.usb.requestDevice({ filters: [] });
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Approved USB device selected. Connect it to a local sensor bridge to stream observations.' } : capability));
      }
      if (id === 'serial' && hardwareNavigator.serial?.requestPort) {
        await hardwareNavigator.serial.requestPort({ filters: [] });
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Approved serial port selected. A local Python bridge can stream observations through it.' } : capability));
      }
    } catch {
      // Permission prompts can be dismissed. Keep the capability visible without treating dismissal as a failure.
    }
  };
  const exportLedger = () => { const columns = ['id', 'mac', 'vendor', 'protocol', 'signal', 'maxProximity', 'status', 'lastSeen', 'firstSeen', 'node', 'channel', 'encrypted', 'favorite']; const csv = [columns.join(','), ...devices.map(device => columns.map(key => JSON.stringify(device[key as keyof RFDevice] ?? '')).join(','))].join('\n'); const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'backspyne-device-ledger.csv'; link.click(); URL.revokeObjectURL(url); };
  return <div className="app-shell"><Sidebar {...{ view, mobileOpen, onClose: () => setMobileOpen(false), onNavigate: setView, devices }} /><div className="main-content"><Topbar view={view} scanning={scanning} onToggleScan={() => setScanning(!scanning)} onOpenMenu={() => setMobileOpen(true)} /><main className="content">{view === 'dashboard' && <Dashboard {...{ devices, nodes, selectedId, scanning, onSelect: setSelectedId, onFavorite: toggleFavorite, onNavigate: setView }} />}{view === 'ledger' && <Ledger {...{ devices, selectedId, onSelect: setSelectedId, onFavorite: toggleFavorite, onExport: exportLedger }} />}{view === 'sensing' && <Sensing scanning={scanning} />}{view === 'nodes' && <Nodes {...{ nodes, onAdd: addNode, onRemove: removeNode }} />}{view === 'hardware' && <Hardware capabilities={hardware} refreshing={hardwareRefreshing} onRefresh={() => void refreshHardware()} onRequest={requestHardware} />}</main></div></div>;
}

function Router() {
  return <ErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

export default function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}