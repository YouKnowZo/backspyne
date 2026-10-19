// Tests for the first-run operator onboarding checklist model.
//
//   node --experimental-strip-types --test artifacts/backspyne/test/firstRun.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFirstRunProgress,
  markFirstRunReportExported,
  readFirstRunDismissed,
  readFirstRunReportExported,
  writeFirstRunDismissed,
} from '../src/lib/first-run.ts';
import type { RFDevice, RelayTokenSummary, ScanNode } from '../src/lib/types.ts';

function sampleNode(overrides: Partial<ScanNode> = {}): ScanNode {
  return {
    id: 'relay-office-01',
    name: 'Office AP sweep',
    address: '10.0.0.12',
    status: 'online',
    lastSeen: 'now',
    lastSeenTimestamp: Date.now(),
    devices: 3,
    role: 'WIFI',
    positionX: null,
    positionY: null,
    positionLabel: null,
    ...overrides,
  };
}

function sampleDevice(overrides: Partial<RFDevice> = {}): RFDevice {
  return {
    id: 'device_1',
    mac: 'B0:19:21:AA:BB:CC',
    vendor: 'TP-Link Systems Inc',
    vendorBasis: 'IEEE OUI prefix',
    deviceType: 'WiFi access point',
    addressType: 'globally assigned (UAA)',
    addressMasked: false,
    protocol: 'WiFi',
    signal: -62,
    signalQualityPercent: null,
    signalSource: 'adapter dBm',
    signalDerived: false,
    maxProximity: 'Strong (-62 dBm)',
    status: 'active',
    lastSeen: 'now',
    firstSeen: '1 min ago',
    node: 'relay-office-01',
    channel: '6',
    favorite: false,
    details: {},
    lastSeenTimestamp: Date.now(),
    firstSeenTimestamp: Date.now() - 60_000,
    ...overrides,
  };
}

function sampleRelayToken(overrides: Partial<RelayTokenSummary> = {}): RelayTokenSummary {
  return {
    id: 'rtok_01',
    label: 'Field laptop',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    active: true,
    ...overrides,
  };
}

test('a brand-new operator starts on step 1 (pair-relay) with 0 of 3 completed', () => {
  const progress = buildFirstRunProgress({
    apiStatus: 'connected',
    nodes: [],
    devices: [],
    pairedRelays: [],
    reportExportedAt: null,
  });
  assert.equal(progress.completedCount, 0);
  assert.equal(progress.allComplete, false);
  assert.equal(progress.activeStepId, 'pair-relay');
  assert.equal(progress.steps[0].status, 'active');
  assert.equal(progress.steps[1].status, 'pending');
  assert.equal(progress.steps[2].status, 'pending');
});

test('pairing a relay token completes step 1 and advances active step to room-scan', () => {
  const progress = buildFirstRunProgress({
    apiStatus: 'connected',
    nodes: [],
    devices: [],
    pairedRelays: [sampleRelayToken()],
    reportExportedAt: null,
  });
  assert.equal(progress.relayPaired, true);
  assert.equal(progress.completedCount, 1);
  assert.equal(progress.activeStepId, 'room-scan');
  assert.equal(progress.steps[0].status, 'complete');
  assert.equal(progress.steps[1].status, 'active');
  assert.match(progress.steps[0].summary, /1 relay credential paired/);
});

test('revoked relay tokens alone do not count as a paired relay', () => {
  const progress = buildFirstRunProgress({
    apiStatus: 'connected',
    nodes: [],
    devices: [],
    pairedRelays: [sampleRelayToken({ active: false, revokedAt: new Date().toISOString() })],
    reportExportedAt: null,
  });
  assert.equal(progress.relayPaired, false);
  assert.equal(progress.activeStepId, 'pair-relay');
});

test('collecting room scan observations completes step 2 and advances active step to export-report', () => {
  const progress = buildFirstRunProgress({
    apiStatus: 'connected',
    nodes: [sampleNode()],
    devices: [sampleDevice(), sampleDevice({ id: 'device_2', protocol: 'BLE' })],
    pairedRelays: [],
    reportExportedAt: null,
  });
  assert.equal(progress.relayPaired, true);
  assert.equal(progress.scanCompleted, true);
  assert.equal(progress.reportExported, false);
  assert.equal(progress.completedCount, 2);
  assert.equal(progress.activeStepId, 'export-report');
  assert.equal(progress.steps[0].status, 'complete');
  assert.equal(progress.steps[1].status, 'complete');
  assert.equal(progress.steps[2].status, 'active');
  assert.match(progress.steps[1].summary, /2 radios observed \(1 WiFi · 1 BLE\)/);
});

test('exporting or sharing a client report completes step 3 and marks allComplete', () => {
  const progress = buildFirstRunProgress({
    apiStatus: 'connected',
    nodes: [sampleNode()],
    devices: [sampleDevice()],
    pairedRelays: [],
    reportExportedAt: '2026-10-18T12:00:00.000Z',
  });
  assert.equal(progress.completedCount, 3);
  assert.equal(progress.allComplete, true);
  assert.equal(progress.activeStepId, null);
  assert.ok(progress.steps.every(step => step.status === 'complete'));
});

test('report export and dismissal helpers persist per operator scope when localStorage is available', t => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  t.after(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: prevStorage, configurable: true });
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });

  assert.equal(readFirstRunReportExported('user_1'), null);
  markFirstRunReportExported('user_1', '2026-10-18T15:00:00.000Z');
  assert.equal(readFirstRunReportExported('user_1'), '2026-10-18T15:00:00.000Z');
  assert.equal(readFirstRunReportExported('user_2'), null);

  assert.equal(readFirstRunDismissed('user_1'), false);
  writeFirstRunDismissed('user_1', true);
  assert.equal(readFirstRunDismissed('user_1'), true);
  writeFirstRunDismissed('user_1', false);
  assert.equal(readFirstRunDismissed('user_1'), false);
});
