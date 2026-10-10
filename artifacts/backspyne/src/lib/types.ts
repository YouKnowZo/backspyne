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
  maxProximity: string; status: 'active' | 'idle' | 'ghost'; lastSeen: string; firstSeen: string;
  node: string; channel: string; favorite: boolean; details: Record<string, unknown>;
  lastSeenTimestamp: number | null; firstSeenTimestamp: number | null;
};

export type ScanNode = {
  id: string; name: string; address: string; status: 'online' | 'offline';
  lastSeen: string; lastSeenTimestamp: number | null; devices: number; role: string;
};

export type SensingMetric = { label: string; value: string; unit: string; status: string; trend: string };

export type SensingSnapshot = {
  id: string; observedAt: string; metrics: Record<string, unknown>;
  confidence?: number | null; uncertainty?: Record<string, unknown>;
};

export type DeviceSighting = { observedAt: string; signalDbm: number | null; distanceMeters: number | null };

export type HardwareStatus = 'ready' | 'permission' | 'connected' | 'limited' | 'unsupported';

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
export type NavView = 'dashboard' | 'ledger' | 'sensing' | 'nodes' | 'hardware' | 'billing';

export const NAV_VIEWS: readonly NavView[] = ['dashboard', 'ledger', 'sensing', 'nodes', 'hardware', 'billing'];

/**
 * Where each view lives. The path carries the state, so a refresh, a bookmark, a shared
 * link, and the back button all land on the view the operator was actually looking at.
 */
export const VIEW_PATHS: Record<NavView, string> = {
  dashboard: '/user-portal',
  ledger: '/user-portal/ledger',
  sensing: '/user-portal/assessment',
  nodes: '/user-portal/relays',
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

export type BillingEntitlements = { maxRelays: number; historyDays: number; reportExport: boolean; csiResearch: boolean };

export type BillingPlan = {
  id: string; name: string; priceMonthlyUsd: number; tagline: string; highlights: string[];
  entitlements: BillingEntitlements; purchasable?: boolean;
};

export type BillingCatalog = {
  configured: boolean; currentPlanId: string; status: string; entitlements: BillingEntitlements;
  plans: BillingPlan[]; portalAvailable?: boolean;
};

export type RelayTokenSummary = {
  id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; active: boolean;
};

export type RelayListPayload = { relays: RelayTokenSummary[]; allowance: { maxRelays: number; active: number; remaining: number } };

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
  hardware: HardwareCapability[];
  hardwareRefreshing: boolean;
  refreshHardware: () => Promise<void>;
  requestHardware: (id: HardwareCapability['id']) => Promise<void>;
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
