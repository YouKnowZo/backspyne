/**
 * Maps stored observation rows onto the shared assessment model.
 *
 * The console maps the same stored rows through its own live adapter, so the label
 * vocabulary here is deliberately the one the relay writes (see
 * `scanner/backspyne_bridge/vendor.py`) rather than a second phrasing of the same idea:
 * two spellings of one basis would split a single label source into two buckets in the
 * report and disagree with the screen it came from.
 *
 * This module is pure and imports nothing at runtime, which keeps it unit-testable
 * without a database. The relay's own vocabulary is the contract.
 */

import type { AssessmentDevice } from "@workspace/assessment";
import type { RfDevice } from "@workspace/db/schema";

export const UNKNOWN_VENDOR = "Unknown vendor";

/** Label bases exactly as the relay reports them. */
export const LABEL_BASIS = {
  registry: "hardware address prefix (IEEE registry match)",
  reviewedPrefix: "hardware address prefix (local OUI match)",
  bleCompanyCode: "BLE manufacturer company code",
  randomized: "unavailable: address is randomized",
  masked: "unavailable: address masked or locally administered by the host operating system",
  none: "no manufacturer evidence reported",
} as const;

/** Freshness windows shared with the console: fresh <=60s, idle <=300s, else ghost. */
export const ACTIVE_WINDOW_SECONDS = 60;
export const IDLE_WINDOW_SECONDS = 300;

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** The relay's per-observation detail, stored under `metadata.payload`. */
export function observationPayload(row: Pick<RfDevice, "metadata">): Record<string, unknown> {
  const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};
  const payload = metadata.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function timestamp(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function deviceStatusFor(lastSeenAt: unknown, now: number): "active" | "idle" | "ghost" {
  const seen = timestamp(lastSeenAt);
  if (seen === null) return "ghost";
  const ageSeconds = Math.max(0, (now - seen) / 1000);
  if (ageSeconds <= ACTIVE_WINDOW_SECONDS) return "active";
  if (ageSeconds <= IDLE_WINDOW_SECONDS) return "idle";
  return "ghost";
}

interface VendorEvidence {
  vendor: string | null;
  vendorBasis: string;
  addressMasked: boolean;
}

/**
 * Resolves what can honestly be said about a row's manufacturer.
 *
 * An observation the relay labelled keeps its label. A row stored before the relay
 * reported a basis is labelled from what is actually present, and an address the host
 * operating system masked always outranks a guessed basis because it explains why no
 * vendor can exist at all.
 */
export function vendorEvidence(row: RfDevice, payload: Record<string, unknown>): VendorEvidence {
  const observed = text(row.vendor);
  const advertised = text(payload.advertisedManufacturer);
  const addressMasked = payload.addressMasked === true;
  const attributed = observed && observed !== UNKNOWN_VENDOR ? observed : "";
  const vendor = attributed || advertised || null;

  const reported = text(payload.vendorBasis);
  if (reported) return { vendor, vendorBasis: reported, addressMasked };
  if (attributed) return { vendor, vendorBasis: LABEL_BASIS.reviewedPrefix, addressMasked };
  if (advertised) return { vendor, vendorBasis: LABEL_BASIS.bleCompanyCode, addressMasked };
  if (addressMasked) return { vendor, vendorBasis: LABEL_BASIS.masked, addressMasked };
  if (text(payload.addressType).toLowerCase().includes("random")) {
    return { vendor, vendorBasis: LABEL_BASIS.randomized, addressMasked };
  }
  return { vendor, vendorBasis: LABEL_BASIS.none, addressMasked };
}

/** Converts one stored observation into the model's vocabulary. */
export function toAssessmentDevice(row: RfDevice, now: number = Date.now()): AssessmentDevice {
  const payload = observationPayload(row);
  const { vendor, vendorBasis, addressMasked } = vendorEvidence(row, payload);
  const signal = typeof row.lastSignalDbm === "number" && Number.isFinite(row.lastSignalDbm) ? row.lastSignalDbm : null;
  return {
    protocol: row.protocol,
    signal,
    channel: text(row.channel) || text(payload.channel) || null,
    status: deviceStatusFor(row.lastSeenAt, now),
    vendor,
    vendorBasis,
    addressMasked,
    security: text(payload.security) || null,
    ssid: text(payload.ssid) || null,
    lastSeenTimestamp: timestamp(row.lastSeenAt),
    firstSeenTimestamp: timestamp(row.firstSeenAt),
  };
}
