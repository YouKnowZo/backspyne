// Where a radio is, to the accuracy this measurement can actually support.
//
// No relay here measures a bearing. A relay reports one received level, and the
// log-distance path-loss model below turns that level into an implied distance. One relay
// therefore yields a ring, two yield at most two candidate points, and three or more yield a
// real fix whose uncertainty is the spread of the residuals — which is what this module
// reports, status included. It never upgrades a ring into a point: a position printed as a
// fix is a position the geometry supports, and an ambiguous one says so.
//
// Pure arithmetic with no database and no I/O, so the geometry can be tested directly.

export interface RadioModel {
  /** The level a transmitter of interest is expected to produce at `referenceMeters`. */
  referenceDbm: number;
  /**
   * Environment path-loss exponent. Free space is 2; an indoor environment with walls,
   * furniture and people is typically 2.5–4. Kept as configuration because the same relay
   * in a corridor and in a warehouse are different environments.
   */
  pathLossExponent: number;
  referenceMeters: number;
}

/**
 * Defaults for an indoor site. They describe a *model*, not a calibration: without a
 * measured reference at a known distance the implied distances below inherit this
 * uncertainty, which is why the portal prints the model it used next to the estimate.
 */
export const DEFAULT_RADIO_MODEL: RadioModel = {
  referenceDbm: -40,
  pathLossExponent: 2.5,
  referenceMeters: 1,
};

/** An implied distance longer than this is clamped: it is not a usable indoor fix. */
export const MAX_IMPLIED_METERS = 150;
export const MIN_IMPLIED_METERS = 0.5;

export interface RelayObservation {
  nodeId: string;
  nodeName: string;
  /** Site-frame metres, east and north of the operator's origin. */
  x: number;
  y: number;
  signalDbm: number;
  observedAt: string;
}

export type PositionStatus = 'estimated' | 'ambiguous' | 'single_relay' | 'no_signal';

export interface PositionCandidate {
  x: number;
  y: number;
}

export interface PositionResidual {
  nodeId: string;
  nodeName: string;
  reportedDbm: number;
  impliedMeters: number;
  modelledMeters: number;
  residualMeters: number;
}

