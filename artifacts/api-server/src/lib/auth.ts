// Who is asking.
//
// Operators sign in with Clerk, which is the right answer for a multi-tenant product. The
// deployment's own administrator signs in with a password checked against a configured
// verifier (see `adminAuth.ts`), because the owner of a deployment has to be able to open it
// when a third-party identity provider is not configured or not reachable.
//
// Both are one identity to the rest of the API: a request carries an owner id and every query
// is scoped to it. The administrator acts as the configured owner id, which the billing module
// already treats as owner access, so their relays, devices, reports, and calibrations behave
// like any other operator's instead of needing a parallel code path.

import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

import { ADMIN_COOKIE_NAME, adminOwnerId, readAdminSession } from "./adminAuth";
import { readRequestCookie } from "./requestCookie";

export type AuthenticatedRequest = Request & { userId?: string };

/**
 * The administrator's owner id for this request, or null. Only ever a session this deployment
 * signed: a cookie that cannot be verified is treated as absent.
 */
function adminOwnerIdForRequest(req: Request): string | null {
  const session = readAdminSession(readRequestCookie(req, ADMIN_COOKIE_NAME));
  return session ? adminOwnerId() : null;
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const auth = getAuth(req);
  const clerkUserId = String(auth?.sessionClaims?.userId || auth?.userId || "");
  const userId = clerkUserId || adminOwnerIdForRequest(req) || "";
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}

export function getOptionalUserId(req: Request): string | null {
  const auth = getAuth(req);
  const clerkUserId = auth?.sessionClaims?.userId || auth?.userId;
  if (clerkUserId) return String(clerkUserId);
  return adminOwnerIdForRequest(req);
}
