// Tests for the phone relay's contract with the operator API.
//
//   node --experimental-strip-types --test artifacts/backspyne/test/phoneRelay.test.ts
//
// The phone relay is the one ingest path that runs on a device nobody can inspect, so its
// payload is asserted here against what the server accepts: an identifier the server's
// address gate allows, a level inside the accepted range, a timestamp the freshness window
// accepts, and metadata that says the identifier is the browser's rather than a radio
// address. The sensor APIs are stubbed, because what is under test is the sample the relay
// builds and sends, not the phone's hardware.

import test from 'node:test';
import assert from 'node:assert/strict';

type Sample = {
  nodeId: string;
  nodeName: string;
  observedAt: string;
  fix: { lat: number; lon: number; accuracyMeters: number | null } | null;
  observations: Array<{
    address: string;
    vendor: string;
    signalDbm?: number;
    serviceUuids?: string[];
    payload: Record<string, unknown>;
  }>;
  metrics: Record<string, number | string | boolean>;
  capabilities: string[];
};

type Sent = { url: string; init: RequestInit; body: Sample };

/** The smallest environment the relay touches, with every sensor answering as itself. */
function fakeEnvironment() {
  const sent: Sent[] = [];
  const listeners = new Map<string, (event: Event) => void>();
  const intervals: Array<() => void> = [];
  const storage = new Map<string, string>();
  let response: { status: number; body: unknown } = {
    status: 202,
    body: {
      accepted: true,
      observationsStored: 1,
      site: { origin: { lat: 51.5, lon: -0.12, setAt: '2026-10-10T19:00:00.000Z' }, originIsThisDevice: true, justSet: true },
      position: { x: 3.4, y: -1.2, accuracyMeters: 7.5, usedAsVantagePoint: true, accepted: true, reason: null },
    },
  };

  const windowLike = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    addEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(`window:${type}`, listener); },
    removeEventListener: (type: string) => { listeners.delete(`window:${type}`); },
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    clearInterval: () => { intervals.length = 0; },
    DeviceMotionEvent: { requestPermission: async () => 'granted' as const },
  };

  const navigatorLike = {
    geolocation: {
      watchPosition: (success: (position: unknown) => void) => {
        success({ coords: { latitude: 51.500045, longitude: -0.1199823, accuracy: 7.5 }, timestamp: Date.now() });
        return 1;
      },
    },
    bluetooth: {
      requestLEScan: async () => undefined,
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(`bluetooth:${type}`, listener); },
      removeEventListener: (type: string) => { listeners.delete(`bluetooth:${type}`); },
    },
    connection: { effectiveType: '4g', downlink: 12 },
    getBattery: async () => ({ level: 0.62, charging: false }),
    wakeLock: { request: async () => ({ release: async () => undefined }) },
  };

  Object.defineProperty(globalThis, 'window', { value: windowLike, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', {
    value: {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', { value: navigatorLike, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url: string, init: RequestInit) => {
      sent.push({ url, init, body: JSON.parse(String(init.body)) as Sample });
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    },
    configurable: true,
    writable: true,
  });

  return {
    sent,
    setResponse: (next: { status: number; body: unknown }) => { response = next; },
    /** Fires one advertisement at the relay, as Chrome Android does for a scanned device. */
    advertise: (event: unknown) => listeners.get('bluetooth:advertisementreceived')?.(event as Event),
    isBluetoothListening: () => listeners.has('bluetooth:advertisementreceived'),
    tick: () => { for (const callback of [...intervals]) callback(); },
    intervalsCleared: () => intervals.length === 0,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a phone sample is what the server's ingest gate accepts", async () => {
  const environment = fakeEnvironment();
  const { startPhoneRelay } = await import('../src/lib/phone-relay.ts');

  const controller = await startPhoneRelay({
    nodeId: 'phone_0123456789abcdef',
    nodeName: 'Walk-around phone',
    intervalMs: 5_000,
    onStatus: () => undefined,
  });

  // The relay checks in as soon as it starts, before anything has been heard.
  await settle();
  assert.equal(environment.sent.length, 1);
  assert.equal(environment.sent[0].body.observations.length, 0);
  assert.equal(environment.sent[0].body.metrics.fixAccuracyMeters, 7.5);
  assert.equal(environment.sent[0].body.metrics.batteryPercent, 62);
  assert.deepEqual(environment.sent[0].body.capabilities, ['geolocation', 'motion', 'bluetooth', 'wakelock', 'network']);

  // A BLE advertiser, with the one identifier Web Bluetooth exposes: the browser's own.
  environment.advertise({
    device: { id: '0a1b2c3d-4e5f-6708-91a2-b3c4d5e6f708', name: 'Tile' },
    rssi: -67,
    uuids: ['0000fe9f-0000-1000-8000-00805f9b34fb'],
    manufacturerData: new Map([[76, new DataView(new Uint8Array([0x01, 0x02]).buffer)]]),
  });
  environment.tick();
  await settle();

  assert.equal(environment.sent.length, 2);
  const sample = environment.sent[1].body;
  assert.equal(environment.sent[1].url, '/api/phone-relay/sample');
  assert.equal(environment.sent[1].init.method, 'POST');
  assert.equal(environment.sent[1].init.credentials, 'include');
  assert.match(sample.nodeId, /^phone_[A-Za-z0-9-]{6,}$/);
  assert.equal(sample.nodeName, 'Walk-around phone');
  assert.ok(Math.abs(Date.now() - new Date(sample.observedAt).getTime()) < 60_000);
  assert.equal(sample.fix?.accuracyMeters, 7.5);

  assert.equal(sample.observations.length, 1);
  const observation = sample.observations[0];
  // The server drops any address that is not hex, colons, dots or dashes, and caps it at 80.
  assert.match(observation.address, /^[0-9A-Fa-f:.-]{1,80}$/);
  assert.equal(observation.signalDbm, -67);
  assert.equal(observation.payload.source, 'ble_adapter');
  assert.match(String(observation.payload.addressType), /browser-scoped identifier/);
  assert.match(String(observation.payload.vendorBasis), /does not expose the radio address/);
  assert.equal(observation.payload.advertisedVendorHint, 'Tile');
  assert.deepEqual(observation.payload.manufacturerData, { '76': '0102' });
  assert.deepEqual(observation.serviceUuids, ['0000fe9f-0000-1000-8000-00805f9b34fb']);
  assert.equal(observation.vendor, 'Unknown vendor');

  // The next sample carries what has been heard since, not the same advertisement again.
  environment.tick();
  await settle();
  assert.equal(environment.sent.length, 3);
  assert.equal(environment.sent[2].body.observations.length, 0);

  await controller.stop();
  assert.equal(environment.intervalsCleared(), true);
  assert.equal(environment.isBluetoothListening(), false);
});

