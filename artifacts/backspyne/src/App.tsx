import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Antenna, Archive, ArrowDownToLine, BarChart3, Bluetooth,
  CameraOff, Check, CheckCircle2, ChevronRight, CircleHelp, Cpu, Download,
  Eye, ExternalLink, FileDown, Filter, Github, Gauge, LayoutDashboard, MapPin,
  LogOut, Menu, Mic, Minus, Network, Plus, Radio, Radar, RefreshCw, ScanLine, Search,
  Shield, ShieldCheck, Smartphone,
  Signal, Star, Trash2, Wifi, X, Zap,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from './components/error-boundary';
import { Toaster } from './components/ui/toaster';
import { TooltipProvider } from './components/ui/tooltip';
import NotFound from './pages/not-found';
import { Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

type RFDevice = {
  id: string; mac: string; vendor: string; protocol: 'WiFi' | 'BLE';
  signal: number; maxProximity: string; status: 'active' | 'idle' | 'ghost';
  lastSeen: string; firstSeen: string; node: string; channel: string;
  encrypted: boolean; favorite: boolean;
};
type ScanNode = { id: string; name: string; address: string; status: 'online' | 'offline'; lastSeen: string; devices: number; role: string };
type SensingMetric = { label: string; value: string; unit: string; confidence: number; status: string; trend: string };
type SensingSnapshot = { id: string; observedAt: string; metrics: Record<string, unknown>; confidence?: number | null; uncertainty?: Record<string, unknown> };
type DeviceSighting = { observedAt: string; signalDbm: number | null; distanceMeters: number | null };
type HardwareStatus = 'ready' | 'permission' | 'connected' | 'limited' | 'unsupported';
type HardwareCapability = {
  id: string;
  label: string;
  status: HardwareStatus;
  detail: string;
  use: string;
  action?: 'bluetooth' | 'usb' | 'serial' | 'camera-mic' | 'location';
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

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in the environment.');

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#37d0c3',
    colorForeground: '#d7e9e7',
    colorMutedForeground: '#8aa2a0',
    colorDanger: '#ef928b',
    colorBackground: '#10232d',
    colorInput: '#0c1d25',
    colorInputForeground: '#d7e9e7',
    colorNeutral: '#29434c',
    fontFamily: 'Manrope, sans-serif',
    borderRadius: '0.65rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#10232d] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#e1f1ef]',
    headerSubtitle: 'text-[#8aa2a0]',
    socialButtonsBlockButtonText: 'text-[#d7e9e7]',
    formFieldLabel: 'text-[#a8bfbb]',
    footerActionLink: 'text-[#55dfd1]',
    footerActionText: 'text-[#8aa2a0]',
    dividerText: 'text-[#8aa2a0]',
    identityPreviewEditButton: 'text-[#55dfd1]',
    formFieldSuccessText: 'text-[#55dfd1]',
    alertText: 'text-[#ef928b]',
    logoBox: 'h-10',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border-[#29434c] bg-[#0c1d25]',
    formButtonPrimary: 'bg-[#37d0c3] text-[#062522] hover:bg-[#55dfd1]',
    formFieldInput: 'border-[#29434c] bg-[#0c1d25] text-[#d7e9e7]',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-[#29434c]',
    alert: 'border-[#7a3d3c] bg-[#321e24]',
    otpCodeFieldInput: 'border-[#29434c] bg-[#0c1d25] text-[#d7e9e7]',
    formFieldRow: 'text-[#d7e9e7]',
    main: 'bg-transparent',
  },
};

const initialHardware: HardwareCapability[] = [
  { id: 'bluetooth', label: 'Bluetooth radio', status: 'permission', detail: 'Radio detected. Choose an approved BLE peripheral to connect.', use: 'BLE discovery and local sensor adapters', action: 'bluetooth' },
  { id: 'wifi', label: 'WiFi awareness', status: 'limited', detail: 'The browser can report network state, but cannot enumerate nearby access points.', use: 'Use a local relay or ESP32 adapter for RF observations' },
  { id: 'motion', label: 'Motion sensors', status: 'ready', detail: 'Device motion and orientation APIs are available to this browser.', use: 'Optional device movement context for local sensing' },
  { id: 'camera-mic', label: 'Camera and microphone', status: 'permission', detail: 'Media inputs are present. BackSpyne will not request access automatically.', use: 'Optional operator presence checks; never used for RF sensing', action: 'camera-mic' },
  { id: 'usb', label: 'USB devices', status: 'unsupported', detail: 'No browser USB adapter is available until a device is explicitly selected.', use: 'Direct ESP32 or compatible scanner connection', action: 'usb' },
  { id: 'serial', label: 'Serial ports', status: 'unsupported', detail: 'No browser serial adapter is available until a port is explicitly selected.', use: 'Local Python bridge or microcontroller stream', action: 'serial' },
  { id: 'location', label: 'Location', status: 'permission', detail: 'Location is available only after an explicit user permission decision.', use: 'Optional node placement and operator map context', action: 'location' },
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

function Sidebar({ view, onNavigate, mobileOpen, onClose, devices, nodes, liveMode, apiConnected }: { view: NavView; onNavigate: (view: NavView) => void; mobileOpen: boolean; onClose: () => void; devices: RFDevice[]; nodes: ScanNode[]; liveMode: boolean; apiConnected: boolean }) {
  const items: { id: NavView; label: string; icon: typeof Radio; count?: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'ledger', label: 'Device ledger', icon: Archive, count: String(devices.length).padStart(2, '0') },
    { id: 'sensing', label: 'Sensing', icon: Activity },
    { id: 'nodes', label: 'Network nodes', icon: Network, count: String(nodes.length).padStart(2, '0') },
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
        <div className="adapter-line"><span className={`pulse-dot ${liveMode ? '' : 'amber'}`} /> <span>Adapter status</span><span style={{ marginLeft: 'auto', color: liveMode ? '#79d8cf' : '#d6b064', fontSize: 10 }}>{liveMode ? 'LIVE' : apiConnected ? 'READY' : 'OFFLINE'}</span></div>
        <p className="adapter-caption">{liveMode ? 'Signed node telemetry is connected to this operator session.' : apiConnected ? 'Operator API is connected; waiting for an authorized node heartbeat.' : 'Operator API is unavailable. Reconnect to load persisted telemetry.'}</p>
      </div>
      <div className="disclaimer"><strong>Authorized environments only.</strong><br />BackSpyne is a defensive observability surface. Respect local law, consent, and scope.</div>
    </div>
  </aside>;
}

 function Topbar({ view, scanning, onToggleScan, onOpenMenu, sessionId, onSignOut }: { view: NavView; scanning: boolean; onToggleScan: () => void; onOpenMenu: () => void; sessionId: string | null; onSignOut: () => Promise<void> }) {
  const { user } = useUser();
  const titles: Record<NavView, [string, string]> = { dashboard: ['Operations / overview', 'Local RF environment'], ledger: ['Operations / ledger', 'Discovered device inventory'], sensing: ['Operations / sensing', 'Camera-free inference layer'], nodes: ['Operations / nodes', 'Sensor network topology'], hardware: ['Operations / hardware', 'Device capability bridge'] };
  const operatorName = user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Operator';
  return <header className="topbar">
    <div className="topbar-context"><button className="menu-button" data-testid="button-open-menu" onClick={onOpenMenu}><Menu size={20} /></button><div className="context-line" /><div><div className="context-title">{titles[view][0]}</div><div className="context-sub">{titles[view][1]}</div></div></div>
     <div className="topbar-actions"><a className="github-link" href="https://github.com/youknowzo" target="_blank" rel="noreferrer"><Github size={14} /> <span>youknowzo</span></a><div className="connection"><span className="pulse-dot" /> {sessionId ? 'Session active · encrypted' : 'Local session · encrypted'}</div><button data-testid="button-global-scan" className={`btn scan-toggle ${scanning ? 'is-scanning' : ''}`} onClick={onToggleScan}>{scanning ? <><Activity size={14} /> Scanning</> : <><Minus size={14} /> Paused</>}</button><div className="operator-menu"><div className="avatar" title={operatorName}>{operatorName.slice(0, 2).toUpperCase()}</div><button className="session-button" data-testid="button-sign-out" onClick={() => void onSignOut()}><LogOut size={13} /> Sign out</button></div></div>
  </header>;
}

function SignalChart({ values = [] }: { values?: number[] }) {
  if (values.length < 2) return <div className="chart-empty">No sighting history for this target.</div>;
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

function Dashboard({ devices, nodes, selectedId, scanning, onSelect, onFavorite, onNavigate, liveMode, apiConnected, trail }: { devices: RFDevice[]; nodes: ScanNode[]; selectedId: string; scanning: boolean; onSelect: (id: string) => void; onFavorite: (id: string) => void; onNavigate: (view: NavView) => void; liveMode: boolean; apiConnected: boolean; trail: DeviceSighting[] }) {
  const selected = devices.find(d => d.id === selectedId);
  const visibleDevices = devices.filter(d => d.status !== 'ghost');
  const activeNodes = nodes.filter(node => node.status === 'online').length;
  const signalFloor = visibleDevices.length ? String(Math.min(...visibleDevices.map(device => device.signal))) : '—';
  const encryptedCount = devices.filter(device => device.encrypted).length;
  const protectedLinks = devices.length ? `${Math.round((encryptedCount / devices.length) * 100)}%` : '—';
  const historyValues = trail.length > 1 ? [...trail].reverse().map(sighting => Math.abs(sighting.signalDbm ?? -92)) : [];
  return <><div className="page-heading"><div><div className="page-kicker">RF command surface / 01</div><h1>Know what is nearby.</h1><p>One calm view of the local radio environment, with every inference grounded in observable signal.</p></div><div className="header-actions"><button className="btn" data-testid="button-refresh-dashboard" onClick={() => window.location.reload()}><RefreshCw size={14} /> Refresh view</button></div></div>
     <div className="signal-banner"><Shield /><span><strong>Defensive session.</strong> {liveMode ? 'Signed observations from an authorized local node are flowing into this session.' : nodes.length ? 'An authorized node is registered, but it has not reported an observation yet. Check its local bridge permissions and logs.' : apiConnected ? 'The operator API is connected, but no local relay is connected. Start the bridge from Hardware scan.' : 'The operator API is not connected yet.'} No cameras. No cloud relay.</span><button className="banner-action" onClick={() => onNavigate('hardware')}>Hardware scan <ChevronRight size={14} /></button></div>
     <div className="stats-grid"><MetricCard label="Nearby targets" value={String(visibleDevices.length).padStart(2, '0')} note="Current authorized scope" icon={Radio} accent /><MetricCard label="Tracked now" value={String(devices.filter(d => d.status === 'active').length).padStart(2, '0')} note={`${activeNodes} active node${activeNodes === 1 ? '' : 's'}`} icon={Eye} /><MetricCard label="Signal floor" value={signalFloor} note="Lowest observed dBm" icon={Signal} /><MetricCard label="Protected links" value={protectedLinks} note="Encrypted observations" icon={Shield} /></div>
    <div className="main-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Proximity field</div><div className="panel-subtitle">Relative signal position · 25 m radius</div></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'LIVE SWEEP' : 'SWEEP PAUSED'}</div></div><RadarView devices={devices} selectedId={selectedId} onSelect={onSelect} /></section>
       <section className="panel"><div className="panel-header"><div><div className="panel-title">Signal history</div><div className="panel-subtitle">{selected ? `${selected.vendor} · ${selected.mac}` : 'Select a target to lock tracking'}</div></div><BarChart3 size={16} style={{ color: '#6a8c8b' }} /></div><div className="history"><SignalChart values={historyValues} /><div className="history-summary"><div><div className="eyebrow">Current signal</div><div className="history-value">{selected?.signal ?? '—'}<small>{selected ? 'dBm' : 'NO LOCK'}</small></div></div><div style={{ textAlign: 'right' }}><div className="eyebrow">Proximity</div><div className="history-value" style={{ fontSize: 14, marginTop: 7 }}>{selected?.maxProximity ?? '—'}</div></div></div></div></section>
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

function sensingMetricsFromSnapshot(snapshot: SensingSnapshot | null): SensingMetric[] {
  const metrics = snapshot?.metrics ?? {};
  const confidence = Math.round(Math.max(0, Math.min(1, typeof snapshot?.confidence === 'number' ? snapshot.confidence : 0)) * 100);
  const number = (key: string, digits = 1) => typeof metrics[key] === 'number' ? (metrics[key] as number).toFixed(digits) : '—';
  const percent = typeof metrics.presenceProbability === 'number' ? ((metrics.presenceProbability as number) * 100).toFixed(1) : '—';
  const status = snapshot ? 'Observed' : 'Awaiting telemetry';
  return [
    { label: 'Presence probability', value: percent, unit: '%', confidence, status, trend: snapshot ? 'latest batch' : 'no sample' },
    { label: 'Motion index', value: number('motionIndex', 2), unit: 'Δ', confidence, status, trend: snapshot ? 'latest batch' : 'no sample' },
    { label: 'Occupancy estimate', value: typeof metrics.occupancyEstimate === 'number' ? String(metrics.occupancyEstimate) : '—', unit: 'persons', confidence, status, trend: 'environmental only' },
    { label: 'Channel noise floor', value: number('signalFloorDbm', 1), unit: 'dBm', confidence, status, trend: snapshot ? 'latest batch' : 'no sample' },
    { label: 'Signal variance', value: number('signalVarianceDb', 2), unit: 'dB', confidence, status, trend: snapshot ? 'latest batch' : 'no sample' },
    { label: 'Observations', value: typeof metrics.observationCount === 'number' ? String(metrics.observationCount) : '—', unit: '/ batch', confidence, status, trend: snapshot ? 'signed node input' : 'no sample' },
  ];
}

function Sensing({ scanning, snapshot, apiConnected }: { scanning: boolean; snapshot: SensingSnapshot | null; apiConnected: boolean }) {
  const metrics = sensingMetricsFromSnapshot(snapshot);
  const notes = snapshot ? [`Last signed sample: ${new Date(snapshot.observedAt).toLocaleString()}.`, `Inference mode: ${String(snapshot.metrics.inferenceStatus ?? 'environmental heuristic')}.`, 'Outputs are low-resolution environmental indicators, not identity or medical measurements.'] : ['No sensing snapshot has been received.', 'Connect an authorized CSI or RF node to publish environmental metrics.', 'No camera, microphone, or biometric stream is used.'];
  return <><div className="page-heading"><div><div className="page-kicker">Sensing / 03</div><h1>Read the room, quietly.</h1><p>Camera-free environmental inference from changes in radio behavior. This layer surfaces patterns, never identities.</p></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'INFERENCE ACTIVE' : 'INFERENCE PAUSED'}</div></div><div className="signal-banner"><CameraOff /><span><strong>Privacy boundary.</strong> {apiConnected ? (snapshot ? 'Metrics below come from the latest signed local-node sample.' : 'The API is connected, but no sensing sample has arrived yet.') : 'Connect to the operator API to load sensing telemetry.'} No images, audio, or medical inference.</span><CircleHelp size={14} style={{ marginLeft: 'auto' }} /></div><div className="sensing-grid">{metrics.map(metric => <div className="panel sensing-card" key={metric.label} data-testid={`sensing-${metric.label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-icon"><Gauge size={17} /></div><div className="eyebrow">{metric.label}</div><div className="sensing-value">{metric.value}<span className="sensing-unit">{metric.unit}</span></div><div className="confidence"><span>{metric.status} · {metric.trend}</span><span className="confidence-bar"><i style={{ width: `${metric.confidence}%` }} /></span></div></div>)}</div><div className="panel" style={{ marginTop: 11 }}><div className="panel-header"><div><div className="panel-title">Inference notes</div><div className="panel-subtitle">Signed telemetry provenance and uncertainty</div></div><Zap size={15} style={{ color: '#d3a652' }} /></div><div className="notes-grid">{notes.map((note, index) => <div className="note-cell" key={note}><div className="eyebrow">{index === 0 && snapshot ? 'LATEST' : 'BOUNDARY'}</div><p style={{ fontSize: 11, color: '#a2b9b5', lineHeight: 1.5, margin: '9px 0 0' }}>{note}</p></div>)}</div></div></>;
}

function Nodes({ nodes, onAdd, onRemove }: { nodes: ScanNode[]; onAdd: (name: string, address: string) => Promise<boolean>; onRemove: (id: string) => void }) {
  const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [adding, setAdding] = useState(false);
  const submit = async () => { if (name.trim() && address.trim() && await onAdd(name.trim(), address.trim())) { setName(''); setAddress(''); setAdding(false); } };
  return <><div className="page-heading"><div><div className="page-kicker">Network topology / 04</div><h1>Know your vantage points.</h1><p>Local relay nodes keep collection scoped, inspectable, and close to the operator.</p></div><button className="btn btn-primary" data-testid="button-add-node" onClick={() => setAdding(!adding)}>{adding ? <X size={14} /> : <Plus size={14} />}{adding ? 'Cancel' : 'Add node'}</button></div><div className="nodes-layout"><section className="panel"><div className="panel-header"><div><div className="panel-title">Registered nodes</div><div className="panel-subtitle">{nodes.filter(n => n.status === 'online').length} online · {nodes.length} total</div></div><Network size={16} style={{ color: '#6a8c8b' }} /></div><div className="node-grid">{nodes.length ? nodes.map(node => <div className="node-card" key={node.id} data-testid={`node-detail-${node.id}`}><div className="node-card-top"><span className="node-name">{node.name}</span><button className="icon-button" aria-label={`Remove ${node.name}`} data-testid={`button-remove-node-${node.id}`} onClick={() => onRemove(node.id)}><Trash2 size={13} /></button></div><div className="node-address">{node.address} · {node.role}</div><div className="node-meta"><span className={node.status === 'online' ? 'node-status' : 'node-status offline'}>{node.status === 'online' ? 'heartbeat nominal' : 'last heartbeat'}</span><span>{node.lastSeen}</span></div><div style={{ marginTop: 13, color: '#abc1bd', font: '10px var(--app-font-mono)' }}>{node.devices} <span style={{ color: '#667f80' }}>observations in scope</span></div></div>) : <div className="empty-state"><Network size={23} /><h3>No relay nodes registered</h3><p>Add an authorized local relay or start the scanner bridge.</p></div>}</div></section><section className="panel node-add"><div className="panel-title">Add a local relay</div><p>Register an authorized sensor adapter by its local address. Registration is stored for this operator account.</p>{adding ? <div className="form-grid"><div className="field full"><label htmlFor="node-name">Node label</label><input id="node-name" data-testid="input-node-name" value={name} onChange={e => setName(e.target.value)} placeholder="West hallway" /></div><div className="field full"><label htmlFor="node-address">Local address</label><input id="node-address" data-testid="input-node-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="10.42.0.14" /></div><div className="form-actions field full"><button className="btn" data-testid="button-cancel-node" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" data-testid="button-save-node" onClick={() => void submit()}><Check size={14} /> Register node</button></div></div> : <div className="node-hero"><div className="node-hero-title"><Antenna size={15} /> Adapter contract ready</div><p>Use the scanner bridge to send signed heartbeats and observations to this registered operator.</p></div>}</section></div></>;
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

function liveNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function liveText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function timeAgo(value: unknown) {
  if (typeof value !== 'string') return 'unknown';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

function liveDeviceFromApi(raw: Record<string, unknown>, index: number): RFDevice {
  const signal = liveNumber(raw.lastSignalDbm ?? raw.signalDbm, -92);
  const address = liveText(raw.address, `LIVE-${index + 1}`);
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload as Record<string, unknown> : {};
  const protocol = raw.protocol === 'BLE' || payload.source === 'ble_adapter' ? 'BLE' : 'WiFi';
  const distance = Math.max(0.5, Math.pow(10, (-45 - signal) / 20));
  const seenAt = liveText(raw.lastSeenAt, new Date().toISOString());
  const ageSeconds = seenAt === 'now' ? 0 : Math.max(0, Math.floor((Date.now() - new Date(seenAt).getTime()) / 1000));
  return {
    id: liveText(raw.id, `live-${address}`),
    mac: address,
    vendor: liveText(raw.vendor, 'Unknown vendor'),
    protocol,
    signal,
    maxProximity: `${distance.toFixed(1)} m`,
    status: ageSeconds < 60 ? 'active' : ageSeconds < 300 ? 'idle' : 'ghost',
    lastSeen: timeAgo(seenAt),
    firstSeen: timeAgo(liveText(raw.firstSeenAt, seenAt)),
    node: liveText(raw.nodeName, 'Authorized relay'),
    channel: liveText(raw.channel, protocol === 'BLE' ? '2.4 GHz' : 'observed'),
    encrypted: Boolean(raw.encrypted ?? true),
    favorite: Boolean(raw.favorite),
  };
}

function liveNodeFromApi(raw: Record<string, unknown>): ScanNode {
  const heartbeat = liveText(raw.lastHeartbeatAt, new Date().toISOString());
  return {
    id: liveText(raw.id, `node-${Date.now()}`),
    name: liveText(raw.name, 'Authorized relay'),
    address: liveText(raw.address, 'local'),
    status: raw.status === 'online' ? 'online' : 'offline',
    lastSeen: heartbeat === 'now' ? 'now' : 'live heartbeat',
    devices: 0,
    role: liveText(raw.role, 'Sensor relay'),
  };
}

function Home() {
  const [view, setView] = useState<NavView>('dashboard'); const [mobileOpen, setMobileOpen] = useState(false); const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<RFDevice[]>([]);
  const [nodes, setNodes] = useState<ScanNode[]>([]);
  const [hardware, setHardware] = useState<HardwareCapability[]>(initialHardware);
  const [hardwareRefreshing, setHardwareRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [liveMode, setLiveMode] = useState(false);
  const [apiConnected, setApiConnected] = useState(false);
  const [sensingSnapshot, setSensingSnapshot] = useState<SensingSnapshot | null>(null);
  const [trail, setTrail] = useState<DeviceSighting[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { signOut } = useClerk();
  const { isSignedIn } = useUser();
  useEffect(() => { void refreshHardware(); }, []);
  useEffect(() => {
    if (!isSignedIn) return;
    let disposed = false;
    const readLiveState = async () => {
      try {
        const [devicesResponse, nodesResponse] = await Promise.all([
          fetch('/api/devices', { credentials: 'include' }),
          fetch('/api/nodes', { credentials: 'include' }),
        ]);
        if (!devicesResponse.ok || !nodesResponse.ok || disposed) return;
        const devicePayload = await devicesResponse.json() as { devices?: Array<Record<string, unknown>> };
        const nodePayload = await nodesResponse.json() as { nodes?: Array<Record<string, unknown>> };
        setApiConnected(true);
        setDevices((devicePayload.devices ?? []).map((device, index) => liveDeviceFromApi(device, index)));
        setNodes((nodePayload.nodes ?? []).map((node) => liveNodeFromApi(node)));
        setLiveMode(Boolean(devicePayload.devices?.length || nodePayload.nodes?.some(node => node.status === 'online')));
        const sensingResponse = await fetch('/api/sensing/summary', { credentials: 'include' });
        if (sensingResponse.ok) {
          const sensingPayload = await sensingResponse.json() as { latest?: SensingSnapshot | null };
          setSensingSnapshot(sensingPayload.latest ?? null);
        }
      } catch {
        setApiConnected(false);
        setLiveMode(false);
      }
    };
    void readLiveState();
    void (async () => {
      try {
        const response = await fetch('/api/sessions', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'BackSpyne operator session' }) });
        if (response.ok) {
          const payload = await response.json() as { session?: { id: string } };
          if (payload.session?.id) setSessionId(payload.session.id);
        }
      } catch {
        // The session is optional for read-only operation; telemetry remains account-scoped.
      }
    })();
    const stream = new EventSource('/api/stream');
    const onTelemetry = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { nodeId?: string; observations?: Array<Record<string, unknown>> };
        if (disposed) return;
        setApiConnected(true);
        if (payload.observations?.length) setLiveMode(true);
        const telemetry = payload as { metrics?: Record<string, unknown>; observedAt?: string };
        if (telemetry.metrics && telemetry.observedAt) setSensingSnapshot({ id: `stream-${telemetry.observedAt}`, observedAt: telemetry.observedAt, metrics: telemetry.metrics });
        if (!payload.observations?.length) return;
        setDevices(current => {
          const next = [...current];
          for (const observation of payload.observations ?? []) {
            const address = typeof observation.address === 'string' ? observation.address : '';
            if (!address) continue;
            const existing = next.findIndex(device => device.mac === address);
            const live = liveDeviceFromApi({ ...observation, address, id: `${payload.nodeId ?? 'node'}-${address}` }, next.length);
            if (existing >= 0) next[existing] = { ...next[existing], ...live, favorite: next[existing].favorite };
            else next.unshift(live);
          }
          return next;
        });
      } catch {
        // Ignore malformed events; the next heartbeat or poll will recover.
      }
    };
    stream.addEventListener('telemetry', onTelemetry as EventListener);
    return () => { disposed = true; stream.close(); };
  }, [isSignedIn]);
  useEffect(() => { if (!selectedId && devices[0]) setSelectedId(devices[0].id); }, [devices, selectedId]);
  useEffect(() => {
    if (!selectedId || !apiConnected) {
      setTrail([]);
      return;
    }
    void (async () => {
      try {
        const response = await fetch(`/api/devices/${encodeURIComponent(selectedId)}/trail`, { credentials: 'include' });
        if (!response.ok) {
          setTrail([]);
          return;
        }
        const payload = await response.json() as { sightings?: DeviceSighting[] };
        setTrail(payload.sightings ?? []);
      } catch {
        setTrail([]);
      }
    })();
  }, [selectedId, apiConnected]);
  const toggleFavorite = async (id: string) => {
    const device = devices.find(item => item.id === id);
    if (!device) return;
    const nextFavorite = !device.favorite;
    const response = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: nextFavorite }) });
    if (response.ok) setDevices(current => current.map(item => item.id === id ? { ...item, favorite: nextFavorite } : item));
  };
  const addNode = async (name: string, address: string) => {
    const response = await fetch('/api/nodes', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, address, role: 'Sensor relay' }) });
    if (!response.ok) return false;
    const payload = await response.json() as { node?: Record<string, unknown> };
    if (payload.node) setNodes(current => [...current, liveNodeFromApi(payload.node!)]);
    return true;
  };
  const removeNode = async (id: string) => {
    const response = await fetch(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
    if (response.ok) setNodes(current => current.filter(node => node.id !== id));
  };
  const toggleScan = async () => {
    const nextScanning = !scanning;
    if (sessionId) {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextScanning ? 'active' : 'paused' }) });
      if (!response.ok) return;
    }
    setScanning(nextScanning);
  };
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
      if (id === 'camera-mic' && navigator.mediaDevices?.getUserMedia) {
        const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        media.getTracks().forEach(track => track.stop());
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Permission granted. BackSpyne does not retain camera or microphone data.' } : capability));
      }
      if (id === 'location' && navigator.geolocation) {
        await new Promise<void>((resolve, reject) => navigator.geolocation.getCurrentPosition(() => resolve(), reject, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 }));
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Location permission granted. Coordinates remain local to this browser session.' } : capability));
      }
    } catch {
      setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'limited', detail: 'Permission was not granted. Choose the action again to retry.' } : capability));
    }
  };
  const exportLedger = () => { const columns = ['id', 'mac', 'vendor', 'protocol', 'signal', 'maxProximity', 'status', 'lastSeen', 'firstSeen', 'node', 'channel', 'encrypted', 'favorite']; const csv = [columns.join(','), ...devices.map(device => columns.map(key => JSON.stringify(device[key as keyof RFDevice] ?? '')).join(','))].join('\n'); const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'backspyne-device-ledger.csv'; link.click(); URL.revokeObjectURL(url); };
   const onSignOut = async () => {
     if (sessionId) await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
     await signOut({ redirectUrl: basePath || '/' });
   };
   return <div className="app-shell"><Sidebar {...{ view, mobileOpen, onClose: () => setMobileOpen(false), onNavigate: setView, devices, nodes, liveMode, apiConnected }} /><div className="main-content"><Topbar view={view} scanning={scanning} onToggleScan={() => void toggleScan()} onOpenMenu={() => setMobileOpen(true)} sessionId={sessionId} onSignOut={onSignOut} /><main className="content">{view === 'dashboard' && <Dashboard {...{ devices, nodes, selectedId, scanning, onSelect: setSelectedId, onFavorite: toggleFavorite, onNavigate: setView, liveMode, apiConnected, trail }} />}{view === 'ledger' && <Ledger {...{ devices, selectedId, onSelect: setSelectedId, onFavorite: toggleFavorite, onExport: exportLedger }} />}{view === 'sensing' && <Sensing scanning={scanning} snapshot={sensingSnapshot} apiConnected={apiConnected} />}{view === 'nodes' && <Nodes {...{ nodes, onAdd: addNode, onRemove: removeNode }} />}{view === 'hardware' && <Hardware capabilities={hardware} refreshing={hardwareRefreshing} onRefresh={() => void refreshHardware()} onRequest={requestHardware} />}</main></div></div>;
}

function Landing() {
  return <div className="landing-shell"><div className="landing-grid" /><div className="landing-inner"><Brand /><div className="landing-hero"><div className="page-kicker">BackSpyne by PaperBagExpress</div><h1>Know what is nearby.<br /><span>Keep the signal local.</span></h1><p>Privacy-first RF observability for authorized environments. Connect approved sensor nodes, inspect uncertainty, and keep every observation accountable.</p><div className="landing-actions"><a className="btn btn-primary" href={`${basePath}/sign-in`}>Enter operator portal <ChevronRight size={14} /></a><a className="btn landing-secondary" href={`${basePath}/sign-up`}>Create access</a></div><div className="landing-proof"><span><ShieldCheck size={14} /> Permission-first hardware</span><span><Radio size={14} /> Local bridge ready</span><span><Github size={14} /> Open operator identity</span></div></div><div className="landing-footer"><span>Authorized environments only.</span><span>© PaperBagExpress · BackSpyne</span></div></div></div>;
}

function SignInPage() {
  return <div className="auth-shell"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

function SignUpPage() {
  return <div className="auth-shell"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) queryClient.clear();
    previousUserId.current = userId;
  }), [addListener]);
  return null;
}

function HomeRedirect() {
  return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out"><Landing /></Show></>;
}

function UserPortal() {
  return <><Show when="signed-in"><Home /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function Router() {
  return <ErrorBoundary><Switch><Route path="/" component={HomeRedirect} /><Route path="/user-portal" component={UserPortal} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your operator portal' } }, signUp: { start: { title: 'Create operator access', subtitle: 'Keep your authorized sensing sessions accountable' } } }} routerPush={to => setLocation(stripBase(to))} routerReplace={to => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><Router /></QueryClientProvider></ClerkProvider>;
}

export default function App() {
  return <TooltipProvider><WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter><Toaster /></TooltipProvider>;
}