// Tests for the administrator account.
//
//   node --experimental-strip-types --test artifacts/api-server/test/adminAuth.test.ts
//
// The administrator is one configured identity with a password verifier and a signed cookie,
// and it is the only way into a deployment that has no Clerk instance. That makes it a
// security boundary worth testing directly rather than through a browser: a verifier must not
// accept a wrong password or a malformed stored value, a session must not survive tampering or
// expiry, a session signed with a different secret must not validate, and repeated failures
// must stop being answered at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  LOGIN_MAX_FAILURES,
  adminConfigured,
  adminEmail,
  adminEmailMatches,
  adminLoginBlocked,
  adminOwnerId,
  adminPasswordHash,
  adminSessionSecret,
  clearAdminLoginFailures,
  cookieOptions,
  createAdminSession,
  hashAdminPassword,
  readAdminSession,
  registerAdminLoginFailure,
  resetAdminLoginFailures,
  verifyAdminPassword,
} from "../src/lib/adminAuth.ts";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "correct horse battery stapl3";

const CONFIGURED: NodeJS.ProcessEnv = {
  BACKSPYNE_ADMIN_EMAIL: "owner@backspyne.test",
  BACKSPYNE_ADMIN_PASSWORD: PASSWORD,
  BACKSPYNE_ADMIN_SESSION_SECRET: "a-session-secret-long-enough-to-use",
  FRONTEND_ORIGIN: "https://backspyne-app.vercel.app",
};

test("a password verifier round-trips and rejects everything else", () => {
  const stored = hashAdminPassword(PASSWORD);
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyAdminPassword(PASSWORD, stored), true);
  assert.equal(verifyAdminPassword(OTHER_PASSWORD, stored), false);
  assert.equal(verifyAdminPassword("", stored), false);
  assert.equal(verifyAdminPassword(PASSWORD, null), false);
  assert.equal(verifyAdminPassword(PASSWORD, undefined), false);
  // Two hashes of one password differ, because each carries its own salt, and both verify.
  const second = hashAdminPassword(PASSWORD);
  assert.notEqual(second, stored);
  assert.equal(verifyAdminPassword(PASSWORD, second), true);
  // A fixed salt reproduces the same verifier, which is what makes the plaintext
  // environment variable stable across calls.
  assert.equal(hashAdminPassword(PASSWORD, "0".repeat(32)), hashAdminPassword(PASSWORD, "0".repeat(32)));
  // A salt of the wrong shape is ignored rather than misread.
  assert.notEqual(hashAdminPassword(PASSWORD, "not-hex"), hashAdminPassword(PASSWORD, "not-hex"));
});

test("a malformed stored verifier fails closed instead of throwing", () => {
  for (const broken of ["", "scrypt", "scrypt$", "scrypt$aa$bb", "bcrypt$" + "0".repeat(32) + "$" + "0".repeat(128), "scrypt$" + "z".repeat(32) + "$" + "0".repeat(128), "scrypt$" + "0".repeat(32) + "$short"]) {
    assert.equal(verifyAdminPassword(PASSWORD, broken), false, `expected ${JSON.stringify(broken)} to be rejected`);
  }
});

test("the configured verifier comes from configuration and is absent without it", () => {
  assert.equal(adminPasswordHash({}), null);
  // A short plaintext password is refused rather than hashed into a weak verifier.
  assert.equal(adminPasswordHash({ BACKSPYNE_ADMIN_PASSWORD: "short" }), null);
  const fromPlain = adminPasswordHash({ BACKSPYNE_ADMIN_PASSWORD: PASSWORD });
  assert.ok(fromPlain);
  assert.equal(verifyAdminPassword(PASSWORD, fromPlain), true);
  // A stored hash wins over a plaintext variable, and the plaintext is never used instead.
  const stored = hashAdminPassword("a different password entirely");
  const both = adminPasswordHash({ BACKSPYNE_ADMIN_PASSWORD_HASH: stored, BACKSPYNE_ADMIN_PASSWORD: PASSWORD });
  assert.equal(both, stored);
  assert.equal(verifyAdminPassword("a different password entirely", both), true);
  assert.equal(verifyAdminPassword(PASSWORD, both), false);
  // A malformed stored hash is reported as no verifier at all, so the route says the
  // deployment is not configured instead of rejecting every password forever.
  assert.equal(adminPasswordHash({ BACKSPYNE_ADMIN_PASSWORD_HASH: "nonsense" }), null);
  assert.equal(adminPasswordHash({ BACKSPYNE_ADMIN_PASSWORD_HASH: "scrypt$aa$bb" }), null);
});