test("the server's answer places the phone and says whether the fix may be measured from", async () => {
  const environment = fakeEnvironment();
  const { startPhoneRelay } = await import('../src/lib/phone-relay.ts');
  const statuses: Array<{ samplesSent: number; x: number | null; origin: boolean }> = [];

  const controller = await startPhoneRelay({
    nodeId: 'phone_0123456789abcdef',
    nodeName: 'Phone relay',
    onStatus: (status) => statuses.push({
      samplesSent: status.samplesSent,
      x: status.sitePosition?.x ?? null,
      origin: status.siteOrigin !== null,
    }),
  });
  await settle();
  environment.tick();
  await settle();

  const latest = statuses[statuses.length - 1];
  assert.equal(latest.samplesSent, 2);
  assert.equal(latest.x, 3.4);
  assert.equal(latest.origin, true);
  assert.equal(controller.current().lastError, null);
  await controller.stop();
});

test('a refused sample is reported and the relay keeps running', async () => {
  const environment = fakeEnvironment();
  environment.setResponse({ status: 403, body: { error: 'The current plan allows 1 authorized relay' } });
  const { startPhoneRelay } = await import('../src/lib/phone-relay.ts');

  const controller = await startPhoneRelay({ nodeId: 'phone_0123456789abcdef', nodeName: 'Phone relay', onStatus: () => undefined });
  await settle();
  environment.tick();
  await settle();

  const status = controller.current();
  assert.equal(status.running, true);
  assert.equal(status.lastError, 'The current plan allows 1 authorized relay');
  assert.equal(status.samplesSent, 0);
  // The reason is visible in the log, so a refused relay never looks like a working one.
  assert.ok(status.log.some((entry) => entry.kind === 'error'));
  await controller.stop();
});

test('a coarse fix is recorded but never claimed as a position', async () => {
  const environment = fakeEnvironment();
  environment.setResponse({
    status: 202,
    body: {
      accepted: true,
      observationsStored: 0,
      site: { origin: { lat: 51.5, lon: -0.12, setAt: '2026-10-10T19:00:00.000Z' }, originIsThisDevice: true, justSet: true },
      position: {
        x: null,
        y: null,
        accuracyMeters: 120,
        usedAsVantagePoint: false,
        accepted: false,
        reason: 'This fix is reported as ±120 m, so it is shown but not used as a vantage point.',
      },
    },
  });
  const { startPhoneRelay } = await import('../src/lib/phone-relay.ts');
  const controller = await startPhoneRelay({ nodeId: 'phone_0123456789abcdef', nodeName: 'Phone relay', onStatus: () => undefined });
  await settle();
  environment.tick();
  await settle();

  const status = controller.current();
  assert.equal(status.sitePosition?.x, null);
  assert.equal(status.sitePosition?.usedAsVantagePoint, false);
  assert.match(String(status.sitePosition?.reason), /not used as a vantage point/);
  assert.equal(status.samplesSent, 2);
  await controller.stop();
});
