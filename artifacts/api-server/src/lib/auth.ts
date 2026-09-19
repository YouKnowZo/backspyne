import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

export type AuthenticatedRequest = Request & { userId?: string };

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const auth = getAuth(req);
  const userId = String(auth?.sessionClaims?.userId || auth?.userId || "");
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}

export function getOptionalUserId(req: Request): string | null {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId || auth?.userId;
  return userId ? String(userId) : null;
}