test("an administrator exists only when an address, a verifier, and a signing secret do", () => {
  assert.equal(adminConfigured({}), false);
  assert.equal(adminConfigured({ ...CONFIGURED, BACKSPYNE_ADMIN_EMAIL: "" }), false);
  assert.equal(adminConfigured({ ...CONFIGURED, BACKSPYNE_ADMIN_EMAIL: "not an address" }), false);
  assert.equal(adminConfigured({ ...CONFIGURED, BACKSPYNE_ADMIN_PASSWORD: "", BACKSPYNE_ADMIN_PASSWORD_HASH: "" }), false);
  assert.equal(adminConfigured({ ...CONFIGURED, BACKSPYNE_ADMIN_SESSION_SECRET: "too-short" }), false);
  assert.equal(adminConfigured(CONFIGURED), true);
  assert.equal(adminEmail(CONFIGURED), "owner@backspyne.test");
  assert.equal(adminEmail({}), "");
});

test("the signing secret is resolved from configuration, domain separated from every fallback", () => {
  assert.equal(adminSessionSecret({}), null);
  assert.equal(adminSessionSecret({ BACKSPYNE_ADMIN_SESSION_SECRET: "short" }), null);
  const dedicated = adminSessionSecret({ BACKSPYNE_ADMIN_SESSION_SECRET: "a-session-secret-long-enough" });
  assert.equal(dedicated, "a-session-secret-long-enough");
  const fromRelay = adminSessionSecret({ BACKSPYNE_NODE_TOKEN: "n".repeat(40) });
  assert.ok(fromRelay && fromRelay.length === 64);
  // The derived key is not the relay token itself, so a leaked session signature cannot be
  // replayed against ingest.
  assert.notEqual(fromRelay, "n".repeat(40));
  const fromShare = adminSessionSecret({ BACKSPYNE_REPORT_SHARE_SECRET: "s".repeat(20) });
  assert.ok(fromShare && fromShare.length === 64);
  assert.notEqual(fromRelay, fromShare);
  // A dedicated secret always wins over both fallbacks.
  assert.equal(adminSessionSecret({ ...CONFIGURED, BACKSPYNE_NODE_TOKEN: "n".repeat(40) }), "a-session-secret-long-enough-to-use");
});

test("the owner id defaults to admin and can be overridden", () => {
  assert.equal(adminOwnerId({}), "admin");
  assert.equal(adminOwnerId({ BACKSPYNE_ADMIN_OWNER_ID: "  " }), "admin");
  assert.equal(adminOwnerId({ BACKSPYNE_ADMIN_OWNER_ID: " owner_1 " }), "owner_1");
});

test("an address is compared case-insensitively and never by prefix", () => {
  assert.equal(adminEmailMatches("owner@backspyne.test", "owner@backspyne.test"), true);
  assert.equal(adminEmailMatches("  OWNER@BackSpyne.Test ", "owner@backspyne.test"), true);
  assert.equal(adminEmailMatches("owner@backspyne.tes", "owner@backspyne.test"), false);
  assert.equal(adminEmailMatches("owner@backspyne.testx", "owner@backspyne.test"), false);
  assert.equal(adminEmailMatches("", "owner@backspyne.test"), false);
  assert.equal(adminEmailMatches("owner@backspyne.test", ""), false);
  assert.equal(adminEmailMatches(null, "owner@backspyne.test"), false);
});

