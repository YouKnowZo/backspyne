// The console's vocabulary.
//
// One module owns the shapes that cross a boundary — API payloads, mapped devices, relay
// tokens, plan entitlements — so a view, a mapper, and the data provider cannot drift into
// three spellings of the same record. Only types live here: no runtime code, no imports.

import type { Assessment } from '@workspace/assessment';

export type RFDevice = {
  id: string; mac: string; vendor: string; vendorBasis: string; deviceType: string; addressType: string;
  vendorCategory?: string | null; vendorOui?: string | null; evidenceQuality?: number | null; addressMasked: boolean;
  protocol: 'WiFi' | 'BLE' | 'CSI' | 'system'; signal: number | null; signalQualityPercent: number | null;
  /**
   * Where the level came from. `adapter dBm` is a measurement; `link-quality percentage` is
   * the driver's 0-100 scale mapped to dBm, which Windows WiFi and NetworkManager report
   * instead of power. A derived level is a real input to the position model and is labelled
   * wherever it is shown, so it is never read as something the adapter measured.
   */
  signalSource: LevelSource | null;
  signalDerived: boolean;
  maxProximity: string; status: 'active' | 'idle' | 'ghost'; lastSeen: string; firstSeen: string;
  node: string; channel: string; favorite: boolean; details: Record<string, unknown>;
  lastSeenTimestamp: number | null; firstSeenTimestamp: number | null;
};

/** The two vocabularies an adapter's level can arrive in. Mirrors the API's `lib/signal.ts`. */
export type LevelSource = 'adapter dBm' | 'link-quality percentage';

export type ScanNode = {
  id: string; name: string; address: string; status: 'online' | 'offline';
  lastSeen: string; lastSeenTimestamp: number | null; devices: number; role: string;
  /**
   * Operator-entered placement in the site frame: metres east and north of the origin the
   * operator chose. Null means "not placed", which the console must never read as 0,0.
   */
  positionX: number | null; positionY: number | null; positionLabel: string | null;
};

/** Where a radio was heard from, how far each relay's level implies it is, and how sure. */
export type DeviceLocationRelay = {
  nodeId: string; name: string; placed: boolean; x: number | null; y: number | null;
  signalDbm: number | null; samples: number; lastObservedAt: string; impliedDistanceMeters: number | null;
};

export type DevicePositionEstimate = {
  status: 'estimated' | 'ambiguous' | 'single_relay' | 'no_signal';
  x: number | null; y: number | null; uncertaintyMeters: number | null;
  method: string; relays: number; note: string;
  candidates: Array<{ x: number; y: number }>;
  ring: { nodeId: string; nodeName: string; x: number; y: number; distanceMeters: number } | null;
  residuals: Array<{ nodeId: string; nodeName: string; reportedDbm: number; impliedMeters: number; modelledMeters: number; residualMeters: number }>;
};

export type DeviceTrackPoint = { at: string; x: number; y: number; uncertaintyMeters: number; relays: number };

/**
 * The modelled position of one stored radio. Every part is optional because the server can
 * answer `available: false` — placement unavailable on the deployment — and the console then
 * states that instead of drawing an empty map.
 */
export type DeviceLocation = {
  available: boolean;
  reason?: string;
  /**
   * How many distinct places the radio was heard from. A relay that reported where it stood
   * — a phone that was walked around — contributes one vantage point per place, which is
   * what a position needs; `fromPhone` counts the ones recorded while moving.
   */
  vantages?: { used: number; fromPhone: number };
  device: { id: string; address: string; vendor?: string; protocol?: string; lastSignalDbm?: number | null; lastSeenAt?: string };
  model?: { referenceDbm: number; pathLossExponent: number; referenceMeters: number; windowMinutes: number; bucketSeconds: number };
  placement?: { heard: number; placed: number };
  relays?: DeviceLocationRelay[];
  estimate?: DevicePositionEstimate;
  track?: DeviceTrackPoint[];
};

export type SensingMetric = { label: string; value: string; unit: string; status: string; trend: string };

export type SensingSnapshot = {
  id: string; observedAt: string; metrics: Record<string, unknown>;
  confidence?: number | null; uncertainty?: Record<string, unknown>;
};

export type DeviceSighting = { observedAt: string; signalDbm: number | null; distanceMeters: number | null };

export type HardwareStatus = 'ready' | 'permission' | 'connected' | 'limited' | 'unsupported';

