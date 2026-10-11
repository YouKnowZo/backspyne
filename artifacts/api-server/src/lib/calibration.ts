// Calibrating the radio model to the site it is used in.
//
// The position maths turns a received level into a distance through the log-distance
// path-loss model, and that model has constants: how strong a transmitter is at one metre,
// and how fast level falls away with distance. The deployed defaults are a reasonable indoor
// guess, which is exactly what they are — a guess. This module replaces them with constants
// fitted from measurements taken in the site itself.
//
// How a walk becomes a fit. A phone that is carried reports where it stood for every level it
// measured, so a walk around a fixed radio yields several (distance, level) pairs. Neither
// the distance nor the constants are known, but they constrain each other: a candidate
// exponent and reference level place the radio somewhere, that placement implies a distance
// from every vantage point, and those implied distances can be compared with the measured
// levels. Solving that jointly is what this file does: two closed-form steps and one small
// damped Gauss–Newton step alternate until the residuals stop improving, run from several
// starting layouts — but that alternation is not trustworthy on its own, because the exponent
// and the placement trade against each other along a nearly flat ridge. The exponent is
// therefore swept across its whole plausible range with everything else solved at each value,
// and the best fit wins outright. See `sweepExponent` for what goes wrong without that.
//
// Two honest properties fall out of the mathematics, and the caller is told about both:
//   * A single radio cannot separate a weak transmitter from a lossy site, so a one-radio fit
//     reports a reference level that carries that transmitter's power. Calibrating a second
//     radio separates them, because the exponent is shared while the reference level is not.
//   * The exponent is only identifiable when the levels actually varied, so a walk that never
//     gets close to (or far from) the radio is refused rather than fitted.
//
// Pure arithmetic with no database and no I/O, so every claim above can be tested directly.

// The extension is explicit because this module is imported directly by a Node test as well
// as bundled; `allowImportingTsExtensions` in this package's tsconfig covers the type check.
import {
  DEFAULT_RADIO_MODEL,
  MAX_IMPLIED_METERS,
  MIN_IMPLIED_METERS,
  impliedDistanceMeters,
  latestPerRelay,
  estimatePosition,
  type RadioModel,
} from "./localization.ts";

const LN10 = Math.LN10;

/** A plausible indoor exponent. Outside this range the fit is describing something else. */
export const EXPONENT_BOUNDS: [number, number] = [1.8, 5.5];
/** A plausible level one metre from a transmitter, in dBm. */
export const REFERENCE_DBM_BOUNDS: [number, number] = [-80, -25];
/** Vantage points needed per radio: three is the minimum for a fix, four is the minimum for a fit. */
export const MIN_VANTAGES_PER_TARGET = 4;
/** The walk must span at least this far, or the distances barely differ. */
export const MIN_VANTAGE_SPREAD_METERS = 8;
/** The reported levels must vary by at least this much, or the fall-off rate is unidentifiable. */
export const MIN_LEVEL_SPREAD_DB = 8;
/** A fitted radio further than this from the walk is not the radio that was walked around. */
export const MAX_TARGET_DISTANCE_METERS = 60;
/** Residuals above this suggest the walk measured something that moved. */
export const LARGE_RESIDUAL_DB = 7;

export interface CalibrationSample {
  targetId: string;
  label?: string;
  vantageKey: string;
  x: number;
  y: number;
  rssi: number;
}

export interface TargetSummary {
  targetId: string;
  label: string;
  samples: number;
  vantages: number;
  levelSpreadDb: number;
  vantageSpreadMeters: number;
  eligible: boolean;
  /**
   * The places this radio was heard from, in metres in the site frame: the walk as it was
   * recorded. Drawn by the console so the operator can see where the phone actually stood
   * before trusting what was fitted from it.
   */
  vantagePoints: Array<{ x: number; y: number }>;
  /** Why this radio cannot be fitted yet, in words the console can show unchanged. */
  reasons: string[];
}

