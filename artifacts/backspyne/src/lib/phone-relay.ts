// The phone relay: this browser as a measuring instrument.
//
// Why this exists. The desktop bridge needs a machine with an adapter and a Python service
// installed on it. A phone that is already signed in to this console has hardware of its own,
// and three of those sensors are genuinely useful for locating radios:
//
//   * GNSS position, so the relay knows where it was standing when it heard something. A
//     phone that walks a corridor and reports from each position gives several vantage points
//     for one radio, which is the geometry a position estimate needs.
//   * Motion, so samples can say whether the phone was still or moving. A distance measured
//     while the operator is walking is worth less than one measured while standing.
//   * The BLE advertisement scanning API, where the browser exposes it (Chrome on Android
//     behind its experimental flag, at the time of writing). This reports names, levels,
//     manufacturer data and service UUIDs — but never a radio address, so a device is
//     identified by the browser's own scoped identifier and is labelled as such.
//
// What it deliberately does not do: claim a capability the browser does not have, convert a
// percentage into dBm, or start anything without the operator pressing a button. Every
// unavailable sensor is reported with the reason it is unavailable.

export type PhoneSensorState = 'available' | 'needs-permission' | 'denied' | 'unsupported';

export interface PhoneSensor {
  id: 'geolocation' | 'motion' | 'bluetooth' | 'wakelock' | 'network';
  label: string;
  state: PhoneSensorState;
  detail: string;
  use: string;
}

export interface PhoneFix {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  at: number;
}

export interface PhoneRelayLogEntry {
  at: number;
  kind: 'info' | 'sent' | 'error';
  message: string;
}

export interface PhoneRelayStatus {
  running: boolean;
  nodeId: string;
  nodeName: string;
  sensors: PhoneSensor[];
  fix: PhoneFix | null;
  /**
   * Where this phone is in the site frame, as the server placed it. The coordinates are null
   * when the fix was too coarse to place — the reason then says why, rather than showing a
   * position the measurement does not support.
   */
  sitePosition: { x: number | null; y: number | null; accuracyMeters: number | null; usedAsVantagePoint: boolean; reason: string | null } | null;
  /** The origin the site frame is measured from, if one has been set. */
  siteOrigin: { lat: number; lon: number; setAt: string } | null;
  originIsThisDevice: boolean;
  samplesSent: number;
  observationsSent: number;
  lastSentAt: number | null;
  lastError: string | null;
  log: PhoneRelayLogEntry[];
}

export interface PhoneRelayStartOptions {
  nodeId: string;
  nodeName: string;
  /** How often a sample is sent. Shorter intervals cost battery and data. */
  intervalMs?: number;
  onStatus: (status: PhoneRelayStatus) => void;
}

export interface PhoneRelayController {
  stop: () => Promise<void>;
  /** One extra sample, on the operator's instruction. */
  sendNow: () => Promise<void>;
  /** Moves the site origin to the current fix, or clears it. */
  setOrigin: (action: 'set' | 'clear') => Promise<void>;
  current: () => PhoneRelayStatus;
}

/** Minimal shapes for the experimental APIs, so nothing here depends on lib.dom's coverage. */
type AdvertisingEvent = {
  device?: { id?: string; name?: string | null };
  rssi?: number;
  txPower?: number;
  manufacturerData?: Map<number, DataView>;
  uuids?: string[];
  name?: string;
};
type BluetoothLike = {
  requestLEScan?: (options: { acceptAllAdvertisements: boolean; keepRepeatedDevices?: boolean }) => Promise<unknown>;
  getAvailability?: () => Promise<boolean>;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
};
type MotionEventLike = {
  acceleration?: { x: number | null; y: number | null; z: number | null } | null;
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  interval?: number;
};
type MotionEventConstructor = { requestPermission?: () => Promise<'granted' | 'denied'> };
type WakeLockLike = { request: (type: 'screen') => Promise<{ release?: () => Promise<void>; released?: boolean; addEventListener?: (type: string, listener: () => void) => void }> };
type BatteryLike = { level?: number; charging?: boolean };

