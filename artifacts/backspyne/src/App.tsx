import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Antenna, Archive, ArrowDownToLine, BarChart3, Bluetooth,
  CameraOff, Check, CheckCircle2, ChevronRight, CircleHelp, Cpu, Download,
  Eye, FileDown, Filter, Gauge, LayoutDashboard, MapPin,
  LogOut, Menu, Mic, Minus, Network, Plus, Radio, Radar, RefreshCw, ScanLine, Search,
  Shield, ShieldCheck, Smartphone,
  Signal, Star, Trash2, Wifi, X, Zap,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from './components/error-boundary';
import { Toaster } from './components/ui/toaster';
import { TooltipProvider } from './components/ui/tooltip';
import NotFound from './pages/not-found';
import { Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

type RFDevice = {
  id: string; mac: string; vendor: string; vendorBasis: string; deviceType: string; addressType: string;
  protocol: 'WiFi' | 'BLE' | 'CSI' | 'system'; signal: number | null; signalQualityPercent: number | null;
  maxProximity: string; status: 'active' | 'idle' | 'ghost'; lastSeen: string; firstSeen: string;
  node: string; channel: string; favorite: boolean; details: Record<string, unknown>;
  lastSeenTimestamp: number | null; firstSeenTimestamp: number | null;
};
type ScanNode = { id: string; name: string; address: string; status: 'online' | 'offline'; lastSeen: string; devices: number; role: string };
type SensingMetric = { label: string; value: string; unit: string; status: string; trend: string };
type SensingSnapshot = { id: string; observedAt: string; metrics: Record<string, unknown>; confidence?: number | null; uncertainty?: Record<string, unknown> };
type DeviceSighting = { observedAt: string; signalDbm: number | null; distanceMeters: number | null };
type HardwareStatus = 'ready' | 'permission' | 'connected' | 'limited' | 'unsupported';
type ApiStatus = 'checking' | 'connected' | 'unavailable' | 'error';

function isMobileProfile() {
  return typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.matchMedia('(max-width: 700px)').matches);
}
type ApiDevice = Record<string, unknown>;
type ApiNode = Record<string, unknown>;
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
const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || '';
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL || undefined;

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
  const isMobile = isMobileProfile();
  if (isMobile) {
    const cameraMic = next.find(capability => capability.id === 'camera-mic');
    if (cameraMic) {
      cameraMic.status = 'unsupported';
      cameraMic.detail = 'Camera and microphone are not used for RF scanning.';
    }
    const usb = next.find(capability => capability.id === 'usb');
    if (usb) {
      usb.status = 'unsupported';
      usb.detail = 'Mobile USB access is not used by this browser scanning profile.';
    }
    const serial = next.find(capability => capability.id === 'serial');
    if (serial) {
      serial.status = 'unsupported';
      serial.detail = 'Mobile serial access is not used by this browser scanning profile.';
    }
  }

  if (!isMobile && mediaDevices?.enumerateDevices) {
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
  } else if (!isMobile) {
    const cameraMic = next.find(capability => capability.id === 'camera-mic');
    if (cameraMic) {
      cameraMic.status = 'unsupported';
      cameraMic.detail = 'Media device APIs are not available in this browser.';
    }
  }

  if (!isMobile && hardwareNavigator.bluetooth) {
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
  } else if (!isMobile) {
    const bluetooth = next.find(capability => capability.id === 'bluetooth');
    if (bluetooth) {
      bluetooth.status = 'unsupported';
      bluetooth.detail = 'Web Bluetooth is not available in this browser.';
    }
  }

  const motion = next.find(capability => capability.id === 'motion');
  if (motion) {
    const motionAvailable = typeof window !== 'undefined' && ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window);
    motion.status = 'unsupported';
    motion.detail = motionAvailable
      ? 'Motion sensors are available but are not used for RF scanning.'
      : 'Motion sensors are not exposed by this browser and are not used for RF scanning.';
  }

  const location = next.find(capability => capability.id === 'location');
  if (location) {
    location.status = 'unsupported';
    location.detail = 'Location is not used for RF scanning.';
  }

  const battery = next.find(capability => capability.id === 'battery');
  if (battery) {
    battery.status = 'unsupported';
    battery.detail = 'Battery state is not used for RF scanning.';
  }

  const wifi = next.find(capability => capability.id === 'wifi');
  if (wifi && hardwareNavigator.connection?.effectiveType) {
    wifi.detail = `Network link reports ${hardwareNavigator.connection.effectiveType}. Browsers do not expose nearby WiFi scan results.`;
  }
  if (wifi) wifi.status = 'limited';
  const bluetooth = next.find(capability => capability.id === 'bluetooth');
  if (isMobile && bluetooth) {
    const available = Boolean(hardwareNavigator.bluetooth?.requestDevice);
    bluetooth.status = available ? 'permission' : 'unsupported';
    bluetooth.detail = available
      ? 'This browser may let you select one BLE device with permission. BackSpyne does not passively discover nearby advertisements from the phone browser.'
      : 'This mobile browser does not expose Web Bluetooth device selection.';
    bluetooth.use = 'User-approved BLE device selection only; use the local bridge for measured scans';
  }

  if (!isMobile && hardwareNavigator.usb?.getDevices) {
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

  if (!isMobile && hardwareNavigator.serial?.getPorts) {
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
  if (protocol === 'BLE') return <Bluetooth className={className} />;
  if (protocol === 'WiFi') return <Wifi className={className} />;
  return <Radio className={className} />;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><Radar size={16} /></div><div className="brand-copy"><div className="brand-name">Back<span>Spyne</span></div><div className="brand-credit">by PaperBagExpress</div></div></div>;
}

function Sidebar({ view, onNavigate, mobileOpen, onClose, devices, nodes, liveMode, apiConnected, apiStatus }: { view: NavView; onNavigate: (view: NavView) => void; mobileOpen: boolean; onClose: () => void; devices: RFDevice[]; nodes: ScanNode[]; liveMode: boolean; apiConnected: boolean; apiStatus: ApiStatus }) {
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
        <div className="adapter-line"><span className={`pulse-dot ${liveMode ? '' : 'amber'}`} /> <span>Adapter status</span><span style={{ marginLeft: 'auto', color: liveMode ? '#79d8cf' : apiStatus === 'error' || apiStatus === 'unavailable' ? '#ef928b' : '#d6b064', fontSize: 10 }}>{liveMode ? 'LIVE' : apiStatus === 'error' ? 'DATA ERROR' : apiStatus === 'unavailable' ? 'OFFLINE' : apiConnected ? 'READY' : 'CHECKING'}</span></div>
        <p className="adapter-caption">{liveMode ? 'Signed node telemetry is connected to this operator session.' : apiStatus === 'error' ? 'The operator API could not read scan data. Check the database connection; relay state is unavailable.' : apiStatus === 'unavailable' ? 'Operator API is unavailable. Reconnect to load persisted telemetry.' : apiConnected ? 'Operator API is connected; waiting for an authorized node heartbeat.' : 'Checking operator API and authorized relay status.'}</p>
      </div>
      <div className="disclaimer"><strong>Authorized environments only.</strong><br />Collect only where you have permission. CSI research is experimental and not validated for safety, identity, or health use. See <a href="/legal">Legal & Privacy</a>.</div>
    </div>
  </aside>;
}

 function Topbar({ view, scanning, apiStatus, onOpenMenu, sessionId, onSignOut }: { view: NavView; scanning: boolean; apiStatus: ApiStatus; onOpenMenu: () => void; sessionId: string | null; onSignOut: () => Promise<void> }) {
  const { user } = useUser();
  const titles: Record<NavView, [string, string]> = { dashboard: ['Operations / overview', 'Local RF environment'], ledger: ['Operations / ledger', 'Discovered device inventory'], sensing: ['Operations / sensing', 'Measured radio adapter data'], nodes: ['Operations / nodes', 'Sensor network topology'], hardware: ['Operations / hardware', 'Device capability bridge'] };
  const operatorName = user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Operator';
  return <header className="topbar">
    <div className="topbar-context"><button className="menu-button" data-testid="button-open-menu" onClick={onOpenMenu}><Menu size={20} /></button><div className="context-line" /><div><div className="context-title">{titles[view][0]}</div><div className="context-sub">{titles[view][1]}</div></div></div>
     <div className="topbar-actions"><div className="connection"><span className="pulse-dot" /> {sessionId ? 'Session active' : 'Session not persisted'}</div><button type="button" data-testid="button-global-scan" className={`btn scan-toggle ${scanning ? 'is-scanning' : ''} ${apiStatus === 'error' || apiStatus === 'unavailable' ? 'scan-error' : ''}`} aria-live="polite" title={scanning ? 'Authorized node heartbeat received' : apiStatus === 'error' ? 'BackSpyne could not read scan state from its data service' : apiStatus === 'unavailable' ? 'The operator API is unavailable' : apiStatus === 'checking' ? 'Checking the operator API' : 'No authorized relay heartbeat has been received'}>{scanning ? <><Activity size={14} /> Relay active</> : apiStatus === 'error' ? <><CircleHelp size={14} /> Data service error</> : apiStatus === 'unavailable' ? <><Minus size={14} /> API unavailable</> : apiStatus === 'checking' ? <><RefreshCw size={14} /> Checking</> : <><Minus size={14} /> Awaiting relay</>}</button><div className="operator-menu"><div className="avatar" title={operatorName}>{operatorName.slice(0, 2).toUpperCase()}</div><button className="session-button" data-testid="button-sign-out" onClick={() => void onSignOut()}><LogOut size={13} /> Sign out</button></div></div>
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
    <div className="radar" aria-label="Schematic display of detected targets; no direction or distance is measured"><span className="radar-ring-label top">—</span><span className="radar-ring-label right">—</span><span className="radar-ring-label bottom">—</span><span className="radar-ring-label left">—</span><span className="radar-center" />
      {devices.map((device, index) => <button key={device.id} data-testid={`radar-target-${device.id}`} aria-label={`Select ${device.vendor}`} className={`target ${device.status === 'ghost' ? 'ghost' : ''} ${device.id === selectedId ? 'selected' : ''}`} style={{ left: `${positions[index % positions.length][0]}%`, top: `${positions[index % positions.length][1]}%` }} onClick={() => onSelect(device.id)}><span className="target-label">{device.id === selectedId ? 'LOCKED' : device.mac.slice(-5)}</span></button>)}
    </div>
    <div className="radar-footer"><div className="legend"><span><i />active</span><span><i className="amber" />locked</span><span><i className="gray" />ghost</span></div><span>target positions are schematic · no bearing measurement</span></div>
  </div>;
}

function DeviceDetails({ device }: { device: RFDevice }) {
  const reportedName = liveText(device.details.localName, liveText(device.details.name, ''));
  const ssid = liveText(device.details.ssid, '');
  const security = liveText(device.details.security, '');
  const manufacturerData = device.details.manufacturerData && typeof device.details.manufacturerData === 'object'
    ? Object.entries(device.details.manufacturerData as Record<string, unknown>).map(([id, value]) => `${id}: ${String(value)}`)
    : [];
  const serviceUuids = Array.isArray(device.details.serviceUuids) ? device.details.serviceUuids.filter((uuid): uuid is string => typeof uuid === 'string') : [];
  const values: Array<[string, string]> = [
    ['Device class', device.deviceType], ['Vendor evidence', device.vendorBasis], ['Address type', device.addressType],
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
    <p className="device-details-note">Vendor data is based on a globally assigned address prefix or a BLE advertiser company code. A radio name/network name is self-reported and does not establish an exact product model or a nearby person’s identity.</p>
  </section>;
}

function DeviceRows({ devices, selectedId, onSelect, onFavorite }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void; onFavorite: (id: string) => void }) {
  if (!devices.length) return <div className="empty-state"><Search size={23} /><h3>No targets in this slice</h3><p>Try a different query or include ghost targets.</p></div>;
  return <><div className="list-head"><span /><span>Target</span><span>Protocol</span><span>Signal</span><span>State</span><span /></div><div className="device-list">{devices.map(device => <div key={device.id} data-testid={`row-device-${device.id}`} className={`device-row ${device.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(device.id)}>
    <div className="device-icon"><AppIcon protocol={device.protocol} /></div><div><div className="device-name">{device.vendor}</div><div className="device-mac">{device.deviceType} · {liveText(device.details.ssid, liveText(device.details.localName, liveText(device.details.name, device.mac)))}</div></div><div><div className="device-name" style={{ fontWeight: 500 }}>{device.protocol}</div><div className="device-meta">{device.channel}</div></div><div className="signal-cell">{device.signal === null ? '—' : `${device.signal} dBm`}{device.signalQualityPercent !== null && <span> {device.signalQualityPercent}%</span>}<span className="signal-bar">{device.signal !== null && <b style={{ width: `${Math.max(8, Math.min(100, 100 - (Math.abs(device.signal) - 35) * 1.65))}%` }} />}</span></div><div className={`state ${device.status}`}>{device.status}</div><button className="icon-button" aria-label={device.favorite ? 'Remove favorite' : 'Add favorite'} data-testid={`button-favorite-${device.id}`} onClick={event => { event.stopPropagation(); onFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} /></button>
  </div>)}</div></>;
}

function NodeList({ nodes }: { nodes: ScanNode[] }) {
  return <div className="node-list">{nodes.map(node => <div className="node-card" key={node.id} data-testid={`card-node-${node.id}`}><div className="node-card-top"><span className="node-name">{node.name}</span><span className={`state ${node.status === 'online' ? 'active' : 'ghost'}`}>{node.status}</span></div><div className="node-address">{node.address} · {node.role}</div><div className="node-meta"><span>{node.devices} targets observed</span><span>{node.lastSeen}</span></div></div>)}</div>;
}

function Dashboard({ devices, nodes, selectedId, scanning, onSelect, onFavorite, onNavigate, liveMode, apiConnected, apiStatus, trail }: { devices: RFDevice[]; nodes: ScanNode[]; selectedId: string; scanning: boolean; onSelect: (id: string) => void; onFavorite: (id: string) => void; onNavigate: (view: NavView) => void; liveMode: boolean; apiConnected: boolean; apiStatus: ApiStatus; trail: DeviceSighting[] }) {
  const selected = devices.find(d => d.id === selectedId);
  const visibleDevices = devices.filter(d => d.status !== 'ghost');
  const activeNodes = nodes.filter(node => node.status === 'online').length;
  const measuredSignals = visibleDevices.flatMap(device => device.signal === null ? [] : [device.signal]);
  const signalFloor = measuredSignals.length ? String(Math.min(...measuredSignals)) : '—';
  const scanSources = [...new Set(devices.map(device => device.protocol))].join(', ') || 'No measurements';
  const historyValues = trail.length > 1 ? [...trail].reverse().flatMap(sighting => sighting.signalDbm === null ? [] : [Math.abs(sighting.signalDbm)]) : [];
  return <><div className="page-heading"><div><div className="page-kicker">RF command surface / 01</div><h1>Know what is nearby.</h1><p>Measured WiFi access points and BLE advertisements from your authorized local relay. Nearby client devices are not fully discoverable through standard OS scans.</p></div><div className="header-actions"><button className="btn" data-testid="button-refresh-dashboard" onClick={() => window.location.reload()}><RefreshCw size={14} /> Refresh view</button></div></div>
     <div className="signal-banner"><Shield /><span><strong>Authorized environment only.</strong> {liveMode ? 'Signed observations from an authorized local node are flowing into this session.' : apiStatus === 'error' ? 'The API returned an error reading scan data; the relay status cannot be confirmed. The database connection must be repaired before scans can be stored.' : apiStatus === 'unavailable' ? 'The operator API is unavailable, so relay status cannot be checked.' : nodes.length ? 'An authorized node is registered, but it has not reported an observation yet. Check its local bridge permissions and logs.' : apiConnected ? 'The operator API is connected, but no local relay is connected. Start the bridge from Hardware scan.' : 'Checking operator API and authorized relay status.'} This dashboard lists WiFi APs/BLE advertisers only, not all nearby phones or people.</span><button className="banner-action" onClick={() => onNavigate('hardware')}>Hardware scan <ChevronRight size={14} /></button></div>
     <div className="stats-grid"><MetricCard label="Nearby targets" value={String(visibleDevices.length).padStart(2, '0')} note="Current authorized scope" icon={Radio} accent /><MetricCard label="Tracked now" value={String(devices.filter(d => d.status === 'active').length).padStart(2, '0')} note={`${activeNodes} active node${activeNodes === 1 ? '' : 's'}`} icon={Eye} /><MetricCard label="Signal floor" value={signalFloor} note="Lowest observed dBm" icon={Signal} /><MetricCard label="Scan sources" value={scanSources} note="Protocols observed" icon={Shield} /></div>
    <div className="main-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Detected targets</div><div className="panel-subtitle">Schematic layout · direction and distance not measured</div></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'LIVE SWEEP' : 'SWEEP PAUSED'}</div></div><RadarView devices={devices} selectedId={selectedId} onSelect={onSelect} /></section>
       <section className="panel"><div className="panel-header"><div><div className="panel-title">Signal history</div><div className="panel-subtitle">{selected ? `${selected.vendor} · ${selected.mac}` : 'Select a target to lock tracking'}</div></div><BarChart3 size={16} style={{ color: '#6a8c8b' }} /></div><div className="history"><SignalChart values={historyValues} /><div className="history-summary"><div><div className="eyebrow">Current signal</div><div className="history-value">{selected?.signal ?? '—'}<small>{selected?.signal !== null && selected ? 'dBm' : 'NO MEASUREMENT'}</small></div></div><div style={{ textAlign: 'right' }}><div className="eyebrow">Proximity</div><div className="history-value" style={{ fontSize: 14, marginTop: 7 }}>{selected?.maxProximity ?? '—'}</div></div></div></div></section>
    </div>
    <div className="lower-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Latest discoveries</div><div className="panel-subtitle">{visibleDevices.length} visible targets · sorted by signal</div></div><button className="btn" data-testid="button-open-ledger" onClick={() => onNavigate('ledger')}>Open ledger <ArrowDownToLine size={13} /></button></div><DeviceRows devices={visibleDevices.slice(0, 4)} selectedId={selectedId} onSelect={onSelect} onFavorite={onFavorite} /></section><section className="panel"><div className="panel-header"><div><div className="panel-title">Scan nodes</div><div className="panel-subtitle">Local sensor topology</div></div><button className="icon-button" data-testid="button-open-nodes" onClick={() => onNavigate('nodes')}><ChevronRight /></button></div><NodeList nodes={nodes} /></section></div>
    {selected && <DeviceDetails device={selected} />}
  </>;
}

type DeviceSort = 'signal-strongest' | 'signal-weakest' | 'type' | 'vendor' | 'channel' | 'last-seen' | 'first-seen' | 'address';

function FilterToolbar({ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, sort, setSort, onExport }: { query: string; setQuery: (v: string) => void; protocol: string; setProtocol: (v: string) => void; showGhosts: boolean; setShowGhosts: (v: boolean) => void; sort: DeviceSort; setSort: (v: DeviceSort) => void; onExport: () => void }) {
  return <div className="toolbar"><div className="search-box"><Search /><input data-testid="input-device-search" className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search MAC, vendor, type, name…" /></div><select data-testid="select-protocol" className="select-filter" value={protocol} onChange={event => setProtocol(event.target.value)}><option value="all">All protocols</option><option value="WiFi">WiFi</option><option value="BLE">BLE</option></select><label className="sort-control"><span>Sort</span><select data-testid="select-device-sort" className="select-filter" value={sort} onChange={event => setSort(event.target.value as DeviceSort)}><option value="signal-strongest">Signal · strongest first</option><option value="signal-weakest">Signal · weakest first</option><option value="type">Device type · A–Z</option><option value="vendor">Vendor · A–Z</option><option value="channel">Channel</option><option value="last-seen">Last seen · newest</option><option value="first-seen">First seen · oldest</option><option value="address">Address · A–Z</option></select></label><button data-testid="button-toggle-ghosts" className="toggle-filter" onClick={() => setShowGhosts(!showGhosts)}><span className={`switch ${showGhosts ? 'on' : ''}`} /> include ghosts</button><button className="btn" data-testid="button-export-ledger" onClick={onExport}><Download size={13} /> Export CSV</button></div>;
}

function Ledger({ devices, selectedId, onSelect, onFavorite, onExport }: { devices: RFDevice[]; selectedId: string; onSelect: (id: string) => void; onFavorite: (id: string) => void; onExport: () => void }) {
  const [query, setQuery] = useState(''); const [protocol, setProtocol] = useState('all'); const [showGhosts, setShowGhosts] = useState(false); const [sort, setSort] = useState<DeviceSort>('signal-strongest');
  const filtered = useMemo(() => {
    const matches = devices.filter(device => (showGhosts || device.status !== 'ghost') && (protocol === 'all' || device.protocol === protocol) && [device.mac, device.vendor, device.deviceType, device.node, device.details.ssid, device.details.localName, device.details.name].join(' ').toLowerCase().includes(query.toLowerCase()));
    return matches.sort((a, b) => {
      const textCompare = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
      switch (sort) {
        case 'signal-strongest': return (b.signal ?? Number.NEGATIVE_INFINITY) - (a.signal ?? Number.NEGATIVE_INFINITY);
        case 'signal-weakest': return (a.signal ?? Number.POSITIVE_INFINITY) - (b.signal ?? Number.POSITIVE_INFINITY);
        case 'type': return textCompare(a.deviceType, b.deviceType) || textCompare(a.vendor, b.vendor);
        case 'vendor': return textCompare(a.vendor, b.vendor) || textCompare(a.deviceType, b.deviceType);
        case 'channel': return textCompare(a.channel, b.channel);
        case 'last-seen': return (b.lastSeenTimestamp ?? 0) - (a.lastSeenTimestamp ?? 0);
        case 'first-seen': return (a.firstSeenTimestamp ?? Number.POSITIVE_INFINITY) - (b.firstSeenTimestamp ?? Number.POSITIVE_INFINITY);
        case 'address': return textCompare(a.mac, b.mac);
      }
    });
  }, [devices, protocol, query, showGhosts, sort]);
  return <><div className="page-heading"><div><div className="page-kicker">Device ledger / 02</div><h1>Every signal leaves a trace.</h1><p>Search and review adapter observations. Signal strength is not a reliable distance estimate; network discovery does not reveal every client device.</p></div><div className="header-actions"><button className="btn btn-primary" data-testid="button-export-ledger-header" onClick={onExport}><FileDown size={14} /> Export ledger</button></div></div><div className="panel view-panel"><FilterToolbar {...{ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, sort, setSort, onExport }} /><div className="ledger-table-wrap">{filtered.length ? <table className="ledger-table"><thead><tr><th>Target</th><th>Vendor</th><th>Protocol</th><th>Signal</th><th>Proximity</th><th>Node</th><th>Last seen</th><th>Status</th><th /></tr></thead><tbody>{filtered.map(device => <tr key={device.id} data-testid={`ledger-row-${device.id}`} onClick={() => onSelect(device.id)}><td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><button className="icon-button" data-testid={`ledger-favorite-${device.id}`} onClick={event => { event.stopPropagation(); onFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} /></button><span className="strong">{device.mac}</span></span></td><td>{device.vendor}</td><td>{device.protocol}</td><td>{device.signal === null ? '—' : `${device.signal} dBm`}{device.signalQualityPercent !== null ? ` · ${device.signalQualityPercent}% quality` : ''}</td><td>{device.maxProximity}</td><td>{device.node}</td><td>{device.lastSeen}</td><td><span className={`state ${device.status}`}>{device.status}</span></td><td><ChevronRight size={14} /></td></tr>)}</tbody></table> : <div className="empty-state"><Filter size={23} /><h3>No matching observations</h3><p>Nothing in the ledger matches the current filters.</p></div>}</div></div>{devices.find(device => device.id === selectedId) && <DeviceDetails device={devices.find(device => device.id === selectedId)!} />}</>;
}

function sensingMetricsFromSnapshot(snapshot: SensingSnapshot | null): SensingMetric[] {
  const metrics = snapshot?.metrics ?? {};
  const number = (key: string, digits = 1) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]) ? (metrics[key] as number).toFixed(digits) : '—';
  const status = snapshot ? 'Signed node sample' : 'Awaiting telemetry';
  const csiActive = metrics.sensingMode === 'research';
  const classification = metrics.classification && typeof metrics.classification === 'object' ? metrics.classification as Record<string, unknown> : {};
  const researchVitals = metrics.researchVitalSigns && typeof metrics.researchVitalSigns === 'object' ? metrics.researchVitalSigns as Record<string, unknown> : {};
  const modelStatus = metrics.poseModelStatus && typeof metrics.poseModelStatus === 'object' ? metrics.poseModelStatus as Record<string, unknown> : {};
  const pose = Array.isArray(metrics.poseKeypoints) ? metrics.poseKeypoints : [];
  const numericVitalsAuthorized = metrics.numericVitalsAuthorized === true;
  const rawEvidence = metrics.calibratedEvidence && typeof metrics.calibratedEvidence === 'object' ? metrics.calibratedEvidence as Record<string, unknown> : null;
  const evidenceCount = rawEvidence?.person_count;
  const evidence = rawEvidence?.schema === 'backspyne.calibrated-presence-evidence.v2' && typeof evidenceCount === 'number' && Number.isInteger(evidenceCount) && evidenceCount >= 0 && evidenceCount <= 255 && typeof rawEvidence.presence === 'boolean' && rawEvidence.presence === (evidenceCount > 0) && Array.isArray(rawEvidence.source_node_ids) ? rawEvidence : null;
  const rows: SensingMetric[] = [
    { label: 'Radio signal floor', value: number('signalFloorDbm', 1), unit: 'dBm', status, trend: typeof metrics.signalFloorDbm === 'number' ? 'measured AP/BLE sample' : 'no measurement' },
    { label: 'Radio signal variance', value: number('signalVarianceDb', 2), unit: 'dB²', status, trend: typeof metrics.signalVarianceDb === 'number' ? 'measured AP/BLE sample' : 'no measurement' },
    { label: 'CSI amplitude variance', value: number('csiAmplitudeVariance', 4), unit: 'amplitude²', status, trend: csiActive ? `${String(metrics.csiSampleCount ?? 0)} live source samples` : 'compatible CSI source not connected' },
    { label: 'Observed radios', value: typeof metrics.observationCount === 'number' ? String(metrics.observationCount) : '—', unit: '/ scan', status, trend: typeof metrics.observationCount === 'number' ? 'signed WiFi/BLE observations' : 'no radio observations' },
    { label: 'CSI source', value: csiActive ? String(metrics.csiSource ?? 'live') : '—', unit: '', status, trend: csiActive ? `node ${Array.isArray(metrics.csiNodeIds) ? metrics.csiNodeIds.join(', ') || 'unknown' : 'unknown'} · ${String(metrics.csiSampleAgeMilliseconds ?? '—')} ms old` : 'awaiting compatible live CSI engine' },
    { label: 'Research classification', value: typeof classification.motion_level === 'string' ? classification.motion_level.replaceAll('_', ' ') : 'Not available', unit: '', status: csiActive ? 'Experimental' : 'No CSI inference', trend: evidence ? 'calibration evidence attached' : 'uncalibrated research output' },
    { label: 'Calibrated room state', value: evidence ? (evidence.presence === true ? 'Presence' : 'No presence') : 'Not established', unit: '', status: evidence ? 'Calibration-bound · experimental' : 'Abstaining', trend: evidence ? `experimental output · count ${String(evidence.person_count)} · model ${String(evidence.model_id ?? 'unknown')}` : 'requires fresh explicit room calibration' },
    { label: 'Research breathing rate', value: numericVitalsAuthorized && typeof researchVitals.breathing_rate_bpm === 'number' && Number.isFinite(researchVitals.breathing_rate_bpm) ? Number(researchVitals.breathing_rate_bpm).toFixed(1) : 'Not released', unit: 'BPM', status: 'Research · non-medical', trend: numericVitalsAuthorized ? 'engine publication gate confirmed' : 'not published by the engine' },
    { label: 'Research heart rate', value: numericVitalsAuthorized && typeof researchVitals.heart_rate_bpm === 'number' && Number.isFinite(researchVitals.heart_rate_bpm) ? Number(researchVitals.heart_rate_bpm).toFixed(1) : 'Not released', unit: 'BPM', status: 'Research · non-medical', trend: numericVitalsAuthorized ? 'engine publication gate confirmed' : 'not published by the engine' },
    { label: 'Pose model', value: modelStatus.loaded === true ? 'Model loaded' : 'Not available', unit: '', status: modelStatus.loaded === true ? 'Experimental model output' : 'No trained model', trend: pose.length ? `${pose.length} model keypoints` : 'no pose points published' },
  ];
  return rows;
}

function Sensing({ scanning, snapshot, apiConnected }: { scanning: boolean; snapshot: SensingSnapshot | null; apiConnected: boolean }) {
  const metrics = sensingMetricsFromSnapshot(snapshot);
  const snapshotMetrics = snapshot?.metrics ?? {};
  const csiActive = snapshotMetrics.sensingMode === 'research';
  const csiFeatures = snapshotMetrics.csiFeatures && typeof snapshotMetrics.csiFeatures === 'object' ? snapshotMetrics.csiFeatures as Record<string, unknown> : {};
  const qualityVerdict = typeof snapshotMetrics.qualityVerdict === 'string' ? snapshotMetrics.qualityVerdict : 'not provided';
  const notes = snapshot ? [
    `Last signed bridge sample: ${new Date(snapshot.observedAt).toLocaleString()}.`,
    csiActive ? `CSI source: ${String(snapshotMetrics.csiSource)} · ${String(snapshotMetrics.csiSampleAgeMilliseconds)} ms upstream age · quality ${qualityVerdict}.` : 'The current bridge cycle contains WiFi/BLE measurements only; CSI inference is not active.',
    'Research classifications and estimates are experimental signals, not proof of occupancy, identity, motion, or health; absence of a result means the system abstained.',
  ] : ['No sensing snapshot has been received.', 'Only actual adapter observations are displayed; synthetic data is not generated.', 'No image, audio, or biometric stream is used.'];
  const researchFeatures = [
    ['Mean RSSI', 'mean_rssi', 'dBm'], ['Signal variance', 'variance', ''], ['Motion-band power', 'motion_band_power', ''], ['Breathing-band power', 'breathing_band_power', ''], ['Dominant frequency', 'dominant_freq_hz', 'Hz'], ['Spectral power', 'spectral_power', ''],
  ] as const;
  const rawCalibratedEvidence = snapshotMetrics.calibratedEvidence && typeof snapshotMetrics.calibratedEvidence === 'object' ? snapshotMetrics.calibratedEvidence as Record<string, unknown> : null;
  const evidenceCount = rawCalibratedEvidence?.person_count;
  const calibratedEvidence = rawCalibratedEvidence?.schema === 'backspyne.calibrated-presence-evidence.v2' && typeof evidenceCount === 'number' && Number.isInteger(evidenceCount) && evidenceCount >= 0 && evidenceCount <= 255 && typeof rawCalibratedEvidence.presence === 'boolean' && rawCalibratedEvidence.presence === (evidenceCount > 0) && Array.isArray(rawCalibratedEvidence.source_node_ids) ? rawCalibratedEvidence : null;
  const poseKeypoints = Array.isArray(snapshotMetrics.poseKeypoints) ? snapshotMetrics.poseKeypoints : [];
  return <><div className="page-heading"><div><div className="page-kicker">WiFi sensing / 03</div><h1>Read the radio data.</h1><p>CSI-enabled research mode is available through a compatible, authenticated local sensing engine. Standard WiFi access-point/BLE scans remain descriptive measurements only.</p></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'RELAY REPORTING' : 'AWAITING MEASUREMENTS'}</div></div>
    <div className={`signal-banner ${csiActive ? 'research-banner' : ''}`}><CameraOff /><span><strong>{csiActive ? 'Experimental research output.' : 'Measurement-only mode.'}</strong> {csiActive ? 'CSI measurements and model outputs below are sourced from the authenticated live engine and are research-only. No safety, clinical, identity, or emergency interpretation.' : apiConnected ? (snapshot ? 'The latest signed local-node sample has WiFi/BLE measurements; configure compatible CSI hardware to enable WiFi sensing research.' : 'The API is connected, but no sensing sample has arrived yet.') : 'Connect to the operator API to load sensing telemetry.'} No images or audio are used.</span><CircleHelp size={14} style={{ marginLeft: 'auto' }} /></div>
    <div className="sensing-grid">{metrics.map(metric => <div className="panel sensing-card" key={metric.label} data-testid={`sensing-${metric.label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-icon"><Gauge size={17} /></div><div className="eyebrow">{metric.label}</div><div className="sensing-value">{metric.value}<span className="sensing-unit">{metric.unit}</span></div><div className="confidence"><span>{metric.status} · {metric.trend}</span></div></div>)}</div>
    {csiActive && <div className="panel research-panel"><div className="panel-header"><div><div className="panel-title">Engine measurements</div><div className="panel-subtitle">Measured features from live CSI frames · not person-level evidence</div></div><span className="hardware-status limited">RESEARCH</span></div><div className="notes-grid">{researchFeatures.map(([label, key, unit]) => <div className="note-cell" key={key}><div className="eyebrow">{label}</div><strong className="research-feature-value">{typeof csiFeatures[key] === 'number' && Number.isFinite(csiFeatures[key]) ? (csiFeatures[key] as number).toFixed(3) : '—'} <small>{unit}</small></strong></div>)}</div></div>}
    {calibratedEvidence && <div className="panel research-panel"><div className="panel-header"><div><div className="panel-title">Calibration provenance</div><div className="panel-subtitle">The engine attached a calibration-bound research result</div></div><CheckCircle2 size={16} style={{ color: '#79d8cf' }} /></div><div className="device-details-grid"><div className="device-detail"><span>Evidence schema</span><strong>{String(calibratedEvidence.schema ?? 'unknown')}</strong></div><div className="device-detail"><span>Model ID</span><strong>{String(calibratedEvidence.model_id ?? 'unknown')}</strong></div><div className="device-detail"><span>Inference method</span><strong>{String(calibratedEvidence.inference_method ?? 'unknown')}</strong></div><div className="device-detail"><span>Bound node IDs</span><strong>{Array.isArray(calibratedEvidence.source_node_ids) ? calibratedEvidence.source_node_ids.join(', ') : 'unknown'}</strong></div></div></div>}
    {poseKeypoints.length > 0 && <div className="panel research-panel"><div className="panel-header"><div><div className="panel-title">Experimental model keypoints</div><div className="panel-subtitle">Coordinates emitted by a loaded model; not a validated pose or person identity</div></div><span className="hardware-status limited">MODEL OUTPUT</span></div><div className="pose-points">{poseKeypoints.map((point, index) => <span key={index}>{Array.isArray(point) ? point.map(value => typeof value === 'number' ? value.toFixed(2) : '—').join(' · ') : 'Invalid point'}</span>)}</div></div>}
    <div className="panel" style={{ marginTop: 11 }}><div className="panel-header"><div><div className="panel-title">Provenance & limits</div><div className="panel-subtitle">Source mode, calibration state, and safe interpretation</div></div><Zap size={15} style={{ color: '#d3a652' }} /></div><div className="notes-grid">{notes.map((note, index) => <div className="note-cell" key={note}><div className="eyebrow">{index === 0 && snapshot ? 'LATEST' : 'BOUNDARY'}</div><p style={{ fontSize: 11, color: '#a2b9b5', lineHeight: 1.5, margin: '9px 0 0' }}>{note}</p></div>)}</div></div>
  </>;
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

function Hardware({ capabilities, refreshing, onRefresh, onRequest, isMobile, apiStatus }: { capabilities: HardwareCapability[]; refreshing: boolean; onRefresh: () => void; onRequest: (id: HardwareCapability['id']) => void; isMobile: boolean; apiStatus: ApiStatus }) {
  const visibleCapabilities = isMobile ? capabilities.filter(capability => ['bluetooth', 'wifi'].includes(capability.id)) : capabilities;
  const connected = visibleCapabilities.filter(capability => capability.status === 'connected' || capability.status === 'ready').length;
  const supported = visibleCapabilities.filter(capability => capability.status !== 'unsupported').length;
  const statusLabel: Record<HardwareStatus, string> = { ready: 'ready', permission: 'permission needed', connected: 'connected', limited: 'limited', unsupported: 'not exposed' };
  return <><div className={`page-heading ${isMobile ? 'mobile-scan-heading' : ''}`}><div><div className="page-kicker">{isMobile ? 'Phone radio access / 05' : 'Computer hardware bridge / 05'}</div><h1>{isMobile ? 'Scan with your phone.' : 'Scan with your computer.'}</h1><p>{isMobile ? 'This phone view reports only browser-exposed WiFi link status and optional BLE device selection. Mobile browsers cannot list nearby WiFi networks or passively scan all BLE advertisers.' : 'The browser cannot scan computer radios directly. Run the local BackSpyne bridge on this computer to scan nearby WiFi access points and BLE advertisements with OS-approved adapters.'}</p></div><button className="btn btn-primary" data-testid="button-scan-hardware" onClick={onRefresh}>{refreshing ? <><RefreshCw className="spin" size={14} /> Checking radios</> : <><ScanLine size={14} /> Check this device</>}</button></div>
    <div className={`scan-status-banner ${apiStatus}`} role="status"><ShieldCheck /><span><strong>{apiStatus === 'error' ? 'Data service error.' : apiStatus === 'unavailable' ? 'Operator API unavailable.' : apiStatus === 'checking' ? 'Checking connection.' : 'Scan status.'}</strong> {apiStatus === 'error' ? 'The API returned an error while reading devices or relay nodes. Scans cannot be saved until the database connection is repaired.' : apiStatus === 'unavailable' ? 'Cannot connect to the operator API. Check the server and your connection before starting a relay.' : apiStatus === 'checking' ? 'Waiting for the operator API to report its status.' : 'A scan runs only when a local authorized scanner or supported radio action is actively reporting. No sample readings are generated.'}</span></div>
    <div className="signal-banner"><ShieldCheck /><span><strong>{isMobile ? 'Phone-only radio access.' : 'Computer-local radio scan.'}</strong> {isMobile ? 'No camera, microphone, location, motion sensor, or background activity is used for RF scanning.' : 'The local bridge uses the computer’s WiFi and Bluetooth hardware. Grant any OS permission prompts on that computer.'}</span><span className="hardware-count">{connected}/{supported} usable</span></div>
    <div className="stats-grid hardware-stats"><MetricCard label="Usable radios" value={String(connected).padStart(2, '0')} note="Available to this browser" icon={Cpu} /><MetricCard label="Permission gates" value={String(visibleCapabilities.filter(capability => capability.status === 'permission').length).padStart(2, '0')} note="Operator decision required" icon={Shield} /><MetricCard label="RF scan path" value={isMobile ? 'PHONE' : 'LOCAL'} note={isMobile ? 'Browser-exposed phone features only' : 'Computer OS bridge required'} icon={Radio} /><MetricCard label="Relay" value={apiStatus === 'connected' ? 'API OK' : 'BLOCKED'} note={apiStatus === 'connected' ? 'Waiting for scanner heartbeat' : 'Data service not ready'} icon={Smartphone} /></div>
    <div className="panel hardware-panel"><div className="panel-header"><div><div className="panel-title">Detected capability surface</div><div className="panel-subtitle">Results come from this device and this browser session</div></div><div className="status-pill"><span className="pulse-dot" /> DEVICE-AWARE</div></div><div className="capability-grid">{visibleCapabilities.map(capability => <div className={`capability-card ${capability.status}`} key={capability.id} data-testid={`hardware-${capability.id}`}><div className="capability-top"><div className="capability-icon"><CapabilityIcon id={capability.id} /></div><span className={`hardware-status ${capability.status}`}>{statusLabel[capability.status]}</span></div><div className="capability-label">{capability.label}</div><p>{capability.detail}</p><div className="capability-use"><span className="eyebrow">BackSpyne use</span><span>{capability.use}</span></div>{capability.action && <button className="btn capability-action" data-testid={`button-connect-${capability.action}`} onClick={() => onRequest(capability.id)}>{capability.status === 'connected' ? <><CheckCircle2 size={13} /> Connected</> : <><Plus size={13} /> Choose approved device</>}</button>}</div>)}</div></div>
    {!isMobile && <div className="panel desktop-bridge-guide"><div className="panel-header"><div><div className="panel-title">Start scanning with this computer</div><div className="panel-subtitle">The bridge reads real OS WiFi and Bluetooth adapters</div></div><Cpu size={16} style={{ color: '#6a8c8b' }} /></div><div className="bridge-guide-body"><ol><li>On the computer, open the BackSpyne project and go to its <strong>scanner</strong> folder.</li><li>Copy <code>.env.example</code> to <code>.env</code>. Set the operator ID and node token to match the server secrets; never share or commit them.</li><li>Run <code>start.ps1</code> on Windows, <code>start.sh</code> on macOS/Linux, or <code>start.bat</code> on Windows Command Prompt.</li><li>Keep the bridge running. The page will switch to <strong>Relay active</strong> after a signed heartbeat reaches the server.</li></ol><p>WiFi and BLE scans use OS permissions and adapters on that computer. A browser tab cannot start local programs by itself. If the API/data service is reporting an error above, scans cannot be saved until the server database is repaired.</p></div></div>}
    <div className="panel hardware-note"><div className="panel-header"><div><div className="panel-title">{isMobile ? 'What your phone can scan' : 'What the local bridge can scan'}</div><div className="panel-subtitle">Real device and operating-system limits</div></div><Wifi size={16} style={{ color: '#6a8c8b' }} /></div><div className="hardware-note-body"><div><p>{isMobile ? 'Mobile browsers do not expose nearby WiFi access-point lists. Motion, location, battery, camera, and microphone are not RF scanning. Some Android browsers offer user-selected BLE device connections, but not passive discovery of every advertiser; iOS browsers may not expose Web Bluetooth. A dedicated native app or local scanner hardware is needed for broader scans.' : 'The local Python scanner uses OS-approved WiFi scan APIs and BLE adapter scans on this computer. It reports access points and visible BLE advertisements only—not every nearby phone or client. CSI requires separately configured compatible hardware. A browser cannot start the scanner process itself.'}</p>{isMobile && <p className="phone-scan-note">This phone view intentionally offers only WiFi status and browser-exposed Bluetooth access. It does not request camera, microphone, location, motion, USB, or serial permissions.</p>}</div></div></div>
  </>;
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

function liveDeviceFromApi(raw: ApiDevice): RFDevice | null {
  const address = liveText(raw.address, '');
  if (!address) return null;
  const signalValue = raw.lastSignalDbm ?? raw.signalDbm;
  const signal = typeof signalValue === 'number' && Number.isFinite(signalValue) ? signalValue : null;
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {};
  const sightingMetadata = raw.sightingMetadata && typeof raw.sightingMetadata === 'object' ? raw.sightingMetadata as Record<string, unknown> : {};
  const storedQuality = sightingMetadata.signalQualityPercent ?? metadata.signalQualityPercent;
  const quality = typeof storedQuality === 'number' && Number.isFinite(storedQuality) ? storedQuality : null;
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload as Record<string, unknown> :
    metadata.payload && typeof metadata.payload === 'object' ? metadata.payload as Record<string, unknown> : {};
  const protocol = raw.protocol === 'BLE' || payload.source === 'ble_adapter' ? 'BLE' : raw.protocol === 'WiFi' || payload.source === 'wifi_os_api' ? 'WiFi' : 'system';
  const addressType = liveText(payload.addressType, (() => {
    const firstOctet = Number.parseInt(address.split(/[:-]/)[0] || '', 16);
    return Number.isFinite(firstOctet) ? firstOctet & 0x02 ? 'private/randomized address' : firstOctet & 0x01 ? 'multicast address' : 'globally administered address' : 'unknown address type';
  })());
  const observedVendor = liveText(raw.vendor, 'Unknown vendor');
  const advertisedManufacturer = liveText(payload.advertisedManufacturer, '');
  const vendor = observedVendor !== 'Unknown vendor' ? observedVendor : advertisedManufacturer || observedVendor;
  const vendorBasis = observedVendor !== 'Unknown vendor' ? 'Hardware address prefix (local OUI match)' : advertisedManufacturer ? 'BLE manufacturer-specific data (company code)' : addressType === 'private/randomized address' ? 'Unavailable: address is randomized' : 'No manufacturer evidence reported';
  const deviceType = protocol === 'WiFi' ? 'Wi-Fi access point' : protocol === 'BLE' ? 'Bluetooth LE advertiser' : 'Radio observation';
  const seenAt = liveText(raw.lastSeenAt, '');
  const parsedAt = seenAt ? new Date(seenAt).getTime() : Number.NaN;
  const ageSeconds = Number.isFinite(parsedAt) ? Math.max(0, Math.floor((Date.now() - parsedAt) / 1000)) : Number.POSITIVE_INFINITY;
  const staleLimit = 5 * 60;
  return {
    id: liveText(raw.id, `live-${address}`),
    mac: address,
    vendor,
    vendorBasis,
    deviceType,
    addressType,
    protocol,
    details: { ...payload, serviceUuids: raw.serviceUuids ?? metadata.serviceUuids ?? [] },
    signal,
    signalQualityPercent: quality,
    maxProximity: 'Not measured',
    status: ageSeconds <= 60 ? 'active' : ageSeconds <= staleLimit ? 'idle' : 'ghost',
    lastSeen: timeAgo(seenAt),
    firstSeen: timeAgo(liveText(raw.firstSeenAt, '')),
    lastSeenTimestamp: Number.isFinite(parsedAt) ? parsedAt : null,
    firstSeenTimestamp: typeof raw.firstSeenAt === 'string' && Number.isFinite(new Date(raw.firstSeenAt).getTime()) ? new Date(raw.firstSeenAt).getTime() : null,
    node: liveText(raw.nodeName, liveText(raw.node, 'Authorized relay')),
    channel: liveText(raw.channel, liveText(payload.channel, 'not reported')),
    favorite: Boolean(raw.favorite),
  };
}

function liveNodeFromApi(raw: ApiNode): ScanNode {
  const heartbeat = liveText(raw.lastHeartbeatAt, '');
  return {
    id: liveText(raw.id, 'unknown-node'),
    name: liveText(raw.name, 'Authorized relay'),
    address: liveText(raw.address, 'local'),
    status: raw.status === 'online' ? 'online' : 'offline',
    lastSeen: timeAgo(heartbeat),
    devices: typeof raw.deviceCount === 'number' ? raw.deviceCount : 0,
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
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');
  const [isMobile, setIsMobile] = useState(isMobileProfile);
  const [sensingSnapshot, setSensingSnapshot] = useState<SensingSnapshot | null>(null);
  const [trail, setTrail] = useState<DeviceSighting[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { signOut } = useClerk();
  const { isSignedIn } = useUser();
  useEffect(() => { void refreshHardware(); }, []);
  useEffect(() => {
    const updateDeviceProfile = () => setIsMobile(isMobileProfile());
    window.addEventListener('resize', updateDeviceProfile);
    return () => window.removeEventListener('resize', updateDeviceProfile);
  }, []);
  useEffect(() => {
    if (!isSignedIn) return;
    let disposed = false;
    const readLiveState = async () => {
      try {
        const [devicesResponse, nodesResponse] = await Promise.all([
          fetch('/api/devices', { credentials: 'include' }),
          fetch('/api/nodes', { credentials: 'include' }),
        ]);
        if (devicesResponse.status === 401 || nodesResponse.status === 401 || devicesResponse.status === 503 || nodesResponse.status === 503) {
          setApiStatus('unavailable');
          setApiConnected(false);
          setLiveMode(false);
          setScanning(false);
          setDevices([]);
          setNodes([]);
          return;
        }
        if (!devicesResponse.ok || !nodesResponse.ok || disposed) {
          setApiStatus('error');
          throw new Error(`BackSpyne data request failed (${devicesResponse.status}/${nodesResponse.status})`);
        }
        const devicePayload = await devicesResponse.json() as { devices?: Array<Record<string, unknown>> };
        const nodePayload = await nodesResponse.json() as { nodes?: Array<Record<string, unknown>> };
        setApiStatus('connected');
        setApiConnected(true);
        setDevices((devicePayload.devices ?? []).map(liveDeviceFromApi).filter((device): device is RFDevice => device !== null));
        setNodes((nodePayload.nodes ?? []).map(liveNodeFromApi));
        const relayActive = Boolean(nodePayload.nodes?.some(node => node.status === 'online'));
        setScanning(relayActive);
        setLiveMode(relayActive);
        const sensingResponse = await fetch('/api/sensing/summary', { credentials: 'include' });
        if (sensingResponse.ok) {
          const sensingPayload = await sensingResponse.json() as { latest?: SensingSnapshot | null };
          setSensingSnapshot(sensingPayload.latest ?? null);
        }
      } catch {
        setApiStatus(current => current === 'unavailable' ? current : 'error');
        setApiConnected(false);
        setLiveMode(false);
        setScanning(false);
      }
    };
    void readLiveState();
    const pollTimer = window.setInterval(() => { void readLiveState(); }, 15_000);
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
    const stream = new EventSource('/api/stream', { withCredentials: true });
    const onTelemetry = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { nodeId?: string; observations?: Array<Record<string, unknown>> };
        if (disposed) return;
        setApiStatus('connected');
        setApiConnected(true);
        setScanning(true);
        setLiveMode(true);
        const telemetry = payload as { metrics?: Record<string, unknown>; observedAt?: string };
        if (telemetry.metrics && typeof telemetry.observedAt === 'string') {
          const observedAt = new Date(telemetry.observedAt);
          if (Number.isFinite(observedAt.getTime())) {
            setSensingSnapshot({ id: `stream-${telemetry.observedAt}`, observedAt: telemetry.observedAt, metrics: telemetry.metrics });
          }
        }
        if (!payload.observations?.length) return;
        setDevices(current => {
          const next = [...current];
          for (const observation of payload.observations ?? []) {
            const address = typeof observation.address === 'string' ? observation.address : '';
            if (!address) continue;
            const existing = next.findIndex(device => device.mac === address);
            const live = liveDeviceFromApi({ ...observation, address, id: `${payload.nodeId ?? 'node'}-${address}` });
            if (!live) continue;
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
    return () => { disposed = true; window.clearInterval(pollTimer); stream.close(); };
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
  const refreshHardware = async () => { setHardwareRefreshing(true); try { setHardware(await scanHardwareCapabilities()); } finally { setHardwareRefreshing(false); } };
  const requestHardware = async (id: HardwareCapability['id']) => {
    const hardwareNavigator = navigator as HardwareNavigator;
    const setCapability = (status: HardwareStatus, detail: string) => setHardware(current => current.map(capability => capability.id === id ? { ...capability, status, detail } : capability));
    try {
      if (id === 'bluetooth' && hardwareNavigator.bluetooth?.requestDevice) {
        const device = await hardwareNavigator.bluetooth.requestDevice({ acceptAllDevices: true });
        setCapability('permission', `${device.name ?? 'BLE peripheral'} selected and approved. Selection alone does not connect to it or scan advertisements; use a scanner bridge for measured observations.`);
      }
      if (id === 'usb' && hardwareNavigator.usb?.requestDevice) {
        await hardwareNavigator.usb.requestDevice({ filters: [] });
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Approved USB device selected. Connect it to a local sensor bridge to stream observations.' } : capability));
      }
      if (id === 'serial' && hardwareNavigator.serial?.requestPort) {
        await hardwareNavigator.serial.requestPort({ filters: [] });
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Approved serial port selected. A local Python bridge can stream observations through it.' } : capability));
      }
      if (id === 'bluetooth' && !hardwareNavigator.bluetooth?.requestDevice) setCapability('unsupported', 'This browser or mobile operating system does not expose Bluetooth device selection.');
      if (id === 'usb' && !hardwareNavigator.usb?.requestDevice) setCapability('unsupported', 'This browser or device does not expose USB device selection.');
      if (id === 'serial' && !hardwareNavigator.serial?.requestPort) setCapability('unsupported', 'This browser or device does not expose serial port selection.');
      if (id === 'camera-mic' && navigator.mediaDevices?.getUserMedia) {
        const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        media.getTracks().forEach(track => track.stop());
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Permission granted. BackSpyne does not retain camera or microphone data.' } : capability));
      }
      if (id === 'location' && navigator.geolocation) {
        await new Promise<void>((resolve, reject) => navigator.geolocation.getCurrentPosition(() => resolve(), reject, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 }));
        setHardware(current => current.map(capability => capability.id === id ? { ...capability, status: 'connected', detail: 'Location permission granted. Coordinates remain local to this browser session.' } : capability));
      }
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
      setCapability('limited', cancelled ? 'No device was selected. No scan was started.' : 'Permission was denied or the device is unavailable. Check OS/browser permissions and try again.');
    }
  };
  const exportLedger = () => {
    const columns = ['id', 'mac', 'vendor', 'vendorBasis', 'deviceType', 'addressType', 'protocol', 'signalDbm', 'signalQualityPercent', 'proximity', 'status', 'lastSeen', 'firstSeen', 'node', 'channel', 'favorite'];
    const csv = [columns.join(','), ...devices.map(device => columns.map(key => JSON.stringify(({ signalDbm: device.signal, proximity: device.maxProximity } as Record<string, unknown>)[key] ?? device[key as keyof RFDevice] ?? '')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'backspyne-device-ledger.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
   const onSignOut = async () => {
     if (sessionId) await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
     await signOut({ redirectUrl: basePath || '/' });
   };    return <div className={`app-shell ${isMobile ? 'mobile-device' : 'desktop-device'}`}><Sidebar {...{ view, mobileOpen, onClose: () => setMobileOpen(false), onNavigate: setView, devices, nodes, liveMode, apiConnected, apiStatus }} /><div className="main-content"><Topbar view={view} scanning={scanning} apiStatus={apiStatus} onOpenMenu={() => setMobileOpen(true)} sessionId={sessionId} onSignOut={onSignOut} /><main className="content">{view === 'dashboard' && <Dashboard {...{ devices, nodes, selectedId, scanning, onSelect: setSelectedId, onFavorite: toggleFavorite, onNavigate: setView, liveMode, apiConnected, apiStatus, trail }} />}{view === 'ledger' && <Ledger {...{ devices, selectedId, onSelect: setSelectedId, onFavorite: toggleFavorite, onExport: exportLedger }} />}{view === 'sensing' && <Sensing scanning={scanning} snapshot={sensingSnapshot} apiConnected={apiConnected} />}{view === 'nodes' && <Nodes {...{ nodes, onAdd: addNode, onRemove: removeNode }} />}{view === 'hardware' && <Hardware capabilities={hardware} refreshing={hardwareRefreshing} onRefresh={() => void refreshHardware()} onRequest={requestHardware} isMobile={isMobile} apiStatus={apiStatus} />}</main></div></div>;
}

function Landing() {
  return <div className="landing-shell"><div className="landing-grid" /><div className="landing-inner"><Brand /><div className="landing-hero"><div className="page-kicker">BackSpyne by PaperBagExpress</div><h1>Know what is nearby.<br /><span>Keep the signal local.</span></h1><p>Privacy-first RF observability for authorized environments. Connect approved sensor nodes, inspect measurements, and keep every observation accountable.</p><div className="landing-actions"><a className="btn btn-primary" href={`${basePath}/sign-in`}>Enter operator portal <ChevronRight size={14} /></a><a className="btn landing-secondary" href={`${basePath}/sign-up`}>Create access</a></div><div className="landing-proof"><span><ShieldCheck size={14} /> Permission-first hardware</span><span><Radio size={14} /> Local bridge ready</span><span><ShieldCheck size={14} /> Operator-controlled access</span></div></div><div className="landing-footer"><span>Authorized environments only.</span><span>© PaperBagExpress · BackSpyne</span><a href="/legal" className="legal-link">Legal & Privacy</a></div></div></div>;
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

function LegalPage() {
  return <main className="legal-page">
    <a href="/" className="legal-back">← BackSpyne home</a>
    <h1>Legal, privacy & acceptable use</h1>
    <p><strong>Important:</strong> This is general information, not legal advice or a substitute for jurisdiction-specific terms, privacy notices, or counsel review. It cannot guarantee protection from liability. Replace all bracketed items and have qualified counsel review before public operation.</p>
    <h2>Authorized use only</h2>
    <p>Use this software only on networks, radio equipment, locations, and data for which you have documented authority and any required consent. You are responsible for complying with wiretap, computer access, radio, privacy, consumer-protection, workplace-monitoring, and data-protection laws. No use to stalk, identify, track, surveil, or harm people; bypass device/network access controls; intercept communications; or conduct covert monitoring.</p>
    <h2>What the scanner can and cannot do</h2>
    <p>Standard operating-system APIs report nearby WiFi access points and BLE advertisements that are visible to the adapter. They do not enumerate every nearby WiFi client or Bluetooth device; identifiers may be randomized or absent. RSSI is noisy and does not establish distance, direction, identity, person presence, occupancy, movement, or health. Optional CSI research mode requires separate compatible hardware, an authenticated live sensing engine, and any required room calibration. Its outputs are experimental, not independently validated by this console, may be absent when the engine abstains, and are not for safety-critical, medical, identity, or emergency use. No named-person identification is supported.</p>
    <h2>Data and privacy</h2>
    <p>When configured, the local bridge sends WiFi/BLE observation identifiers and radio metadata, node identifiers, timestamps, and measured aggregates to the configured API. The server stores account-scoped telemetry in its configured database and streams it to signed-in users. Do not scan or transmit personal data unless you have a lawful basis and any required notice/consent. The operator must document purposes, legal basis, retention/deletion schedule, processors, contact details, rights-request process, and security practices before deployment. Authentication, hosting, and database providers may process account/network metadata under their own terms.</p>
    <h2>Security and availability</h2>
    <p>Use HTTPS and strong, unique server-side credentials. Never place server secrets in frontend variables or commit them. The local node token is a shared credential and must be rotated if exposed. The software is provided as-is; measurements, access, persistence, alerts, and service availability are not guaranteed. It is not for emergency response, safety-critical, medical, law-enforcement, or evidentiary use.</p>
    <h2>Operator contact and policy links</h2>
    <p>Operator/business name: [operator must supply]. Contact: [operator must supply]. Effective date: [operator must supply]. Replace these placeholders with actual policy URLs and business/contact details before public use. Do not collect telemetry until retention and deletion policies are published and configured.</p>
  </main>;
}

function AuthNotConfigured() {
  return <main className="legal-page">
    <a href="/" className="legal-back">← BackSpyne home</a>
    <h1>Operator sign-in is not configured</h1>
    <p>This deployment does not have authentication credentials set. No account data is being collected, stored, or transmitted. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> (build) and <code>CLERK_SECRET_KEY</code> / <code>CLERK_PUBLISHABLE_KEY</code> (server) to enable the operator portal.</p>
    <p><a href="/legal" className="legal-link">Read the legal, privacy &amp; acceptable-use notice</a></p>
  </main>;
}

function Router() {
  return <ErrorBoundary><Switch><Route path="/legal" component={LegalPage} /><Route path="/" component={clerkPubKey ? HomeRedirect : Landing} /><Route path="/user-portal" component={clerkPubKey ? UserPortal : AuthNotConfigured} /><Route path="/sign-in/*?" component={clerkPubKey ? SignInPage : AuthNotConfigured} /><Route path="/sign-up/*?" component={clerkPubKey ? SignUpPage : AuthNotConfigured} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
  const content = <QueryClientProvider client={queryClient}><Router /></QueryClientProvider>;
  if (!clerkPubKey) return content;
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your operator portal' } }, signUp: { start: { title: 'Create operator access', subtitle: 'Keep your authorized sensing sessions accountable' } } }} routerPush={to => setLocation(stripBase(to))} routerReplace={to => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><Router /></QueryClientProvider></ClerkProvider>;
}

export default function App() {
  return <TooltipProvider><WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter><Toaster /></TooltipProvider>;
}