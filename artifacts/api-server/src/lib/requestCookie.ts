// Reading one request cookie, without a cookie-parsing middleware.
//
// Two identity paths need this: the operator's Clerk session and the deployment
// administrator's own signed cookie. Both are read from a small allowlist of names, and both
// must keep working whether or not a `cookie-parser` middleware happens to be mounted — so
// `req.cookies` is used when something upstream already parsed them, and the raw header is the
// fallback. One implementation, so a decoding rule can never differ between the two.

import type { Request } from "express";

export function readRequestCookie(req: Request, name: string): string | undefined {
  const parsed = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[name];
  if (typeof parsed === "string" && parsed) return parsed;
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}
