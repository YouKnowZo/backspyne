// Unit tests for the pure billing logic. These run on Node's built-in test runner with
// native TypeScript type stripping, with no bundler, database, or Stripe account:
//
//   node --test artifacts/api-server/test/billing.test.ts
//
// The file lives outside src/ on purpose: it is not part of the server build.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  OWNER_PLAN,
  PLAN_CATALOG,
  PLAN_IDS,
  effectiveEntitlements,
  effectivePlanId,
  entitlementsFor,
  isOwnerAccount,
  isPlanId,
  ownerUserIds,
  planDefinition,
} from "../src/lib/billing/plans.ts";
import {
  encodeStripeForm,
  isPurchasablePlan,
  planIdForPriceId,
  safeOrigin,
  stripeConfigFromEnv,
  stripeEventIdentity,
  subscriptionUpdateFromEvent,
  verifyStripeSignature,
  type StripeConfig,
} from "../src/lib/billing/stripe.ts";

const CONFIG: StripeConfig = {
  secretKey: "sk_test_1234567890abcdef",
  webhookSecret: "whsec_test_1234567890",
  origin: "https://backspyne-app.vercel.app",
  priceIds: { solo: "price_solo", team: "price_team", consultant: "price_consultant" },
};

function sign(payload: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${payload}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

test("plan catalog is ordered, unique, and free-first", () => {
  assert.deepEqual([...PLAN_IDS], ["free", "solo", "team", "consultant"]);
  assert.equal(PLAN_CATALOG.length, 4);
  assert.equal(new Set(PLAN_IDS).size, 4);
  assert.equal(planDefinition("free").priceMonthlyUsd, 0);
  for (const plan of PLAN_CATALOG) {
    assert.equal(plan.id, planDefinition(plan.id).id);
    assert.ok(plan.name.length > 0);
    assert.ok(plan.highlights.length > 0);
  }
});

test("entitlements increase monotonically with price except for relay count at entry tiers", () => {
  const [free, solo, team, consultant] = PLAN_CATALOG.map((plan) => plan.entitlements);
  assert.deepEqual(free, { maxRelays: 1, historyDays: 7, reportExport: false, csiResearch: false });
  assert.ok(solo.historyDays > free.historyDays);
  assert.ok(solo.reportExport);
  assert.ok(team.maxRelays > solo.maxRelays);
  assert.ok(team.csiResearch && consultant.csiResearch);
  assert.ok(consultant.maxRelays > team.maxRelays && consultant.historyDays > team.historyDays);
});

test("unknown plan ids fall back to the free plan and entitlements are copies", () => {
  assert.equal(planDefinition("enterprise").id, "free");
  assert.equal(planDefinition(null).id, "free");
  assert.equal(planDefinition(undefined).id, "free");
  assert.equal(entitlementsFor("nonsense").maxRelays, 1);
  assert.equal(isPlanId("solo"), true);
  assert.equal(isPlanId("Solo"), false);
  assert.equal(isPlanId(7), false);
  const mutated = entitlementsFor("consultant");
  mutated.maxRelays = 9_999;
  assert.equal(entitlementsFor("consultant").maxRelays, 25);
});

test("a stored plan only applies while the subscription is billing", () => {
  for (const status of ENTITLED_SUBSCRIPTION_STATUSES) {
    assert.equal(effectivePlanId("team", status), "team");
  }
  for (const status of ["past_due", "canceled", "unpaid", "incomplete", "paused", "inactive", "", null, undefined]) {
    assert.equal(effectivePlanId("team", status), "free");
  }
  assert.equal(effectivePlanId("free", "active"), "free");
  assert.equal(effectivePlanId("bogus", "active"), "free");
  assert.equal(effectiveEntitlements("team", "past_due").maxRelays, 1);
  assert.equal(effectiveEntitlements("team", "active").maxRelays, 5);
});

test("safeOrigin accepts https and loopback only, and rejects smuggling", () => {
  assert.equal(safeOrigin("https://backspyne-app.vercel.app"), "https://backspyne-app.vercel.app");
  assert.equal(safeOrigin("https://example.com/"), "https://example.com");
  assert.equal(safeOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(safeOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  for (const rejected of [
    "http://evil.example.com",
    "https://user:pass@example.com",
    "https://example.com/?next=evil",
    "https://example.com/#frag",
    "javascript:alert(1)",
    "not a url",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(safeOrigin(rejected), null, `expected ${String(rejected)} to be rejected`);
  }
});

test("stripe config fails closed unless every required value is present", () => {
  const complete = {
    STRIPE_SECRET_KEY: "sk_live_abcdefghijklmnop",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    FRONTEND_ORIGIN: "https://app.example.com",
    STRIPE_PRICE_SOLO: "price_solo",
  };
  const parsed = stripeConfigFromEnv(complete);
  assert.ok(parsed);
  assert.equal(parsed.origin, "https://app.example.com");
  assert.deepEqual(parsed.priceIds, { solo: "price_solo" });

  const restricted = stripeConfigFromEnv({ ...complete, STRIPE_SECRET_KEY: "rk_test_abcdefghijklmnop" });
  assert.ok(restricted);

  for (const missing of [
    { ...complete, STRIPE_SECRET_KEY: undefined },
    { ...complete, STRIPE_WEBHOOK_SECRET: "" },
    { ...complete, FRONTEND_ORIGIN: undefined },
    { ...complete, FRONTEND_ORIGIN: "http://app.example.com" },
    { ...complete, STRIPE_SECRET_KEY: "pk_test_abcdefghijklmnop" },
    { ...complete, STRIPE_SECRET_KEY: "sk_test_short" },
    { ...complete, STRIPE_PRICE_SOLO: undefined },
  ]) {
    assert.equal(stripeConfigFromEnv(missing), null, `expected ${JSON.stringify(missing)} to be rejected`);
  }
});

test("purchasable plans are exactly the ones with a configured price", () => {
  assert.equal(isPurchasablePlan(CONFIG, "team"), true);
  assert.equal(isPurchasablePlan(CONFIG, "free"), false);
  assert.equal(isPurchasablePlan(CONFIG, "toString"), false);
  assert.equal(isPurchasablePlan(CONFIG, "enterprise"), false);
  assert.equal(planIdForPriceId(CONFIG, "price_team"), "team");
  assert.equal(planIdForPriceId(CONFIG, "price_unknown"), null);
  assert.equal(planIdForPriceId(CONFIG, null), null);
});

test("form encoding skips empty values and encodes bracket keys", () => {
  const encoded = encodeStripeForm({
    mode: "subscription",
    "line_items[0][quantity]": 1,
    "metadata[ownerId]": "user_123",
    omitted: undefined,
    alsoOmitted: "",
  });
  assert.equal(
    encoded,
    "mode=subscription&line_items%5B0%5D%5Bquantity%5D=1&metadata%5BownerId%5D=user_123",
  );
});

test("webhook signatures are verified against the raw body and a replay window", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const now = 1_700_000_000_000;
  const timestamp = Math.floor(now / 1000);
  const header = sign(payload, CONFIG.webhookSecret, timestamp);

  assert.equal(verifyStripeSignature({ payload, header, secret: CONFIG.webhookSecret, now }), true);
  // Signature over a different secret must not validate.
  assert.equal(verifyStripeSignature({ payload, header, secret: "whsec_other", now }), false);
  // Tampered payload with a valid signature for the original body must not validate.
  assert.equal(verifyStripeSignature({ payload: `${payload} `, header, secret: CONFIG.webhookSecret, now }), false);
  // Replay outside the tolerance window is rejected, in both directions.
  assert.equal(verifyStripeSignature({ payload, header, secret: CONFIG.webhookSecret, now: now + 301_000 }), false);
  assert.equal(verifyStripeSignature({ payload, header, secret: CONFIG.webhookSecret, now: now - 301_000 }), false);
  assert.equal(verifyStripeSignature({ payload, header, secret: CONFIG.webhookSecret, now: now + 299_000 }), true);
  // Malformed headers never throw and never validate.
  for (const bad of [undefined, "", "t=,v1=", `v1=${"a".repeat(64)}`, "t=abc,v1=xyz", `t=${timestamp},v1=short`]) {
    assert.equal(verifyStripeSignature({ payload, header: bad, secret: CONFIG.webhookSecret, now }), false);
  }
  // A second candidate signature (as Stripe sends during rotation) is accepted.
  const rotated = `t=${timestamp},v1=${"0".repeat(64)},v1=${createHmac("sha256", CONFIG.webhookSecret).update(`${timestamp}.${payload}`).digest("hex")}`;
  assert.equal(verifyStripeSignature({ payload, header: rotated, secret: CONFIG.webhookSecret, now }), true);
  assert.equal(verifyStripeSignature({ payload, header, secret: "", now }), false);
});

test("event identity requires both an id and a type", () => {
  assert.deepEqual(stripeEventIdentity({ id: "evt_1", type: "invoice.paid" }), { id: "evt_1", type: "invoice.paid" });
  assert.equal(stripeEventIdentity({ id: "evt_1" }), null);
  assert.equal(stripeEventIdentity({ type: "invoice.paid" }), null);
  assert.equal(stripeEventIdentity(null), null);
  assert.equal(stripeEventIdentity("nope"), null);
});

test("checkout completion grants the metadata plan to the referenced operator", () => {
  const update = subscriptionUpdateFromEvent(
    {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          payment_status: "paid",
          customer: "cus_1",
          subscription: "sub_1",
          client_reference_id: "user_1",
          metadata: { ownerId: "user_1", planId: "team" },
        },
      },
    },
    CONFIG,
  );
  assert.ok(update);
  assert.equal(update.ownerId, "user_1");
  assert.equal(update.planId, "team");
  assert.equal(update.status, "active");
  assert.equal(update.stripeCustomerId, "cus_1");
  assert.equal(update.stripeSubscriptionId, "sub_1");
  assert.equal(update.unattributed, false);
});

test("an unpaid or unfinished checkout is never recorded as active", () => {
  const update = subscriptionUpdateFromEvent(
    { id: "evt", type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "unpaid", metadata: { ownerId: "user_1", planId: "solo" } } } },
    CONFIG,
  );
  assert.ok(update);
  assert.equal(update.status, "incomplete");
  // One-time payments are not BackSpyne subscriptions.
  assert.equal(
    subscriptionUpdateFromEvent({ id: "evt", type: "checkout.session.completed", data: { object: { mode: "payment", metadata: { ownerId: "user_1" } } } }, CONFIG),
    null,
  );
});

