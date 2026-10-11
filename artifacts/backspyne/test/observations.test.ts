// Tests for the console's mapping of a stored observation.
//
//   node --experimental-strip-types --test artifacts/backspyne/test/observations.test.ts
//
// A level that came from a driver's link-quality percentage is used by the position model, so
// the console has to label it wherever it shows a level. That labelling happens in exactly one
// place — `liveDeviceFromApi` — which is why it is asserted here: if this mapping stops
// carrying the source, the ledger starts showing a derived level as though the adapter had
// measured it, and nothing else would notice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessmentDeviceFrom, liveDeviceFromApi } from '../src/lib/observations.ts';

const ADDRESS = 'B0:19:21:AA:BB:CC';

/** A device row as `/api/devices` returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'device_1',
    address: ADDRESS,
    vendor: 'TP-Link Systems Inc',
    protocol: 'WiFi',
    lastSignalDbm: -78,
    channel: '6',
    firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    metadata: { payload: { source: 'wifi_os_api', ssid: 'site' } },
    ...overrides,
  };
}

test('a level the API marked as derived stays marked in the console', () => {
  const mapped = liveDeviceFromApi(row({ signalSource: 'link-quality percentage', sightingMetadata: { signalQualityPercent: 44 } }));
  assert.ok(mapped);
  assert.equal(mapped!.signal, -78);
  assert.equal(mapped!.signalSource, 'link-quality percentage');
  assert.equal(mapped!.signalDerived, true);
  assert.equal(mapped!.signalQualityPercent, 44);
});

test('a measured level is not marked as derived', () => {
  const mapped = liveDeviceFromApi(row({ signalSource: 'adapter dBm', lastSignalDbm: -62 }));
  assert.ok(mapped);
  assert.equal(mapped!.signalSource, 'adapter dBm');
  assert.equal(mapped!.signalDerived, false);
});

test('a row stored before the API recorded a source is still shown as derived, not as measured', () => {
  // The percentage and no dBm is what an older Windows observation looks like, and the honest
  // reading is that the level came from the percentage: the console must not imply otherwise.
  const legacy = liveDeviceFromApi(row({ lastSignalDbm: null, sightingMetadata: { signalQualityPercent: 30 } }));
  assert.ok(legacy);
  assert.equal(legacy!.signal, null);
  assert.equal(legacy!.signalSource, 'link-quality percentage');
  assert.equal(legacy!.signalDerived, true);
});

test('a row with neither a source nor a percentage is not labelled at all', () => {
  const plain = liveDeviceFromApi(row({ signalSource: undefined }));
  assert.ok(plain);
  assert.equal(plain!.signalSource, null);
  assert.equal(plain!.signalDerived, false);
});

test('the assessment sees the same source the console shows', () => {
  const derived = liveDeviceFromApi(row({ signalSource: 'link-quality percentage', sightingMetadata: { signalQualityPercent: 44 } }));
  const measured = liveDeviceFromApi(row({ signalSource: 'adapter dBm' }));
  assert.ok(derived && measured);
  assert.equal(assessmentDeviceFrom(derived!).levelSource, 'link-quality percentage');
  assert.equal(assessmentDeviceFrom(measured!).levelSource, 'adapter dBm');
});
