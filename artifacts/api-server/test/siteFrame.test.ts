// Tests for the site frame, and for what a phone that walks around buys.
//
//   node --experimental-strip-types --test artifacts/api-server/test/siteFrame.test.ts
//
// Two claims are asserted here rather than assumed. A latitude/longitude fix lands in the
// same metric frame the relay placements use, closely enough that the difference between the
// two is far below the fix's own error. And a phone that reports the same radio from several
// places produces a fix, while a phone that reports from one place produces a ring — which is
// the whole reason the phone path records where each measurement was taken.

import test from "node:test";
import assert from "node:assert/strict";

// The storage module behind the site frame needs a connection string to load; nothing in
// these tests opens a connection, and the projection itself is pure arithmetic.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@127.0.0.1:5432/backspyne_test";

const {
  MAX_FIX_ACCURACY_METERS,
  MAX_VANTAGE_ACCURACY_METERS,
  fixIsReportable,
  isUsableVantage,
  projectToSiteFrame,
  readGeoFix,
} = await import("../src/lib/siteFrame.ts");
const { estimatePosition, latestPerRelay, modelledDbmAt } = await import("../src/lib/localization.ts");

const ORIGIN = { lat: 51.5, lon: -0.12 };
const METERS_PER_DEGREE_LATITUDE = 110_574;
const metersPerDegreeLongitude = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** The inverse of the projection, used to synthesize fixes from metres on a plan. */
function fixAt(x: number, y: number, accuracyMeters: number | null = 5) {
  return { lat: ORIGIN.lat + y / METERS_PER_DEGREE_LATITUDE, lon: ORIGIN.lon + x / metersPerDegreeLongitude(ORIGIN.lat), accuracyMeters };
}

test("a fix at the origin is the origin", () => {
  const projected = projectToSiteFrame(fixAt(0, 0), ORIGIN);
  assert.deepEqual(projected, { x: 0, y: 0 });
});

test("north is +y and east is +x, in metres", () => {
  const north = projectToSiteFrame({ lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon, accuracyMeters: 5 }, ORIGIN);
  assert.equal(north.x, 0);
  assert.equal(north.y, 110.6);

  const east = projectToSiteFrame({ lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001, accuracyMeters: 5 }, ORIGIN);
  assert.equal(east.y, 0);
  // 111.32 km per degree of longitude at 51.5°N is about 69.3 m per thousandth of a degree.
  assert.ok(Math.abs(east.x - 69.3) < 0.2, `expected about 69.3 m east, saw ${east.x}`);
});

test("a planned path survives the round trip far more precisely than the fix itself", () => {
  for (const point of [{ x: 0, y: 0 }, { x: 7.5, y: -3.25 }, { x: -12, y: 40 }, { x: 250, y: -180 }]) {
    const projected = projectToSiteFrame(fixAt(point.x, point.y), ORIGIN);
    const error = Math.hypot(projected.x - point.x, projected.y - point.y);
    assert.ok(error < 0.2, `${point.x},${point.y} projected to ${projected.x},${projected.y} (${error} m out)`);
  }
});

test("a fix has to be a real coordinate before it is a position", () => {
  assert.equal(readGeoFix({ lat: 91, lon: 0 }), null);
  assert.equal(readGeoFix({ lat: 0, lon: 181 }), null);
  assert.equal(readGeoFix({ lat: "51.5", lon: "0.1" }), null);
  assert.equal(readGeoFix({ lat: 51.5 }), null);
  assert.equal(readGeoFix(null), null);
  assert.equal(readGeoFix([51.5, -0.12]), null);
  const accepted = readGeoFix({ lat: 51.50000001, lon: -0.12000001, accuracyMeters: -4 });
  assert.equal(accepted?.lat, 51.5);
  assert.equal(accepted?.accuracyMeters, 0);
  // An unreported accuracy stays null: it is never rounded into a number.
  assert.equal(readGeoFix({ lat: 51.5, lon: -0.12 })?.accuracyMeters, null);
});

test("accuracy decides whether a fix may be measured from", () => {
  assert.equal(isUsableVantage({ lat: 0, lon: 0, accuracyMeters: 5 }), true);
  assert.equal(isUsableVantage({ lat: 0, lon: 0, accuracyMeters: MAX_VANTAGE_ACCURACY_METERS }), true);
  assert.equal(isUsableVantage({ lat: 0, lon: 0, accuracyMeters: MAX_VANTAGE_ACCURACY_METERS + 1 }), false);
  assert.equal(isUsableVantage({ lat: 0, lon: 0, accuracyMeters: null }), false);
  assert.equal(fixIsReportable({ lat: 0, lon: 0, accuracyMeters: MAX_FIX_ACCURACY_METERS }), true);
  assert.equal(fixIsReportable({ lat: 0, lon: 0, accuracyMeters: MAX_FIX_ACCURACY_METERS + 1 }), false);
});

/**
 * The capability the phone path exists for: one radio, one phone, several places.
 */
test("a phone that reports from several places produces a fix; from one place it cannot", () => {
  const target = { x: 9, y: 2 };
  const walk = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }];
  const startedAt = Date.UTC(2026, 9, 10, 12, 0, 0);
  const rows = walk.map((point, index) => {
    const projected = projectToSiteFrame(fixAt(point.x, point.y), ORIGIN);
    const distance = Math.hypot(target.x - projected.x, target.y - projected.y);
    return {
      nodeId: `phone_walk#${projected.x}:${projected.y}`,
      nodeName: `phone · vantage ${projected.x}, ${projected.y} m`,
      signalDbm: modelledDbmAt(distance),
      observedAt: new Date(startedAt + index * 10_000),
      x: projected.x,
      y: projected.y,
    };
  });

  const estimate = estimatePosition(latestPerRelay(rows));
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.relays, walk.length);
  const error = Math.hypot((estimate.x ?? 0) - target.x, (estimate.y ?? 0) - target.y);
  assert.ok(error < 1.5, `expected the fix within 1.5 m of ${target.x},${target.y}, saw ${estimate.x},${estimate.y}`);
  assert.ok(estimate.uncertaintyMeters !== null && estimate.uncertaintyMeters > 0);

  // The same phone standing still: one vantage point, so a distance with no direction.
  const standing = estimatePosition(latestPerRelay(rows.slice(0, 1)));
  assert.equal(standing.status, "single_relay");
  assert.equal(standing.x, null);
  assert.equal(standing.ring?.distanceMeters, Math.round(Math.hypot(target.x - 0, target.y - 0) * 10) / 10);
});

/**
 * Standing still is not the only way to lose the fix: several reports from one place are one
 * vantage point however many of them there are, which is why the vantage key is bucketed.
 */
test("repeated reports from one place are one vantage point, not three", () => {
  const target = { x: 4, y: 4 };
  const rows = [0, 1, 2].map((index) => ({
    nodeId: "phone_parked#0:0",
    nodeName: "phone · vantage 0, 0 m",
    signalDbm: modelledDbmAt(Math.hypot(target.x, target.y)) - index * 0.2,
    observedAt: new Date(Date.UTC(2026, 9, 10, 12, 0, index * 10)),
    x: 0,
    y: 0,
  }));
  const estimate = estimatePosition(latestPerRelay(rows));
  assert.equal(estimate.status, "single_relay");
  assert.equal(estimate.relays, 1);
});