export interface CalibrationTargetSolution {
  targetId: string;
  label: string;
  /** Level this radio produced at `referenceMeters`, from the fit. */
  referenceDbm: number;
  x: number;
  y: number;
  /** Places this radio's position was solved from: one observation each. */
  samples: number;
  /** Readings those places produced, which is what the walk actually collected. */
  readings: number;
  vantages: number;
  residualRmsDb: number;
  minDistanceMeters: number;
  maxDistanceMeters: number;
  /** False when trilateration under the generic model could not seed this position. */
  seededByGeometry: boolean;
}

export interface CalibrationFit {
  pathLossExponent: number;
  referenceMeters: number;
  /** The level used for radios that were not themselves calibrated: the median of the fitted ones. */
  referenceDbm: number;
  targets: CalibrationTargetSolution[];
  /** Readings the fit stands on, before repeats at one place were collapsed. */
  samples: number;
  /** Places the fit was solved from: one observation each, the level being the median there. */
  observations: number;
  vantages: number;
  residualRmsDb: number;
  clampedExponent: boolean;
  warnings: string[];
}

export type CalibrationOutcome =
  | { ok: true; fit: CalibrationFit; summaries: TargetSummary[] }
  | { ok: false; reasons: string[]; summaries: TargetSummary[] };

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, [low, high]: [number, number]): { value: number; clamped: boolean } {
  if (value < low) return { value: low, clamped: true };
  if (value > high) return { value: high, clamped: true };
  return { value, clamped: false };
}

/** Keeps a measured level inside the range the model and the schema accept. */
export function usableLevel(rssi: number): boolean {
  return Number.isFinite(rssi) && rssi >= -127 && rssi <= 20;
}

function distance(fromX: number, fromY: number, x: number, y: number): number {
  return Math.max(MIN_IMPLIED_METERS, Math.min(MAX_IMPLIED_METERS, Math.hypot(x - fromX, y - fromY)));
}

function spreadMeters(points: Array<{ x: number; y: number }>): number {
  let widest = 0;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      widest = Math.max(widest, Math.hypot(points[first].x - points[second].x, points[first].y - points[second].y));
    }
  }
  return widest;
}

/** A long walk has many squares; the console draws the first forty and says so. */
export const MAX_SUMMARY_VANTAGES = 40;
/** Places per radio the fit will use; beyond this the walk is subsampled evenly. */
export const MAX_OBSERVATIONS_PER_TARGET = 120;
/**
 * Readings of one radio taken at one place should agree within a few decibels. Wider than this
 * and the place is not measuring one stationary radio, which the caller is told about.
 */
export const MAX_PLACE_SPREAD_DB = 10;

