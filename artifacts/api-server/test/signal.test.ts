// Tests for the received level: measured power, or a link-quality percentage mapped to one.
//
//   node --experimental-strip-types --test artifacts/api-server/test/signal.test.ts
//
// This mapping decides whether a WiFi access point seen from a Windows relay can be located at
// all, so its two properties are asserted rather than assumed: it reproduces the scale the
// driver documents (0% = -100 dBm, 100% = -50 dBm, half-decibel steps), and it never lets a
// derived level displace a level an adapter actually measured. The cases that must be refused
// are here too — a percentage outside 0-100 is not a level, and a device that reported neither
// vocabulary has nothing to model with.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DERIVED_LEVEL_NOTE,
  USABLE_DBM_MAX,
  USABLE_DBM_MIN,
  dbmFromLinkQualityPercent,
  levelFromObservation,
  levelIsDerived,
  linkQualityPercentFromDbm,
  usableDbm,
} from "../src/lib/signal.ts";

test("the driver scale maps 0-100% onto -100..-50 dBm in half-decibel steps", () => {
  assert.equal(dbmFromLinkQualityPercent(0), -100);
  assert.equal(dbmFromLinkQualityPercent(25), -87.5);
  assert.equal(dbmFromLinkQualityPercent(50), -75);
  assert.equal(dbmFromLinkQualityPercent(75), -62.5);
  assert.equal(dbmFromLinkQualityPercent(100), -50);
  // Odd percentages land on the half-decibel the scale itself has, never finer.
  assert.equal(dbmFromLinkQualityPercent(1), -99.5);
  assert.equal(dbmFromLinkQualityPercent(33), -83.5);
  assert.equal(dbmFromLinkQualityPercent(99), -50.5);
  for (let percent = 0; percent <= 100; percent += 1) {
    const dbm = dbmFromLinkQualityPercent(percent);
    assert.ok(dbm !== null, `${percent}% produced no level`);
    assert.equal(Number.isInteger((dbm as number) * 2), true, `${percent}% produced a level finer than half a decibel`);
    assert.ok((dbm as number) >= -100 && (dbm as number) <= -50, `${percent}% produced ${dbm} dBm, outside the scale`);
    // The scale is affine, so a percentage survives the round trip exactly.
    assert.equal(linkQualityPercentFromDbm(dbm as number), percent);
  }
});

test("the top of the scale saturates, which is what a derived level cannot express", () => {
  // Everything at or above -50 dBm reads 100%: a driver cannot distinguish a nearby access
  // point from a closer one, so a derived level is never stronger than -50 dBm.
  assert.equal(dbmFromLinkQualityPercent(100), -50);
  assert.equal(linkQualityPercentFromDbm(-50), 100);
  assert.equal(linkQualityPercentFromDbm(-45), 100);
  assert.equal(linkQualityPercentFromDbm(-40), 100);
  // The whole mapped range is inside what the model and the schema accept.
  assert.ok(USABLE_DBM_MIN < -100 && USABLE_DBM_MAX > -50);
});

test("a percentage that is not a percentage is not a level", () => {
  for (const value of [-1, 101, 1000, Number.NaN, Number.POSITIVE_INFINITY, -0.5, null, undefined, "50", {}, [], true]) {
    assert.equal(dbmFromLinkQualityPercent(value), null, `${String(value)} was accepted as a percentage`);
  }
  assert.equal(dbmFromLinkQualityPercent(0), -100);
  assert.equal(dbmFromLinkQualityPercent(100), -50);
});

test("a measured level always beats a percentage of the same reading", () => {
  const measured = levelFromObservation({ signalDbm: -67, signalQualityPercent: 20 });
  // -67 dBm is 66% on the driver's scale, so the percentage the adapter reported is ignored in
  // favour of the power it measured, and the equivalent percentage travels beside it.
  assert.deepEqual(measured, { dbm: -67, source: "adapter dBm", percent: 66 });
  assert.equal(levelIsDerived(measured?.source), false);

  // An adapter that reports a percentage and a nonsense level is still usable: the percentage
  // is what it actually produced.
  const fromPercent = levelFromObservation({ signalDbm: -500, signalQualityPercent: 64 });
  assert.equal(fromPercent?.dbm, -68);
  assert.equal(fromPercent?.source, "link-quality percentage");
  assert.equal(fromPercent?.percent, 64);
  assert.equal(levelIsDerived(fromPercent?.source), true);
});

test("a reading with no level at all is refused rather than defaulted", () => {
  assert.equal(levelFromObservation({}), null);
  assert.equal(levelFromObservation({ signalDbm: Number.NaN }), null);
  assert.equal(levelFromObservation({ signalQualityPercent: 120 }), null);
  assert.equal(levelFromObservation({ signalDbm: null, signalQualityPercent: null }), null);
  // A BLE advertiser with a real level keeps working with no percentage anywhere.
  assert.equal(levelFromObservation({ signalDbm: -82 })?.dbm, -82);
});

test("the usable level range is the one the model and the schema hold", () => {
  assert.equal(usableDbm(-127), true);
  assert.equal(usableDbm(20), true);
  assert.equal(usableDbm(-128), false);
  assert.equal(usableDbm(21), false);
  assert.equal(usableDbm(Number.NaN), false);
  assert.equal(usableDbm("−70"), false);
  assert.equal(linkQualityPercentFromDbm(-200), null);
  assert.equal(linkQualityPercentFromDbm(Number.NaN), null);
});

test("the limitation a derived level carries is stated in one place", () => {
  assert.match(DERIVED_LEVEL_NOTE, /link-quality percentage/);
  assert.match(DERIVED_LEVEL_NOTE, /-100 dBm/);
  assert.match(DERIVED_LEVEL_NOTE, /-50 dBm/);
});
