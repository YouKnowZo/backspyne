// Maps stored relay rows onto the console's own vocabulary.
//
// The console's vocabulary is deliberately the one the relay writes (see
// `scanner/backspyne_bridge/vendor.py`): a stored row is translated once, here, so a vendor
// basis, a freshness window, and an address type cannot be spelled two ways in two views.
// Pure functions only — no fetching, no React.

import type { AssessmentDevice } from '@workspace/assessment';
import { liveText, timeAgo } from './format';
import type { RFDevice, ScanNode } from './types';

/** Freshness windows: current within a minute, idle within five, else history. */
export const ACTIVE_WINDOW_SECONDS = 60;
export const IDLE_WINDOW_SECONDS = 5 * 60;

export type ApiDevice = Record<string, unknown>;
export type ApiNode = Record<string, unknown>;

export function liveDeviceFromApi(raw: ApiDevice): RFDevice | null {
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
  const addressMasked = payload.addressMasked === true;
  // These strings are the relay's own label bases (see scanner/backspyne_bridge/vendor.py).
  // A row stored before the relay reported its basis still renders the same way, so one
  // label source cannot split into two buckets on screen.
  const derivedVendorBasis = observedVendor !== 'Unknown vendor' ? 'hardware address prefix (local OUI match)' : advertisedManufacturer ? 'BLE manufacturer company code' : addressMasked ? 'unavailable: address masked or locally administered by the host operating system' : addressType === 'private/randomized address' ? 'unavailable: address is randomized' : 'no manufacturer evidence reported';
  const vendorBasis = liveText(payload.vendorBasis, derivedVendorBasis);
  const vendorCategory = liveText(payload.vendorCategory, '');
  // Registry prefixes are 6 (MA-L), 7 (MA-M) or 9 (MA-S) hex characters.
  const vendorOui = typeof payload.vendorOui === 'string' && /^(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{7}|[0-9A-Fa-f]{9})$/.test(payload.vendorOui) ? payload.vendorOui.toUpperCase() : null;
  const evidenceQuality = typeof payload.evidenceQuality === 'number' && Number.isFinite(payload.evidenceQuality) && payload.evidenceQuality >= 0 && payload.evidenceQuality <= 100 ? Math.round(payload.evidenceQuality) : null;
  const deviceType = protocol === 'WiFi' ? 'Wi-Fi access point' : protocol === 'BLE' ? 'Bluetooth LE advertiser' : 'Radio observation';
  const seenAt = liveText(raw.lastSeenAt, '');
  const parsedAt = seenAt ? new Date(seenAt).getTime() : Number.NaN;
  const ageSeconds = Number.isFinite(parsedAt) ? Math.max(0, Math.floor((Date.now() - parsedAt) / 1000)) : Number.POSITIVE_INFINITY;
  return {
    id: liveText(raw.id, `live-${address}`),
    mac: address,
    vendor,
    vendorBasis,
    vendorCategory: vendorCategory || null,
    vendorOui,
    evidenceQuality,
    addressMasked,
    deviceType,
    addressType,
    protocol,
    details: { ...payload, serviceUuids: raw.serviceUuids ?? metadata.serviceUuids ?? [] },
    signal,
    signalQualityPercent: quality,
    maxProximity: 'Not measured',
    status: ageSeconds <= ACTIVE_WINDOW_SECONDS ? 'active' : ageSeconds <= IDLE_WINDOW_SECONDS ? 'idle' : 'ghost',
    lastSeen: timeAgo(seenAt),
    firstSeen: timeAgo(liveText(raw.firstSeenAt, '')),
    lastSeenTimestamp: Number.isFinite(parsedAt) ? parsedAt : null,
    firstSeenTimestamp: typeof raw.firstSeenAt === 'string' && Number.isFinite(new Date(raw.firstSeenAt).getTime()) ? new Date(raw.firstSeenAt).getTime() : null,
    node: liveText(raw.nodeName, liveText(raw.node, 'Authorized relay')),
    channel: liveText(raw.channel, liveText(payload.channel, 'not reported')),
    favorite: Boolean(raw.favorite),
  };
}

export function liveNodeFromApi(raw: ApiNode): ScanNode {
  const heartbeat = liveText(raw.lastHeartbeatAt, '');
  return {
    id: liveText(raw.id, 'unknown-node'),
    name: liveText(raw.name, 'Authorized relay'),
    address: liveText(raw.address, 'local'),
    status: raw.status === 'online' ? 'online' : 'offline',
    lastSeen: timeAgo(heartbeat),
    lastSeenTimestamp: typeof raw.lastHeartbeatAt === 'string' && Number.isFinite(new Date(raw.lastHeartbeatAt).getTime()) ? new Date(raw.lastHeartbeatAt).getTime() : null,
    devices: typeof raw.deviceCount === 'number' ? raw.deviceCount : 0,
    role: liveText(raw.role, 'Sensor relay'),
  };
}

/**
 * Maps a console device onto the shared assessment model. The console and the printable
 * client report therefore describe the same measurements in the same words.
 */
export function assessmentDeviceFrom(device: RFDevice): AssessmentDevice {
  return {
    protocol: device.protocol,
    signal: device.signal,
    channel: device.channel && device.channel !== 'not reported' ? device.channel : null,
    status: device.status,
    vendor: device.vendor,
    vendorBasis: device.vendorBasis,
    addressMasked: device.addressMasked,
    security: typeof device.details.security === 'string' ? device.details.security : null,
    ssid: typeof device.details.ssid === 'string' ? device.details.ssid : null,
    lastSeenTimestamp: device.lastSeenTimestamp,
    firstSeenTimestamp: device.firstSeenTimestamp,
  };
}
