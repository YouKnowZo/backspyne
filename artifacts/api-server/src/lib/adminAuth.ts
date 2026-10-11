// The deployment's own administrator account.
//
// The operator console signs operators in with Clerk, which is the right answer for a
// multi-tenant product: invitations, sessions, and password resets are somebody else's
// well-tested problem. The *owner* of a deployment, though, needs a way in that does not
// depend on a third-party dashboard being reachable — to read revenue, check whether relays
// are reporting, and rotate configuration — and a local development checkout has no Clerk
// instance at all.
//
// So there is exactly one administrative identity, and it comes from configuration rather
// than from a database row: `BACKSPYNE_ADMIN_EMAIL` plus a password verifier. Nothing can
// create an administrator at runtime, no request can name one, and a deployment without those
// variables has no administrator at all (`adminConfigured` is false and the routes say so
// instead of half-working).
//
// The password is stored as a scrypt verifier (`scrypt$<salt>$<hash>`), never as plaintext;
// `BACKSPYNE_ADMIN_PASSWORD` is accepted as a convenience for a local checkout and is hashed
// with a salt derived from itself so the same verifier is produced on every call. Sessions are
// a signed cookie holding the email and an expiry — no server-side session table, no shared
// state between function instances — signed with a secret this module resolves from
// configuration (its own variable, or the relay token, or the report-share secret, each with
// domain separation so a value used for one purpose can never validate another).
//
// Pure crypto and configuration reading: no database, no request handling, so every claim here
// is testable directly.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE_NAME = "backspyne_admin";
/** How long a sign-in lasts before the administrator has to authenticate again. */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Failed sign-ins allowed from one address inside the window before it is refused. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const SCRYPT_LABEL = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SALT_HEX_LENGTH = SALT_BYTES * 2;
const KEY_HEX_LENGTH = KEY_BYTES * 2;
const MIN_PASSWORD_LENGTH = 8;
const SESSION_VERSION = "v1";

