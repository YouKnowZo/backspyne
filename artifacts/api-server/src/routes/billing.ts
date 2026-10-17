import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { PLAN_CATALOG, entitlementsFor, isPlanId, planDefinition } from "../lib/billing/plans";
import {
  isPurchasablePlan,
  stripeConfigFromEnv,
  stripeEventIdentity,
  stripeRequest,
  subscriptionUpdateFromEvent,
  stripeSubscriptionIdFromEvent,
  stripeObjectId,
  currentSubscriptionUpdate,
  blocksNewSubscription,
  checkoutIdempotencyKey,
  safeOrigin,
  verifyStripeSignature,
  type StripeConfig,
} from "../lib/billing/stripe";
import {
  ownerEntitlements,
  readSubscription,
  reconcileSubscription,
  rememberBillingCustomer,
} from "../lib/billing/subscriptions";

const router: IRouter = Router();

router.use((req, res, next) => {
  if (req.method === "POST" && req.path !== "/billing/webhook") {
    const origin = req.header("origin");
    const allowed = safeOrigin(process.env.FRONTEND_ORIGIN ?? process.env.APP_ORIGIN);
    if ((origin && origin !== allowed) || req.header("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "Cross-origin billing requests are not allowed" });
      return;
    }
    res.set("Cache-Control", "private, no-store");
  }
  next();
});

function currentStripeConfig(): StripeConfig | null {
  return stripeConfigFromEnv(process.env);
}

interface BillingCatalogPayload {
  configured: boolean;
  currentPlanId: string;
  currentPlanName: string;
  status: string;
  entitlements: ReturnType<typeof entitlementsFor>;
  plans: Array<{
    id: string;
    name: string;
    priceMonthlyUsd: number;
    tagline: string;
    highlights: string[];
    entitlements: ReturnType<typeof entitlementsFor>;
    purchasable: boolean;
  }>;
}

function catalogPayload(
  config: StripeConfig | null,
  currentPlanId: string,
  status: string,
  entitlements: ReturnType<typeof entitlementsFor>,
): BillingCatalogPayload {
  return {
    configured: Boolean(config),
    currentPlanId,
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
    res.set("Cache-Control", "private, no-store").json({
      ...catalogPayload(config, state.planId, state.status, state.entitlements),
      portalAvailable: Boolean(config && state.customerId),
      subscriptionExists: Boolean(state.customerId && blocksNewSubscription(state.status)),
      pastDue: state.status === "past_due" && Boolean(state.customerId),
    });
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
    let customerId: string | null = stored?.stripeCustomerId ?? null;
    if (!customerId) {
      const created = await stripeRequest(
        config,
        "POST",
        "/customers",
        { "metadata[ownerId]": req.userId },
        `backspyne-customer-${createHash("sha256").update(req.userId!).digest("hex")}`,
      );
      const body = created.body as { id?: string } | undefined;
      customerId = stripeObjectId(body?.id);
      if (!created.ok || !customerId) {
        const bodyString = created.rawBody ? created.rawBody.toString() : "";
        logger.error({ status: created.status, code: created.code, body: bodyString }, "Stripe customer creation failed");
        throw new Error("Unable to create billing customer");
      }
    }
    await rememberBillingCustomer(req.userId!, customerId);
    const subscriptions = await stripeRequest(config, "GET", "/subscriptions", { customer: customerId, status: "all", limit: 100 });
    if (!subscriptions.ok) throw new Error("Unable to check existing subscriptions");
    const subscriptionsBody = subscriptions.body as { data?: unknown } | null;
    const currentSubscriptions = Array.isArray(subscriptionsBody?.data)
      ? subscriptionsBody.data as Array<{ status?: string }>
      : [];
    if (currentSubscriptions.some((subscription) => blocksNewSubscription(subscription.status))) {
      res.status(409).json({ error: "This account already has a subscription. Use Manage billing to change plans or resolve payment issues.", code: "subscription_exists" });
      return;
    }
    const sessions = await stripeRequest(config, "GET", "/checkout/sessions", { customer: customerId, limit: 100 });
    if (!sessions.ok) throw new Error("Unable to check open Checkout sessions");
    const sessionsBody = sessions.body as { data?: unknown } | null;
    const openSessions = Array.isArray(sessionsBody?.data)
      ? sessionsBody.data as Array<{ id?: string; status?: string; url?: string; mode?: string; metadata?: Record<string, string> }>
      : [];
    const open = openSessions.find((session) => session.status === "open" && session.mode === "subscription" && session.metadata?.ownerId === req.userId);
    if (open?.url) {
      if (open.metadata?.planId !== planId) {
        res.status(409).json({ error: "A checkout for another plan is already open. Complete or cancel it before choosing another plan.", code: "checkout_exists" });
        return;
      }
      res.set("Cache-Control", "private, no-store").json({ url: open.url });
      return;
    }
    if (stored?.stripeSubscriptionId) {
      const current = await currentSubscriptionUpdate(config, stored.stripeSubscriptionId);
      if (current.ownerId !== req.userId) throw new Error("Subscription owner mismatch");
      if (blocksNewSubscription(current.status)) {
        res.status(409).json({ error: "This account already has a subscription. Use Manage billing to change plans or resolve payment issues.", code: "subscription_exists" });
        return;
      }
    }
    const latestSession = openSessions.find((session) => session.mode === "subscription" && session.metadata?.ownerId === req.userId);
    const key = checkoutIdempotencyKey(req.userId!, `${stored?.stripeSubscriptionId ?? "new"}:${latestSession?.id ?? "first"}`);
    const fields: Record<string, string | undefined> = {
      mode: "subscription",
      "line_items[0][price]": config.priceIds[planId],
      "line_items[0][quantity]": "1",
      success_url: `${config.origin}/user-portal/plan?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.origin}/user-portal/plan?billing=cancelled`,
      expires_at: String((Math.floor(Date.now() / 1_800_000) + 2) * 1800),
      client_reference_id: req.userId,
      "metadata[ownerId]": req.userId,
      "metadata[planId]": planId,
      "subscription_data[metadata][ownerId]": req.userId,
      "subscription_data[metadata][planId]": planId,
    };
    fields.customer = customerId;
    const response = await stripeRequest(config, "POST", "/checkout/sessions", fields, key);
    const body = response.body as { url?: string } | undefined;
    const url = typeof body?.url === "string" ? body.url : "";
    if (!response.ok || !url) {
      const bodyString = response.rawBody ? response.rawBody.toString() : "";
      logger.error({ status: response.status, code: response.code, body: bodyString }, "Stripe checkout session creation failed");
      res.status(502).json({ error: "Stripe did not return a checkout session" });
      return;
    }
    res.set("Cache-Control", "private, no-store").json({ url });
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
      configuration: config.portalConfigurationId,
      return_url: `${config.origin}/user-portal/plan?billing=portal`,
    });
    const body = response.body as { url?: string } | undefined;
    const url = typeof body?.url === "string" ? body.url : "";
    if (!response.ok || !url) {
      const bodyString = response.rawBody ? response.rawBody.toString() : "";
      logger.error({ status: response.status, body: bodyString }, "Stripe billing portal session creation failed");
      res.status(502).json({ error: "Stripe did not return a billing portal session" });
      return;
    }
    res.set("Cache-Control", "private, no-store").json({ url });
  } catch (error) {
    next(error);
  }
});

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
    const subscriptionId = stripeSubscriptionIdFromEvent(req.body);
    const hint = subscriptionUpdateFromEvent(req.body, config);
    if (!subscriptionId || (hint?.unattributed && !identity.type.startsWith("invoice."))) {
      logger.warn({ eventId: identity.id, type: identity.type }, "Ignoring unattributed Stripe event");
      res.json({ received: true, applied: false });
      return;
    }
    const ownerId = hint?.ownerId ?? (await currentSubscriptionUpdate(config, subscriptionId)).ownerId;
    if (!ownerId) {
      res.json({ received: true, applied: false });
      return;
    }
    const result = await reconcileSubscription(config, identity, ownerId, subscriptionId);
    res.json({ received: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/billing/sync", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const config = currentStripeConfig();
    if (!config) {
      res.status(503).json({ error: "Billing is not configured", code: "billing_not_configured" });
      return;
    }
    let subscriptionId: string | null = null;
    const sessionId = req.body?.sessionId;
    if (sessionId !== undefined) {
      if (typeof sessionId !== "string" || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
        res.status(400).json({ error: "Invalid Checkout session id" });
        return;
      }
      const response = await stripeRequest(config, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) throw new Error("Unable to retrieve Checkout session");
      const session = response.body as { metadata?: { ownerId?: string }; client_reference_id?: string; mode?: string; subscription?: string; status?: string } | undefined;
      if (session?.metadata?.ownerId !== req.userId || session?.client_reference_id !== req.userId || session?.mode !== "subscription") {
        res.status(403).json({ error: "Checkout session does not belong to this account" });
        return;
      }
      if (session?.status !== "complete") {
        res.status(409).json({ error: "Checkout has not completed", code: "checkout_pending" });
        return;
      }
      subscriptionId = stripeObjectId(session?.subscription) ?? null;
    } else {
      subscriptionId = (await readSubscription(req.userId!))?.stripeSubscriptionId ?? null;
    }
    if (sessionId && !subscriptionId) {
      res.status(409).json({ error: "Subscription confirmation is pending", code: "checkout_pending" });
      return;
    }
    if (subscriptionId) await reconcileSubscription(config, { id: `sync_${Math.random().toString(36).slice(2)}`, type: "billing.sync" }, req.userId!, subscriptionId);
    const state = await ownerEntitlements(req.userId!);
    res.set("Cache-Control", "private, no-store").json({ currentPlanId: state.planId, status: state.status });
  } catch (error) {
    next(error);
  }
});

export default router;