export interface PositionEstimate {
  status: PositionStatus;
  x: number | null;
  y: number | null;
  /** Radius in metres that contains the estimate at this model's accuracy. */
  uncertaintyMeters: number | null;
  method: string;
  relays: number;
  note: string;
  /** Two-relay solutions: both are printed rather than one being chosen silently. */
  candidates: PositionCandidate[];
  /** One-relay solution: a distance from one relay, with no direction. */
  ring: { nodeId: string; nodeName: string; x: number; y: number; distanceMeters: number } | null;
  residuals: PositionResidual[];
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Inverts the log-distance path-loss model: level in, implied distance out. */
export function impliedDistanceMeters(signalDbm: number, model: RadioModel = DEFAULT_RADIO_MODEL): number {
  if (!Number.isFinite(signalDbm)) return MAX_IMPLIED_METERS;
  const exponent = 10 * model.pathLossExponent;
  const meters = model.referenceMeters * 10 ** ((model.referenceDbm - signalDbm) / exponent);
  return clamp(meters, MIN_IMPLIED_METERS, MAX_IMPLIED_METERS);
}

/** The inverse, used to state what a placed relay's level implies. */
export function modelledDbmAt(meters: number, model: RadioModel = DEFAULT_RADIO_MODEL): number {
  const distance = Math.max(MIN_IMPLIED_METERS, meters);
  return model.referenceDbm - 10 * model.pathLossExponent * Math.log10(distance / model.referenceMeters);
}

/**
 * Where two circles meet, in the plane. Zero, one or two answers: a pair of relays that
 * both hear a radio usually leaves two mirror positions, and this returns both.
 */
function circleIntersections(
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): PositionCandidate[] {
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return [];
  // Circles that do not reach each other, or one that contains the other, have no crossing.
  if (distance > ar + br || distance < Math.abs(ar - br)) return [];
  const a = (ar ** 2 - br ** 2 + distance ** 2) / (2 * distance);
  const heightSquared = ar ** 2 - a ** 2;
  const height = heightSquared > 0 ? Math.sqrt(heightSquared) : 0;
  const mx = ax + (a * dx) / distance;
  const my = ay + (a * dy) / distance;
  const rx = (dy / distance) * height;
  const ry = (dx / distance) * height;
  if (height === 0) return [{ x: round(mx), y: round(my) }];
  return [
    { x: round(mx + rx), y: round(my + ry) },
    { x: round(mx - rx), y: round(my - ry) },
  ];
}

function noSignal(): PositionEstimate {
  return {
    status: 'no_signal',
    x: null,
    y: null,
    uncertaintyMeters: null,
    method: 'none',
    relays: 0,
    note: 'No placed relay reported a numeric level for this radio inside the window, so no position can be modelled.',
    candidates: [],
    ring: null,
    residuals: [],
  };
}

/**
 * Estimates a position from the latest level each placed relay reported. Callers pass one
 * observation per relay (see `latestPerRelay`), because two reports from the same relay are
 * one vantage point, not two.
 */
export function estimatePosition(observations: RelayObservation[], model: RadioModel = DEFAULT_RADIO_MODEL): PositionEstimate {
  const usable = observations.filter((observation) => Number.isFinite(observation.signalDbm) && Number.isFinite(observation.x) && Number.isFinite(observation.y));
  if (!usable.length) return noSignal();

  const vertices = usable.map((observation) => ({
    observation,
    implied: impliedDistanceMeters(observation.signalDbm, model),
  }));

  if (vertices.length === 1) {
    const [single] = vertices;
    return {
      status: 'single_relay',
      x: null,
      y: null,
      uncertaintyMeters: null,
      method: 'implied distance from one relay',
      relays: 1,
      note: `One placed relay hears this radio at ${single.observation.signalDbm.toFixed(0)} dBm, which the model puts about ${single.implied.toFixed(1)} m away. One relay gives a distance and no direction, so the position is a ring, not a point. Place two more relays to resolve a fix.`,
      candidates: [],
      ring: {
        nodeId: single.observation.nodeId,
        nodeName: single.observation.nodeName,
        x: single.observation.x,
        y: single.observation.y,
        distanceMeters: round(single.implied),
      },
      residuals: [],
    };
  }

  if (vertices.length === 2) {
    const [first, second] = vertices;
    const candidates = circleIntersections(
      first.observation.x, first.observation.y, first.implied,
      second.observation.x, second.observation.y, second.implied,
    );
    if (candidates.length >= 1) {
      return {
        status: 'ambiguous',
        x: candidates[0].x,
        y: candidates[0].y,
        uncertaintyMeters: null,
        method: 'two-circle intersection',
        relays: 2,
        note: candidates.length === 1
          ? 'Two placed relays put this radio at a single crossing point, but two circles can also meet twice on noisy data, so treat this as an estimate rather than a fix. A third placed relay would settle it.'
          : 'Two placed relays put this radio at either of two mirror positions and this measurement cannot choose between them. Both candidates are printed; a third placed relay resolves the ambiguity.',
        candidates,
        ring: null,
        residuals: [],
      };
    }
    return {
      status: 'ambiguous',
      x: null,
      y: null,
      uncertaintyMeters: null,
      method: 'two-circle intersection',
      relays: 2,
      note: 'Two placed relays reported levels whose implied distances do not meet, so no position is supported. That usually means the model constants do not match this site, or one relay is reporting a heavily obstructed path. Three or more relays, and a measured reference level, make this resolvable.',
      candidates: [],
      ring: null,
      residuals: [],
    };
  }

  const [reference, ...rest] = vertices;
  // Linearised trilateration: subtracting the reference circle removes the squared terms and
  // leaves one linear equation per remaining relay, solved in the least-squares sense.
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const vertex of rest) {
    const a1 = 2 * (vertex.observation.x - reference.observation.x);
    const a2 = 2 * (vertex.observation.y - reference.observation.y);
    const b = reference.implied ** 2 - vertex.implied ** 2
      + vertex.observation.x ** 2 - reference.observation.x ** 2
      + vertex.observation.y ** 2 - reference.observation.y ** 2;
    s11 += a1 * a1;
    s12 += a1 * a2;
    s22 += a2 * a2;
    t1 += a1 * b;
    t2 += a2 * b;
  }
  const determinant = s11 * s22 - s12 * s12;
  const scale = Math.max(s11 * s22, 1);
  // A near-zero determinant means the placements are collinear (or coincident): the circles
  // have no unique intersection, and the honest answer is a weighted centre, not a fix.
  const degenerate = determinant / scale < 1e-6;

  let x: number;
  let y: number;
  let method: string;
  let note: string;
  let floorUncertainty = 1.5;
  if (degenerate) {
    let weightSum = 0;
    let weightedX = 0;
    let weightedY = 0;
    for (const vertex of vertices) {
      const weight = 1 / Math.max(vertex.implied, MIN_IMPLIED_METERS);
      weightSum += weight;
      weightedX += vertex.observation.x * weight;
      weightedY += vertex.observation.y * weight;
    }
    x = weightedX / weightSum;
    y = weightedY / weightSum;
    method = 'weighted centre of placed relays';
    note = 'Every placed relay that hears this radio sits on one line, so their implied distances cannot resolve a unique point. The marker is the centre of those relays weighted by closeness, and the uncertainty below reflects how little that placement constrains. Spread the relays out to get a real fix.';
    floorUncertainty = 15;
  } else {
    x = (t1 * s22 - t2 * s12) / determinant;
    y = (t2 * s11 - t1 * s12) / determinant;
    method = 'least-squares trilateration (log-distance path loss)';
    note = `A fix from ${vertices.length} placed relays. Its uncertainty is the spread between the modelled distance each relay implies and the distance to the fitted point; it does not include walls, antenna orientation, or a miscalibrated reference level.`;
  }

