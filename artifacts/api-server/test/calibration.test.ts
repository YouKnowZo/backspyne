// Tests for the calibration walk's solver.
//
//   node --experimental-strip-types --test artifacts/api-server/test/calibration.test.ts
//
// A calibration replaces the constants every distance in the product is measured with, so it
// is tested the only way that proves anything: a site is synthesized with known constants and
// a radio at a known position, levels are computed from that model, and the solver has to
// recover what was put in. The cases that must be refused are asserted too — a short walk, a
// walk that never changes distance, and a walk whose levels barely varied — because a fit
// that quietly succeeds on unusable data is worse than no calibration at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPONENT_BOUNDS,
  MIN_VANTAGES_PER_TARGET,
  MIN_VANTAGE_SPREAD_METERS,
  calibratedRadioModel,
  compareAtLevel,
  fitSiteCalibration,
  summarizeCalibrationSamples,
  type CalibrationSample,
} from "../src/lib/calibration.ts";
import {
  MAX_OBSERVATIONS_PER_TARGET,
  collapseToVantages,
  usableLevel,
} from "../src/lib/calibration.ts";
import { DEFAULT_RADIO_MODEL, estimatePosition, latestPerRelay, modelledDbmAt } from "../src/lib/localization.ts";

type Walk = Array<{ x: number; y: number }>;

const err = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** A walk with given ground truth: what the levels would be if the site were this model. */
function synthesize(options: { targetId: string; label?: string; p0: number; exponent: number; target: { x: number; y: number }; walk: Walk; jitterDb?: number; round?: boolean }): CalibrationSample[] {
  const jitter = options.jitterDb ?? 0.4;
  return options.walk.map((point, index) => {
    const meters = Math.hypot(point.x - options.target.x, point.y - options.target.y);
    const level = options.p0 - 10 * options.exponent * Math.log10(meters) + ((index % 3) - 1) * jitter;
    return {
      targetId: options.targetId,
      label: options.label ?? options.targetId,
      vantageKey: `${options.targetId}#${point.x}:${point.y}`,
      x: point.x,
      y: point.y,
      rssi: options.round === false ? level : Math.round(level),
    };
  });
}

/** A walk that goes past a radio, so distances and levels both vary a lot. */
const WALK_AROUND: Walk = [
  { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }, { x: 12, y: 0 },
  { x: 12, y: 6 }, { x: 6, y: 10 }, { x: 0, y: 6 },
];

test("a walk recovers the site's constants and where the radio is", () => {
  const truth = { p0: -46, exponent: 3.2, target: { x: 10, y: 4 } };
  const samples = synthesize({ targetId: "device_a", p0: truth.p0, exponent: truth.exponent, target: truth.target, walk: WALK_AROUND });

  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const fit = outcome.fit;

  assert.ok(Math.abs(fit.pathLossExponent - truth.exponent) < 0.5, `exponent ${fit.pathLossExponent} did not recover ${truth.exponent}`);
  const solution = fit.targets[0];
  assert.equal(fit.targets.length, 1);
  assert.equal(solution.vantages, WALK_AROUND.length);
  assert.equal(fit.samples, WALK_AROUND.length);
  assert.ok(Math.abs(solution.referenceDbm - truth.p0) < 4, `reference ${solution.referenceDbm} dBm did not recover ${truth.p0} dBm`);
  assert.ok(err(solution, truth.target) < 2.5, `position ${solution.x},${solution.y} did not recover ${truth.target.x},${truth.target.y}`);
  assert.ok(fit.residualRmsDb < 3, `residuals ${fit.residualRmsDb} dB are larger than the noise that was put in`);
  assert.ok(solution.minDistanceMeters < solution.maxDistanceMeters);
  // One radio means the reference level carries that transmitter, and the fit says so.
  assert.ok(fit.warnings.some((warning) => warning.includes("one radio")));

  // The point of calibrating: the generic model is measurably worse on the same measurements.
  const rows = samples.map((sample) => ({
    nodeId: sample.vantageKey,
    nodeName: sample.vantageKey,
    signalDbm: sample.rssi,
    observedAt: new Date(0),
    x: sample.x,
    y: sample.y,
  }));
  const generic = estimatePosition(latestPerRelay(rows), DEFAULT_RADIO_MODEL);
  assert.equal(generic.status, "estimated");
  const genericError = err({ x: generic.x as number, y: generic.y as number }, truth.target);
  assert.ok(genericError > err(solution, truth.target), `the calibrated fit (${err(solution, truth.target).toFixed(2)} m) was not better than the generic model (${genericError.toFixed(2)} m)`);

  // And the model the rest of the product would use is the fitted one.
  const model = calibratedRadioModel(fit, "device_a");
  assert.equal(model.pathLossExponent, fit.pathLossExponent);
  assert.equal(model.referenceDbm, solution.referenceDbm);
  assert.equal(model.referenceMeters, DEFAULT_RADIO_MODEL.referenceMeters);
  const atLevel = compareAtLevel(-70, fit, "device_a");
  assert.ok(atLevel.calibratedMeters < atLevel.genericMeters, `at -70 dBm the calibrated model said ${atLevel.calibratedMeters} m and the generic model ${atLevel.genericMeters} m`);
});