/** One place's evidence: the level heard there, the readings behind it, and how much they differ. */
export interface VantageObservation {
  sample: CalibrationSample;
  readings: number;
  spreadDb: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Collapses readings to one observation per place: the median level heard there, and the mean
 * of the positions the relay reported while it stood there.
 *
 * The independent measurement in a walk is the *place*, not the reading. A phone left standing
 * for a minute produces a dozen readings from the same spot, and treating those as a dozen
 * measurements would let one place outvote the rest of the walk — the same mistake the
 * position maths avoids by bucketing reports from one spot. The median is used because a
 * single spurious reading at a place should not move it.
 */
export function collapseToVantages(samples: CalibrationSample[]): VantageObservation[] {
  const groups = new Map<string, { samples: CalibrationSample[]; readings: number }>();
  for (const sample of samples) {
    if (!usableLevel(sample.rssi) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    const key = `${sample.targetId}\u0000${sample.vantageKey}`;
    const group = groups.get(key) ?? { samples: [], readings: 0 };
    group.samples.push(sample);
    group.readings += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const levels = group.samples.map((sample) => sample.rssi);
    return {
      sample: {
        ...group.samples[0],
        x: group.samples.reduce((sum, sample) => sum + sample.x, 0) / group.samples.length,
        y: group.samples.reduce((sum, sample) => sum + sample.y, 0) / group.samples.length,
        rssi: median(levels),
      },
      readings: group.readings,
      spreadDb: Math.max(...levels) - Math.min(...levels),
    };
  });
}

/** Every `stride`-th observation, so a very long walk is thinned rather than truncated. */
function subsampleEvenly(observations: VantageObservation[], limit: number): VantageObservation[] {
  if (observations.length <= limit) return observations;
  const stride = observations.length / limit;
  return Array.from({ length: limit }, (_, index) => observations[Math.min(observations.length - 1, Math.floor(index * stride))]);
}

/** One summary per radio, with the reasons a radio is not yet fittable. */
export function summarizeCalibrationSamples(samples: CalibrationSample[]): TargetSummary[] {
  const byTarget = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    if (!usableLevel(sample.rssi) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    const bucket = byTarget.get(sample.targetId) ?? [];
    bucket.push(sample);
    byTarget.set(sample.targetId, bucket);
  }
  return [...byTarget.entries()]
    .map(([targetId, bucket]) => {
      const vantageByKey = new Map<string, { x: number; y: number }>();
      for (const sample of bucket) vantageByKey.set(sample.vantageKey, { x: sample.x, y: sample.y });
      const levels = bucket.map((sample) => sample.rssi);
      const levelSpreadDb = Math.max(...levels) - Math.min(...levels);
      const vantageSpread = spreadMeters([...vantageByKey.values()]);
      const reasons: string[] = [];
      if (vantageByKey.size < MIN_VANTAGES_PER_TARGET) {
        reasons.push(`${vantageByKey.size} place${vantageByKey.size === 1 ? "" : "s"} recorded — ${MIN_VANTAGES_PER_TARGET} are needed, so stand still at ${MIN_VANTAGES_PER_TARGET - vantageByKey.size} more.`);
      }
      if (vantageByKey.size >= 2 && vantageSpread < MIN_VANTAGE_SPREAD_METERS) {
        reasons.push(`The places recorded span ${round(vantageSpread)} m — walk at least ${MIN_VANTAGE_SPREAD_METERS} m so the distances to this radio differ enough to fit.`);
      }
      if (levelSpreadDb < MIN_LEVEL_SPREAD_DB) {
        reasons.push(`The levels varied by only ${round(levelSpreadDb)} dB — walk closer to and further from this radio so the fall-off rate is identifiable.`);
      }
      const vantagePoints = [...vantageByKey.values()]
        .sort((left, right) => left.y - right.y || left.x - right.x)
        .slice(0, MAX_SUMMARY_VANTAGES)
        .map((point) => ({ x: round(point.x, 2), y: round(point.y, 2) }));
      return {
        targetId,
        label: bucket[0].label || targetId,
        samples: bucket.length,
        vantages: vantageByKey.size,
        levelSpreadDb: round(levelSpreadDb),
        vantageSpreadMeters: round(vantageSpread),
        eligible: reasons.length === 0,
        vantagePoints,
        reasons,
      };
    })
    .sort((left, right) => right.vantages - left.vantages || left.label.localeCompare(right.label));
}

interface WorkingTarget {
  targetId: string;
  label: string;
  /** One sample per place, the level at that place being the median of its readings. */
  samples: CalibrationSample[];
  /** The readings those observations were collapsed from. */
  readings: number;
  /** How wide each place's readings were, aligned with `samples`, for the disagreement warning. */
  spreads: number[];
  x: number;
  y: number;
  referenceDbm: number;
  seededByGeometry: boolean;
}

/** The state of one converged search, including which of its constants had to be limited. */
interface DescentResult {
  targets: WorkingTarget[];
  exponent: number;
  sse: number;
  clampedExponent: boolean;
  referenceClamped: boolean;
}

function cloneTargets(list: WorkingTarget[]): WorkingTarget[] {
  return list.map((target) => ({ ...target }));
}

function centreOf(target: WorkingTarget): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const sample of target.samples) {
    x += sample.x;
    y += sample.y;
  }
  return { x: x / target.samples.length, y: y / target.samples.length };
}

/** Re-solves one target's reference level and reports whether the bounds had to hold it back. */
function refreshReference(target: WorkingTarget, exponent: number): boolean {
  const reference = clamp(solveReferenceDbm(target, exponent), REFERENCE_DBM_BOUNDS);
  target.referenceDbm = reference.value;
  return reference.clamped;
}