/**
 * A random identifier, without depending on `crypto.randomUUID`, which a page served over
 * plain http does not have.
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Nodes created here are named so the two ingest paths can never be confused. */
export function phoneRelayNodeId(): string {
  const key = 'backspyne.phoneRelayNodeId';
  const created = `phone_${randomSuffix()}`;
  try {
    const existing = window.localStorage.getItem(key);
    if (existing && /^phone_[A-Za-z0-9-]{6,}$/.test(existing)) return existing;
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    // Private browsing can refuse storage; a per-session id still works for this visit.
    return created;
  }
}

export function phoneRelayNodeName(): string {
  try {
    return window.localStorage.getItem('backspyne.phoneRelayNodeName') || 'Operator phone';
  } catch {
    return 'Operator phone';
  }
}

export function rememberPhoneRelayNodeName(name: string): void {
  try {
    window.localStorage.setItem('backspyne.phoneRelayNodeName', name.slice(0, 80));
  } catch {
    // The name is a convenience; failing to remember it is not an error.
  }
}

function dataViewToHex(view: DataView): string {
  const bytes: string[] = [];
  for (let index = 0; index < view.byteLength; index += 1) bytes.push(view.getUint8(index).toString(16).padStart(2, '0'));
  return bytes.join('');
}

function hexAddress(id: string): string {
  // The API accepts hex, colons, dots and dashes as an address. A Web Bluetooth identifier is
  // already a dash-separated hex UUID; anything else is reduced to its hex characters.
  const cleaned = id.replace(/[^0-9A-Fa-f-]/g, '').slice(0, 78);
  return cleaned.length >= 8 ? cleaned : '';
}

function magnitude(event: MotionEventLike): number | null {
  const source = event.accelerationIncludingGravity ?? event.acceleration;
  if (!source) return null;
  const { x, y, z } = source;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  // Gravity is present in the including-gravity reading, so this is acceleration magnitude
  // with a ~9.8 m/s² floor when still; the caller compares it against that floor.
  return Math.round(Math.hypot(x, y, z) * 100) / 100;
}

