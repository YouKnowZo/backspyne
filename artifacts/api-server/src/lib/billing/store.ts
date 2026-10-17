import { sql, type SQL } from "drizzle-orm";
import type { StripeSubscriptionUpdate } from "./stripe";

export interface BillingTransaction {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface BillingDatabase extends BillingTransaction {
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T>;
}

/**
 * Dedupe and entitlement writes commit together. Any Stripe/database failure rolls both
 * back, leaving the delivery retryable. Serialize by owner BEFORE retrieving Stripe's
 * current state, so an older request cannot overwrite a newer projection.
 * The one network call under the lock has a 12-second timeout; lock contention has a
 * separate 5-second bound. This is synchronous because serverless background work isn't durable.
 */
export async function applyBillingEvent(
  database: BillingDatabase,
  event: { id: string; type: string },
  ownerId: string,
  resolve: () => Promise<StripeSubscriptionUpdate>,
): Promise<{ applied: boolean; duplicate?: boolean }> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`backspyne-billing:${ownerId}`}, 0))`);
    const existingEvent = await tx.execute(sql`select id from backspyne_billing_events where id = ${event.id}`);
    if (existingEvent.rows.length) return { applied: false, duplicate: true };
    const update = await resolve();
    if (update.unattributed || update.ownerId !== ownerId || !update.stripeSubscriptionId) {
      throw new Error("Stripe subscription attribution changed during reconciliation");
    }
    const existing = await tx.execute(sql`select stripe_subscription_id, status from backspyne_subscriptions where owner_id = ${ownerId}`);
    const stored = existing.rows[0];
    // A delayed cancellation of a previous subscription must not cancel its replacement.
    const replaced = stored?.stripe_subscription_id && stored.stripe_subscription_id !== update.stripeSubscriptionId
      && !["canceled", "incomplete_expired", "inactive"].includes(String(stored.status));
    const inserted = await tx.execute(sql`
      insert into backspyne_billing_events (id, type, owner_id) values (${event.id}, ${event.type}, ${ownerId})
      on conflict (id) do nothing returning id
    `);
    if (!inserted.rows.length) return { applied: false, duplicate: true };
    if (replaced) return { applied: false };
    await tx.execute(sql`
      insert into backspyne_subscriptions
        (owner_id, plan_id, status, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
      values (${ownerId}, ${update.planId ?? "free"}, ${update.status}, ${update.stripeCustomerId},
        ${update.stripeSubscriptionId}, ${update.currentPeriodEnd?.toISOString() ?? null}, now())
      on conflict (owner_id) do update set
        plan_id = excluded.plan_id, status = excluded.status, stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id, current_period_end = excluded.current_period_end,
        updated_at = excluded.updated_at
    `);
    return { applied: true };
  });
}