/**
 * Positions and reference levels with the exponent held fixed, which is the sub-problem an
 * exponent sweep has to solve. Only the better of the states it passes through is kept, so a
 * step that overshoots can never leave the caller worse off than it started.
 */
function fitPositions(input: WorkingTarget[], exponent: number, rounds: number): DescentResult {
  const targets = cloneTargets(input);
  let referenceClamped = false;
  for (const target of targets) referenceClamped = refreshReference(target, exponent) || referenceClamped;

  let bestTargets = cloneTargets(targets);
  let bestSse = sumSquares(targets, exponent);
  let previous = bestSse;
  for (let round = 0; round < rounds; round += 1) {
    for (const target of targets) {
      refinePosition(target, exponent);
      referenceClamped = refreshReference(target, exponent) || referenceClamped;
    }
    const current = sumSquares(targets, exponent);
    if (!Number.isFinite(current)) break;
    if (current < bestSse) {
      bestSse = current;
      bestTargets = cloneTargets(targets);
    }
    if (previous - current < 1e-6) break;
    previous = current;
  }

  return { targets: bestTargets, exponent, sse: bestSse, clampedExponent: false, referenceClamped };
}

/**
 * Alternating descent with the exponent free: positions by damped Gauss–Newton, then the
 * reference levels, then the one site-wide exponent, until the residuals stop improving.
 *
 * Only ever run once the sweep below has landed in the right basin: on its own this cannot be
 * trusted, for the reason the sweep exists.
 */
function descend(input: WorkingTarget[], exponentStart: number): DescentResult {
  const targets = cloneTargets(input);
  const first = clamp(exponentStart, EXPONENT_BOUNDS);
  let exponent = first.value;
  let clampedExponent = first.clamped;
  let referenceClamped = false;
  for (const target of targets) referenceClamped = refreshReference(target, exponent) || referenceClamped;

  let bestTargets = cloneTargets(targets);
  let bestExponent = exponent;
  let bestSse = sumSquares(targets, exponent);
  let previous = bestSse;
  for (let round = 0; round < 40; round += 1) {
    for (const target of targets) {
      refinePosition(target, exponent);
      referenceClamped = refreshReference(target, exponent) || referenceClamped;
    }
    const next = clamp(solveExponent(targets), EXPONENT_BOUNDS);
    clampedExponent = clampedExponent || next.clamped;
    exponent = next.value;
    const current = sumSquares(targets, exponent);
    if (!Number.isFinite(current)) break;
    if (current < bestSse) {
      bestSse = current;
      bestExponent = exponent;
      bestTargets = cloneTargets(targets);
    }
    if (previous - current < 1e-6) break;
    previous = current;
  }

  return { targets: bestTargets, exponent: bestExponent, sse: bestSse, clampedExponent, referenceClamped };
}

/**
 * Sweeps the exponent across its range, fitting positions at each value, and keeps the best.
 *
 * This is the heart of the solver, because the exponent cannot be found by descending alone.
 * A radio placed further away predicts weaker levels, and a smaller exponent then reproduces
 * those same weaker levels, so along that trade-off the residual is almost flat while the
 * position moves. An alternating descent started anywhere on that ridge walks along it and
 * stops at whichever end it happens to reach — a fit that is self-consistent, reproduces every
 * level, and is not the best fit, and whose constants are wrong by a wide margin. Holding the
 * exponent and solving everything else at each value removes the ridge: the position that best
 * explains the levels at one exponent is compared directly with the position that best
 * explains them at the next, and the sweep is continued from the previous answer so a fine
 * step is cheap. The residue is a genuinely one-dimensional problem, so the range is scanned
 * completely rather than optimised locally.
 */
function sweepExponent(input: WorkingTarget[], from: number, to: number, steps: number, rounds: number): DescentResult {
  let best: DescentResult | null = null;
  let carried = cloneTargets(input);
  for (let step = 0; step <= steps; step += 1) {
    const exponent = from + ((to - from) * step) / steps;
    const run = fitPositions(carried, exponent, rounds);
    carried = run.targets;
    if (!Number.isFinite(run.sse)) continue;
    if (!best || run.sse < best.sse) best = run;
  }
  if (best) return best;
  // Every value failed, which no real measurement does; report the input unchanged.
  return { targets: cloneTargets(input), exponent: from, sse: Number.POSITIVE_INFINITY, clampedExponent: false, referenceClamped: false };
}