/** The outcome of one explicit scan of this device, so the action is never silent. */
export type HardwareScanResult = { checkedAt: number; probes: number; changes: string[] };

export type HardwareCapability = {
  id: string;
  label: string;
  status: HardwareStatus;
  detail: string;
  use: string;
  action?: 'bluetooth' | 'usb' | 'serial' | 'camera-mic' | 'location';
};

export type ApiStatus = 'checking' | 'connected' | 'unavailable' | 'error';

/** Console views, each with its own address under the operator portal. */
export type NavView = 'dashboard' | 'ledger' | 'sensing' | 'nodes' | 'calibration' | 'hardware' | 'billing';

export const NAV_VIEWS: readonly NavView[] = ['dashboard', 'ledger', 'sensing', 'nodes', 'calibration', 'hardware', 'billing'];

/**
 * Where each view lives. The path carries the state, so a refresh, a bookmark, a shared
 * link, and the back button all land on the view the operator was actually looking at.
 */
export const VIEW_PATHS: Record<NavView, string> = {
  dashboard: '/user-portal',
  ledger: '/user-portal/ledger',
  sensing: '/user-portal/assessment',
  nodes: '/user-portal/relays',
  calibration: '/user-portal/calibration',
  hardware: '/user-portal/hardware',
  billing: '/user-portal/plan',
};

/**
 * The inverse of VIEW_PATHS, and the only place an address is turned back into a view. An
 * address naming no view returns null so the caller can correct the address instead of
 * rendering a view at a URL that does not describe it.
 */
export function viewFromPath(path: string): NavView | null {
  const match = (Object.entries(VIEW_PATHS) as Array<[NavView, string]>).find(([, route]) => route === path);
  return match ? match[0] : null;
}

export type DeviceSort = 'signal-strongest' | 'signal-weakest' | 'type' | 'vendor' | 'channel' | 'last-seen' | 'first-seen' | 'address';

export const DEVICE_SORTS: readonly DeviceSort[] = ['signal-strongest', 'signal-weakest', 'type', 'vendor', 'channel', 'last-seen', 'first-seen', 'address'];

export type BillingEntitlements = { maxRelays: number; historyDays: number; reportExport: boolean; csiResearch: boolean; unlimited?: boolean };

export type BillingPlan = {
  id: string; name: string; priceMonthlyUsd: number; tagline: string; highlights: string[];
  entitlements: BillingEntitlements; purchasable?: boolean;
};

export type BillingCatalog = {
  configured: boolean; currentPlanId: string; currentPlanName?: string; status: string;
  entitlements: BillingEntitlements; plans: BillingPlan[]; portalAvailable?: boolean;
};

export type RelayTokenSummary = {
  id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; active: boolean;
};

export type RelayListPayload = { relays: RelayTokenSummary[]; allowance: { maxRelays: number; active: number; remaining: number; unlimited?: boolean } };

export type IssuedRelay = { token: string; label: string; nodeId: string };

/** Everything the console's views read, owned by one provider. */
export type ConsoleData = {
  devices: RFDevice[];
  nodes: ScanNode[];
  assessment: Assessment;
  trail: DeviceSighting[];
  sensingSnapshot: SensingSnapshot | null;
  selectedId: string;
  select: (id: string) => void;
  toggleFavorite: (id: string) => Promise<void>;
  addNode: (name: string, address: string) => Promise<boolean>;
  removeNode: (id: string) => Promise<void>;
  /** Set once the operator has run a scan, with what that scan actually found. */
  hardwareScan: HardwareScanResult | null;
  hardware: HardwareCapability[];
  hardwareRefreshing: boolean;
  refreshHardware: () => Promise<void>;
  requestHardware: (id: HardwareCapability['id']) => Promise<void>;
  /** True while the details drawer is open; selecting a row opens it. */
  detailsOpen: boolean;
  closeDetails: () => void;
  /** Modelled position for the selected radio, or null before it is read. */
  location: DeviceLocation | null;
  locationLoading: boolean;
  /** Saves or clears a relay's placement in the site frame. */
  placeNode: (id: string, x: number | null, y: number | null, label?: string) => Promise<boolean>;
  exportLedger: () => void;
  scanning: boolean;
  liveMode: boolean;
  apiConnected: boolean;
  apiStatus: ApiStatus;
  operatorName: string;
  siteLabel: string;
  sessionId: string | null;
  isMobile: boolean;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  signOut: () => Promise<void>;
};
