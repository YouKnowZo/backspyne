// Received level: what an adapter reported, and what that can honestly mean.
//
// Two vocabularies arrive from the same kind of scan. Bluetooth adapters report dBm, and so do
// macOS WiFi (CoreWLAN) and Linux `iw`. Windows WiFi (netsh) and Linux NetworkManager
// (`nmcli SIGNAL`) report a *link-quality percentage*: an integer 0-100 the driver computes
// from its own smoothed view of the radio.
//
// Before this module the percentage was stored beside the observation and the position maths
// simply skipped it, so a WiFi access point seen only from Windows could not be located at all
// while a BLE advertiser seen from the same machine could. That is a hole in coverage, not
// caution, and closing it is what this file does.
//
// The mapping. Microsoft documents the driver scale as
//
//     quality = 2 * (dBm + 100)        therefore        dBm = quality / 2 - 100
//
// so 100% is -50 dBm and 0% is -100 dBm, in steps of half a decibel. That is an *estimate
// derived from* a percentage rather than a measurement: it is quantised, the scale is a
// convention rather than a calibration against a reference receiver, and it saturates at the
// top (every access point at -50 dBm or stronger reads 100%). It is still far more useful than
// nothing for locating an access point indoors, where the levels that matter are far weaker
// than the saturation point, and every value it produces is labelled with where it came from
// so a report can say so.
//
// Pure arithmetic: no database, no I/O, so the mapping and its limits are testable directly.

/** How the level reached us. A derived level is never presented as an adapter measurement. */
export type LevelSource = "adapter dBm" | "link-quality percentage";

export interface MeasuredLevel {
  /** Level in dBm: measured, or derived from a link-quality percentage. */
  dbm: number;
  source: LevelSource;
  /** The reported percentage when the level was derived from one, otherwise null. */
  percent: number | null;
}

/** The range the model and the schema accept, in dBm. */
export const USABLE_DBM_MIN = -127;
export const USABLE_DBM_MAX = 20;

export function usableDbm(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= USABLE_DBM_MIN && value <= USABLE_DBM_MAX;
}

/**
 * Windows' documented driver scale, and the scale `nmcli SIGNAL` uses. Returns null for a
 * value that is not a percentage at all rather than clamping it into a level: an out-of-range
 * number means the adapter reported something this mapping does not describe.
 */
export function dbmFromLinkQualityPercent(percent: unknown): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  // Rounded to the half-decibel step the scale itself has, so a derived level never looks
  // more precise than the number it came from.
  return Math.round((percent / 2 - 100) * 2) / 2;
}

/** A percentage from a level, so a derived level can be shown next to the reading it came from. */
export function linkQualityPercentFromDbm(dbm: number): number | null {
  if (!usableDbm(dbm)) return null;
  return Math.max(0, Math.min(100, Math.round((dbm + 100) * 2)));
}

/**
 * The level to model with, given whatever the adapter reported. A real dBm always wins: when
 * an adapter reports both, the percentage is the driver's derivation of the same number and
 * nothing is gained by preferring it.
 */
export function levelFromObservation(input: { signalDbm?: unknown; signalQualityPercent?: unknown }): MeasuredLevel | null {
  if (usableDbm(input.signalDbm)) {
    return { dbm: input.signalDbm, source: "adapter dBm", percent: linkQualityPercentFromDbm(input.signalDbm) };
  }
  const derived = dbmFromLinkQualityPercent(input.signalQualityPercent);
  if (derived === null) return null;
  return { dbm: derived, source: "link-quality percentage", percent: input.signalQualityPercent as number };
}

/** True when this level was derived rather than measured, for anywhere that displays it. */
export function levelIsDerived(source: unknown): boolean {
  return source === "link-quality percentage";
}

/**
 * The sentence a report or a console panel must carry whenever a derived level was used. It is
 * exported so every surface states the same limitation in the same words.
 */
export const DERIVED_LEVEL_NOTE =
  "A link-quality percentage is the driver's own 0-100 scale, not a measured power: it maps to " +
  "half-decibel steps between -100 dBm at 0% and -50 dBm at 100%, and it saturates at the top of " +
  "that range. Distances modelled from one carry the driver's rounding and scale error as well as " +
  "the usual uncertainty about walls and antenna orientation.";
