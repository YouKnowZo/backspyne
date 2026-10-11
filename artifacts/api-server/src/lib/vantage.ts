// Vantage points: where a radio was heard from.
//
// A sighting is only usable geometry once it has a vantage point. A fixed relay contributes
// its placement on the plan, which is the same place for every sighting it makes. A relay
// that reported where it stood — a phone in a pocket — contributes the position recorded on
// that sighting, so one walked phone becomes several vantage points for the same radio.
//
// Reports taken within `VANTAGE_BUCKET_METERS` of each other were measured from the same
// place and constrain a position the same way, so they are bucketed to one vantage point.
// Without that, standing still for a minute would look like a dozen separate measurements
// and a position estimate would trust them as if they were independent.
//
// Pure: no database, no I/O, so the geometry that depends on it can be tested directly.

/** Reports within this many metres of each other count as one vantage point. */
export const VANTAGE_BUCKET_METERS = 2;

export interface RecordedVantage {
  x: number;
  y: number;
  accuracyMeters: number | null;
  source: string;
}

export interface ResolvedVantage {
  /** Identity of the vantage point: one fixed relay, or one two-metre square of a walk. */
  key: string;
  name: string;
  x: number;
  y: number;
  /** True when the position came from the relay reporting where it was, not from a placement. */
  measured: boolean;
}

export interface SightingForVantage {
  nodeId: string;
  metadata?: Record<string, unknown> | null;
}

export interface NodeForVantage {
  id: string;
  name: string;
  positionX: number | null;
  positionY: number | null;
}

/** The two-metre square a coordinate falls in, as the stable identity of a vantage point. */
export function vantageBucket(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(x / VANTAGE_BUCKET_METERS) * VANTAGE_BUCKET_METERS,
    y: Math.round(y / VANTAGE_BUCKET_METERS) * VANTAGE_BUCKET_METERS,
  };
}

export function vantageKeyFor(nodeId: string, x: number, y: number): string {
  const bucket = vantageBucket(x, y);
  return `${nodeId}#${bucket.x}:${bucket.y}`;
}

/** The position a relay recorded on a sighting, if it recorded a usable one. */
export function readRecordedVantage(value: unknown): RecordedVantage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const x = typeof record.x === "number" && Number.isFinite(record.x) ? record.x : null;
  const y = typeof record.y === "number" && Number.isFinite(record.y) ? record.y : null;
  if (x === null || y === null) return null;
  const accuracy = typeof record.accuracyMeters === "number" && Number.isFinite(record.accuracyMeters) ? record.accuracyMeters : null;
  return { x, y, accuracyMeters: accuracy, source: typeof record.source === "string" && record.source ? record.source : "unknown" };
}

/** Reads the vantage point recorded on a sighting, if the relay recorded one. */
export function vantageFromSighting(sighting: SightingForVantage): RecordedVantage | null {
  return readRecordedVantage(sighting.metadata?.vantage);
}

/**
 * Where this sighting was measured from: the recorded position when there is one, otherwise
 * the relay's placement. An unplaced relay that recorded nothing is not a vantage point, and
 * says so by returning null rather than being treated as standing at the origin.
 */
export function vantagePointFor(sighting: SightingForVantage, node: NodeForVantage | undefined): ResolvedVantage | null {
  const recorded = vantageFromSighting(sighting);
  if (recorded) {
    const bucket = vantageBucket(recorded.x, recorded.y);
    return {
      key: vantageKeyFor(sighting.nodeId, recorded.x, recorded.y),
      name: `${node?.name ?? "Phone relay"} · vantage ${bucket.x}, ${bucket.y} m`,
      x: recorded.x,
      y: recorded.y,
      measured: true,
    };
  }
  if (!node || typeof node.positionX !== "number" || typeof node.positionY !== "number") return null;
  return { key: node.id ?? sighting.nodeId, name: node.name, x: node.positionX, y: node.positionY, measured: false };
}