test("subscription lifecycle events map price ids to plans and carry the period end", () => {
  const updated = subscriptionUpdateFromEvent(
    {
      id: "evt_sub",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "past_due",
          customer: "cus_1",
          current_period_end: 1_700_000_000,
          metadata: { ownerId: "user_1" },
          items: { data: [{ price: { id: "price_consultant" } }] },
        },
      },
    },
    CONFIG,
  );
  assert.ok(updated);
  assert.equal(updated.planId, "consultant");
  assert.equal(updated.status, "past_due");
  assert.equal(updated.currentPeriodEnd?.getTime(), 1_700_000_000_000);

  // Cancellation clears the plan; the stored status decides the downgrade.
  const deleted = subscriptionUpdateFromEvent(
    { id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", metadata: { ownerId: "user_1" }, items: { data: [] } } } },
    CONFIG,
  );
  assert.ok(deleted);
  assert.equal(deleted.status, "canceled");
  assert.equal(deleted.planId, null);

  // Unknown statuses degrade to incomplete rather than being trusted.
  const weird = subscriptionUpdateFromEvent(
    { id: "evt_w", type: "customer.subscription.created", data: { object: { id: "sub_2", status: "something_new", customer: "cus_1", metadata: { ownerId: "user_1" }, items: { data: [] } } } },
    CONFIG,
  );
  assert.ok(weird);
  assert.equal(weird.status, "incomplete");
  assert.equal(weird.planId, null);
});

