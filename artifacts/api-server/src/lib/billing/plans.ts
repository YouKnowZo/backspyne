// Single source of truth for BackSpyne plans and what each plan is allowed to do.
// Prices are monthly US-dollar list prices; they are intentionally small whole
// numbers so the catalog can be rendered directly by the operator portal.

export type PlanId = "free" | "solo" | "team" | "consultant" | "owner";

export interface PlanEntitlements {
  /** Maximum number of authorized local relays a single operator may register. */
  maxRelays: number;
  /** How many days of observation history the operator portal will read back. */
  historyDays: number;
  /** Whether the operator may export a client-facing CSV ledger. */
  reportExport: boolean;
  /** Whether gated CSI research panels may be enabled for this operator. */
  csiResearch: boolean;
  /**
   * True only for deployment-configured owner access. The relay allowance stays a real
   * number above so every enforcement path keeps working; this flag is what the portal
   * reads to describe the account as unlimited instead of printing a large limit.
   */
  unlimited?: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number;
  tagline: string;
  highlights: string[];
  entitlements: PlanEntitlements;
}

export const PLAN_CATALOG: readonly PlanDefinition[] = [
  {
    id: "free",
    name: "Free",
    priceMonthlyUsd: 0,
    tagline: "Evaluate an authorized site with one relay.",
    highlights: [
      "One authorized relay",
      "Recent WiFi/BLE inventory",
      "Seven days of observation history",
    ],
    entitlements: { maxRelays: 1, historyDays: 7, reportExport: false, csiResearch: false },
  },
  {
    id: "solo",
    name: "Solo",
    priceMonthlyUsd: 39,
    tagline: "For one operator documenting one site.",
    highlights: [
      "One authorized relay",
      "CSV report export",
      "Thirty days of observation history",
      "Email support",
    ],
    entitlements: { maxRelays: 1, historyDays: 30, reportExport: true, csiResearch: false },
  },
  {
    id: "team",
    name: "Team",
    priceMonthlyUsd: 149,
    tagline: "For small IT teams covering several locations.",
    highlights: [
      "Up to five authorized relays",
      "Shared operator workspace",
      "Ninety days of observation history",
      "CSI research panels",
      "Priority support",
    ],
    entitlements: { maxRelays: 5, historyDays: 90, reportExport: true, csiResearch: true },
  },
  {
    id: "consultant",
    name: "Consultant",
    priceMonthlyUsd: 399,
    tagline: "For wireless consultants running repeat assessments.",
    highlights: [
      "Up to twenty-five authorized relays",
      "Multiple client workspaces",
      "One year of observation history",
      "CSI research panels",
      "Reusable assessment templates",
    ],
    entitlements: { maxRelays: 25, historyDays: 365, reportExport: true, csiResearch: true },
  },
] as const;

/**
 * Owner access. It is deliberately not part of PLAN_CATALOG: it is never purchasable and
 * never appears in the plan grid, because it is granted by deployment configuration
 * (`BACKSPYNE_OWNER_USER_IDS`) rather than bought. The relay allowance is a real ceiling so
 * the enforcement code stays total, and `unlimited` is what the portal shows the owner.
 */
export const OWNER_PLAN: PlanDefinition = {
  id: "owner",
  name: "Owner access",
  priceMonthlyUsd: 0,
  tagline: "Internal operator access with no plan limits.",
  highlights: [
    "Unlimited authorized relays",
    "Full observation history",
    "Client report export",
    "Experimental CSI research panels",
  ],
  entitlements: { maxRelays: 250, historyDays: 3650, reportExport: true, csiResearch: true, unlimited: true },
};

export const PLAN_IDS: readonly PlanId[] = PLAN_CATALOG.map((plan) => plan.id);

const PLAN_BY_ID: Record<PlanId, PlanDefinition> = {
  free: PLAN_CATALOG[0],
  solo: PLAN_CATALOG[1],
  team: PLAN_CATALOG[2],
  consultant: PLAN_CATALOG[3],
  owner: OWNER_PLAN,
};

/** Subscription states that count as a paid, usable plan. Anything else falls back to free. */
export const ENTITLED_SUBSCRIPTION_STATUSES: readonly string[] = ["active", "trialing"];

/**
 * Whether a value is a plan an operator can hold or buy. `owner` is deliberately excluded:
 * it is deployment configuration, so nothing that arrives from a request or a Stripe
 * webhook can name it and be granted owner limits.
 */
export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

/** Returns the plan definition for a known plan id, falling back to the free plan. */
export function planDefinition(planId: string | null | undefined): PlanDefinition {
  if (typeof planId === "string" && Object.prototype.hasOwnProperty.call(PLAN_BY_ID, planId)) {
    return PLAN_BY_ID[planId as PlanId];
  }
  return PLAN_BY_ID.free;
}

/**
 * The owner allowlist, read from `BACKSPYNE_OWNER_USER_IDS` as comma-separated Clerk user
 * ids. Parsed on every call so rotating it is a configuration change, and an exact match
 * only, so a truncated id can never widen access.
 */
export function ownerUserIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.BACKSPYNE_OWNER_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isOwnerAccount(ownerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(ownerId) && ownerUserIds(env).includes(ownerId);
}

export function entitlementsFor(planId: string | null | undefined): PlanEntitlements {
  return { ...planDefinition(planId).entitlements };
}

/**
 * A stored plan only applies while the subscription is active or trialing.
 * `past_due`, `canceled`, `unpaid`, and `incomplete` all fall back to free so the
 * API never grants paid limits that Stripe is no longer billing for.
 */
export function effectivePlanId(planId: string | null | undefined, status: string | null | undefined): PlanId {
  if (!isPlanId(planId) || planId === "free") return "free";
  return typeof status === "string" && ENTITLED_SUBSCRIPTION_STATUSES.includes(status) ? planId : "free";
}

export function effectiveEntitlements(planId: string | null | undefined, status: string | null | undefined): PlanEntitlements {
  return entitlementsFor(effectivePlanId(planId, status));
}
