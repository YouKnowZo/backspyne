// The administrator's sign-in, sign-out, and session read.
//
// These three routes are deliberately kept out of `admin.ts`, which reads revenue from the
// database. The difference matters: importing a module that touches the database pulls in
// `@workspace/db`, and that module *throws at import time* when `DATABASE_URL` is unset. A
// deployment that has an administrator configured but no database yet — the exact state of a
// fresh staging box, and of a local checkout following the environment guide — would then
// answer a sign-in with a 500 and a log line about provisioning a database, for a route that
// never wanted one. Sign-in is configuration and crypto, so this router imports only
// configuration and crypto, and it answers whether or not a database exists.
//
// The rules carried over unchanged from the deployment's admin surface: exactly one identity,
// taken from configuration; a sign-in failure answered generically and counted, so the route
// cannot be used to discover which half of the credentials was wrong or to guess at speed; and
// a deployment with no administrator configured says so instead of exposing a login that could
// never succeed.

import { Router, type IRouter, type Request, type Response } from "express";

import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  adminConfigured,
  adminEmail,
  adminEmailMatches,
  adminLoginBlocked,
  adminOwnerId,
  adminPasswordHash,
  clearAdminLoginFailures,
  cookieOptions,
  createAdminSession,
  readAdminSession,
  registerAdminLoginFailure,
  verifyAdminPassword,
} from "../lib/adminAuth";
import { logger } from "../lib/logger";
import { readRequestCookie } from "../lib/requestCookie";

export const ADMIN_NOT_CONFIGURED = {
  error: "No administrator is configured on this deployment. Set BACKSPYNE_ADMIN_EMAIL and BACKSPYNE_ADMIN_PASSWORD_HASH (or BACKSPYNE_ADMIN_PASSWORD).",
  code: "admin_not_configured",
};

/** Sign-in throttling is keyed by client address; the body never decides who is blocked. */
export function clientKey(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/** The administrator's session cookie value, or undefined. */
export function adminCookie(req: Request): string | undefined {
  return readRequestCookie(req, ADMIN_COOKIE_NAME);
}

const router: IRouter = Router();

router.post("/admin/login", (req, res) => {
  if (!adminConfigured(process.env)) {
    res.status(503).json(ADMIN_NOT_CONFIGURED);
    return;
  }
  const key = clientKey(req);
  if (adminLoginBlocked(key)) {
    res.status(429).json({ error: "Too many failed sign-in attempts from this address. Try again later." });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || password.length < 8) {
    res.status(400).json({ error: "Enter the administrator email and password." });
    return;
  }
  const configuredEmail = adminEmail(process.env);
  const verifier = adminPasswordHash(process.env);
  // Both checks are evaluated (never short-circuited) so a wrong address and a wrong password
  // cost the same work, and the response says nothing about which one was wrong.
  const passwordMatches = verifyAdminPassword(password, verifier);
  const emailMatches = adminEmailMatches(email, configuredEmail);
  if (!verifier || !passwordMatches || !emailMatches) {
    registerAdminLoginFailure(key);
    logger.warn({ ip: key }, "Rejected an administrator sign-in attempt");
    res.status(401).json({ error: "Those credentials were not accepted." });
    return;
  }
  const token = createAdminSession(configuredEmail);
  if (!token) {
    res.status(503).json(ADMIN_NOT_CONFIGURED);
    return;
  }
  clearAdminLoginFailures(key);
  // The request's own transport is handed over so a local http checkout, which configures no
  // origin, gets a cookie its browser will actually keep.
  res.cookie(ADMIN_COOKIE_NAME, token, cookieOptions(process.env, { secureTransport: req.secure }));
  const session = readAdminSession(token);
  logger.info({ email: configuredEmail }, "Administrator signed in");
  res.json({ signedIn: true, email: configuredEmail, ownerId: adminOwnerId(process.env), expiresAt: session?.expiresAt ?? Date.now() + ADMIN_SESSION_TTL_MS });
});

router.post("/admin/logout", (req, res) => {
  // The attributes must match the ones the cookie was set with, or a browser keeps it.
  const options = cookieOptions(process.env, { secureTransport: req.secure });
  res.clearCookie(ADMIN_COOKIE_NAME, { httpOnly: options.httpOnly, sameSite: options.sameSite, secure: options.secure, path: options.path });
  res.json({ signedIn: false });
});

router.get("/admin/session", (req, res) => {
  const session = readAdminSession(adminCookie(req));
  res.json({
    configured: adminConfigured(process.env),
    signedIn: Boolean(session),
    email: session?.email ?? null,
    ownerId: session ? adminOwnerId(process.env) : null,
    expiresAt: session?.expiresAt ?? null,
  });
});

export default router;
