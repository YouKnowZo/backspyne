// Tests for the position model.
//
//   node --test artifacts/api-server/test/localization.test.ts
//
// A position printed as a fix is a claim about where a radio is, so the geometry is asserted
// directly: a synthesized target must be recovered from modelled levels, and every case the
// geometry cannot resolve must come back as a ring, an ambiguity, or nothing at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RADIO_MODEL,
  estimatePosition,
  estimateTrack,
  impliedDistanceMeters,
  latestPerRelay,
  modelledDbmAt,
  type RelayObservation,
} from "../src/lib/localization.ts";
import { levelFromObservation } from "../src/lib/signal.ts";

/** A level a relay would report if the radio sat exactly this far away under the model. */
function levelAt(meters: number): number {
  return modelledDbmAt(meters);
}

function observation(nodeId: string, x: number, y: number, targetX: number, targetY: number): RelayObservation {
  return {
    nodeId,
    nodeName: nodeId,
    x,
    y,
    signalDbm: levelAt(Math.hypot(targetX - x, targetY - y)),
    observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0)).toISOString(),
  };
}

test("the path-loss model is inverted at the reference point and by one exponent step", () => {
  assert.equal(impliedDistanceMeters(DEFAULT_RADIO_MODEL.referenceDbm), DEFAULT_RADIO_MODEL.referenceMeters);
  // A 20 dB drop at exponent 2.5 is a factor of 10^(20/25) = 6.31.
  assert.ok(Math.abs(impliedDistanceMeters(DEFAULT_RADIO_MODEL.referenceDbm - 20) - 6.31) < 0.02);
  // Distances are clamped at both ends rather than extrapolated without limit.
  assert.equal(impliedDistanceMeters(20), 0.5);
  assert.equal(impliedDistanceMeters(-200), 150);
});

test("one placed relay yields a ring, never a position", () => {
  const estimate = estimatePosition([observation("relay-a", 0, 0, 8, 0)]);
  assert.equal(estimate.status, "single_relay");
  assert.equal(estimate.x, null);
  assert.equal(estimate.y, null);
  assert.equal(estimate.ring?.distanceMeters, 8);
  assert.match(estimate.note, /ring, not a point/);
});

test("three placed relays recover a synthesized target", () => {
  const target = { x: 12, y: -7 };
  const relays = [
    observation("relay-a", 0, 0, target.x, target.y),
    observation("relay-b", 20, 0, target.x, target.y),
    observation("relay-c", 10, 15, target.x, target.y),
  ];
  const estimate = estimatePosition(relays);
  assert.equal(estimate.status, "estimated");
  assert.ok(estimate.x !== null && estimate.y !== null);
  assert.ok(Math.abs(estimate.x! - target.x) < 0.6, `x was ${estimate.x}`);
  assert.ok(Math.abs(estimate.y! - target.y) < 0.6, `y was ${estimate.y}`);
  // Exact inputs mean the residual spread is the only error, so the radius stays small.
  assert.ok(estimate.uncertaintyMeters !== null && estimate.uncertaintyMeters < 5);
  assert.equal(estimate.method, "least-squares trilateration (log-distance path loss)");
  assert.equal(estimate.residuals.length, 3);
});

test("two placed relays return both mirror candidates instead of choosing silently", () => {
  // An off-axis target, because a target on the relay baseline is tangent and resolves to one
  // point; two vantage points alone cannot tell which side of that line the radio is on.
  const estimate = estimatePosition([
    observation("relay-a", 0, 0, 10, 5),
    observation("relay-b", 20, 0, 10, 5),
  ]);
  assert.equal(estimate.status, "ambiguous");
  assert.equal(estimate.candidates.length, 2);
  assert.equal(estimate.candidates[0].x, estimate.candidates[1].x);
  assert.notEqual(estimate.candidates[0].y, estimate.candidates[1].y);
  assert.match(estimate.note, /third placed relay/);
});

test("two relays whose implied distances never meet are reported as unresolved", () => {
  const estimate = estimatePosition([
    { nodeId: "a", nodeName: "a", x: 0, y: 0, signalDbm: -60, observedAt: new Date().toISOString() },
    { nodeId: "b", nodeName: "b", x: 100, y: 0, signalDbm: -30, observedAt: new Date().toISOString() },
  ]);
  assert.equal(estimate.status, "ambiguous");
  assert.equal(estimate.candidates.length, 0);
  assert.equal(estimate.x, null);
  assert.match(estimate.note, /do not meet/);
});

test("collinear relays fall back to a weighted centre with an honest radius", () => {
  const estimate = estimatePosition([
    observation("relay-a", 0, 0, 9, 0),
    observation("relay-b", 6, 0, 9, 0),
    observation("relay-c", 18, 0, 9, 0),
  ]);
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.method, "weighted centre of placed relays");
  assert.ok(estimate.uncertaintyMeters !== null && estimate.uncertaintyMeters >= 15);
  assert.match(estimate.note, /one line/);
});

test("no numeric level means no position at all", () => {
  const estimate = estimatePosition([]);
  assert.equal(estimate.status, "no_signal");
  assert.equal(estimate.x, null);
  assert.equal(estimate.uncertaintyMeters, null);
});

