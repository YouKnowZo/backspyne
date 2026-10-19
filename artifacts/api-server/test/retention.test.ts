// Tests for observation retention windows and site data purge policy.
//
//   node --experimental-strip-types --test artifacts/api-server/test/retention.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_RETENTION_DAYS,
  DAY_MS,
  isAllowedRetentionDays,
  parsePurgeRequest,
  parseRequestedRetentionDays,
  resolveRetentionPolicy,
} from "../src/lib/retention.ts";

test("allowed retention windows are positive ascending integers", () => {
  assert.deepEqual([...ALLOWED_RETENTION_DAYS], [1, 3, 7, 14, 30, 90, 365]);
  for (const days of ALLOWED_RETENTION_DAYS) {
    assert.equal(isAllowedRetentionDays(days), true);
  }
  assert.equal(isAllowedRetentionDays(0), false);
  assert.equal(isAllowedRetentionDays(10), false);
  assert.equal(isAllowedRetentionDays(-7), false);
  assert.equal(isAllowedRetentionDays("7"), false);
});

test("parseRequestedRetentionDays accepts null, 'plan', and allowed windows, and rejects invalid values", () => {
  assert.equal(parseRequestedRetentionDays(null), null);
  assert.equal(parseRequestedRetentionDays("plan"), null);
  assert.equal(parseRequestedRetentionDays(1), 1);
  assert.equal(parseRequestedRetentionDays("30"), 30);
  assert.equal(parseRequestedRetentionDays(5), undefined);
  assert.equal(parseRequestedRetentionDays("forever"), undefined);
});

test("resolveRetentionPolicy defaults to the plan's historyDays when no custom window is configured", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const freePolicy = resolveRetentionPolicy({
    configuredDays: null,
    planHistoryDays: 7,
    now,
  });
  assert.equal(freePolicy.configuredDays, null);
  assert.equal(freePolicy.planMaxDays, 7);
  assert.equal(freePolicy.effectiveDays, 7);
  assert.equal(freePolicy.autoPrune, true);
  assert.equal(freePolicy.cutoffDate.getTime(), now - 7 * DAY_MS);

  const allowedDays = freePolicy.options.filter((opt) => opt.allowedByPlan).map((opt) => opt.days);
  assert.deepEqual(allowedDays, [1, 3, 7]);
});

test("an operator can narrow retention below their plan ceiling, and downgrading clamps effectiveDays to the new plan ceiling", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");

  // Team plan (90 days max) narrowed by operator to 14 days
  const narrowed = resolveRetentionPolicy({
    configuredDays: 14,
    autoPrune: false,
    planHistoryDays: 90,
    now,
  });
  assert.equal(narrowed.configuredDays, 14);
  assert.equal(narrowed.effectiveDays, 14);
  assert.equal(narrowed.autoPrune, false);

  // Operator configured 90 days on Team, then downgraded to Free (7 days max)
  const clamped = resolveRetentionPolicy({
    configuredDays: 90,
    planHistoryDays: 7,
    now,
  });
  assert.equal(clamped.configuredDays, 90);
  assert.equal(clamped.planMaxDays, 7);
  assert.equal(clamped.effectiveDays, 7);
});

test("unlimited owner plans allow every retention window option", () => {
  const policy = resolveRetentionPolicy({
    configuredDays: 365,
    planHistoryDays: 3650,
    planUnlimited: true,
  });
  assert.equal(policy.effectiveDays, 365);
  assert.ok(policy.options.every((opt) => opt.allowedByPlan));
});

test("parsePurgeRequest requires explicit PURGE confirmation for full site purge and allows expired prune", () => {
  assert.deepEqual(parsePurgeRequest({ scope: "expired" }), { scope: "expired", resetRelays: false });
  assert.equal(parsePurgeRequest({ scope: "site" }), null);
  assert.equal(parsePurgeRequest({ scope: "site", confirm: "delete" }), null);
  assert.deepEqual(
    parsePurgeRequest({ scope: "site", confirm: "PURGE", resetRelays: true }),
    { scope: "site", resetRelays: true },
  );
  assert.equal(parsePurgeRequest(null), null);
});
