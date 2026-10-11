// The site frame: the arithmetic that turns a phone's coordinates into metres on the plan.
//
// Relay placement is metres east and north of an origin the operator chose (see
// `locationSchema.ts`). A phone cannot type that in, because the only position it has is a
// GNSS fix in latitude and longitude. This module bridges the two: the operator's first
// accepted fix becomes the origin (kept by `siteOriginStore.ts`), and every later fix is
// projected into the same metric frame, so a walked phone path and a typed relay placement
// live in one coordinate system and can be used by the same geometry.
//
// Accuracy is treated as data, not as a footnote. A fix whose reported accuracy is worse
// than `MAX_VANTAGE_ACCURACY_METERS` is recorded and displayed, but it is never used as a
// vantage point for a position estimate: a 90 m circle drawn as a distance measurement
// would put a confident-looking marker where no measurement exists.
//
// Pure arithmetic with no database access, so the projection can be tested directly.

/** Worse than this and the fix is not a position at all; it is only a hint. */
export const MAX_FIX_ACCURACY_METERS = 150;
/** At or better than this, the fix may be used as a vantage point for position geometry. */
export const MAX_VANTAGE_ACCURACY_METERS = 25;

const METERS_PER_DEGREE_LATITUDE = 110_574;

export interface GeoFix {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
}

export interface SiteOrigin {
  lat: number;
  lon: number;
  nodeId: string | null;
  setAt: string;
}

/** A fix is only usable when both coordinates are real and its accuracy was reported. */
export function readGeoFix(value: unknown): GeoFix | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const lat = typeof record.lat === "number" && Number.isFinite(record.lat) ? record.lat : Number.NaN;
  const lon = typeof record.lon === "number" && Number.isFinite(record.lon) ? record.lon : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const rawAccuracy = typeof record.accuracyMeters === "number" && Number.isFinite(record.accuracyMeters) ? record.accuracyMeters : null;
  const accuracyMeters = rawAccuracy === null ? null : Math.min(10_000, Math.max(0, Math.round(rawAccuracy * 10) / 10));
  return { lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, accuracyMeters };
}

/** A coarse fix may be shown as the device's position but is not a measurement of distance. */
export function isUsableVantage(fix: GeoFix): boolean {
  return fix.accuracyMeters !== null && fix.accuracyMeters <= MAX_VANTAGE_ACCURACY_METERS;
}

export function fixIsReportable(fix: GeoFix): boolean {
  return fix.accuracyMeters === null || fix.accuracyMeters <= MAX_FIX_ACCURACY_METERS;
}

/**
 * Projects a fix into the site frame. Over a site-sized area an equirectangular projection
 * about the origin is accurate to well under the fix's own accuracy, and it keeps the
 * arithmetic readable: north is +y, east is +x, one unit is one metre.
 */
export function projectToSiteFrame(fix: GeoFix, origin: { lat: number; lon: number }): { x: number; y: number } {
  const metersPerDegreeLongitude = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const x = (fix.lon - origin.lon) * metersPerDegreeLongitude;
  const y = (fix.lat - origin.lat) * METERS_PER_DEGREE_LATITUDE;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}
