// The revenue surface: the deployment's own books, and the plans a visitor can buy.
//
// Two audiences read this module. The administration page asks who is signed in and what the
// deployment is earning; the landing page asks what the plans are and what they cost. Both
// answers come from the server — the monthly figures are read from the subscriptions the
// payment provider confirmed, never recomputed here from a price list, and the public catalog
// is the same catalog the operator portal renders. A console that added prices up itself would
// eventually disagree with what customers are actually charged.
//
// Admin access is a separate credential from the operator portal: an email and password
// configured on the deployment, exchanged for an httpOnly session cookie. Nothing about it
// touches the operator accounts, and signing out of one does not sign out of the other.

export interface AdminSession {
  /** False when the deployment has no admin credential configured at all. */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  ownerId: string | null;
  /** When the session cookie expires, in milliseconds since the epoch. */
  expiresAt: number | null;
}

export interface AdminSignedIn {
  signedIn: true;
  email: string;
  ownerId: string;
  expiresAt: number;
}

export interface AdminPlanRevenue {
  planId: string;
  name: string;
  priceMonthlyUsd: number;
  operators: number;
  mrrUsd: number;
}

export interface AdminRevenueAvailable {
  available: true;
  generatedAt: string;
  plan: {
    configured: boolean;
    pricesUsd: { solo: number; team: number; consultant: number };
  };
  revenue: {
    mrrUsd: number;
    payingOperators: number;
    trialingOperators: number;
    freeOperators: number;
    arpaUsd: number | null;
  };
  plans: AdminPlanRevenue[];
  usage: {
    operators: number;
    relays: number;
    activeRelays: number;
    devices: number;
    sightings30d: number;
    sessions: number;
    calibrations: number;
  };
  recent: Array<{
    ownerId: string;
    planId: string;
    status: string;
    updatedAt: string;
    currentPeriodEnd: string | null;
  }>;
  totals: { subscriptions: number; billingEvents: number };
}

export interface AdminRevenueUnavailable {
  available: false;
  reason: string;
}

export type AdminRevenue = AdminRevenueAvailable | AdminRevenueUnavailable;

export interface PublicPlan {
  id: string;
  name: string;
  priceMonthlyUsd: number;
  tagline: string;
  highlights: string[];
}

export interface PublicPlanCatalog {
  configured: boolean;
  plans: PublicPlan[];
}

async function readJson<T>(response: Response): Promise<T | null> {
  return await response.json().catch(() => null) as T | null;
}

/** The server's own words when it has any, otherwise a sentence that names the status. */
function messageFrom(payload: { error?: unknown } | null, status: number, fallback: string): string {
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  if (status === 401) return "Unauthorized";
  if (status === 503) return "Admin access is not configured on this deployment";
  return `${fallback} (${status})`;
}

/** Who the deployment believes this browser is. Safe to call while signed out. */
export async function readAdminSession(): Promise<AdminSession> {
  const response = await fetch("/api/admin/session", { credentials: "include" });
  const payload = await readJson<AdminSession & { error?: unknown }>(response);
  if (!response.ok || !payload) throw new Error(messageFrom(payload, response.status, "The admin session could not be read"));
  return payload;
}

/** Exchanges the configured email and password for a session cookie. */
export async function signInAdmin(email: string, password: string): Promise<AdminSignedIn> {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await readJson<(AdminSignedIn & { error?: unknown })>(response);
  if (!response.ok || !payload || payload.signedIn !== true) {
    throw new Error(messageFrom(payload, response.status, "Sign-in failed"));
  }
  return payload;
}

/** Clears the session cookie. The server decides; this only reports what it said. */
export async function signOutAdmin(): Promise<void> {
  const response = await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error(messageFrom(await readJson<{ error?: unknown }>(response), response.status, "Sign-out failed"));
}

/**
 * The deployment's revenue and usage. A deployment whose database is unreachable answers
 * `available: false` with a reason, and the page shows the reason rather than a row of zeros.
 */
export async function readAdminRevenue(): Promise<AdminRevenue> {
  const response = await fetch("/api/admin/revenue", { credentials: "include" });
  const payload = await readJson<(AdminRevenue & { error?: unknown })>(response);
  if (!response.ok || !payload) throw new Error(messageFrom(payload, response.status, "Revenue could not be read"));
  return payload;
}

/** The purchasable plans, for a visitor who has no account yet. */
export async function readPublicPlans(): Promise<PublicPlanCatalog> {
  const response = await fetch("/api/public/plans", { credentials: "include" });
  const payload = await readJson<(PublicPlanCatalog & { error?: unknown })>(response);
  if (!response.ok || !payload || !Array.isArray(payload.plans)) {
    throw new Error(messageFrom(payload, response.status, "Pricing could not be read"));
  }
  return payload;
}

/** Whole dollars with thousands separators: `$399`, `$1,299`. */
export function formatUsd(amountUsd: number | null | undefined): string {
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) return "—";
  const rounded = Math.round(amountUsd);
  return `$${rounded.toLocaleString("en-US")}`;
}

/**
 * What share of the operator base each plan holds, so the plan mix can be drawn as bars.
 * A deployment with no operators reports zero for every plan rather than dividing by zero.
 */
export function planShare(plans: Array<{ planId: string; operators: number }>): Array<{ planId: string; sharePercent: number }> {
  const count = (plan: { operators: number }) => Number.isFinite(plan.operators) && plan.operators > 0 ? plan.operators : 0;
  const total = plans.reduce((sum, plan) => sum + count(plan), 0);
  return plans.map((plan) => ({
    planId: plan.planId,
    sharePercent: total === 0 ? 0 : Math.round(count(plan) / total * 1000) / 10,
  }));
}

/**
 * Average revenue per paying operator, in words. There is no average until somebody is paying,
 * and saying so is better than printing a zero that reads like a measurement.
 */
export function describeArpa(arpaUsd: number | null | undefined): string {
  if (typeof arpaUsd !== "number" || !Number.isFinite(arpaUsd)) {
    return "Not available yet: no operator is on a paying plan, so there is nothing to average.";
  }
  return `${formatUsd(arpaUsd)} per paying operator per month.`;
}
