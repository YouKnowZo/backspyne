// Reads and writes for BackSpyne billing state.
//
// The production database is owned by the deployment, and this API cannot rely on a
// migration step having run before it serves traffic, so the two billing tables are
// created lazily and idempotently on first use. The same statements are kept in
// lib/db/backspyne-billing.sql for operators who prefer to run them by hand.

import { db } from "@workspace/db";
import { billingEvents, subscriptions, type Subscription } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import { adminOwnerId } from "../adminAuth";
import { entitlementsFor, effectivePlanId, isOwnerAccount, type PlanEntitlements, type PlanId } from "./plans";

// Statement text mirrors lib/db/backspyne-billing.sql. One statement per call: the
// driver uses the extended protocol, which rejects multi-statement queries.
const CREATE_SUBSCRIPTIONS = sql`
  CREATE TABLE IF NOT EXISTS backspyne_subscriptions (
    owner_id text PRIMARY KEY,
    plan_id text NOT NULL DEFAULT 'free',
    status text NOT NULL DEFAULT 'inactive',
    stripe_customer_id text,
    stripe_subscription_id text,
    current_period_end timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

const CREATE_BILLING_EVENTS = sql`
  CREATE TABLE IF NOT EXISTS backspyne_billing_events (
    id text PRIMARY KEY,
    type text NOT NULL,
    owner_id text,
    received_at timestamptz NOT NULL DEFAULT now()
  )
`;

let schemaReady: Promise<boolean> | null = null;

async function createBillingTables(): Promise<boolean> {
  try {
    await db.execute(CREATE_SUBSCRIPTIONS);
    await db.execute(CREATE_BILLING_EVENTS);
    return true;
  } catch (error) {
    logger.error({ err: error }, "Unable to create the billing tables");
    return false;
  }
}

/** Ensures the billing tables exist. Memoized so the DDL runs at most once per process. */
export function ensureBillingSchema(): Promise<boolean> {
  if (!schemaReady) schemaReady = createBillingTables();
  return schemaReady;
}

export async function readSubscription(ownerId: string): Promise<Subscription | null> {
  await ensureBillingSchema();
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.ownerId, ownerId)).limit(1);
  return rows[0] ?? null;
}

export interface SubscriptionWrite {
  ownerId: string;
  planId: string | null;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
}

/**
 * Applies a webhook update, preserving the stored plan when the event did not carry
 * one (for example a subscription update that arrives before Checkout metadata).
 */
export async function writeSubscription(update: SubscriptionWrite): Promise<void> {
  await ensureBillingSchema();
  const existing = await readSubscription(update.ownerId);
  const planId = update.planId ?? existing?.planId ?? "free";
  const values = {
    ownerId: update.ownerId,
    planId,
    status: update.status,
    stripeCustomerId: update.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
    stripeSubscriptionId: update.stripeSubscriptionId ?? existing?.stripeSubscriptionId ?? null,
    currentPeriodEnd: update.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({ target: subscriptions.ownerId, set: values });
}

/**
 * Records a webhook event id. Returns false when the event was already processed, so
 * the caller can acknowledge a Stripe retry without applying it twice.
 */
export async function recordBillingEvent(eventId: string, type: string, ownerId: string | null): Promise<boolean> {
  await ensureBillingSchema();
  const inserted = await db
    .insert(billingEvents)
    .values({ id: eventId, type, ownerId })
    .onConflictDoNothing({ target: billingEvents.id })
    .returning({ id: billingEvents.id });
  return inserted.length > 0;
}

export interface OwnerEntitlements {
  planId: PlanId;
  status: string;
  customerId: string | null;
  entitlements: PlanEntitlements;
}

/**
 * Whether this owner id holds deployment-granted owner access. Two ways in: the
 * `BACKSPYNE_OWNER_USER_IDS` allowlist, and the deployment administrator's own owner id
 * (`BACKSPYNE_ADMIN_OWNER_ID`). The administrator cannot buy a plan — nobody can, owner
 * access is not in the catalog — so their relays, history, and exports must not be capped by
 * one they could never purchase.
 */
function holdsOwnerAccess(ownerId: string): boolean {
  return isOwnerAccount(ownerId) || (Boolean(ownerId) && ownerId === adminOwnerId());
}

/**
 * Effective plan for an operator. A configured owner is evaluated first and never falls
 * back on a database read; everyone else falls back to the free plan when billing state
 * cannot be read, so a database or DDL problem can never grant paid limits.
 */
export async function ownerEntitlements(ownerId: string): Promise<OwnerEntitlements> {
  if (holdsOwnerAccess(ownerId)) {
    const customerId = await readSubscription(ownerId)
      .then((subscription) => subscription?.stripeCustomerId ?? null)
      .catch(() => null);
    return { planId: "owner", status: "owner", customerId, entitlements: entitlementsFor("owner") };
  }
  try {
    const subscription = await readSubscription(ownerId);
    const status = subscription?.status ?? "inactive";
    const planId = effectivePlanId(subscription?.planId, status);
    return { planId, status, customerId: subscription?.stripeCustomerId ?? null, entitlements: entitlementsFor(planId) };
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to read the operator subscription; falling back to the free plan");
    return { planId: "free", status: "unavailable", customerId: null, entitlements: entitlementsFor("free") };
  }
}