test("one report per relay, with the median of recent samples", () => {
  const rows = [
    { nodeId: "a", nodeName: "A relay", signalDbm: -50, observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 30)), x: 0, y: 0 },
    { nodeId: "a", nodeName: "A relay", signalDbm: -70, observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 20)), x: 0, y: 0 },
    { nodeId: "a", nodeName: "A relay", signalDbm: -60, observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 10)), x: 0, y: 0 },
    { nodeId: "b", nodeName: "B relay", signalDbm: null, observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0)), x: 5, y: 5 },
  ];
  const collapsed = latestPerRelay(rows);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].nodeId, "a");
  assert.equal(collapsed[0].signalDbm, -60);
  assert.equal(collapsed[0].sampleCount, 3);
});

test("a track is one point per time bucket and only where the geometry supports one", () => {
  const start = Date.UTC(2026, 9, 9, 12, 0, 0);
  const relays = [
    { nodeId: "a", nodeName: "A", x: 0, y: 0 },
    { nodeId: "b", nodeName: "B", x: 20, y: 0 },
    { nodeId: "c", nodeName: "C", x: 10, y: 15 },
  ];
  const rows = relays.flatMap((relay) => [0, 60_000, 120_000].map((offset, index) => {
    const target = index < 2 ? { x: 5, y: 5 } : { x: 14, y: 6 };
    const observedAt = new Date(start + offset);
    return {
      nodeId: relay.nodeId,
      nodeName: relay.nodeName,
      signalDbm: levelAt(Math.hypot(target.x - relay.x, target.y - relay.y)),
      observedAt,
      x: relay.x,
      y: relay.y,
    };
  }));
  const track = estimateTrack(rows, { bucketSeconds: 60 });
  assert.equal(track.length, 3);
  assert.ok(track[0].at < track[1].at && track[1].at < track[2].at);
  assert.ok(Math.abs(track[0].x - 5) < 0.6);
  assert.ok(Math.abs(track[2].x - 14) < 0.6);
  assert.equal(track[0].relays, 3);
});

test("an access point reported by Windows WiFi as a percentage only is localizable", () => {
  // The chain a Windows relay actually produces, end to end and without a database: netsh
  // reports a 0-100 link quality and no power, so the observation carries only a percentage.
  // Three placed relays is enough geometry for a fix, and a signal reported in the wrong
  // vocabulary must not lose the one radio an operator most wants placed.
  const target = { x: 6, y: -3 };
  const placements = [
    { nodeId: "relay-a", x: 0, y: 0 },
    { nodeId: "relay-b", x: 12, y: 0 },
    { nodeId: "relay-c", x: 0, y: 11 },
  ];
  const observations: RelayObservation[] = placements.map((relay) => {
    const metres = Math.hypot(target.x - relay.x, target.y - relay.y);
    // What the driver would report for this path: the level in the other direction, quantised
    // to the whole-number percentage netsh writes. Rounding here is the point — the estimate
    // has to survive the driver's own scale, not a convenient exact number.
    const dbm = modelledDbmAt(metres);
    const percent = Math.max(0, Math.min(100, Math.round((dbm + 100) * 2)));
    const level = levelFromObservation({ signalQualityPercent: percent });
    assert.ok(level, "a percentage inside the driver's scale is a usable level");
    assert.equal(level!.source, "link-quality percentage");
    return {
      nodeId: relay.nodeId,
      nodeName: relay.nodeId,
      x: relay.x,
      y: relay.y,
      signalDbm: level!.dbm,
      observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0)).toISOString(),
    };
  });

  const estimate = estimatePosition(observations);
  assert.equal(estimate.status, "estimated", "a percentage-only access point must produce a fix, not no_signal");
  assert.ok(estimate.x !== null && estimate.y !== null);
  // The half-decibel quantisation costs accuracy, so the tolerance is the driver's own step
  // rather than the millimetre a measured level would allow.
  assert.ok(Math.hypot(estimate.x! - target.x, estimate.y! - target.y) < 2.5, `recovered (${estimate.x}, ${estimate.y}) for a target at (${target.x}, ${target.y})`);
  assert.deepEqual(estimate.residuals.map((residual) => residual.nodeId), ["relay-a", "relay-b", "relay-c"]);

  // And the same three relays reporting measured power place it at least as well, so the
  // derivation is a widening of coverage rather than a different answer.
  const measured = estimatePosition(observations.map((observation) => ({
    ...observation,
    signalDbm: modelledDbmAt(Math.hypot(target.x - observation.x, target.y - observation.y)),
  })));
  assert.equal(measured.status, "estimated");
  assert.ok(Math.hypot(measured.x! - target.x, measured.y! - target.y) < 1.5);
});

test("a sighting with neither power nor a percentage is not a position input", () => {
  // What keeps an unplaceable radio honest: nothing to model means no fix, and the caller is
  // told so rather than being handed the origin.
  assert.equal(levelFromObservation({}), null);
  assert.equal(estimatePosition([
    { nodeId: "relay-a", nodeName: "A", x: 0, y: 0, signalDbm: Number.NaN, observedAt: new Date().toISOString() },
  ]).status, "no_signal");
});

test("a track with a single placed relay stays empty rather than inventing movement", () => {
  const rows = [0, 60_000, 120_000].map((offset) => ({
    nodeId: "a",
    nodeName: "A",
    signalDbm: -55,
    observedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + offset),
    x: 0,
    y: 0,
  }));
  assert.deepEqual(estimateTrack(rows, { bucketSeconds: 60 }), []);
});
