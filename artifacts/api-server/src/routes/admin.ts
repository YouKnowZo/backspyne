// The administrator's revenue view.
//
// This is the owner's surface, not a customer's. It exists so a single configured operator can
// open a deployment, confirm relays are reporting, and see the revenue picture without holding
// a Clerk account or reading the database by hand. Sign-in itself lives in `adminSession.ts`,
// which has no database dependency, so an administrator can reach the console on a deployment
// whose database is not provisioned yet; this router is the part that needs rows.
//
// One rule holds here. Revenue is only ever stated from rows Stripe's verified webhook wrote: a
// subscription that is not `active` is not counted as revenue, whichever plan it names, and a
// subscription whose status lapsed is reported under the free plan because that is the plan the
// product honours (see `effectivePlanId`).

import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";

import { readAdminSession } from "../lib/adminAuth";
import { PLAN_CATALOG, effectivePlanId, planDefinition } from "../lib/billing/plans";
import { stripeConfigFromEnv } from "../lib/billing/stripe";
import { logger } from "../lib/logger";
import { adminCookie } from "./adminSession";

const router: IRouter = Router();

interface AdminRequest extends Request {
  admin?: { email: string; ownerId: string; expiresAt: number };
}

/** Answers who is signed in, or 401 when nobody is. */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = readAdminSession(adminCookie(req));
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as AdminRequest).admin = session;
  next();
}

type CountRow = { n: number | string | null };

/** A count that answers 0 when its table does not exist yet on this deployment. */
async function countOrZero(sqlText: string): Promise<number> {
  try {
    const result = await pool.query<CountRow>(sqlText);
    return Number(result.rows[0]?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

function asCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

/**
 * What the deployment is earning and how much of it is in use.
 *
 * Money is counted from subscriptions Stripe's webhook actually wrote: a plan contributes only
 * while its status is `active`, trialing accounts are reported separately and contribute
 * nothing, and a plan whose status lapsed is reported under the free plan because that is the
 * plan the product honours (see `effectivePlanId`).
 */
router.get("/admin/revenue", requireAdmin, async (_req, res) => {
  const priceFor = (planId: string) => planDefinition(planId).priceMonthlyUsd;
  const stripe = stripeConfigFromEnv(process.env);
  try {
    const [planRows, subscriptionTotals, billingTotals, recent] = await Promise.all([
      pool.query<{ plan_id: string | null; status: string | null; operators: string | number }>(
        "SELECT plan_id, status, count(*)::int AS operators FROM backspyne_subscriptions GROUP BY plan_id, status",
      ),
      pool.query<CountRow>("SELECT count(*)::int AS n FROM backspyne_subscriptions"),
      pool.query<CountRow>("SELECT count(*)::int AS n FROM backspyne_billing_events"),
      pool.query<{ owner_id: string; plan_id: string | null; status: string | null; updated_at: Date | string; current_period_end: Date | string | null }>(
        "SELECT owner_id, plan_id, status, updated_at, current_period_end FROM backspyne_subscriptions ORDER BY updated_at DESC LIMIT 20",
      ),
    ]);

    const byPlan = new Map<string, { operators: number; payingOperators: number }>();
    let payingOperators = 0;
    let trialingOperators = 0;
    let freeOperators = 0;
    for (const row of planRows.rows) {
      const status = typeof row.status === "string" ? row.status : "";
      const effective = effectivePlanId(row.plan_id, status);
      const operators = asCount(row.operators);
      if (status === "active" && effective !== "free") {
        payingOperators += operators;
        const entry = byPlan.get(effective) ?? { operators: 0, payingOperators: 0 };
        entry.operators += operators;
        entry.payingOperators += operators;
        byPlan.set(effective, entry);
        continue;
      }
      if (status === "trialing") trialingOperators += operators;
      else if (effective === "free") freeOperators += operators;
      const entry = byPlan.get(effective) ?? { operators: 0, payingOperators: 0 };
      entry.operators += operators;
      byPlan.set(effective, entry);
    }

    const plans = PLAN_CATALOG.map((plan) => {
      const entry = byPlan.get(plan.id) ?? { operators: 0, payingOperators: 0 };
      return {
        planId: plan.id,
        name: plan.name,
        priceMonthlyUsd: plan.priceMonthlyUsd,
        operators: entry.operators,
        mrrUsd: plan.priceMonthlyUsd * entry.payingOperators,
      };
    });
    const mrrUsd = plans.reduce((sum, plan) => sum + plan.mrrUsd, 0);

    const [operators, relays, activeRelays, devices, sightings30d, sessions, calibrations] = await Promise.all([
      countOrZero("SELECT count(*)::int AS n FROM (SELECT owner_id FROM backspyne_scan_nodes UNION SELECT owner_id FROM backspyne_rf_devices) AS operators"),
      countOrZero("SELECT count(*)::int AS n FROM backspyne_scan_nodes"),
      countOrZero("SELECT count(*)::int AS n FROM backspyne_scan_nodes WHERE last_heartbeat_at > now() - interval '5 minutes'"),
      countOrZero("SELECT count(*)::int AS n FROM backspyne_rf_devices"),
      countOrZero("SELECT count(*)::int AS n FROM backspyne_rf_sightings WHERE observed_at > now() - interval '30 days'"),
      countOrZero("SELECT count(*)::int AS n FROM backspyne_scan_sessions"),
      countOrZero("SELECT count(*)::int AS n FROM backspyne_site_calibrations"),
    ]);

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      plan: {
        configured: Boolean(stripe),
        pricesUsd: {
          solo: priceFor("solo"),
          team: priceFor("team"),
          consultant: priceFor("consultant"),
        },
      },
      revenue: {
        mrrUsd: Math.round(mrrUsd),
        payingOperators,
        trialingOperators,
        freeOperators,
        arpaUsd: payingOperators > 0 ? Math.round(mrrUsd / payingOperators) : null,
      },
      plans,
      usage: { operators, relays, activeRelays, devices, sightings30d, sessions, calibrations },
      recent: recent.rows.map((row) => ({
        ownerId: row.owner_id,
        planId: effectivePlanId(row.plan_id, row.status),
        status: typeof row.status === "string" ? row.status : "unknown",
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        currentPeriodEnd: row.current_period_end
          ? row.current_period_end instanceof Date ? row.current_period_end.toISOString() : String(row.current_period_end)
          : null,
      })),
      totals: { subscriptions: asCount(subscriptionTotals.rows[0]?.n), billingEvents: asCount(billingTotals.rows[0]?.n) },
    });
  } catch (error) {
    logger.error({ err: error }, "Unable to read the administrator revenue overview");
    res.json({ available: false, reason: "The database could not be read, so revenue cannot be reported on this deployment." });
  }
});

export default router;