function residualOf(sample: CalibrationSample, x: number, y: number, referenceDbm: number, exponent: number): number {
  return sample.rssi - referenceDbm + 10 * exponent * Math.log10(distance(sample.x, sample.y, x, y));
}

function sumSquares(targets: WorkingTarget[], exponent: number): number {
  let total = 0;
  for (const target of targets) {
    for (const sample of target.samples) {
      total += residualOf(sample, target.x, target.y, target.referenceDbm, exponent) ** 2;
    }
  }
  return total;
}

/**
 * The level one metre from a transmitter, with the position and exponent held: the mean of
 * what each sample implies. Closed form, so it never wanders.
 */
function solveReferenceDbm(target: WorkingTarget, exponent: number): number {
  let total = 0;
  for (const sample of target.samples) {
    total += sample.rssi + 10 * exponent * Math.log10(distance(sample.x, sample.y, target.x, target.y));
  }
  return total / target.samples.length;
}

/**
 * The site exponent, with every position and reference level held: one least-squares value
 * across all radios at once, which is what makes the exponent a property of the site rather
 * than of one transmitter.
 */
function solveExponent(targets: WorkingTarget[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const target of targets) {
    for (const sample of target.samples) {
      const levelLog = Math.log10(distance(sample.x, sample.y, target.x, target.y));
      numerator += levelLog * (target.referenceDbm - sample.rssi);
      denominator += levelLog ** 2;
    }
  }
  if (denominator <= 0) return DEFAULT_RADIO_MODEL.pathLossExponent;
  return numerator / (10 * denominator);
}

/** One damped Gauss–Newton step of the transmitter's position, given level and exponent. */
function refinePosition(target: WorkingTarget, exponent: number, steps = 16): void {
  for (let step = 0; step < steps; step += 1) {
    let jxx = 0;
    let jxy = 0;
    let jyy = 0;
    let jxr = 0;
    let jyr = 0;
    for (const sample of target.samples) {
      const meters = distance(sample.x, sample.y, target.x, target.y);
      const residual = residualOf(sample, target.x, target.y, target.referenceDbm, exponent);
      const scale = (10 * exponent) / LN10 / (meters * meters);
      const dx = target.x - sample.x;
      const dy = target.y - sample.y;
      jxx += scale * scale * dx * dx;
      jxy += scale * scale * dx * dy;
      jyy += scale * scale * dy * dy;
      jxr += scale * dx * residual;
      jyr += scale * dy * residual;
    }
    const trace = jxx + jyy;
    if (!Number.isFinite(trace) || trace <= 0) return;
    let damping = Math.max(trace * 1e-3, 1e-9);
    let moved = false;
    for (let attempt = 0; attempt < 6 && !moved; attempt += 1) {
      const a = jxx + damping;
      const c = jyy + damping;
      const determinant = a * c - jxy * jxy;
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
        damping *= 10;
        continue;
      }
      const stepX = (-jxr * c + jyr * jxy) / determinant;
      const stepY = (-jyr * a + jxr * jxy) / determinant;
      if (!Number.isFinite(stepX) || !Number.isFinite(stepY)) {
        damping *= 10;
        continue;
      }
      // A single step may not teleport the target: it is refined, not thrown.
      const limit = 5;
      const length = Math.hypot(stepX, stepY);
      const factor = length > limit ? limit / length : 1;
      const nextX = target.x + stepX * factor;
      const nextY = target.y + stepY * factor;
      const before = target.samples.reduce((sum, sample) => sum + residualOf(sample, target.x, target.y, target.referenceDbm, exponent) ** 2, 0);
      const after = target.samples.reduce((sum, sample) => sum + residualOf(sample, nextX, nextY, target.referenceDbm, exponent) ** 2, 0);
      if (after <= before) {
        target.x = nextX;
        target.y = nextY;
        moved = true;
      } else {
        damping *= 10;
      }
    }
    if (!moved) return;
  }
}

