import { Router, type IRouter } from "express";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { PLAN_CATALOG, entitlementsFor, isPlanId, planDefinition } from "../lib/billing/plans";
import {
  isPurchasablePlan,
  stripeConfigFromEnv,
  stripeEventIdentity,
  stripeRequest,
  subscriptionUpdateFromEvent,
  verifyStripeSignature,
  type StripeConfig,
} from "../lib/billing/stripe";
import { ownerEntitlements, readSubscription, recordBillingEvent, writeSubscription } from "../lib/billing/subscriptions";

const router: IRouter = Router();

function currentStripeConfig(): StripeConfig | null {
  return stripeConfigFromEnv(process.env);
}

/** Public catalog: plan definitions are safe to expose, prices included. */
function catalogPayload(config: StripeConfig | null, currentPlanId: string, status: string, entitlements: ReturnType<typeof entitlementsFor>) {
  return {
    configured: Boolean(config),
    currentPlanId,
    // Owner access is not a row in the plan grid, so its display name travels with the
    // catalog instead of being guessed from the plan id on the client.
    currentPlanName: planDefinition(currentPlanId).name,
    status,
    entitlements,
    plans: PLAN_CATALOG.map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceMonthlyUsd: plan.priceMonthlyUsd,
      tagline: plan.tagline,
      highlights: plan.highlights,
      entitlements: plan.entitlements,
      purchasable: plan.id !== "free" && Boolean(config && isPurchasablePlan(config, plan.id)),
    })),
  };
}

router.get("/billing/catalog", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const config = currentStripeConfig();
    const state = await ownerEntitlements(req.userId!);
    res.json(catalogPayload(config, state.planId, state.status, state.entitlements));
  } catch (error) {
    next(error);
  }
});

router.post("/billing/checkout", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const config = currentStripeConfig();
    if (!config) {
      res.status(503).json({ error: "Billing is not configured for this deployment", code: "billing_not_configured" });
      return;
    }
    const planId = typeof req.body?.planId === "string" ? req.body.planId : "";
    if (!isPlanId(planId) || planId === "free") {
      res.status(400).json({ error: "planId must be one of solo, team, or consultant" });
      return;
    }
    if (!isPurchasablePlan(config, planId)) {
      res.status(409).json({ error: `The ${planDefinition(planId).name} plan has no price configured on this deployment`, code: "plan_not_configured" });
      return;
    }
    const stored = await readSubscription(req.userId!);
    const fields: Record<string, string | undefined> = {
      mode: "subscription",
      "line_items[0][price]": config.priceIds[planId],
      "line_items[0][quantity]": "1",
      success_url: `${config.origin}/user-portal?billing=success`,
      cancel_url: `${config.origin}/user-portal?billing=cancelled`,
      client_reference_id: req.userId,
      "metadata[ownerId]": req.userId,
      "metadata[planId]": planId,
      "subscription_data[metadata][ownerId]": req.userId,
      "subscription_data[metadata][planId]": planId,
    };
    // Reuse the Stripe customer when we already have one so an operator never ends up
    // with two billing profiles for the same account.
    if (stored?.stripeCustomerId) fields.customer = stored.stripeCustomerId;
    const response = await stripeRequest(config, "POST", "/checkout/sessions", fields);
    const url = typeof response.body.url === "string" ? response.body.url : "";
    if (!response.ok || !url) {
      logger.error({ status: response.status, code: response.body.code }, "Stripe checkout session creation failed");
      res.status(502).json({ error: "Stripe did not return a checkout session" });
      return;
    }
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

router.post("/billing/portal", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const config = currentStripeConfig();
    if (!config) {
      res.status(503).json({ error: "Billing is not configured for this deployment", code: "billing_not_configured" });
      return;
    }
    const stored = await readSubscription(req.userId!);
    if (!stored?.stripeCustomerId) {
      res.status(400).json({ error: "This account has no billing profile yet", code: "no_billing_profile" });
      return;
    }
    const response = await stripeRequest(config, "POST", "/billing_portal/sessions", {
      customer: stored.stripeCustomerId,
      return_url: `${config.origin}/user-portal?billing=portal`,
    });
    const url = typeof response.body.url === "string" ? response.body.url : "";
    if (!response.ok || !url) {
      logger.error({ status: response.status }, "Stripe billing portal session creation failed");
      res.status(502).json({ error: "Stripe did not return a billing portal session" });
      return;
    }
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

/**
 * Stripe webhook. The raw body is captured by the JSON body parser in app.ts, which is
 * what the signature is computed over; an unverifiable request is rejected before any
 * billing state is touched.
 */
router.post("/billing/webhook", async (req, res, next) => {
  const config = currentStripeConfig();
  if (!config) {
    res.status(503).json({ error: "Billing is not configured for this deployment", code: "billing_not_configured" });
    return;
  }
  const rawBody = ((req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from("")).toString("utf8");
  const signature = req.header("stripe-signature");
  if (!verifyStripeSignature({ payload: rawBody, header: signature, secret: config.webhookSecret })) {
    res.status(400).json({ error: "Invalid Stripe signature" });
    return;
  }
  const identity = stripeEventIdentity(req.body);
  if (!identity) {
    res.status(400).json({ error: "Stripe event is missing an id or type" });
    return;
  }
  try {
    const update = subscriptionUpdateFromEvent(req.body, config);
    if (!update || update.unattributed) {
      // Acknowledge so Stripe stops retrying, but grant nothing: an event we cannot
      // attribute to an operator must never change entitlements.
      logger.warn({ eventId: identity.id, type: identity.type }, "Ignoring unattributed Stripe event");
      res.json({ received: true, applied: false });
      return;
    }
    const firstDelivery = await recordBillingEvent(identity.id, identity.type, update.ownerId);
    if (!firstDelivery) {
      res.json({ received: true, applied: false, duplicate: true });
      return;
    }
    // A null plan keeps whatever is already stored; the event status decides whether
    // it is actually honored, so a canceled subscription still downgrades to free.
    const planId = isPlanId(update.planId) ? update.planId : null;
    await writeSubscription({
      ownerId: update.ownerId,
      planId,
      status: update.status,
      stripeCustomerId: update.stripeCustomerId,
      stripeSubscriptionId: update.stripeSubscriptionId,
      currentPeriodEnd: update.currentPeriodEnd,
    });
    res.json({ received: true, applied: true });
  } catch (error) {
    next(error);
  }
});

export default router;
