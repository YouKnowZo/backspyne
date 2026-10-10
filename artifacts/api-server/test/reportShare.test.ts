// Tests for the client share link.
//
//   node --test artifacts/api-server/test/reportShare.test.ts
//
// A share link is the one part of the product that authorizes a stranger, so its two
// guarantees — scoped to the issuing account, and expiring on a schedule the recipient
// cannot edit — are asserted directly rather than assumed.

import test from "node:test";
import assert from "node:assert/strict";

process.env.BACKSPYNE_REPORT_SHARE_SECRET = "test-share-secret-that-is-long-enough";

import { createReportShareToken, readReportShareToken, shareLinksAvailable, SHARE_TTL_DAYS } from "../src/lib/reportShare.ts";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

test("a share link round-trips the account and the labels the operator chose", () => {
  const created = createReportShareToken({ ownerId: "user_operator", site: "East wing", operatorName: "Alonzo Locket" }, NOW);
  assert.ok(created);
  assert.equal(created.expiresAt, NOW + SHARE_TTL_DAYS * DAY_MS);

  const payload = readReportShareToken(created.token, NOW + 1000);
  assert.equal(payload?.ownerId, "user_operator");
  assert.equal(payload?.site, "East wing");
  assert.equal(payload?.operatorName, "Alonzo Locket");
});

test("the link is scoped: only the account inside the signature can be read", () => {
  const mine = createReportShareToken({ ownerId: "user_mine", site: "Site A", operatorName: "Operator" }, NOW);
  const theirs = createReportShareToken({ ownerId: "user_theirs", site: "Site B", operatorName: "Operator" }, NOW);
  assert.ok(mine && theirs);
  // A different account's link carries its own owner id and cannot be pointed at another.
  assert.equal(readReportShareToken(mine.token, NOW)?.ownerId, "user_mine");
  assert.equal(readReportShareToken(theirs.token, NOW)?.ownerId, "user_theirs");
  assert.notEqual(mine.token, theirs.token);
});

test("a tampered link is refused rather than partially trusted", () => {
  const created = createReportShareToken({ ownerId: "user_operator", site: "East wing", operatorName: "Alonzo" }, NOW);
  assert.ok(created);
  const [body, signature] = created.token.split(".");

  // Re-encoding the payload with another owner id, and every truncation of the signature.
  const forged = Buffer.from(JSON.stringify({ ownerId: "user_someone_else", site: "East wing", operatorName: "Alonzo", expiresAt: NOW + DAY_MS }), "utf8").toString("base64url");
  assert.equal(readReportShareToken(`${forged}.${signature}`, NOW), null);
  assert.equal(readReportShareToken(`${body}.${signature.slice(0, -1)}`, NOW), null);
  assert.equal(readReportShareToken(body, NOW), null);
  assert.equal(readReportShareToken(`${body}.`, NOW), null);
  assert.equal(readReportShareToken("", NOW), null);
  assert.equal(readReportShareToken(null, NOW), null);
  assert.equal(readReportShareToken(`${body}x.${signature}`, NOW), null);
});

test("an expired link is refused, and its expiry cannot be edited forward", () => {
  const created = createReportShareToken({ ownerId: "user_operator", site: "East wing", operatorName: "Alonzo" }, NOW, DAY_MS);
  assert.ok(created);
  assert.ok(readReportShareToken(created.token, NOW + DAY_MS - 1));
  assert.equal(readReportShareToken(created.token, NOW + DAY_MS), null);

  // Extending the expiry means changing the signed body, which invalidates the signature.
  const [body, signature] = created.token.split(".");
  const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { expiresAt: number };
  const extended = Buffer.from(JSON.stringify({ ...decoded, expiresAt: NOW + 365 * DAY_MS }), "utf8").toString("base64url");
  assert.equal(readReportShareToken(`${extended}.${signature}`, NOW + DAY_MS + 1000), null);
});

test("a deployment without a signing secret reports sharing as unavailable instead of guessing one", () => {
  const dedicated = process.env.BACKSPYNE_REPORT_SHARE_SECRET;
  const nodeToken = process.env.BACKSPYNE_NODE_TOKEN;
  try {
    delete process.env.BACKSPYNE_REPORT_SHARE_SECRET;
    delete process.env.BACKSPYNE_NODE_TOKEN;
    assert.equal(shareLinksAvailable(), false);
    assert.equal(createReportShareToken({ ownerId: "user_operator", site: "s", operatorName: "o" }, NOW), null);
    assert.equal(readReportShareToken("anything", NOW), null);

    // The existing node credential is reused with domain separation rather than a default.
    process.env.BACKSPYNE_NODE_TOKEN = "node-credential-used-for-signing";
    assert.equal(shareLinksAvailable(), true);
    const viaNodeToken = createReportShareToken({ ownerId: "user_operator", site: "s", operatorName: "o" }, NOW);
    assert.ok(viaNodeToken);
    process.env.BACKSPYNE_REPORT_SHARE_SECRET = "test-share-secret-that-is-long-enough";
    assert.equal(readReportShareToken(viaNodeToken.token, NOW), null, "a token signed with another secret must not verify");
  } finally {
    if (dedicated === undefined) delete process.env.BACKSPYNE_REPORT_SHARE_SECRET;
    else process.env.BACKSPYNE_REPORT_SHARE_SECRET = dedicated;
    if (nodeToken === undefined) delete process.env.BACKSPYNE_NODE_TOKEN;
    else process.env.BACKSPYNE_NODE_TOKEN = nodeToken;
  }
});
