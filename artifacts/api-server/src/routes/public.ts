// What anybody may read without an account.
//
// The pricing page is the one part of this product a prospective customer sees before signing
// up, so it has to answer without a session and without a database. It reads the same plan
// catalog the operator portal and the Stripe checkout use, which is the point: a price shown
// here cannot drift from the price charged, because there is one list.
//
// Nothing account-specific belongs in this router. If a value is not already public
// information, it is not here.

import { Router, type IRouter } from "express";

import { PLAN_CATALOG } from "../lib/billing/plans";
import { stripeConfigFromEnv } from "../lib/billing/stripe";

const router: IRouter = Router();

/** The sellable plans, with prices, for the public pricing page. */
router.get("/public/plans", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    configured: Boolean(stripeConfigFromEnv(process.env)),
    plans: PLAN_CATALOG.map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceMonthlyUsd: plan.priceMonthlyUsd,
      tagline: plan.tagline,
      highlights: plan.highlights,
      entitlements: plan.entitlements,
    })),
  });
});

export default router;