test("owner access is configuration, never a plan an operator can hold or buy", () => {
  // Not in the catalog, so no plan grid offers it and no stored plan id can name it.
  assert.equal(PLAN_CATALOG.some((plan) => plan.id === "owner"), false);
  assert.equal(isPlanId("owner"), false);
  // But the definition resolves, which is what every entitlement read uses.
  assert.equal(planDefinition("owner").id, "owner");
  assert.equal(planDefinition("owner").name, OWNER_PLAN.name);
  const owner = entitlementsFor("owner");
  assert.equal(owner.unlimited, true);
  assert.ok(owner.reportExport && owner.csiResearch);
  assert.ok(owner.maxRelays > entitlementsFor("consultant").maxRelays);
  assert.ok(owner.historyDays >= entitlementsFor("consultant").historyDays);
  // A stored subscription can never be upgraded to owner by the webhook mapper.
  assert.equal(effectivePlanId("owner", "active"), "free");
  // Entitlements are copies, so a caller cannot edit the shared owner definition.
  owner.maxRelays = 1;
  assert.ok(entitlementsFor("owner").maxRelays > 1);
});

test("the owner allowlist is exact, trimmed, and empty by default", () => {
  assert.deepEqual(ownerUserIds({}), []);
  assert.deepEqual(ownerUserIds({ BACKSPYNE_OWNER_USER_IDS: " user_1 , ,user_2 " }), ["user_1", "user_2"]);
  assert.equal(isOwnerAccount("user_1", { BACKSPYNE_OWNER_USER_IDS: "user_1,user_2" }), true);
  assert.equal(isOwnerAccount("user_2", { BACKSPYNE_OWNER_USER_IDS: "user_1,user_2" }), true);
  assert.equal(isOwnerAccount("user_3", { BACKSPYNE_OWNER_USER_IDS: "user_1,user_2" }), false);
  // No configuration means nobody is an owner, and a partial or empty id never matches.
  assert.equal(isOwnerAccount("user_1", {}), false);
  assert.equal(isOwnerAccount("", { BACKSPYNE_OWNER_USER_IDS: "user_1" }), false);
  assert.equal(isOwnerAccount("user", { BACKSPYNE_OWNER_USER_IDS: "user_1" }), false);
  assert.equal(isOwnerAccount("user_1", { BACKSPYNE_OWNER_USER_IDS: "user_1suffix" }), false);
});

test("unattributed and unrelated events are acknowledged without granting anything", () => {
  const unattributed = subscriptionUpdateFromEvent(
    { id: "evt_x", type: "customer.subscription.updated", data: { object: { id: "sub_9", status: "active", customer: "cus_9", items: { data: [] } } } },
    CONFIG,
  );
  assert.ok(unattributed);
  assert.equal(unattributed.unattributed, true);
  assert.equal(unattributed.ownerId, "");

  for (const type of ["invoice.paid", "customer.created", "payment_intent.succeeded"]) {
    assert.equal(subscriptionUpdateFromEvent({ id: "evt_y", type, data: { object: { metadata: { ownerId: "user_1" } } } }, CONFIG), null);
  }
  assert.equal(subscriptionUpdateFromEvent({ type: "customer.subscription.updated" }, CONFIG), null);
  assert.equal(subscriptionUpdateFromEvent(null, CONFIG), null);
});