test("two radios separate the site's loss from one transmitter's power", () => {
  const walkA: Walk = WALK_AROUND;
  const walkB: Walk = [{ x: 0, y: 0 }, { x: -5, y: 0 }, { x: -10, y: 0 }, { x: -10, y: -6 }, { x: -4, y: -8 }];
  const samples = [
    ...synthesize({ targetId: "device_a", label: "Beacon A", p0: -46, exponent: 3.1, target: { x: 10, y: 4 }, walk: walkA }),
    ...synthesize({ targetId: "device_b", label: "Beacon B", p0: -55, exponent: 3.1, target: { x: -6, y: 8 }, walk: walkB }),
  ];

  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const fit = outcome.fit;

  assert.equal(fit.targets.length, 2);
  assert.ok(Math.abs(fit.pathLossExponent - 3.1) < 0.5, `shared exponent ${fit.pathLossExponent} did not recover 3.1`);
  const a = fit.targets.find((target) => target.targetId === "device_a");
  const b = fit.targets.find((target) => target.targetId === "device_b");
  assert.ok(a && b);
  assert.ok(Math.abs((a as typeof a).referenceDbm + 46) < 4, `radio A's level ${a?.referenceDbm} did not recover -46`);
  assert.ok(Math.abs((b as typeof b).referenceDbm + 55) < 5, `radio B's level ${b?.referenceDbm} did not recover -55`);
  assert.ok(err(a as { x: number; y: number }, { x: 10, y: 4 }) < 3);
  assert.ok(err(b as { x: number; y: number }, { x: -6, y: 8 }) < 3);
  // The radios differ by nine decibels, which is the transmitter, not the site.
  assert.ok(Math.abs(((b as typeof b).referenceDbm - (a as typeof a).referenceDbm) + 9) < 4, `radio levels ${(a as typeof a).referenceDbm} and ${(b as typeof b).referenceDbm} differ by ${Math.abs((b as typeof b).referenceDbm - (a as typeof a).referenceDbm)} dB, not ${9}`);
  assert.equal(fit.warnings.some((warning) => warning.includes("one radio")), false);
  // The shared level sits between the two, and each calibrated radio keeps its own.
  assert.ok(fit.referenceDbm <= (a as typeof a).referenceDbm && fit.referenceDbm >= (b as typeof b).referenceDbm);
  assert.equal(calibratedRadioModel(fit, "device_b").referenceDbm, (b as typeof b).referenceDbm);
  assert.equal(calibratedRadioModel(fit, "device_not_calibrated").referenceDbm, fit.referenceDbm);
});

test("three places are refused with the count that is missing", () => {
  const samples = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 10, y: 4 }, walk: WALK_AROUND.slice(0, 3) });
  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.summaries.length, 1);
  assert.equal(outcome.summaries[0].vantages, 3);
  assert.equal(outcome.summaries[0].eligible, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes(`${MIN_VANTAGES_PER_TARGET}`)), `no reason mentioned ${MIN_VANTAGES_PER_TARGET} places`);
});

test("a walk that never covers ground is refused, however many readings it made", () => {
  const samples = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 10, y: 4 }, walk: [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 },
  ] });
  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.summaries[0].vantageSpreadMeters < MIN_VANTAGE_SPREAD_METERS);
  assert.ok(outcome.reasons.some((reason) => reason.includes("span")), 'no reason mentioned the distance spanned by the walk');
});

