// Dependency-free Stripe client.
//
// BackSpyne only needs a small slice of Stripe: create a Checkout Session, create a
// Billing Portal session, and verify/translate webhook events. Talking to the REST API
// with fetch plus node:crypto keeps the production bundle small and, more importantly,
// keeps all of the decision logic in pure functions that can be unit tested without a
// network or a Stripe account.
//
// This module only depends on the Node standard library, so it stays loadable by
// `node --test` without a bundler.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const DEFAULT_TOLERANCE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 12_000;

export const BILLING_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Browser origin used for Checkout success/cancel and portal return URLs. */
  origin: string;
  /** Plan id -> Stripe price id. Plans absent here cannot be purchased. */
  priceIds: Record<string, string>;
  /** Optional Customer Portal configuration id created by setup-stripe-billing.mjs. */
  portalConfigurationId?: string;
}

export type StripeFormValue = string | number | boolean | undefined;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLoopbackOrigin(url: URL) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

/** Validates an origin that we are willing to redirect a signed-in operator to. */
export function safeOrigin(value: unknown): string | null {
  const raw = trimmed(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackOrigin(url))) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function looksLikeSecretKey(value: string) {
  return /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/.test(value);
}

/**
 * Reads Stripe configuration from the environment. Returns null unless billing is
 * fully usable (secret key, webhook secret, safe redirect origin, and at least one
 * price id), because a half-configured billing surface must fail closed rather than half-work.
 */
export function stripeConfigFromEnv(env: Record<string, string | undefined>): StripeConfig | null {
  const secretKey = trimmed(env.STRIPE_SECRET_KEY);
  const webhookSecret = trimmed(env.STRIPE_WEBHOOK_SECRET);
  const origin = safeOrigin(env.FRONTEND_ORIGIN ?? env.APP_ORIGIN);
  if (!looksLikeSecretKey(secretKey) || !webhookSecret || !origin) return null;
  const priceIds: Record<string, string> = {};
  for (const [planId, priceId] of [
    ["solo", trimmed(env.STRIPE_PRICE_SOLO)],
    ["team", trimmed(env.STRIPE_PRICE_TEAM)],
    ["consultant", trimmed(env.STRIPE_PRICE_CONSULTANT)],
  ] as const) {
    if (priceId) priceIds[planId] = priceId;
  }
  if (!Object.keys(priceIds).length) return null;
  const portalConfigurationId = trimmed(env.STRIPE_PORTAL_CONFIGURATION_ID) || undefined;
  return {
    secretKey,
    webhookSecret,
    origin,
    priceIds,
    ...(portalConfigurationId ? { portalConfigurationId } : {}),
  };
}

export function planIdForPriceId(config: StripeConfig, priceId: unknown): string | null {
  const wanted = trimmed(priceId);
  if (!wanted) return null;
  for (const [planId, configured] of Object.entries(config.priceIds)) {
    if (configured === wanted) return planId;
  }
  return null;
}

export function isPurchasablePlan(config: StripeConfig, planId: unknown): boolean {
  return typeof planId === "string" && Object.prototype.hasOwnProperty.call(config.priceIds, planId);
}

export function encodeStripeForm(fields: Record<string, StripeFormValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === "") continue;
    params.append(key, String(value));
  }
  return params.toString();
}

export interface StripeResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  code?: string;
  rawBody?: Buffer;
}

/**
 * Minimal Stripe request helper. Never throws on an HTTP error status; transport
 * failures are returned as status 0 so callers can respond deterministically.
 */