/**
 * Fits the site's path-loss constants from a walk, and refuses to fit when the data cannot
 * support the answer. `options.model` is the model used to seed positions, so a second
 * calibration can start from the first one's constants.
 */
export function fitSiteCalibration(samples: CalibrationSample[], options: { model?: RadioModel; rounded?: boolean } = {}): CalibrationOutcome {
  const seedModel = options.model ?? DEFAULT_RADIO_MODEL;
  const summaries = summarizeCalibrationSamples(samples);
  const eligible = summaries.filter((summary) => summary.eligible);
  if (!eligible.length) {
    const headline = summaries.length
      ? "No radio has a long enough walk to fit yet. A calibration walk needs one fixed radio heard from at least four places, spanning eight metres, with the levels varying by eight decibels or more."
      : "No measured sighting from a moving relay is in the window, so there is nothing to fit. Start the relay on a phone, then walk around one fixed radio.";
    return {
      ok: false,
      reasons: [headline, ...summaries.flatMap((summary) => summary.reasons.map((reason) => `${summary.label}: ${reason}`))],
      summaries,
    };
  }

  const targets: WorkingTarget[] = [];
  for (const summary of eligible) {
    // Repeats at one place are one observation, and a very long walk is thinned rather than
    // solved in full: the arithmetic below is quadratic in the number of observations, and a
    // hundred places already describe the site far better than the model can.
    const collapsed = subsampleEvenly(
      collapseToVantages(samples.filter((sample) => sample.targetId === summary.targetId)),
      MAX_OBSERVATIONS_PER_TARGET,
    );
    const targetSamples = collapsed.map((observation) => observation.sample);
    const vantagePoints = [...new Map(targetSamples.map((sample) => [sample.vantageKey, { x: sample.x, y: sample.y }])).values()];
    // Seed the search from ordinary trilateration, so the fit starts where the site's own
    // generic model would have put the radio, and only the constants move from there.
    const seed = estimatePosition(latestPerRelay(targetSamples.map((sample) => ({
      nodeId: sample.vantageKey,
      nodeName: sample.vantageKey,
      signalDbm: sample.rssi,
      observedAt: new Date(0),
      x: sample.x,
      y: sample.y,
    }))), seedModel);
    const seededByGeometry = seed.status === "estimated" && seed.x !== null && seed.y !== null;
    const centre = vantagePoints.reduce((accumulator, point) => ({ x: accumulator.x + point.x / vantagePoints.length, y: accumulator.y + point.y / vantagePoints.length }), { x: 0, y: 0 });
    const start = seededByGeometry ? { x: seed.x as number, y: seed.y as number } : centre;
    targets.push({
      targetId: summary.targetId,
      label: summary.label,
      samples: targetSamples,
      readings: collapsed.reduce((sum, observation) => sum + observation.readings, 0),
      spreads: collapsed.map((observation) => observation.spreadDb),
      x: start.x,
      y: start.y,
      referenceDbm: seedModel.referenceDbm,
      seededByGeometry,
    });
  }

  // Three starting layouts for the transmitters: where ordinary trilateration puts them, the
  // centre of the walk, and the place the strongest level was heard (which is near the radio
  // whenever the levels fell off at all). Several starts, because the descent is local.
  const seeds: WorkingTarget[][] = [
    cloneTargets(targets),
    targets.map((target) => {
      const centre = centreOf(target);
      return { ...target, x: centre.x, y: centre.y };
    }),
    targets.map((target) => {
      const strongest = target.samples.reduce((pick, sample) => (pick === null || sample.rssi > pick.rssi ? sample : pick), null as CalibrationSample | null);
      return strongest ? { ...target, x: strongest.x, y: strongest.y } : { ...target };
    }),
  ];

  const [low, high] = EXPONENT_BOUNDS;
  // A thorough search costs seconds on a walk that collected hundreds of places and buys
  // nothing there: the data has already pinned the answer, so the effort is spent where it
  // changes the result, on the short walks an operator is still building.
  const observationCount = targets.reduce((sum, target) => sum + target.samples.length, 0);
  const coarseSteps = observationCount <= 60 ? 14 : observationCount <= 200 ? 10 : 7;
  const fineSteps = observationCount <= 60 ? 12 : 8;
  const effortful = observationCount <= 200 ? seeds : [seeds[0], seeds[2]];
  let best: DescentResult | null = null;

  // Coarse sweep of the whole plausible range from every starting layout, in both directions
  // (a sweep can only converge to the nearest good basin, so which way it runs matters), then
  // a fine sweep around the winner, then one alternating pass, which polishes the constants.
  for (const seed of effortful) {
    const forward = sweepExponent(seed, low, high, coarseSteps, 8);
    if (Number.isFinite(forward.sse) && (best === null || forward.sse < best.sse)) best = forward;
    const backward = sweepExponent(seed, high, low, coarseSteps, 8);
    if (Number.isFinite(backward.sse) && (best === null || backward.sse < best.sse)) best = backward;
  }
  if (best !== null) {
    const coarse = best;
    const fine = sweepExponent(coarse.targets, Math.max(low, coarse.exponent - 0.3), Math.min(high, coarse.exponent + 0.3), fineSteps, 6);
    if (Number.isFinite(fine.sse) && fine.sse < coarse.sse) best = fine;
  }
  if (best !== null) {
    const swept = best;
    const polished = descend(swept.targets, swept.exponent);
    if (Number.isFinite(polished.sse)) {
      best = {
        ...polished,
        clampedExponent: polished.clampedExponent || swept.clampedExponent,
        referenceClamped: polished.referenceClamped || swept.referenceClamped,
      };
    }
  }
  if (!best) {
    return { ok: false, reasons: ["The fit did not converge on this data, so nothing was stored. Check that the relay kept reporting positions during the walk."], summaries };
  }
  const winner = best;
  for (const [index, solution] of winner.targets.entries()) {
    targets[index].x = solution.x;
    targets[index].y = solution.y;
    targets[index].referenceDbm = solution.referenceDbm;
  }
  const exponent = winner.exponent;
  const clampedExponent = winner.clampedExponent;
  const referenceClamped = winner.referenceClamped;

  // A radio that ends up far outside the walk was not the radio that was walked around.
  const wanderers = targets.filter((target) => {
    const points = target.samples.map((sample) => ({ x: sample.x, y: sample.y }));
    const centreX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const centreY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    return Math.hypot(target.x - centreX, target.y - centreY) > MAX_TARGET_DISTANCE_METERS;
  });
  if (wanderers.length) {
    return {
      ok: false,
      reasons: wanderers.map((target) => `${target.label}: the fit placed this radio ${round(Math.hypot(target.x, target.y))} m from the site origin, which is further than ${MAX_TARGET_DISTANCE_METERS} m from the walk itself. That usually means the walk measured more than one radio under this identity, or the phone's positions were wrong.`),
      summaries,
    };
  }

  const solutions: CalibrationTargetSolution[] = targets.map((target) => {
    const residuals = target.samples.map((sample) => residualOf(sample, target.x, target.y, target.referenceDbm, exponent));
    const distances = target.samples.map((sample) => distance(sample.x, sample.y, target.x, target.y));
    const vantageKeys = new Set(target.samples.map((sample) => sample.vantageKey));
    return {
      targetId: target.targetId,
      label: target.label,
      referenceDbm: round(target.referenceDbm),
      x: round(target.x),
      y: round(target.y),
      samples: target.samples.length,
      readings: target.readings,
      vantages: vantageKeys.size,
      residualRmsDb: round(Math.sqrt(residuals.reduce((sum, residual) => sum + residual ** 2, 0) / residuals.length), 2),
      minDistanceMeters: round(Math.min(...distances)),
      maxDistanceMeters: round(Math.max(...distances)),
      seededByGeometry: target.seededByGeometry,
    };
  });

  const allResiduals = targets.flatMap((target) => target.samples.map((sample) => residualOf(sample, target.x, target.y, target.referenceDbm, exponent)));
  const residualRmsDb = Math.sqrt(allResiduals.reduce((sum, residual) => sum + residual ** 2, 0) / allResiduals.length);
  const referenceLevels = [...solutions.map((solution) => solution.referenceDbm)].sort((left, right) => left - right);
  const middle = Math.floor(referenceLevels.length / 2);
  const referenceDbm = referenceLevels.length % 2
    ? referenceLevels[middle]
    : round((referenceLevels[middle - 1] + referenceLevels[middle]) / 2);

  const warnings: string[] = [];
  if (clampedExponent) warnings.push(`The fitted exponent was limited to ${EXPONENT_BOUNDS[0]}–${EXPONENT_BOUNDS[1]}; the measurements cannot support a value outside that range for an indoor site.`);
  if (referenceClamped) warnings.push(`A fitted reference level was limited to ${REFERENCE_DBM_BOUNDS[0]} to ${REFERENCE_DBM_BOUNDS[1]} dBm; check that the walk happened where you think it did.`);
  if (solutions.length === 1) warnings.push("The reference level came from one radio, so it includes that transmitter's own power and antenna. Calibrating a second radio separates the site's loss from one transmitter's power.");
  if (solutions.some((solution) => !solution.seededByGeometry)) warnings.push("At least one position could not be seeded by ordinary trilateration under the generic model, so this fit started from the centre of the walk instead.");
  if (residualRmsDb > LARGE_RESIDUAL_DB) warnings.push(`Residuals are ${round(residualRmsDb, 1)} dB, which is large. A radio that moved during the walk, or two radios reporting under one identity, both look like this.`);
  // Repeats at a place are collapsed to their median, which is the right summary for one
  // stationary radio — and hides the wrong one. Readings at a single place that disagree this
  // widely were not measuring one stationary radio, so the fit says so rather than presenting
  // a median as a measurement.
  const widestPlaceSpread = targets.reduce((widest, target) => Math.max(widest, ...target.spreads, 0), 0);
  if (widestPlaceSpread > MAX_PLACE_SPREAD_DB) {
    warnings.push(`At one place, readings of the same radio disagreed by ${round(widestPlaceSpread, 1)} dB. Something moved there — a radio, a person, or the phone — so that place's level is the median of readings that do not describe one spot.`);
  }

  return {
    ok: true,
    summaries,
    fit: {
      pathLossExponent: round(exponent, 2),
      referenceMeters: seedModel.referenceMeters,
      referenceDbm,
      targets: solutions,
      samples: solutions.reduce((sum, solution) => sum + solution.readings, 0),
      observations: solutions.reduce((sum, solution) => sum + solution.samples, 0),
      vantages: solutions.reduce((sum, solution) => sum + solution.vantages, 0),
      residualRmsDb: round(residualRmsDb, 2),
      clampedExponent,
      warnings,
    },
  };
}