test("a session round-trips and carries the configured owner", () => {
  const now = 1_700_000_000_000;
  const token = createAdminSession("owner@backspyne.test", { now, env: CONFIGURED });
  assert.ok(token);
  assert.match(token!, /^v1\.\d+\.[A-Za-z0-9_-]+\./);
  const session = readAdminSession(token, { now: now + 1000, env: CONFIGURED });
  assert.ok(session);
  assert.equal(session!.email, "owner@backspyne.test");
  assert.equal(session!.ownerId, "admin");
  assert.equal(session!.expiresAt, now + ADMIN_SESSION_TTL_MS);
  // The cookie name is part of the contract the browser and the route share.
  assert.equal(ADMIN_COOKIE_NAME, "backspyne_admin");

  const overridden = readAdminSession(createAdminSession("owner@backspyne.test", { now, env: { ...CONFIGURED, BACKSPYNE_ADMIN_OWNER_ID: "owner_9" } }), { now, env: { ...CONFIGURED, BACKSPYNE_ADMIN_OWNER_ID: "owner_9" } });
  assert.equal(overridden?.ownerId, "owner_9");
});

test("no session survives expiry, tampering, or a different signing secret", () => {
  const now = 1_700_000_000_000;
  const token = createAdminSession("owner@backspyne.test", { now, env: CONFIGURED })!;
  // Expiry is a hard boundary, one millisecond past it is out.
  assert.equal(readAdminSession(token, { now: now + ADMIN_SESSION_TTL_MS, env: CONFIGURED }), null);
  assert.ok(readAdminSession(token, { now: now + ADMIN_SESSION_TTL_MS - 1, env: CONFIGURED }));
  // Absent and malformed tokens are simply not a session.
  for (const absent of [undefined, null, "", "v1.", "nonsense"]) {
    assert.equal(readAdminSession(absent, { now, env: CONFIGURED }), null);
  }
  // A tampered payload or signature fails; the signature covers the whole body.
  const [version, expiry, email, signature] = token.split(".");
  assert.equal(readAdminSession([version, expiry, email, "0".repeat(signature.length)].join("."), { now, env: CONFIGURED }), null);
  assert.equal(readAdminSession([version, expiry, email.slice(0, -2) + "zz", signature].join("."), { now, env: CONFIGURED }), null);
  assert.equal(readAdminSession([version, String(Number(expiry) + 86_400_000), email, signature].join("."), { now, env: CONFIGURED }), null);
  assert.equal(readAdminSession([version, expiry, email].join("."), { now, env: CONFIGURED }), null);
  // A token signed with another deployment's secret does not validate here.
  const foreign = createAdminSession("owner@backspyne.test", { now, env: { ...CONFIGURED, BACKSPYNE_ADMIN_SESSION_SECRET: "a-completely-different-secret-value" } })!;
  assert.equal(readAdminSession(foreign, { now, env: CONFIGURED }), null);
  // And a deployment with no secret at all can neither mint nor read a session.
  assert.equal(createAdminSession("owner@backspyne.test", { now, env: {} }), null);
  assert.equal(readAdminSession(token, { now, env: {} }), null);
});

test("the session cookie is http-only, same-site, and secure only off loopback", () => {
  const production = cookieOptions({ ...CONFIGURED, FRONTEND_ORIGIN: "https://backspyne-app.vercel.app" });
  assert.equal(production.httpOnly, true);
  assert.equal(production.sameSite, "lax");
  assert.equal(production.secure, true);
  assert.equal(production.path, "/");
  assert.equal(production.maxAge, ADMIN_SESSION_TTL_MS);
  // A loopback development origin is http, and a Secure cookie would be dropped there.
  assert.equal(cookieOptions({ FRONTEND_ORIGIN: "http://localhost:5173" }).secure, false);
  assert.equal(cookieOptions({ FRONTEND_ORIGIN: "http://127.0.0.1:8080" }).secure, false);
  assert.equal(cookieOptions({}).secure, true);
  assert.equal(cookieOptions({ FRONTEND_ORIGIN: "http://evil.example.com" }).secure, true);
});