export async function startPhoneRelay(options: PhoneRelayStartOptions): Promise<PhoneRelayController> {
  const intervalMs = Math.max(3_000, options.intervalMs ?? 10_000);
  const nodeId = options.nodeId;
  const nodeName = options.nodeName;

  const sensors: PhoneSensor[] = [
    { id: 'geolocation', label: 'Position', state: 'unsupported', detail: 'Not checked yet.', use: 'Records where the relay was standing when it heard a radio' },
    { id: 'motion', label: 'Motion', state: 'unsupported', detail: 'Not checked yet.', use: 'Says whether a reading was taken while still or while walking' },
    { id: 'bluetooth', label: 'BLE advertisement scan', state: 'unsupported', detail: 'Not checked yet.', use: 'Reports nearby BLE advertisers by level and advertised name' },
    { id: 'wakelock', label: 'Screen wake lock', state: 'unsupported', detail: 'Not checked yet.', use: 'Keeps sampling while the operator walks with the page open' },
    { id: 'network', label: 'Network link', state: 'unsupported', detail: 'Not checked yet.', use: 'Reports the link the phone is using to reach this console' },
  ];
  const sensor = (id: PhoneSensor['id']) => sensors.find((entry) => entry.id === id)!;

  let running = true;
  let fix: PhoneFix | null = null;
  let sitePosition: PhoneRelayStatus['sitePosition'] = null;
  let siteOrigin: PhoneRelayStatus['siteOrigin'] = null;
  let originIsThisDevice = false;
  let samplesSent = 0;
  let observationsSent = 0;
  let lastSentAt: number | null = null;
  let lastError: string | null = null;
  const log: PhoneRelayLogEntry[] = [];

  // Latest advertisement per browser-scoped device id, drained on every sample.
  const advertisements = new Map<string, { address: string; signalDbm: number | null; name: string | null; manufacturerData: Record<string, string>; serviceUuids: string[] }>();
  let motionMagnitude: number | null = null;
  let motionPeak = 0;
  let battery: BatteryLike | null = null;
  let wakeLock: { release?: () => Promise<void> } | null = null;

  const note = (kind: PhoneRelayLogEntry['kind'], message: string) => {
    log.push({ at: Date.now(), kind, message });
    if (log.length > 40) log.splice(0, log.length - 40);
  };

  const status = (): PhoneRelayStatus => ({
    running,
    nodeId,
    nodeName,
    sensors: sensors.map((entry) => ({ ...entry })),
    fix,
    sitePosition,
    siteOrigin,
    originIsThisDevice,
    samplesSent,
    observationsSent,
    lastSentAt,
    lastError,
    log: [...log],
  });

  const publish = () => options.onStatus(status());

  const motionListener = (event: Event) => {
    const value = magnitude(event as unknown as MotionEventLike);
    if (value === null) return;
    motionMagnitude = value;
    // Acceleration includes gravity, so ~9.81 m/s² is standing still. Anything a good deal
    // above that is the phone being carried.
    motionPeak = Math.max(motionPeak, value);
  };

  const advertisingListener = (event: Event) => {
    const advertisement = event as unknown as AdvertisingEvent;
    const rawId = advertisement.device?.id ?? '';
    const address = hexAddress(rawId);
    if (!address) return;
    const manufacturerData: Record<string, string> = {};
    advertisement.manufacturerData?.forEach((view, company) => {
      manufacturerData[String(company)] = dataViewToHex(view);
    });
    const name = advertisement.name ?? advertisement.device?.name ?? null;
    advertisements.set(address, {
      address,
      signalDbm: typeof advertisement.rssi === 'number' && Number.isFinite(advertisement.rssi) ? advertisement.rssi : null,
      name,
      manufacturerData,
      serviceUuids: Array.isArray(advertisement.uuids) ? advertisement.uuids.filter((uuid): uuid is string => typeof uuid === 'string').slice(0, 16) : [],
    });
  };

  // ---------------------------------------------------------------------------------------
  // Sensor setup. Each one is independent: a refused sensor is reported and the rest run.
  // ---------------------------------------------------------------------------------------

  const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth;
  if (bluetooth?.requestLEScan) {
    try {
      await bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
      bluetooth.addEventListener?.('advertisementreceived', advertisingListener);
      sensor('bluetooth').state = 'available';
      sensor('bluetooth').detail = 'Scanning for BLE advertisements. The browser does not expose a radio address, so each device is tracked by this browser\'s own identifier.';
      note('info', 'BLE advertisement scanning started.');
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
      sensor('bluetooth').state = cancelled ? 'denied' : 'unsupported';
      sensor('bluetooth').detail = cancelled
        ? 'The scan permission was dismissed, so no advertisements are being collected. Press Start again to allow it.'
        : 'This browser refused an advertisement scan. Passive scanning is exposed by Chrome on Android behind its experimental web-platform flag; without it the phone cannot list nearby advertisers.';
      note('error', sensor('bluetooth').detail);
    }
  } else {
    sensor('bluetooth').state = 'unsupported';
    sensor('bluetooth').detail = 'This browser does not expose BLE advertisement scanning, so the phone cannot list nearby advertisers. Position and motion still measure.';
  }

  if (navigator.geolocation?.watchPosition) {
    try {
      navigator.geolocation.watchPosition(
        (position) => {
          fix = {
            lat: Math.round(position.coords.latitude * 1e7) / 1e7,
            lon: Math.round(position.coords.longitude * 1e7) / 1e7,
            accuracyMeters: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy * 10) / 10 : null,
            at: position.timestamp,
          };
          sensor('geolocation').state = 'available';
          sensor('geolocation').detail = fix.accuracyMeters === null
            ? 'Receiving a position with no reported accuracy, so it is shown but not used as a vantage point.'
            : `Receiving a position accurate to about ±${fix.accuracyMeters} m.`;
          publish();
        },
        (error) => {
          sensor('geolocation').state = error.code === error.PERMISSION_DENIED ? 'denied' : 'unsupported';
          sensor('geolocation').detail = error.code === error.PERMISSION_DENIED
            ? 'Location permission was denied, so the relay cannot say where it measured from. Estimates will show a ring instead of a position.'
            : 'This device could not produce a position. Outdoors with a clear view of the sky is when phone GNSS is usable; indoors it often is not.';
          note('error', sensor('geolocation').detail);
          publish();
        },
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
      );
      // Only while no fix has arrived: a browser that answers immediately must not be
      // reported as still waiting for one.
      if (sensor('geolocation').state !== 'available') {
        sensor('geolocation').state = 'needs-permission';
        sensor('geolocation').detail = 'Waiting for a position. Your browser will ask for location access.';
      }
    } catch {
      sensor('geolocation').state = 'unsupported';
      sensor('geolocation').detail = 'This browser does not expose the geolocation API.';
    }
  } else {
    sensor('geolocation').state = 'unsupported';
    sensor('geolocation').detail = 'This browser does not expose the geolocation API.';
  }

  const motionConstructor = window.DeviceMotionEvent as unknown as MotionEventConstructor | undefined;
  if (motionConstructor || 'DeviceMotionEvent' in window) {
    try {
      // iOS requires an explicit, gesture-driven permission request; Android does not.
      const permission = motionConstructor?.requestPermission ? await motionConstructor.requestPermission() : 'granted';
      if (permission === 'granted') {
        window.addEventListener('devicemotion', motionListener);
        sensor('motion').state = 'available';
        sensor('motion').detail = 'Acceleration is being read, so a sample can say whether it was taken while still or while walking.';
      } else {
        sensor('motion').state = 'denied';
        sensor('motion').detail = 'Motion access was declined, so samples cannot say whether the phone was still.';
      }
    } catch {
      sensor('motion').state = 'denied';
      sensor('motion').detail = 'Motion access was declined, so samples cannot say whether the phone was still.';
    }
  } else {
    sensor('motion').state = 'unsupported';
    sensor('motion').detail = 'This browser does not expose device motion.';
  }

  const wakeLockApi = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  const acquireWakeLock = async () => {
    if (!wakeLockApi?.request) {
      sensor('wakelock').state = 'unsupported';
      sensor('wakelock').detail = 'This browser has no screen wake lock, so keep the page open and the screen on while walking.';
      return;
    }
    try {
      wakeLock = await wakeLockApi.request('screen');
      sensor('wakelock').state = 'available';
      sensor('wakelock').detail = 'The screen is held awake so sampling continues while you walk.';
    } catch {
      sensor('wakelock').state = 'unsupported';
      sensor('wakelock').detail = 'The screen wake lock was refused; sampling continues only while this page stays visible.';
    }
  };
  await acquireWakeLock();

  const onVisibility = () => {
    // A wake lock is released when the page is hidden; take it back when it returns.
    if (running && document.visibilityState === 'visible' && !wakeLock) void acquireWakeLock();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  if (connection) {
    sensor('network').state = 'available';
    sensor('network').detail = `Link type ${connection.effectiveType ?? 'unknown'}${typeof connection.downlink === 'number' ? `, about ${connection.downlink} Mb/s` : ''}.`;
  } else {
    sensor('network').state = 'unsupported';
    sensor('network').detail = 'This browser does not report link details.';
  }

  const batteryApi = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  if (batteryApi) {
    try {
      battery = await batteryApi.call(navigator);
    } catch {
      battery = null;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Sampling
  // ---------------------------------------------------------------------------------------

  const buildSample = () => {
    const observations = [...advertisements.values()].map((advertisement) => ({
      address: advertisement.address,
      vendor: 'Unknown vendor',
      signalDbm: advertisement.signalDbm ?? undefined,
      serviceUuids: advertisement.serviceUuids,
      payload: {
        source: 'ble_adapter',
        // These two lines are the honesty of the phone path: the identifier is the browser's,
        // not the radio's, and no address was exposed, so no manufacturer can be attributed.
        addressType: 'browser-scoped identifier (Web Bluetooth device id, not a radio address)',
        vendorBasis: 'unavailable: Web Bluetooth does not expose the radio address',
        ...(advertisement.name ? { name: advertisement.name, localName: advertisement.name, advertisedVendorHint: advertisement.name } : {}),
        ...(Object.keys(advertisement.manufacturerData).length ? { manufacturerData: advertisement.manufacturerData } : {}),
      },
    }));
    advertisements.clear();

    const moving = motionPeak > 11.5;
    const metrics: Record<string, number | string | boolean> = {};
    // An unreported accuracy simply is not sent; a sentinel would be a number nobody measured.
    if (fix && fix.accuracyMeters !== null) metrics.fixAccuracyMeters = fix.accuracyMeters;
    if (motionPeak > 0) {
      metrics.motionPeakMs2 = motionPeak;
      metrics.motionState = moving ? 'moving' : 'stationary';
    }
    if (connection?.effectiveType) metrics.effectiveType = connection.effectiveType;
    if (typeof connection?.downlink === 'number') metrics.downlinkMbps = connection.downlink;
    if (typeof battery?.level === 'number') metrics.batteryPercent = Math.round(battery.level * 100);
    motionPeak = 0;

    return {
      nodeId,
      nodeName,
      observedAt: new Date().toISOString(),
      fix: fix ? { lat: fix.lat, lon: fix.lon, accuracyMeters: fix.accuracyMeters } : null,
      observations,
      metrics,
      capabilities: sensors.filter((entry) => entry.state === 'available').map((entry) => entry.id),
    };
  };

  const send = async () => {
    const sample = buildSample();
    const nothingToSay = sample.observations.length === 0 && !sample.fix;
    const heartbeatsDue = lastSentAt === null || Date.now() - lastSentAt > 30_000;
    // A relay that can measure nothing still checks in: the console shows a phone relay that
    // is present and honest about its sensors rather than one that looks offline.
    if (nothingToSay && !heartbeatsDue) return;
    try {
      const response = await fetch('/api/phone-relay/sample', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sample),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        observationsStored?: number;
        site?: { origin: { lat: number; lon: number; setAt: string } | null; originIsThisDevice: boolean; justSet: boolean };
        position?: { x: number | null; y: number | null; accuracyMeters: number | null; usedAsVantagePoint: boolean; accepted: boolean; reason: string | null };
      } | null;
      if (!response.ok) {
        lastError = typeof payload?.error === 'string' && payload.error ? payload.error : `The server refused the sample (${response.status}).`;
        note('error', lastError);
        publish();
        return;
      }
      lastError = null;
      samplesSent += 1;
      lastSentAt = Date.now();
      observationsSent += payload?.observationsStored ?? 0;
      siteOrigin = payload?.site?.origin ?? siteOrigin;
      originIsThisDevice = payload?.site?.originIsThisDevice ?? originIsThisDevice;
      sitePosition = payload?.position ?? null;
      const summary = [
        sample.fix ? `position ±${sample.fix.accuracyMeters ?? '?'} m` : 'no position',
        `${sample.observations.length} advertiser${sample.observations.length === 1 ? '' : 's'}`,
      ].join(' · ');
      note('sent', `Sample ${samplesSent} sent: ${summary}.`);
      if (payload?.site?.justSet) note('info', 'This phone\'s first fix became the site origin, so every placement and estimate is now measured from here.');
      publish();
    } catch {
      lastError = 'The sample could not reach the operator API. It will be sent again on the next cycle.';
      note('error', lastError);
      publish();
    }
  };

  const timer = window.setInterval(() => { void send(); }, intervalMs);
  note('info', `Phone relay started. Sending a sample every ${Math.round(intervalMs / 1000)} s.`);
  publish();
  // First sample immediately, so the operator sees the relay report rather than waiting a cycle.
  void send();

  const stop = async () => {
    running = false;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('devicemotion', motionListener);
    bluetooth?.removeEventListener?.('advertisementreceived', advertisingListener);
    try {
      await wakeLock?.release?.();
    } catch {
      // Releasing an already-released lock is not an error worth reporting.
    }
    wakeLock = null;
    note('info', 'Phone relay stopped. Nothing further is measured from this device.');
    publish();
  };

  const setOrigin = async (action: 'set' | 'clear') => {
    const body = action === 'clear'
      ? { action: 'clear' }
      : fix
        ? { action: 'set', lat: fix.lat, lon: fix.lon, accuracyMeters: fix.accuracyMeters, nodeId }
        : null;
    if (!body) {
      lastError = 'No position has been received yet, so the origin cannot be set to where you are.';
      publish();
      return;
    }
    try {
      const response = await fetch('/api/phone-relay/site', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { origin?: { lat: number; lon: number; setAt: string } | null; error?: string } | null;
      if (!response.ok) {
        lastError = payload?.error ?? `The site origin could not be changed (${response.status}).`;
      } else {
        siteOrigin = payload?.origin ?? null;
        originIsThisDevice = action === 'set';
        lastError = null;
        note('info', action === 'clear'
          ? 'The site origin was cleared; the next accepted fix becomes the new origin.'
          : 'The site origin was moved to this phone\'s current position.');
      }
    } catch {
      lastError = 'The site origin request could not reach the operator API.';
    }
    publish();
  };

  return { stop, sendNow: send, setOrigin, current: status };
}