function envText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** `scrypt$<salt hex>$<key hex>`. */
export function hashAdminPassword(password: string, saltHex?: string): string {
  const salt = saltHex && new RegExp(`^[0-9a-fA-F]{${SALT_HEX_LENGTH}}$`).test(saltHex)
    ? Buffer.from(saltHex, "hex")
    : randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES);
  return `${SCRYPT_LABEL}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Constant-time check of a password against a stored verifier. A malformed stored value is a
 * failure, never an exception: a broken configuration must not turn into a 500, and it must
 * not turn into an accepted password either.
 */
export function verifyAdminPassword(password: string, stored: string | null | undefined): boolean {
  if (typeof password !== "string" || !password || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_LABEL || parts[1].length !== SALT_HEX_LENGTH || parts[2].length !== KEY_HEX_LENGTH) return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, KEY_BYTES);
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * The password verifier this deployment is configured with, or null when there is none.
 *
 * `BACKSPYNE_ADMIN_PASSWORD_HASH` wins. Otherwise `BACKSPYNE_ADMIN_PASSWORD` is accepted and
 * hashed with a salt derived from the password itself: the salt is not secret here (the whole
 * value is already configuration), and a deterministic salt means every call produces the same
 * verifier, so a login verifies against a stable value instead of one that changes per request.
 */
export function adminPasswordHash(env: NodeJS.ProcessEnv = process.env): string | null {
  const stored = envText(env, "BACKSPYNE_ADMIN_PASSWORD_HASH");
  if (stored) {
    const parts = stored.split("$");
    const wellFormed = parts.length === 3 && parts[0] === SCRYPT_LABEL && parts[1].length === SALT_HEX_LENGTH && parts[2].length === KEY_HEX_LENGTH;
    return wellFormed ? stored : null;
  }
  const plain = env["BACKSPYNE_ADMIN_PASSWORD"];
  if (typeof plain !== "string" || plain.length < MIN_PASSWORD_LENGTH) return null;
  const derivedSalt = createHash("sha256").update(plain, "utf8").digest("hex").slice(0, SALT_HEX_LENGTH);
  return hashAdminPassword(plain, derivedSalt);
}

export function adminEmail(env: NodeJS.ProcessEnv = process.env): string {
  return envText(env, "BACKSPYNE_ADMIN_EMAIL");
}

/** The owner id an administrator acts as, so their relays, devices, and reports have an owner. */
export function adminOwnerId(env: NodeJS.ProcessEnv = process.env): string {
  return envText(env, "BACKSPYNE_ADMIN_OWNER_ID") || "admin";
}

function plausibleEmail(value: string): boolean {
  return value.length >= 5 && value.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** True when this deployment has a usable administrator: an address and a password verifier. */
export function adminConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return plausibleEmail(adminEmail(env)) && Boolean(adminPasswordHash(env)) && Boolean(adminSessionSecret(env));
}

/**
 * The key that signs admin session cookies. Resolution is ordered and each fallback is domain
 * separated by its own message, so a value configured for relay ingest or report sharing can
 * sign exactly one purpose and never the other.
 */
export function adminSessionSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const dedicated = envText(env, "BACKSPYNE_ADMIN_SESSION_SECRET");
  if (dedicated.length >= 16) return dedicated;
  const relayToken = envText(env, "BACKSPYNE_NODE_TOKEN");
  if (relayToken.length >= 32) return createHmac("sha256", "backspyne.admin.session").update(relayToken, "utf8").digest("hex");
  const shareSecret = envText(env, "BACKSPYNE_REPORT_SHARE_SECRET");
  if (shareSecret.length >= 16) return createHmac("sha256", "backspyne.admin.session").update(shareSecret, "utf8").digest("hex");
  return null;
}

function signSession(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * A signed session token: `v1.<expiresAt>.<base64url email>.<signature>`. Everything the
 * server needs travels in the cookie, so any instance can validate it with the configured
 * secret alone. Returns null when no signing secret is configured, which is what makes
 * `adminConfigured` false rather than issuing an unsigned session.
 */
export function createAdminSession(
  email: string,
  options: { now?: number; ttlMs?: number; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = options.env ?? process.env;
  const secret = adminSessionSecret(env);
  if (!secret || !plausibleEmail(email)) return null;
  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? ADMIN_SESSION_TTL_MS);
  const body = `${SESSION_VERSION}.${expiresAt}.${Buffer.from(email, "utf8").toString("base64url")}`;
  return `${body}.${signSession(body, secret)}`;
}

/** The session a token proves, or null for absent, tampered, or expired tokens. */
export function readAdminSession(
  token: string | undefined | null,
  options: { now?: number; env?: NodeJS.ProcessEnv } = {},
): { email: string; ownerId: string; expiresAt: number } | null {
  if (typeof token !== "string" || !token) return null;
  const env = options.env ?? process.env;
  const secret = adminSessionSecret(env);
  if (!secret) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = signSession(body, secret);
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;
  const parts = body.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;
  const expiresAt = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? Date.now())) return null;
  let email = "";
  try {
    email = Buffer.from(parts[2], "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!plausibleEmail(email)) return null;
  return { email, ownerId: adminOwnerId(env), expiresAt };
}

/** Case-insensitive, constant-time comparison, so a wrong address costs the same as a wrong password. */
export function adminEmailMatches(submitted: unknown, configured: string): boolean {
  if (typeof submitted !== "string" || !configured) return false;
  const left = createHash("sha256").update(submitted.trim().toLowerCase(), "utf8").digest();
  const right = createHash("sha256").update(configured.trim().toLowerCase(), "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Cookie attributes for the session.
 *
 * `Secure` is decided in this order, because getting it wrong is invisible in the worst way:
 * a browser *silently drops* a Secure cookie sent over http, so the sign-in answers 200, no
 * session exists afterwards, and it looks exactly like a rejected password.
 *
 *   1. The configured origin wins when it is set, since it is the operator's declaration of
 *      how the product is served. A loopback origin is http and gets no flag; anything else
 *      is treated as https and gets it — including a hostname we do not recognise, so a
 *      misconfigured origin can never quietly downgrade the cookie.
 *   2. Otherwise the transport the request actually arrived over decides. A local checkout
 *      serving http on loopback sets `FRONTEND_ORIGIN` nowhere and has no TLS, and a
 *      cookie it cannot keep is a login that cannot work.
 *   3. With neither, https is assumed. A caller that cannot say is not a reason to weaken the
 *      flag.
 */
export function cookieOptions(
  env: NodeJS.ProcessEnv = process.env,
  transport: { secureTransport?: boolean } = {},
): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  const origin = envText(env, "FRONTEND_ORIGIN");
  const secure = origin
    ? !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
    : transport.secureTransport !== false;
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: ADMIN_SESSION_TTL_MS };
}

interface LoginAttempts {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

const attempts = new Map<string, LoginAttempts>();

/**
 * Failed-sign-in accounting, kept in this module so the policy is one implementation and can
 * be tested without a request. The map is per process, which is the honest limit of a
 * dependency-free throttle: it stops password guessing against one instance, and a
 * multi-instance deployment should also rate-limit at the edge.
 */
export function adminLoginBlocked(key: string, now: number = Date.now()): boolean {
  const record = attempts.get(key);
  if (!record) return false;
  if (record.blockedUntil > now) return true;
  if (now - record.lastFailureAt > LOGIN_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return false;
}

export function registerAdminLoginFailure(key: string, now: number = Date.now()): void {
  const record = attempts.get(key) ?? { failures: 0, blockedUntil: 0, lastFailureAt: now };
  if (now - record.lastFailureAt > LOGIN_WINDOW_MS) record.failures = 0;
  record.failures += 1;
  record.lastFailureAt = now;
  if (record.failures >= LOGIN_MAX_FAILURES) record.blockedUntil = now + LOGIN_WINDOW_MS;
  attempts.set(key, record);
}

export function clearAdminLoginFailures(key: string): void {
  attempts.delete(key);
}

/** Test and operator escape hatch: forget every recorded failure. */
export function resetAdminLoginFailures(): void {
  attempts.clear();
}
