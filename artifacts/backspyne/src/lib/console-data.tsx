// The console's data layer: one owner for everything the views read.
//
// Every view used to receive this state through a chain of props from a single shell
// component, which meant the shell had to know each view's needs and a view could not be read
// on its own. The provider now owns the state and the requests; a view asks for what it
// renders with `useConsoleData()` and nothing else has to know.
//
// Two rules hold here:
//  - The console never invents a measurement. A failed or unavailable API empties the view
//    and says so; it does not fall back to sample data.
//  - The shared assessment model is built once, from the same devices the ledger lists, so
//    the screen and the printable client report cannot disagree.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useClerk, useUser } from '@clerk/react';
import { buildAssessment } from '@workspace/assessment';

import { basePath } from './env';
import { initialHardware, requestHardwareAccess, scanHardwareCapabilities } from './hardware';
import { isMobileProfile } from './format';
import { assessmentDeviceFrom, liveDeviceFromApi, liveNodeFromApi } from './observations';
import type {
  ApiStatus, ConsoleData, DeviceSighting, HardwareCapability, RFDevice, ScanNode, SensingSnapshot,
} from './types';

const ConsoleDataContext = createContext<ConsoleData | null>(null);

/** How often the console re-reads stored observations while a session is open. */
const POLL_INTERVAL_MS = 15_000;

const LEDGER_COLUMNS = [
  'id', 'mac', 'vendor', 'vendorBasis', 'deviceType', 'addressType', 'protocol',
  'signalDbm', 'signalQualityPercent', 'proximity', 'status', 'lastSeen', 'firstSeen', 'node', 'channel', 'favorite',
];

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const { signOut: clerkSignOut } = useClerk();
  const { isSignedIn, user } = useUser();

  const operatorName = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Operator';
  // One owner of the analysis: the console and the printable client report read the same model.
  const assessment = useMemo(() => buildAssessment({ devices: devices.map(assessmentDeviceFrom), now: Date.now() }), [devices]);
  const siteLabel = nodes[0]?.name || 'Unnamed site';

  const refreshHardware = useCallback(async () => {
    setHardwareRefreshing(true);
    try {
      setHardware(await scanHardwareCapabilities());
    } finally {
      setHardwareRefreshing(false);
    }
  }, []);

  const requestHardware = useCallback(async (id: HardwareCapability['id']) => {
    const decision = await requestHardwareAccess(id);
    setHardware(current => current.map(capability => capability.id === id ? { ...capability, ...decision } : capability));
  }, []);

  useEffect(() => { void refreshHardware(); }, [refreshHardware]);

  useEffect(() => {
    const updateDeviceProfile = () => setIsMobile(isMobileProfile());
    window.addEventListener('resize', updateDeviceProfile);
    return () => window.removeEventListener('resize', updateDeviceProfile);
  }, []);

  // Polled state is the console's spine: relays, observed devices, and the sensing summary.
  // A signed live stream overlays it when the relay is actually reporting.
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
      }
    };
    void readLiveState();
    const pollTimer = window.setInterval(() => { void readLiveState(); }, POLL_INTERVAL_MS);
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

  const select = useCallback((id: string) => setSelectedId(id), []);

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

  const toggleFavorite = useCallback(async (id: string) => {
    const device = devices.find(item => item.id === id);
    if (!device) return;
    const nextFavorite = !device.favorite;
    const response = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: nextFavorite }) });
    if (response.ok) setDevices(current => current.map(item => item.id === id ? { ...item, favorite: nextFavorite } : item));
  }, [devices]);

  const addNode = useCallback(async (name: string, address: string) => {
    const response = await fetch('/api/nodes', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, address, role: 'Sensor relay' }) });
    if (!response.ok) return false;
    const payload = await response.json() as { node?: Record<string, unknown> };
    if (payload.node) setNodes(current => [...current, liveNodeFromApi(payload.node!)]);
    return true;
  }, []);

  const removeNode = useCallback(async (id: string) => {
    const response = await fetch(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
    if (response.ok) setNodes(current => current.filter(node => node.id !== id));
  }, []);

  /** Saves the ledger the operator is looking at. Local to the browser: nothing is uploaded. */
  const exportLedger = useCallback(() => {
    const csv = [LEDGER_COLUMNS.join(','), ...devices.map(device => LEDGER_COLUMNS.map(key => JSON.stringify(({ signalDbm: device.signal, proximity: device.maxProximity } as Record<string, unknown>)[key] ?? device[key as keyof RFDevice] ?? '')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'backspyne-device-ledger.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [devices]);

  const signOut = useCallback(async () => {
    if (sessionId) await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
    await clerkSignOut({ redirectUrl: basePath || '/' });
  }, [sessionId, clerkSignOut]);

  const value = useMemo<ConsoleData>(() => ({
    devices,
    nodes,
    assessment,
    trail,
    sensingSnapshot,
    selectedId,
    select,
    toggleFavorite,
    addNode,
    removeNode,
    hardware,
    hardwareRefreshing,
    refreshHardware,
    requestHardware,
    exportLedger,
    scanning: liveMode,
    liveMode,
    apiConnected,
    apiStatus,
    operatorName,
    siteLabel,
    sessionId,
    isMobile,
    mobileOpen,
    setMobileOpen,
    signOut,
  }), [
    devices, nodes, assessment, trail, sensingSnapshot, selectedId, select, toggleFavorite, addNode,
    removeNode, hardware, hardwareRefreshing, refreshHardware, requestHardware, exportLedger, liveMode,
    apiConnected, apiStatus, operatorName, siteLabel, sessionId, isMobile, mobileOpen, signOut,
  ]);

  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  const value = useContext(ConsoleDataContext);
  if (!value) throw new Error('useConsoleData must be used inside ConsoleDataProvider');
  return value;
}

