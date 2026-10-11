// Tests for the Stripe setup and probe scripts.
//
//   node --test scripts/test/stripe-billing.test.mjs
//
// Two bugs found by running these scripts against a live account, both of which a test would
// have caught for free:
//
//   * An array encoded as a repeated bare key (`enabled_events=a&enabled_events=b`) is rejected
//     by Stripe with "Invalid array", so the webhook endpoint could not be created at all.
//   * An `expand` passed through that array path is *ignored silently*: the request succeeds
//     and the field is simply absent. The reuse check then concluded no price existed and
//     minted a second live price for every plan — a mistake that costs money to notice, since
//     a price cannot be edited, only archived.
//
// And one invariant worth pinning, because nothing else in the codebase can: the amount the
// public pricing page displays comes from `plans.ts`, while the amount actually charged comes
// from a Stripe price created by this script. If those two drift, the page lies.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SELLABLE_PLANS,
  WEBHOOK_EVENTS,
  activeRecurringPriceAt,
  encodeForm,
  encodeFormValue,
  readFlag,
} from "../setup-stripe-billing.mjs";
import { noOpEvent, signPayload } from "../probe-stripe-webhook.mjs";
import { PLAN_CATALOG } from "../../artifacts/api-server/src/lib/billing/plans.ts";

test("arrays are encoded with an index per element, which is what Stripe accepts", () => {
  assert.deepEqual(encodeFormValue("enabled_events", ["a", "b"]), [
    ["enabled_events[0]", "a"],
    ["enabled_events[1]", "b"],
  ]);
  const encoded = encodeForm({ url: "https://example.test/hook", enabled_events: ["x", "y"] });
  assert.ok(encoded.includes("enabled_events%5B0%5D=x"), encoded);
  assert.ok(encoded.includes("enabled_events%5B1%5D=y"), encoded);
  // A repeated bare key is exactly the shape Stripe refuses.
  assert.equal(encoded.includes("enabled_events=x"), false);
});

test("nested objects become bracketed keys, and empty values are dropped", () => {
  assert.deepEqual(encodeFormValue("metadata", { ownerId: "user_1" }), [["metadata[ownerId]", "user_1"]]);
  assert.deepEqual(encodeFormValue("planId", undefined), []);
  assert.deepEqual(encodeFormValue("planId", ""), []);
  // Numbers and booleans are stringified the way the API expects them.
  assert.deepEqual(encodeFormValue("unit_amount", 3900), [["unit_amount", "3900"]]);
  assert.deepEqual(encodeFormValue("active", false), [["active", "false"]]);
});

test("a price is only reused when it is the same amount, currency, and cadence", () => {
  const price = (overrides = {}) => ({
    id: "price_x", active: true, currency: "usd", unit_amount: 3900, type: "recurring",
    recurring: { interval: "month" }, ...overrides,
  });
  const product = (...prices) => ({ prices: { data: prices } });

  // The reuse decision is what stops a re-run creating a second live price for a plan, which
  // is exactly what happened on the first run against a live account.
  assert.equal(activeRecurringPriceAt(product(price()), 39, "usd")?.id, "price_x");
  // An archived price is skipped in favour of a live one, and a non-matching one is ignored.
  assert.equal(activeRecurringPriceAt(product(price({ id: "price_old", active: false }), price({ id: "price_new" })), 39, "usd")?.id, "price_new");
  // Nothing reusable: the caller must create, and each of these is a reason to.
  for (const wrong of [
    price({ active: false }),
    price({ unit_amount: 2900 }),
    price({ currency: "eur" }),
    price({ type: "one_time", recurring: null }),
    price({ recurring: { interval: "year" } }),
  ]) {
    assert.equal(
      activeRecurringPriceAt(product(wrong), 39, "usd"),
      null,
      `${JSON.stringify(wrong)} must not be reused as the $39 monthly price`,
    );
  }
  assert.equal(activeRecurringPriceAt({ prices: { data: [] } }, 39, "usd"), null);
  assert.equal(activeRecurringPriceAt({}, 39, "usd"), null);
});

test("the amount this script creates is the amount the pricing page shows", () => {
  // One number per plan, in two places: the catalog the API publishes, and the Stripe price
  // this script creates. They are compared here rather than trusted.
  for (const plan of SELLABLE_PLANS) {
    const catalogPlan = PLAN_CATALOG.find((entry) => entry.id === plan.planId);
    assert.ok(catalogPlan, `${plan.planId} is not in the plan catalog`);
    assert.equal(
      plan.amountUsd,
      catalogPlan.priceMonthlyUsd,
      `${plan.planId} would be charged at $${plan.amountUsd} but shown at $${catalogPlan.priceMonthlyUsd}`,
    );
  }
  // Owner access is configuration, never a purchase, so it must never be given a price.
  assert.equal(SELLABLE_PLANS.some((plan) => plan.planId === "owner"), false);
  // The free plan is a plan, not a product to sell.
  assert.equal(SELLABLE_PLANS.some((plan) => plan.planId === "free"), false);
});

test("the probe's no-op event must never be attributable to an operator", () => {
  // This is the property that makes the probe safe to run against production: an event with no
  // owner id cannot change anybody's entitlements, and the handler answers it without a write.
  const event = noOpEvent("test");
  assert.equal(event.type, "customer.subscription.updated");
  assert.equal(event.data.object.metadata.ownerId, undefined);
  assert.equal(event.client_reference_id, undefined);
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("ownerId"), false, "the probe event must carry no owner id anywhere");
});

test("a signature is the documented Stripe scheme, and it is over the timestamp", () => {
  const payload = '{"id":"evt_1"}';
  const signature = signPayload(payload, "whsec_test", 1_700_000_000);
  assert.match(signature, /^t=1700000000,v1=[a-f0-9]{64}$/);
  // Same body, different timestamp: a different signature, because the timestamp is signed too.
  assert.notEqual(signPayload(payload, "whsec_test", 1_700_000_001), signature);
  // Different secret: a different signature.
  assert.notEqual(signPayload(payload, "whsec_other", 1_700_000_000), signature);
});

test("flags are read without swallowing the next flag as a value", () => {
  // `--url --apply` must not read "--apply" as the url, or a bare flag would silently become
  // the endpoint's address and the webhook would be registered against nonsense.
  const fallback = "https://fallback.test/hook";
  assert.equal(readFlag("url", fallback, ["--url", "--apply"]), fallback);
  assert.equal(readFlag("url", fallback, ["--url", "https://given.test/hook"]), "https://given.test/hook");
  assert.equal(readFlag("url", fallback, []), fallback);
  assert.equal(readFlag("url", fallback, ["--apply"]), fallback);
});

test("the webhook subscribes to exactly the events the API understands", () => {
  assert.deepEqual([...WEBHOOK_EVENTS].sort(), [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.deleted",
    "customer.subscription.updated",
  ]);
});
