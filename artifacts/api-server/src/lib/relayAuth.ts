// Credential handling for authorized local relays.
//
// A relay proves two independent things on every ingest:
//   1. it knows the plaintext token (HMAC-SHA256 of the exact body, keyed by that token),
//   2. that token is one the deployment accepts (the shared deployment token, or a
//      per-operator token whose SHA-256 digest is on file and not revoked).
//
// Only digests are stored, so a database read cannot be replayed as a credential. The
// helpers here are dependency-light and pure so they can be unit tested directly.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RELAY_TOKEN_PREFIX = "bsn_";
const RELAY_TOKEN_BYTES = 24;
const RELAY_TOKEN_PATTERN = /^bsn_[0-9a-f]{48}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;
export const MIN_SHARED_TOKEN_LENGTH = 32;

/** Fresh pairing token. 24 random bytes, hex encoded, prefixed for recognisability. */
export function generateRelayToken(): string {
  return `${RELAY_TOKEN_PREFIX}${randomBytes(RELAY_TOKEN_BYTES).toString("hex")}`;
}

export function isPlausibleRelayToken(value: unknown): value is string {
  return typeof value === "string" && RELAY_TOKEN_PATTERN.test(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two secrets. Length differences are not secret-dependent. */
export function secretsMatch(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

/**
 * Constant-time comparison of two hex digests. Hex is case-insensitive, so both sides
 * are lowercased first; the accepted pattern and the comparison must agree.
 */
export function digestsMatch(suppliedHex: string, expectedHex: string): boolean {
  if (!SIGNATURE_PATTERN.test(suppliedHex) || !SIGNATURE_PATTERN.test(expectedHex)) return false;
  const supplied = Buffer.from(suppliedHex.toLowerCase(), "utf8");
  const expected = Buffer.from(expectedHex.toLowerCase(), "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Verifies the relay's HMAC over the exact request body. The supplied token is the key,
 * which is what the bridge signs with, so a valid signature proves possession of the
 * token before the token itself is looked up.
 */
export function signatureMatches(rawBody: string, suppliedToken: string, signatureHeader: string | undefined | null): boolean {
  if (!suppliedToken || typeof signatureHeader !== "string" || !SIGNATURE_PATTERN.test(signatureHeader)) return false;
  const expected = createHmac("sha256", suppliedToken).update(rawBody, "utf8").digest("hex");
  return digestsMatch(signatureHeader, expected);
}

export type CredentialKind = "deployment" | "operator";

export interface ResolvedRelayCredential {
  kind: CredentialKind;
  /** Operator this relay is allowed to report for. */
  ownerId: string;
  /** Relay token row id, for usage tracking. Absent for the shared deployment token. */
  relayTokenId?: string;
}

export interface CredentialLookup {
  /** Owner bound to a per-operator token digest, or null when the token is unknown/revoked. */
  operatorForTokenHash: (tokenHash: string) => Promise<{ id: string; ownerId: string } | null>;
}

export interface DeploymentCredential {
  token: string | null;
  ownerId: string | null;
}

/**
 * Reads the shared single-operator credential from the environment. This is the
 * pre-pairing behaviour and is still supported so an existing relay keeps working after
 * the upgrade; new operators pair per-account tokens instead.
 */
export function deploymentCredential(env: Record<string, string | undefined>): DeploymentCredential {
  const token = (env.BACKSPYNE_NODE_TOKEN ?? "").trim();
  const ownerId = (env.BACKSPYNE_NODE_OWNER_ID ?? "").trim();
  const usable = token.length >= MIN_SHARED_TOKEN_LENGTH && ownerId.length > 0;
  return { token: usable ? token : null, ownerId: usable ? ownerId : null };
}

export interface CredentialRequest {
  rawBody: string;
  suppliedToken: string | undefined | null;
  signatureHeader: string | undefined | null;
}

/**
 * Resolves which operator a relay request may report for, or null when it must be
 * rejected. The shared deployment credential is checked first so a deployment that has
 * not been migrated cannot be locked out by a database problem.
 */
export async function resolveRelayCredential(
  request: CredentialRequest,
  deployment: DeploymentCredential,
  lookup: CredentialLookup,
): Promise<ResolvedRelayCredential | null> {
  const suppliedToken = typeof request.suppliedToken === "string" ? request.suppliedToken : "";
  if (!suppliedToken) return null;
  if (!signatureMatches(request.rawBody, suppliedToken, request.signatureHeader)) return null;
  if (deployment.token && deployment.ownerId && secretsMatch(suppliedToken, deployment.token)) {
    return { kind: "deployment", ownerId: deployment.ownerId };
  }
  if (!isPlausibleRelayToken(suppliedToken)) return null;
  const record = await lookup.operatorForTokenHash(sha256Hex(suppliedToken));
  if (!record) return null;
  return { kind: "operator", ownerId: record.ownerId, relayTokenId: record.id };
}