export async function stripeRequest(
  config: StripeConfig,
  method: "POST" | "GET",
  path: string,
  fields: Record<string, StripeFormValue> = {},
  idempotencyKey?: string,
): Promise<StripeResponse> {
  const encoded = encodeStripeForm(fields);
  const url = `${STRIPE_API_BASE}${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": "2024-06-20",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? encoded : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    const errorRecord = record(body.error);
    const code = typeof errorRecord.code === "string" ? errorRecord.code : undefined;
    return { ok: response.ok, status: response.status, body, code, rawBody: Buffer.from(text) };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

export interface StripeSignatureInput {
  payload: string;
  header: string | undefined;
  secret: string;
  toleranceSeconds?: number;
  /** Milliseconds since epoch; injectable for tests. */
  now?: number;
}

interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || !signatures.length) return null;
  return { timestamp, signatures };
}

/**
 * Verifies a Stripe webhook signature (`Stripe-Signature: t=...,v1=...`) using the
 * documented scheme: HMAC-SHA256 over `${timestamp}.${rawBody}` compared in constant
 * time against every v1 value, with a replay window on the timestamp.
 */
export function verifyStripeSignature(input: StripeSignatureInput): boolean {
  const secret = trimmed(input.secret);
  if (!secret || !input.header) return false;
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return false;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? Date.now();
  const ageSeconds = Math.abs(Math.floor(now / 1000) - parsed.timestamp);
  if (ageSeconds > tolerance) return false;
  const payload = `${parsed.timestamp}.${input.payload}`;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest();
  for (const candidate of parsed.signatures) {
    const supplied = Buffer.from(candidate, "hex");
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}

export interface StripeSubscriptionUpdate {
  ownerId: string;
  /** Plan id carried by Stripe price/metadata, already known-purchasable or null. */
  planId: string | null;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  /** True when the subscription is not attached to any operator and must be ignored. */
  unattributed: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Extracts a Stripe object id whether the field is a string id or an expanded object `{ id: string }`. */
export function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  return text(record(value).id);
}

function periodEndFromSeconds(value: unknown): Date | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function stripeEventIdentity(event: unknown): { id: string; type: string } | null {
  const source = record(event);
  const id = text(source.id);
  const type = text(source.type);
  return id && type ? { id, type } : null;
}

const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
];

function knownStatus(value: unknown): string | null {
  const candidate = text(value);
  return candidate && SUBSCRIPTION_STATUSES.includes(candidate) ? candidate : null;
}

/** Extracts the target Stripe subscription id from a webhook event payload. */
export function stripeSubscriptionIdFromEvent(event: unknown): string | null {
  const identity = stripeEventIdentity(event);
  if (!identity) return null;
  const object = record(record(record(event).data).object);
  if (identity.type.startsWith("customer.subscription.")) {
    return stripeObjectId(object.id);
  }
  if (identity.type.startsWith("checkout.session.")) {
    if (text(object.mode) && text(object.mode) !== "subscription") return null;
    return stripeObjectId(object.subscription);
  }
  if (identity.type.startsWith("invoice.")) {
    const direct = stripeObjectId(object.subscription);
    if (direct) return direct;
    const details = record(record(object.parent).subscription_details);
    return stripeObjectId(details.subscription);
  }
  return null;
}

function subscriptionUpdateFromSubscriptionObject(
  object: Record<string, unknown>,
  config: StripeConfig,
  deleted = false,
): StripeSubscriptionUpdate {
  const metadata = record(object.metadata);
  const ownerId = text(metadata.ownerId) ?? "";
  const customerId = stripeObjectId(object.customer) ?? text(object.customer_id);
  const subscriptionId = stripeObjectId(object.id);
  const status = deleted ? "canceled" : knownStatus(object.status) ?? "incomplete";

  const items = record(object.items);
  const itemList = Array.isArray(items.data) ? items.data : [];
  let periodEnd = periodEndFromSeconds(object.current_period_end);
  const metadataPlan = text(metadata.planId);
  let planId: string | null = metadataPlan && isPurchasablePlan(config, metadataPlan) ? metadataPlan : null;
  let sawPrice = false;
  let mappedPlan: string | null = null;

  for (const rawItem of itemList) {
    const item = record(rawItem);
    if (!periodEnd) {
      periodEnd = periodEndFromSeconds(item.current_period_end);
    }
    const priceId = text(record(item.price).id);
    if (priceId) {
      sawPrice = true;
      const mapped = planIdForPriceId(config, priceId);
      if (mapped) {
        mappedPlan = mapped;
        break;
      }
    }
  }

  if (sawPrice) {
    // Actual configured price overrides stale metadata; an unknown price fails closed to "free".
    planId = mappedPlan ?? "free";
  }

  if (!ownerId) {
    return {
      ownerId: "",
      planId: deleted ? null : planId,
      status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEnd: periodEnd,
      unattributed: true,
    };
  }

  return {
    ownerId,
    planId: deleted ? null : planId,
    status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    currentPeriodEnd: periodEnd,
    unattributed: false,
  };
}

/**
 * Translates the Stripe events BackSpyne subscribes to into a subscription update.
 * Returns null for every other event type, and an `unattributed` update when the
 * payload carries no operator id (those are acknowledged but never granted).
 */
export function subscriptionUpdateFromEvent(event: unknown, config: StripeConfig): StripeSubscriptionUpdate | null {
  const identity = stripeEventIdentity(event);
  if (!identity) return null;
  const object = record(record(record(event).data).object);
  const metadata = record(object.metadata);
  const ownerId = text(metadata.ownerId) ?? text(record(event).client_reference_id) ?? text(object.client_reference_id);
  const customerId = stripeObjectId(object.customer) ?? text(object.customer_id);
  const subscriptionId = stripeObjectId(object.subscription) ?? stripeObjectId(object.id);

  if (
    identity.type === "checkout.session.completed" ||
    identity.type === "checkout.session.async_payment_succeeded" ||
    identity.type === "checkout.session.async_payment_failed"
  ) {
    if (text(object.mode) && text(object.mode) !== "subscription") return null;
    const rawPlanId = text(metadata.planId);
    const planId = rawPlanId && isPurchasablePlan(config, rawPlanId) ? rawPlanId : null;
    const paymentStatus = text(object.payment_status);
    const status =
      identity.type === "checkout.session.async_payment_failed"
        ? "incomplete"
        : paymentStatus === "paid" || paymentStatus === "no_payment_required"
          ? "active"
          : "incomplete";
    if (!ownerId) {
      return {
        ownerId: "",
        planId,
        status,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        currentPeriodEnd: null,
        unattributed: true,
      };
    }
    return {
      ownerId,
      planId,
      status,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEnd: null,
      unattributed: false,
    };
  }

  if (
    identity.type === "customer.subscription.created" ||
    identity.type === "customer.subscription.updated" ||
    identity.type === "customer.subscription.deleted"
  ) {
    return subscriptionUpdateFromSubscriptionObject(
      object,
      config,
      identity.type === "customer.subscription.deleted",
    );
  }

  return null;
}

/**
 * Retrieves the live subscription state from Stripe so out-of-order or invoice
 * webhook deliveries always project current truth rather than stale snapshots.
 */
export async function currentSubscriptionUpdate(
  config: StripeConfig,
  stripeSubscriptionId: string,
): Promise<StripeSubscriptionUpdate> {
  const response = await stripeRequest(
    config,
    "GET",
    `/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
  );
  if (!response.ok || !text(response.body.id)) {
    throw new Error("Unable to retrieve Stripe subscription");
  }
  return subscriptionUpdateFromSubscriptionObject(response.body, config, false);
}

/** Statuses that represent an ongoing subscription that should be managed in the portal rather than duplicated. */
export function blocksNewSubscription(status: string | null | undefined): boolean {
  return (
    status === "active" ||
    status === "trialing" ||
    status === "past_due" ||
    status === "unpaid" ||
    status === "incomplete" ||
    status === "paused"
  );
}

/** Scopes Checkout session creation idempotency to the operator, subscription epoch, and time window. */
export function checkoutIdempotencyKey(ownerId: string, scope: string, nowMs: number = Date.now()): string {
  const bucket = Math.floor(nowMs / 30_000);
  const digest = createHash("sha256").update(`${ownerId}:${scope}:${bucket}`, "utf8").digest("hex");
  return `backspyne-checkout-${digest}`;
}