  const residuals: PositionResidual[] = vertices.map((vertex) => {
    const modelled = Math.hypot(x - vertex.observation.x, y - vertex.observation.y);
    return {
      nodeId: vertex.observation.nodeId,
      nodeName: vertex.observation.nodeName,
      reportedDbm: round(vertex.observation.signalDbm),
      impliedMeters: round(vertex.implied),
      modelledMeters: round(modelled),
      residualMeters: round(Math.abs(modelled - vertex.implied)),
    };
  });
  const rms = Math.sqrt(residuals.reduce((sum, residual) => sum + residual.residualMeters ** 2, 0) / residuals.length);
  const clipped = vertices.some((vertex) => vertex.implied >= MAX_IMPLIED_METERS);

  return {
    status: 'estimated',
    x: round(x),
    y: round(y),
    uncertaintyMeters: round(clamp(rms + 1.5, floorUncertainty, 60)),
    method,
    relays: vertices.length,
    note: clipped ? `${note} At least one relay's implied distance hit the model's ceiling, so that relay is weakly constraining this fix.` : note,
    candidates: [],
    ring: null,
    residuals,
  };
}

/**
 * One observation per relay: the median of that relay's most recent levels. A single report
 * is one sample of a noisy channel, so the median of a few is the same measurement with the
 * noise reduced and no new claim added.
 */
export function latestPerRelay(
  rows: Array<{ nodeId: string; nodeName: string; signalDbm: number | null; observedAt: Date | string; x: number; y: number }>,
  options: { samplesPerRelay?: number } = {},
): Array<RelayObservation & { sampleCount: number }> {
  const samplesPerRelay = options.samplesPerRelay ?? 5;
  const byNode = new Map<string, Array<{ nodeId: string; nodeName: string; signalDbm: number; observedAt: string; x: number; y: number }>>();
  for (const row of rows) {
    if (typeof row.signalDbm !== 'number' || !Number.isFinite(row.signalDbm)) continue;
    const observedAt = row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt;
    const bucket = byNode.get(row.nodeId) ?? [];
    if (bucket.length >= samplesPerRelay) continue;
    bucket.push({ nodeId: row.nodeId, nodeName: row.nodeName, signalDbm: row.signalDbm, observedAt, x: row.x, y: row.y });
    byNode.set(row.nodeId, bucket);
  }
  return [...byNode.values()]
    .map((samples) => {
      const levels = samples.map((sample) => sample.signalDbm).sort((left, right) => left - right);
      const middle = Math.floor(levels.length / 2);
      const median = levels.length % 2 ? levels[middle] : (levels[middle - 1] + levels[middle]) / 2;
      return { ...samples[0], signalDbm: median, sampleCount: samples.length };
    })
    .sort((left, right) => left.nodeName.localeCompare(right.nodeName));
}

export interface TrackPoint {
  at: string;
  x: number;
  y: number;
  uncertaintyMeters: number;
  relays: number;
}

/**
 * The same estimate repeated over time, one point per time bucket, so a radio can be
 * followed rather than merely placed. Only buckets the geometry supports become points.
 */
export function estimateTrack(
  rows: Array<{ nodeId: string; nodeName: string; signalDbm: number | null; observedAt: Date | string; x: number; y: number }>,
  options: { bucketSeconds?: number; model?: RadioModel; maxPoints?: number } = {},
): TrackPoint[] {
  const bucketSeconds = options.bucketSeconds ?? 60;
  const maxPoints = options.maxPoints ?? 60;
  const buckets = new Map<number, typeof rows>();
  for (const row of rows) {
    const at = row.observedAt instanceof Date ? row.observedAt : new Date(row.observedAt);
    if (!Number.isFinite(at.getTime())) continue;
    const key = Math.floor(at.getTime() / (bucketSeconds * 1000));
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([key, bucket]) => {
      const estimate = estimatePosition(latestPerRelay(bucket), options.model ?? DEFAULT_RADIO_MODEL);
      if (estimate.status !== 'estimated' || estimate.x === null || estimate.y === null) return null;
      return {
        at: new Date(key * bucketSeconds * 1000).toISOString(),
        x: estimate.x,
        y: estimate.y,
        uncertaintyMeters: estimate.uncertaintyMeters ?? 0,
        relays: estimate.relays,
      };
    })
    .filter((point): point is TrackPoint => point !== null)
    .slice(-maxPoints);
}