/**
 * The model the position maths should use. A radio that was itself calibrated uses its own
 * reference level, because that level is where its transmit power was measured; every other
 * radio uses the median of the calibrated ones, which is stated rather than hidden.
 */
export function calibratedRadioModel(
  calibration: Pick<CalibrationFit, "pathLossExponent" | "referenceDbm" | "referenceMeters" | "targets">,
  deviceId?: string,
): RadioModel {
  const target = deviceId ? calibration.targets.find((solution) => solution.targetId === deviceId) : undefined;
  return {
    referenceDbm: target ? target.referenceDbm : calibration.referenceDbm,
    pathLossExponent: calibration.pathLossExponent,
    referenceMeters: calibration.referenceMeters,
  };
}

/** How far the fitted model and the generic default disagree at a given level. */
export function compareAtLevel(levelDbm: number, calibration: Pick<CalibrationFit, "pathLossExponent" | "referenceDbm" | "referenceMeters" | "targets">, deviceId?: string): { genericMeters: number; calibratedMeters: number } {
  return {
    genericMeters: round(impliedDistanceMeters(levelDbm, DEFAULT_RADIO_MODEL), 1),
    calibratedMeters: round(impliedDistanceMeters(levelDbm, calibratedRadioModel(calibration, deviceId)), 1),
  };
}
