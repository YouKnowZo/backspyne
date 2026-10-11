// Storing measured observations: one writer for every ingest path.
//
// The desktop bridge and the phone relay report the same things — an address, a level, and
// whatever the radio said about itself — so they write through this one function. Keeping a
// single writer is what stops the ledger from disagreeing with itself: a device is upserted
// the same way, a merged payload is merged the same way, and a sighting is stored the same
// way, whichever relay heard it.
//
// A sighting may also carry the vantage point it was measured from. A fixed relay's vantage
// point is its placement on the plan; a phone in a pocket is somewhere new every few metres.
// Recording it per sighting is what turns a walk around a room into several vantage points
// for the same radio, which is the geometry a position estimate needs.
//
// A level arrives in one of two vocabularies. Bluetooth adapters, macOS WiFi and Linux `iw`
// report dBm. Windows WiFi (netsh) and Linux NetworkManager report a link-quality percentage,
// which `lib/signal.ts` maps to dBm. Storing only the measured ones meant a WiFi access point
// seen from a Windows relay had no level at all and could never be located, so a percentage is
// converted here, at the one place every ingest path writes through, and the sighting records
// which of the two it was.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { rfDevices, rfSightings } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { levelFromObservation, levelIsDerived, usableDbm } from "./signal";

export interface IngestObservation {
  address?: string;
  vendor?: string;
  /** A measured level, when the adapter reports power. Wins over a percentage. */
  signalDbm?: number;
  /**
   * The adapter's 0-100 link-quality scale, which Windows WiFi and NetworkManager report
   * instead of power. Converted to dBm for storage by `lib/signal.ts`.
   */
  signalQualityPercent?: number;
  channel?: string;
  serviceUuids?: string[];
  payload?: Record<string, unknown>;
}

/** Where the radio was heard from, in site-frame metres. */
export interface ObservationVantage {
  x: number;
  y: number;
  accuracyMeters: number | null;
  /** How the vantage point was established, e.g. `geolocation`. */
  source: string;
}

export interface StoreObservationsOptions {
  ownerId: string;
  nodeId: string;
  protocol: "WiFi" | "BLE" | "CSI" | "system";
  observedAt: Date;
  observations: IngestObservation[];
  vantage?: ObservationVantage | null;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Addresses are the relay's own vocabulary. Anything outside the shape a radio address or a
 * browser-scoped device identifier can take is dropped rather than stored as a device.
 */
const ADDRESS_PATTERN = /^[0-9A-Fa-f:.-]{1,80}$/;

export function usableAddress(address: unknown): address is string {
  return typeof address === "string" && ADDRESS_PATTERN.test(address);
}

export function validSignal(signalDbm: unknown): signalDbm is number {
  return usableDbm(signalDbm);
}

/**
 * Upserts each observed radio and appends one sighting per observation. Returns how many
 * observations were stored, so a caller can report what actually happened instead of
 * assuming the payload landed.
 */
export async function storeObservations(options: StoreObservationsOptions): Promise<number> {
  const { ownerId, nodeId, protocol: normalizedProtocol, observedAt, observations, vantage } = options;
  let stored = 0;

  for (const observation of observations) {
    if (!usableAddress(observation.address)) continue;
    const deviceId = newId("device");
    const existing = await db
      .select({ id: rfDevices.id, vendor: rfDevices.vendor, channel: rfDevices.channel, metadata: rfDevices.metadata })
      .from(rfDevices)
      .where(and(eq(rfDevices.ownerId, ownerId), eq(rfDevices.address, observation.address)))
      .limit(1);
    const source = observation.payload?.source;
    const observationProtocol = source === "ble_adapter" ? "BLE" as const : source === "wifi_os_api" ? "WiFi" as const : normalizedProtocol;
    const observationPayload = { ...(observation.payload || {}) };
    delete observationPayload.source;
    const priorMetadata = existing[0]?.metadata ?? {};
    const priorPayload = priorMetadata.payload && typeof priorMetadata.payload === "object"
      ? priorMetadata.payload as Record<string, unknown>
      : {};
    const mergedPayload: Record<string, unknown> = {
      ...priorPayload,
      ...Object.fromEntries(Object.entries(observationPayload).filter(([, value]) => value !== null && value !== "")),
    };
    if (priorPayload.manufacturerData && observationPayload.manufacturerData && typeof priorPayload.manufacturerData === "object" && typeof observationPayload.manufacturerData === "object") {
      mergedPayload.manufacturerData = {
        ...priorPayload.manufacturerData as Record<string, unknown>,
        ...observationPayload.manufacturerData as Record<string, unknown>,
      };
    }
    const currentServiceUuids = observation.serviceUuids?.filter((uuid) => typeof uuid === "string") || [];
    const priorServiceUuids = Array.isArray(priorMetadata.serviceUuids) ? priorMetadata.serviceUuids.filter((uuid): uuid is string => typeof uuid === "string") : [];
    const submittedVendor = typeof observation.vendor === "string" ? observation.vendor.slice(0, 120) : "Unknown vendor";
    // The level to model with: the adapter's own dBm when it reported one, otherwise what its
    // link-quality percentage maps to. A percentage the driver never produced is not a level
    // and stays null, which is what keeps a malformed payload out of the geometry.
    const level = levelFromObservation(observation);
    const values = {
      ownerId,
      address: observation.address.slice(0, 80),
      vendor: submittedVendor !== "Unknown vendor"
        ? submittedVendor
        : observationProtocol === "BLE" || observationPayload.addressType === "private/randomized address"
          ? "Unknown vendor"
          : (existing[0]?.vendor ?? submittedVendor),
      protocol: observationProtocol,
      lastSignalDbm: level ? level.dbm : null,
      channel: typeof observation.channel === "string" ? observation.channel.slice(0, 40) : existing[0]?.channel ?? null,
      lastSeenAt: observedAt,
      metadata: {
        ...priorMetadata,
        serviceUuids: [...new Set([...priorServiceUuids, ...currentServiceUuids])].slice(0, 64),
        payload: mergedPayload,
      },
    };
    if (existing[0]) {
      await db.update(rfDevices).set(values).where(eq(rfDevices.id, existing[0].id));
    } else {
      await db.insert(rfDevices).values({ id: deviceId, ...values });
    }
    await db.insert(rfSightings).values({
      id: newId("sighting"),
      ownerId,
      deviceId: existing[0]?.id ?? deviceId,
      nodeId,
      observedAt,
      signalDbm: level ? level.dbm : null,
      distanceMeters: null,
      metadata: {
        channel: typeof observation.channel === "string" ? observation.channel.slice(0, 40) : null,
        // The percentage exactly as the adapter reported it, plus where the stored level came
        // from, so a derived level is never presented as something the adapter measured.
        signalQualityPercent: typeof observation.signalQualityPercent === "number" && observation.signalQualityPercent >= 0 && observation.signalQualityPercent <= 100 ? observation.signalQualityPercent : null,
        signalSource: level ? level.source : null,
        signalDbmDerived: level ? levelIsDerived(level.source) : false,
        ...(vantage ? { vantage } : {}),
      },
    });
    stored += 1;
  }

  return stored;
}
