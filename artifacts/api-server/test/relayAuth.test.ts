// Unit tests for relay credential handling. These run on Node's built-in test runner
// with native TypeScript type stripping, with no database and no relay:
//
//   node --test artifacts/api-server/test/relayAuth.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  RELAY_TOKEN_PREFIX,
  deploymentCredential,
  digestsMatch,
  generateRelayToken,
  isPlausibleRelayToken,
  resolveRelayCredential,
  secretsMatch,
  sha256Hex,
  signatureMatches,
  type CredentialLookup,
} from "../src/lib/relayAuth.ts";

const DEPLOYMENT_TOKEN = "d".repeat(64);
const OPERATOR_TOKEN = "bsn_" + "a1b2c3d4e5f6".repeat(4);

function body(payload: Record<string, unknown> = { nodeId: "relay-1" }): string {
  return JSON.stringify(payload);
}

function sign(rawBody: string, token: string): string {
  return createHmac("sha256", token).update(rawBody, "utf8").digest("hex");
}

function lookupReturning(record: { id: string; ownerId: string } | null, calls: string[] = []): CredentialLookup {
  return {
    operatorForTokenHash: async (tokenHash: string) => {
      calls.push(tokenHash);
      return record;
    },
  };
}

test("generated pairing tokens have the documented shape and are unique", () => {
  const tokens = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const token = generateRelayToken();
    assert.ok(token.startsWith(RELAY_TOKEN_PREFIX));
    assert.equal(token.length, RELAY_TOKEN_PREFIX.length + 48);
    assert.match(token, /^bsn_[0-9a-f]{48}$/);
    assert.equal(isPlausibleRelayToken(token), true);
    tokens.add(token);
  }
  assert.equal(tokens.size, 50);
});

test("implausible tokens are rejected before any lookup happens", () => {
  for (const candidate of [
    "",
    "short",
    "bsn_",
    "bsn_" + "a".repeat(47),
    "bsn_" + "a".repeat(49),
    "bsn_" + "Z".repeat(48),
    "BSN_" + "a".repeat(48),
    "d".repeat(64),
    null,
    undefined,
    42,
  ]) {
    assert.equal(isPlausibleRelayToken(candidate), false, `expected ${String(candidate)} to be rejected`);
  }
});

