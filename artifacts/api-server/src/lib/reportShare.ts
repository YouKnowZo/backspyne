/**
 * Share links for a client-ready assessment.
 *
 * An operator's job ends by handing something over, and the client who receives it has no
 * BackSpyne account. A share link therefore has to carry its own authority: it names the
 * account whose observations may be read, the display labels the operator chose, and the
 * moment it stops working — all inside a signature the server can verify without a session
 * and without a database table.
 *
 * Two properties matter and are tested:
 *  - The link is scoped. The owner id is inside the signed payload, so a link can only ever
 *    render the account that issued it, never another operator's site.
 *  - The link expires. Every link carries an expiry that is part of the signature, so it
 *    cannot be extended by editing the URL.
 *
 * Stateless links are deliberate: nothing is stored, so there is no share record to leak,
 * rotate, or clean up, and revoking one means waiting out a deliberately short lifetime.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ReportSharePayload {
  /** Clerk user id whose stored observations this link may read. */
  ownerId: string;
  /** Display-only site label chosen by the operator when the link was created. */
  site: string;
  /** Display-only "prepared for" label chosen by the operator. */
  operatorName: string;
  /** Unix milliseconds after which the link must be refused. */
  expiresAt: number;
}

export interface CreatedReportShare {
  token: string;
  expiresAt: number;
}

/** Domain separation: this HMAC can never be confused with the node telemetry credential. */
const TOKEN_PREFIX = "backspyne.report-share.v1";

/** How long a share link stays valid. Short enough to be revocable by waiting. */
export const SHARE_TTL_DAYS = 7;
const SHARE_TTL_MS = SHARE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * The signing secret. A deployment may set a dedicated one; when it has not, the existing
 * node credential is reused with domain separation rather than leaving sharing switched off
 * or inventing a default secret, which would be worse than either.
 */
function signingSecret(): string | null {
  const dedicated = process.env.BACKSPYNE_REPORT_SHARE_SECRET?.trim();
  if (dedicated) return dedicated;
  const shared = process.env.BACKSPYNE_NODE_TOKEN?.trim();
  return shared || null;
}

export function shareLinksAvailable(): boolean {
  return signingSecret() !== null;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}.${body}`).digest("base64url");
}

function encode(payload: ReportSharePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Creates a signed share link for one account, with the labels baked into the signature. */
export function createReportShareToken(
  payload: Omit<ReportSharePayload, "expiresAt">,
  now: number = Date.now(),
  ttlMs: number = SHARE_TTL_MS,
): CreatedReportShare | null {
  const secret = signingSecret();
  if (!secret) return null;
  const withExpiry: ReportSharePayload = { ...payload, expiresAt: now + ttlMs };
  const body = encode(withExpiry);
  return { token: `${body}.${sign(body, secret)}`, expiresAt: withExpiry.expiresAt };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Reads a share token. Returns null for anything that is not a currently valid, correctly
 * signed payload — malformed, truncated, tampered, or expired all look the same from here.
 */
export function readReportShareToken(token: unknown, now: number = Date.now()): ReportSharePayload | null {
  const secret = signingSecret();
  if (!secret || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(body, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<ReportSharePayload>;
  if (typeof candidate.ownerId !== "string" || !candidate.ownerId) return null;
  if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)) return null;
  if (candidate.expiresAt <= now) return null;
  return {
    ownerId: candidate.ownerId,
    site: typeof candidate.site === "string" ? candidate.site : "",
    operatorName: typeof candidate.operatorName === "string" ? candidate.operatorName : "",
    expiresAt: candidate.expiresAt,
  };
}