test("a walk where the levels barely varied cannot identify the fall-off rate", () => {
  // A radio far enough away that a twelve-metre walk hardly changes the distance to it, and
  // close enough that its levels are still measurable: the walk covers ground and the levels
  // are real, but they vary by about two decibels, so the fall-off rate cannot be identified.
  const samples = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 40, y: 40 }, walk: [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }, { x: 12, y: 0 }, { x: 6, y: 10 },
  ], jitterDb: 0 });
  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.summaries.length, 1);
  assert.equal(outcome.summaries[0].eligible, false);
  assert.ok(outcome.summaries[0].vantageSpreadMeters >= MIN_VANTAGE_SPREAD_METERS, 'this case is meant to pass the spread check and fail on the levels');
  assert.ok(outcome.summaries[0].levelSpreadDb < 8, `levels varied by ${outcome.summaries[0].levelSpreadDb} dB`);
  assert.ok(outcome.reasons.some((reason) => reason.includes("dB")), 'no reason mentioned how little the levels varied');
});

test("an exponent the data cannot support is limited and reported", () => {
  // A site that falls away at 60 dB per decade is an exponent of 6, past the indoor range.
  const samples = synthesize({ targetId: "device_a", p0: -35, exponent: 6, target: { x: 10, y: 4 }, walk: WALK_AROUND });
  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.fit.clampedExponent, true);
  assert.ok(outcome.fit.pathLossExponent <= EXPONENT_BOUNDS[1]);
  assert.ok(outcome.fit.warnings.some((warning) => warning.includes("limited")));
});

test('the summary a walk reports is the same one the fit was judged by', () => {
  const samples = synthesize({ targetId: "device_a", label: "Beacon A", p0: -46, exponent: 3.2, target: { x: 10, y: 4 }, walk: WALK_AROUND });
  const summaries = summarizeCalibrationSamples(samples);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].eligible, true);
  assert.equal(summaries[0].label, "Beacon A");
  assert.equal(summaries[0].vantages, WALK_AROUND.length);
  assert.equal(summaries[0].reasons.length, 0);
  assert.ok(summaries[0].levelSpreadDb >= 8);
  // The places the walk recorded travel with the summary, so the console can draw them: one
  // point per vantage, and the same bucketed key never counted twice.
  assert.equal(summaries[0].vantagePoints.length, WALK_AROUND.length);
  assert.deepEqual([...summaries[0].vantagePoints].sort((left, right) => left.x - right.x || left.y - right.y), [...WALK_AROUND].sort((left, right) => left.x - right.x || left.y - right.y));
  const withDuplicates = [...samples, { ...samples[0], vantageKey: samples[0].vantageKey, rssi: samples[0].rssi + 1 }];
  assert.equal(summarizeCalibrationSamples(withDuplicates)[0].vantagePoints.length, WALK_AROUND.length);

  // A level that is not a measurement at all is discarded rather than fitted.
  const withRubbish = [...samples, { ...samples[0], rssi: Number.NaN }, { ...samples[0], rssi: -200 }];
  assert.equal(summarizeCalibrationSamples(withRubbish)[0].samples, samples.length);
});

test("a place's evidence is its median level, its mean position, and how wide it was", () => {
  const samples: CalibrationSample[] = [
    { targetId: "a", label: "A", vantageKey: "relay#0:0", x: 0, y: 0, rssi: -60 },
    { targetId: "a", label: "A", vantageKey: "relay#0:0", x: 1, y: 2, rssi: -70 },
    { targetId: "a", label: "A", vantageKey: "relay#0:0", x: 2, y: 4, rssi: -80 },
    { targetId: "a", label: "A", vantageKey: "relay#10:0", x: 10, y: 0, rssi: -50 },
    // Not a measurement at all, and not counted as one.
    { targetId: "a", label: "A", vantageKey: "relay#10:0", x: 10, y: 0, rssi: -200 },
  ];
  const observations = collapseToVantages(samples);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].readings, 3);
  assert.equal(observations[0].sample.rssi, -70);
  assert.equal(observations[0].sample.x, 1);
  assert.equal(observations[0].sample.y, 2);
  assert.equal(observations[0].spreadDb, 20);
  assert.equal(observations[1].readings, 1);
  assert.equal(observations[1].spreadDb, 0);
});