test("sha256Hex matches a known vector", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("secret and digest comparisons are exact and length safe", () => {
  assert.equal(secretsMatch("token", "token"), true);
  assert.equal(secretsMatch("token", "toke"), false);
  assert.equal(secretsMatch("token", "tokeN"), false);
  assert.equal(secretsMatch("", ""), true);

  const digest = sha256Hex("abc");
  assert.equal(digestsMatch(digest, digest), true);
  assert.equal(digestsMatch(digest, sha256Hex("abd")), false);
  assert.equal(digestsMatch(digest.toUpperCase(), digest), true);
  assert.equal(digestsMatch("not-a-digest", digest), false);
  assert.equal(digestsMatch(digest, "short"), false);
});

test("signature verification binds the body to the supplied token", () => {
  const rawBody = body();
  assert.equal(signatureMatches(rawBody, DEPLOYMENT_TOKEN, sign(rawBody, DEPLOYMENT_TOKEN)), true);
  // A different key must not validate.
  assert.equal(signatureMatches(rawBody, DEPLOYMENT_TOKEN, sign(rawBody, OPERATOR_TOKEN)), false);
  // A tampered body must not validate.
  assert.equal(signatureMatches(`${rawBody} `, DEPLOYMENT_TOKEN, sign(rawBody, DEPLOYMENT_TOKEN)), false);
  // Malformed headers never throw and never validate.
  for (const header of [undefined, null, "", "abc", "a".repeat(63), "z".repeat(64)]) {
    assert.equal(signatureMatches(rawBody, DEPLOYMENT_TOKEN, header), false);
  }
  assert.equal(signatureMatches(rawBody, "", sign(rawBody, "")), false);
});

test("the shared deployment credential requires both values and trims whitespace", () => {
  const complete = deploymentCredential({ BACKSPYNE_NODE_TOKEN: DEPLOYMENT_TOKEN, BACKSPYNE_NODE_OWNER_ID: "user_1" });
  assert.deepEqual(complete, { token: DEPLOYMENT_TOKEN, ownerId: "user_1" });

  const padded = deploymentCredential({ BACKSPYNE_NODE_TOKEN: ` ${DEPLOYMENT_TOKEN} `, BACKSPYNE_NODE_OWNER_ID: " user_1 " });
  assert.deepEqual(padded, { token: DEPLOYMENT_TOKEN, ownerId: "user_1" });

  for (const env of [
    {},
    { BACKSPYNE_NODE_TOKEN: DEPLOYMENT_TOKEN },
    { BACKSPYNE_NODE_OWNER_ID: "user_1" },
    { BACKSPYNE_NODE_TOKEN: "too-short", BACKSPYNE_NODE_OWNER_ID: "user_1" },
  ]) {
    assert.deepEqual(deploymentCredential(env), { token: null, ownerId: null });
  }
});

test("the existing relay keeps working through the deployment credential", async () => {
  const rawBody = body();
  const calls: string[] = [];
  const resolved = await resolveRelayCredential(
    { rawBody, suppliedToken: DEPLOYMENT_TOKEN, signatureHeader: sign(rawBody, DEPLOYMENT_TOKEN) },
    deploymentCredential({ BACKSPYNE_NODE_TOKEN: DEPLOYMENT_TOKEN, BACKSPYNE_NODE_OWNER_ID: "user_1" }),
    lookupReturning(null, calls),
  );
  assert.deepEqual(resolved, { kind: "deployment", ownerId: "user_1" });
  // The deployment token is not a pairing token, so no lookup should be attempted.
  assert.equal(calls.length, 0);
});

test("a paired operator token resolves to its own account", async () => {
  const rawBody = body();
  const calls: string[] = [];
  const resolved = await resolveRelayCredential(
    { rawBody, suppliedToken: OPERATOR_TOKEN, signatureHeader: sign(rawBody, OPERATOR_TOKEN) },
    { token: DEPLOYMENT_TOKEN, ownerId: "user_deployment" },
    lookupReturning({ id: "relay_1", ownerId: "user_operator" }, calls),
  );
  assert.deepEqual(resolved, { kind: "operator", ownerId: "user_operator", relayTokenId: "relay_1" });
  assert.deepEqual(calls, [sha256Hex(OPERATOR_TOKEN)]);
});

test("unknown, revoked, and unpaired operator tokens are rejected", async () => {
  const rawBody = body();
  const request = { rawBody, suppliedToken: OPERATOR_TOKEN, signatureHeader: sign(rawBody, OPERATOR_TOKEN) };
  // A revoked or unknown token looks the same from here: the lookup finds nothing.
  assert.equal(await resolveRelayCredential(request, { token: null, ownerId: null }, lookupReturning(null)), null);
  // A deployment with only half of the shared credential configured still rejects the
  // shared token, and must not fall through to a lookup for it.
  const calls: string[] = [];
  assert.equal(
    await resolveRelayCredential(
      { rawBody, suppliedToken: DEPLOYMENT_TOKEN, signatureHeader: sign(rawBody, DEPLOYMENT_TOKEN) },
      { token: DEPLOYMENT_TOKEN, ownerId: null },
      lookupReturning(null, calls),
    ),
    null,
  );
  assert.equal(calls.length, 0);
});

test("a bad signature is rejected before any token lookup", async () => {
  const rawBody = body();
  const calls: string[] = [];
  const resolved = await resolveRelayCredential(
    { rawBody, suppliedToken: OPERATOR_TOKEN, signatureHeader: sign("different body", OPERATOR_TOKEN) },
    { token: DEPLOYMENT_TOKEN, ownerId: "user_deployment" },
    lookupReturning({ id: "relay_1", ownerId: "user_operator" }, calls),
  );
  assert.equal(resolved, null);
  assert.equal(calls.length, 0);
});

test("a missing token is rejected without touching the database", async () => {
  const rawBody = body();
  const calls: string[] = [];
  for (const suppliedToken of [undefined, null, ""]) {
    assert.equal(
      await resolveRelayCredential(
        { rawBody, suppliedToken, signatureHeader: sign(rawBody, OPERATOR_TOKEN) },
        { token: null, ownerId: null },
        lookupReturning(null, calls),
      ),
      null,
    );
  }
  assert.equal(calls.length, 0);
});