test("with no declared origin the request's own transport decides the cookie's Secure flag", () => {
  // A local checkout serving plain http on loopback declares no origin and has no TLS. A
  // Secure cookie there is dropped by the browser, so the sign-in answers 200 and no session
  // exists afterwards — indistinguishable from a rejected password.
  assert.equal(cookieOptions({}, { secureTransport: false }).secure, false);
  assert.equal(cookieOptions({}, { secureTransport: true }).secure, true);
  // A caller that cannot say keeps the flag rather than dropping it.
  assert.equal(cookieOptions({}, {}).secure, true);
  // An explicit origin still outranks the transport, in both directions: a deployment that
  // declares https behind a proxy that terminated TLS gets the flag even though the request
  // it sees arrived unencrypted.
  assert.equal(cookieOptions({ FRONTEND_ORIGIN: "https://backspyne-app.vercel.app" }, { secureTransport: false }).secure, true);
  assert.equal(cookieOptions({ FRONTEND_ORIGIN: "http://localhost:4599" }, { secureTransport: true }).secure, false);
});

test("the deployment's administrator is only configured with every value a session needs", () => {
  // An address and a password are not enough: without a signing secret no unforgeable session
  // can be minted, so the deployment reports itself unconfigured rather than half-working.
  assert.equal(adminConfigured({ ...CONFIGURED }), true);
  assert.equal(adminConfigured({ ...CONFIGURED, BACKSPYNE_ADMIN_SESSION_SECRET: "" }), false);
  // A verifier that is malformed is a failure, never an accepted password.
  assert.equal(adminConfigured({ ...CONFIGURED, BACKSPYNE_ADMIN_PASSWORD_HASH: "scrypt$deadbeef$deadbeef" }), false);
  // The plaintext convenience variable counts only at or above the minimum the route accepts.
  const withPlain = { BACKSPYNE_ADMIN_EMAIL: "owner@backspyne.test", BACKSPYNE_ADMIN_PASSWORD: "a-long-enough-secret", BACKSPYNE_ADMIN_SESSION_SECRET: "a-completely-different-secret-value" };
  assert.equal(adminConfigured(withPlain), true);
  assert.equal(verifyAdminPassword("a-long-enough-secret", adminPasswordHash(withPlain)), true);
  assert.equal(adminConfigured({ ...withPlain, BACKSPYNE_ADMIN_PASSWORD: "short" }), false);
});

test("repeated failures from one address stop being answered", () => {
  resetAdminLoginFailures();
  const now = 1_700_000_000_000;
  const key = "203.0.113.7";
  assert.equal(adminLoginBlocked(key, now), false);
  for (let attempt = 1; attempt <= LOGIN_MAX_FAILURES; attempt += 1) {
    assert.equal(adminLoginBlocked(key, now), false, `attempt ${attempt} should still be answered`);
    registerAdminLoginFailure(key, now);
  }
  assert.equal(adminLoginBlocked(key, now), true);
  assert.equal(adminLoginBlocked(key, now + 60_000), true);
  // The block lifts after the window, and another address is never affected by it.
  assert.equal(adminLoginBlocked(key, now + 15 * 60_000 + 1), false);
  assert.equal(adminLoginBlocked("203.0.113.8", now), false);
  // Failures spread across more than a window do not accumulate into a block.
  const slow = "203.0.113.9";
  for (let attempt = 0; attempt < LOGIN_MAX_FAILURES + 2; attempt += 1) {
    registerAdminLoginFailure(slow, now + attempt * (15 * 60_000 + 1));
  }
  assert.equal(adminLoginBlocked(slow, now + (LOGIN_MAX_FAILURES + 2) * (15 * 60_000 + 1)), false);
  // A successful sign-in clears the count.
  registerAdminLoginFailure(key, now);
  clearAdminLoginFailures(key);
  assert.equal(adminLoginBlocked(key, now), false);
  resetAdminLoginFailures();
});