test("a very long walk is thinned to a bounded number of places, and still fitted from real ones", () => {
  const walk = Array.from({ length: MAX_OBSERVATIONS_PER_TARGET * 2 }, (_, index) => ({
    x: Math.round((index / 4) * 10) / 10 - 10,
    y: Math.round(12 * Math.sin(index / 9) * 10) / 10,
  }));
  const samples = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 18, y: 0 }, walk, jitterDb: 0.5 });
  assert.ok(samples.every(sample => usableLevel(sample.rssi)), "the generated walk is meant to be entirely measurable");
  const outcome = fitSiteCalibration(samples);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.fit.observations <= MAX_OBSERVATIONS_PER_TARGET, `${outcome.fit.observations} observations were used, past the ${MAX_OBSERVATIONS_PER_TARGET} cap`);
  assert.equal(outcome.fit.targets[0].samples, outcome.fit.observations);
  assert.equal(outcome.fit.targets[0].readings, outcome.fit.observations);
  assert.ok(Math.abs(outcome.fit.pathLossExponent - 3.2) < 0.6, `thinning moved the exponent to ${outcome.fit.pathLossExponent}`);
  assert.ok(err(outcome.fit.targets[0], { x: 18, y: 0 }) < 3, `thinning moved the position to ${outcome.fit.targets[0].x},${outcome.fit.targets[0].y}`);
});

test("a walk whose readings cannot describe one radio is refused or warned about", () => {
  // Two radios' measurements merged under one identity: either the fit cannot place them and
  // is refused, or it succeeds with a warning that says what is wrong. What it must never do
  // is report a clean fit.
  const first = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 10, y: 4 }, walk: WALK_AROUND });
  const second = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 10, y: 4 }, walk: WALK_AROUND.map((point) => ({ x: point.x, y: point.y })) });
  const corrupted = second.map((sample, index) => ({ ...sample, rssi: sample.rssi - index * 6 }));
  const outcome = fitSiteCalibration([...first, ...corrupted]);
  if (outcome.ok) {
    assert.ok(
      outcome.fit.residualRmsDb > 7 || outcome.fit.warnings.some((warning) => warning.includes("disagreed")),
      `a corrupted walk was fitted cleanly (residuals ${outcome.fit.residualRmsDb} dB, warnings ${JSON.stringify(outcome.fit.warnings)})`,
    );
  } else {
    assert.ok(outcome.reasons.length > 0);
  }
});

test("repeats at one place cannot outvote the places that were walked", () => {
  const truth = { p0: -46, exponent: 3.2, target: { x: 10, y: 4 } };
  const walked = synthesize({ targetId: "device_a", p0: truth.p0, exponent: truth.exponent, target: truth.target, walk: WALK_AROUND, jitterDb: 0 });
  // A phone left standing where the level happened to read low, for thirty readings.
  const standing = Array.from({ length: 30 }, (_, index) => ({ ...walked[1], rssi: walked[1].rssi - 8 + (index % 2) }));
  const outcome = fitSiteCalibration([...walked, ...standing]);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // Every place is one observation, so the walk still decides the constants.
  assert.equal(outcome.fit.observations, WALK_AROUND.length);
  assert.equal(outcome.fit.samples, WALK_AROUND.length + standing.length);
  assert.equal(outcome.fit.targets[0].samples, WALK_AROUND.length);
  assert.equal(outcome.fit.targets[0].readings, WALK_AROUND.length + standing.length);
  assert.ok(Math.abs(outcome.fit.pathLossExponent - truth.exponent) < 0.5, `repeats dragged the exponent to ${outcome.fit.pathLossExponent}`);
  assert.ok(err(outcome.fit.targets[0], truth.target) < 2.5, `repeats dragged the position to ${outcome.fit.targets[0].x},${outcome.fit.targets[0].y}`);
});

test("readings at one place that disagree are reported rather than averaged away", () => {
  const settled = synthesize({ targetId: "device_a", p0: -46, exponent: 3.2, target: { x: 10, y: 4 }, walk: WALK_AROUND, jitterDb: 0.3 });
  const quiet = fitSiteCalibration(settled);
  assert.equal(quiet.ok, true);
  if (!quiet.ok) return;
  assert.equal(quiet.fit.warnings.some((warning) => warning.includes("disagreed")), false);

  // The same walk, but one place collected readings fifteen decibels apart: there is no single
  // level there, and the fit has to say so instead of presenting its median as a measurement.
  const unsettled = [
    ...settled,
    { ...settled[2], rssi: settled[2].rssi - 15 },
    { ...settled[2], rssi: settled[2].rssi - 9 },
  ];
  const noisy = fitSiteCalibration(unsettled);
  assert.equal(noisy.ok, true);
  if (!noisy.ok) return;
  assert.ok(noisy.fit.warnings.some((warning) => warning.includes("disagreed")), `no warning about the place: ${JSON.stringify(noisy.fit.warnings)}`);
  // The place is still one observation, so the warning is about evidence quality, not weight.
  assert.equal(noisy.fit.observations, WALK_AROUND.length);
  assert.equal(noisy.fit.samples, WALK_AROUND.length + 2);
});
