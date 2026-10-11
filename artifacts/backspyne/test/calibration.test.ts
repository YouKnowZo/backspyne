// Tests for the calibration walk as the console describes it.
//
//   node --experimental-strip-types --test artifacts/backspyne/test/calibration.test.ts
//
// The view shows an operator whether a walk is good enough yet, and it does that from numbers
// the server reported. Those derivations are the only part of this client that can be wrong
// without a request failing, so they are asserted here against the same thresholds the server
// enforces: four places, eight metres of ground, eight decibels of level variation. A walk that
// meets two of the three has to say so rather than reading as ready, because the alternative is
// an operator walking in circles waiting for a fit that will keep being refused.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WALK_WINDOWS,
  describeWalkEvidence,
  modelDiffersFromDefaults,
  walkChecklist,
  walkWindowLabel,
  type CalibrationCandidate,
  type CalibrationRequirements,
} from '../src/lib/calibration.ts';

const REQUIREMENTS: CalibrationRequirements = {
  minVantagesPerTarget: 4,
  minVantageSpreadMeters: 8,
  minLevelSpreadDb: 8,
  maxTargetDistanceMeters: 60,
  exponentBounds: [1.8, 5.5],
  referenceDbmBounds: [-80, -25],
  largeResidualDb: 7,
};

function candidate(overrides: Partial<CalibrationCandidate> = {}): CalibrationCandidate {
  return {
    targetId: 'device_a',
    label: 'Beacon A',
    address: 'AA:BB:CC:DD:EE:FF',
    vendor: 'Acme',
    protocol: 'BLE',
    samples: 12,
    vantages: 5,
    levelSpreadDb: 14,
    vantageSpreadMeters: 11.5,
    eligible: true,
    vantagePoints: [{ x: 0, y: 0 }, { x: 4, y: 2 }],
    reasons: [],
    ...overrides,
  };
}

const met = (requirements: ReturnType<typeof walkChecklist>, id: string) => requirements.find(item => item.id === id)?.met;

test("a walk that covers ground and varies the level meets every requirement", () => {
  const checklist = walkChecklist(candidate(), REQUIREMENTS);
  assert.equal(checklist.length, 3);
  assert.deepEqual(checklist.map(item => item.id), ['places', 'span', 'levels']);
  assert.ok(checklist.every(item => item.met));
  assert.match(checklist[0].label, /5 of 4 places/);
  assert.match(checklist[1].label, /11\.5 of 8 m/);
  assert.match(checklist[2].label, /14 of 8 dB/);
});

test("one place short is reported as one place short, and nothing else", () => {
  const checklist = walkChecklist(candidate({ vantages: 3, eligible: false }), REQUIREMENTS);
  assert.equal(met(checklist, 'places'), false);
  assert.equal(met(checklist, 'span'), true);
  assert.equal(met(checklist, 'levels'), true);
  assert.match(checklist[0].detail, /stand still and let a few scans run at 1 more place/i);
  assert.match(checklist[0].label, /3 of 4 places/);
});

test("a walk that never left the spot fails the spread check even with many readings", () => {
  const checklist = walkChecklist(candidate({ vantages: 9, samples: 40, vantageSpreadMeters: 1.5, eligible: false }), REQUIREMENTS);
  assert.equal(met(checklist, 'span'), false);
  assert.match(checklist[1].detail, /walk at least 8 m across the site/i);
});

test("levels that barely varied cannot identify the fall-off rate, and the checklist says why", () => {
  const checklist = walkChecklist(candidate({ levelSpreadDb: 3.5, eligible: false }), REQUIREMENTS);
  assert.equal(met(checklist, 'levels'), false);
  assert.match(checklist[2].detail, /get closer to and further from this radio/i);
  // The other two requirements are met, so a console that showed "not ready" alone would be
  // sending the operator to fix the wrong thing.
  assert.equal(met(checklist, 'places'), true);
  assert.equal(met(checklist, 'span'), true);
});

test("the thresholds come from the server's requirements, not from numbers written here", () => {
  const stricter: CalibrationRequirements = { ...REQUIREMENTS, minVantagesPerTarget: 6, minVantageSpreadMeters: 20, minLevelSpreadDb: 15 };
  const checklist = walkChecklist(candidate(), stricter);
  assert.ok(checklist.every(item => !item.met));
  assert.match(checklist[0].label, /5 of 6 places/);
  assert.match(checklist[1].label, /11\.5 of 20 m/);
  assert.match(checklist[2].label, /14 of 15 dB/);
});

test("a radio's evidence line states what was collected, not what was hoped for", () => {
  assert.equal(
    describeWalkEvidence(candidate()),
    '12 readings · 5 places · 11.5 m across · 14 dB of level variation',
  );
  assert.equal(
    describeWalkEvidence(candidate({ samples: 1, vantages: 1, vantageSpreadMeters: 0, levelSpreadDb: 0 })),
    '1 reading · 1 place · 0 m across · 0 dB of level variation',
  );
});

test("a fit is only reported as a change when the constants actually moved", () => {
  const defaults = { referenceDbm: -40, pathLossExponent: 2.5, referenceMeters: 1 };
  assert.equal(modelDiffersFromDefaults(defaults, defaults), false);
  assert.equal(modelDiffersFromDefaults({ ...defaults, pathLossExponent: 3.29 }, defaults), true);
  assert.equal(modelDiffersFromDefaults({ ...defaults, referenceDbm: -46.5 }, defaults), true);
});

test("every offered window names itself, and an unknown one still reads as a duration", () => {
  assert.ok(WALK_WINDOWS.length >= 2);
  assert.ok(WALK_WINDOWS.every(window => window.minutes > 0 && window.label.length > 0));
  assert.equal(walkWindowLabel(WALK_WINDOWS[0].minutes), WALK_WINDOWS[0].label);
  assert.equal(walkWindowLabel(90), '90 minutes');
});
