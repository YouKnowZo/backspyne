// Creates the Stripe objects BackSpyne's billing surface needs, idempotently.
//
// The code in `artifacts/api-server/src/lib/billing/` charges whatever price ids it is
// configured with, which is deliberate — a client cannot name a price. The cost of that
// design is that somebody has to create the prices in the Stripe account and put their ids in
// the environment, and doing that by hand is where a $39 plan ends up priced at $390 and the
// public pricing page quietly starts lying, because the page reads one list and Stripe charges
// another.
//
// So this script reads the price out of that one list (`lib/billing/plans.ts` is the source of
// truth for the catalog amounts, mirrored here as plain numbers because this runs outside the
// bundle) and creates the products and prices to match, then registers the webhook endpoint.
//
//   node scripts/setup-stripe-billing.mjs                    # dry run: report what is missing
//   node scripts/setup-stripe-billing.mjs --apply            # create the missing objects
//   node scripts/setup-stripe-billing.mjs --apply --url https://example.com/api/billing/webhook
//   node scripts/setup-stripe-billing.mjs --apply --rotate-webhook   # mint a fresh signing secret
//   node scripts/setup-stripe-billing.mjs --apply --write-local-env  # record the results in .env.stripe.local
//
// It reads STRIPE_SECRET_KEY from the environment, or from a local `.env.stripe.local`
// (gitignored) so the key never has to appear on a command line. It never prints the key.
//
// Three things are worth knowing before running it against a live account:
//   * A price's amount cannot be edited. Changing a price means creating a new one and
//     repointing the environment variable, which is what the reuse check below assumes.
//   * Stripe returns a webhook signing secret exactly once, at creation, and never again — not
//     through the API and not through the CLI. So an endpoint whose secret nobody wrote down is
//     an endpoint nobody can verify against: the only recovery is to replace it. `--rotate-webhook`
//     does exactly that — deletes the endpoint for this URL and creates a fresh one, so the new
//     secret is known and can be checked with `scripts/probe-stripe-webhook.mjs`. Without the
//     flag an existing endpoint is left alone and reported, never duplicated.
//   * Nothing here charges anybody. It creates catalog objects and an endpoint that receives
//     events; the first payment is still the first operator who completes Checkout.

import { readFileSync, writeFileSync } from "node:fs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

const API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2024-06-20";
const DEFAULT_WEBHOOK_URL = "https://backspyne-app.vercel.app/api/billing/webhook";

/**
 * The sellable plans, with the amounts the public pricing page shows. Kept in step with
 * `artifacts/api-server/src/lib/billing/plans.ts` by hand and checked against it by the caller
 * of this script; the two must agree or a displayed price stops being the charged price.
 */
export const SELLABLE_PLANS = [
  { planId: "solo", name: "BackSpyne Solo", amountUsd: 39, tagline: "One operator documenting one site." },
  { planId: "team", name: "BackSpyne Team", amountUsd: 149, tagline: "Small IT teams covering several locations." },
  { planId: "consultant", name: "BackSpyne Consultant", amountUsd: 399, tagline: "Wireless consultants running repeat assessments." },
];

/** Events the API's webhook handler understands. Anything else it acknowledges and ignores. */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

export function readSecretKey(env = process.env) {
  const fromEnv = typeof env.STRIPE_SECRET_KEY === "string" ? env.STRIPE_SECRET_KEY.trim() : "";
  if (fromEnv) return fromEnv;
  try {
    const file = readFileSync(".env.stripe.local", "utf8");
    for (const line of file.split(/\r?\n/)) {
      if (!line.startsWith("STRIPE_SECRET_KEY=")) continue;
      return line.slice("STRIPE_SECRET_KEY=".length).trim();
    }
  } catch {
    // No local file; the caller reports the missing configuration.
  }
  return "";
}

export function readFlag(name, fallback = "", args = argv) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

/**
 * Stripe's form encoding. Two rules this has to get right, both learned the hard way:
 *
 *   * An array needs an index per element (`enabled_events[0]=...`). A repeated bare key is
 *     rejected outright with "Invalid array", which is how the webhook registration failed on
 *     the first run.
 *   * An array passed to `expand` must NOT be indexed (`expand[]=data.prices`). Stripe ignores
 *     a malformed expand *silently*, so an indexed expand means the request succeeds and the
 *     field simply is not there — which is how the reuse check went blind and minted a second
 *     live price for every plan. That is why `expand` is written literally here rather than
 *     cycled through the array path.
 */
export function encodeFormValue(key, value) {
  if (value === undefined || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => encodeFormValue(`${key}[${index}]`, entry));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([nested, nestedValue]) => encodeFormValue(`${key}[${nested}]`, nestedValue));
  }
  return [[key, String(value)]];
}

export function encodeForm(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const [encodedKey, encodedValue] of encodeFormValue(key, value)) params.append(encodedKey, encodedValue);
  }
  return params.toString();
}

async function stripe(secretKey, method, path, fields = {}) {
  const encoded = encodeForm(fields);
  const url = `${API}${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_VERSION,
    },
    body: method === "POST" ? encoded : undefined,
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`${method} ${path} failed: ${message}`);
  }
  return body;
}

/** A product this script created before, recognised by the marker it sets in metadata. */
function planIdOfProduct(product) {
  const marked = product?.metadata?.backspyne_plan;
  return typeof marked === "string" && marked ? marked : null;
}

/**
 * The active monthly price on this product at exactly this amount, or null.
 * Exported because it is the check that decides whether a re-run creates another live price.
 */
export function activeRecurringPriceAt(product, amountUsd, currency) {
  const prices = Array.isArray(product?.prices?.data) ? product.prices.data : [];
  for (const price of prices) {
    if (price.active === false) continue;
    if (price.currency !== currency) continue;
    if (price.unit_amount !== amountUsd * 100) continue;
    if (price.type !== "recurring") continue;
    if (price.recurring?.interval !== "month") continue;
    return price;
  }
  return null;
}

async function main() {
  const apply = argv.includes("--apply");
  const webhookUrl = readFlag("url", DEFAULT_WEBHOOK_URL);
  const currency = readFlag("currency", "usd");
  const secretKey = readSecretKey();

  if (!secretKey) {
    console.error("No STRIPE_SECRET_KEY. Set it in the environment, or write it to .env.stripe.local.");
    process.exit(1);
  }
  if (!/^(sk|rk)_(test|live)_/.test(secretKey)) {
    console.error("That does not look like a Stripe secret key (expected sk_ or rk_, then test_ or live_).");
    process.exit(1);
  }
  const mode = secretKey.includes("_live_") ? "LIVE" : "TEST";

  const account = await stripe(secretKey, "GET", "/account");
  console.log(`Stripe account: ${account.settings?.dashboard?.display_name || account.id} (${account.country || "unknown country"})`);
  console.log(`Key mode: ${mode}${mode === "LIVE" ? "  ← real money; every payment taken here is a real payment" : "  (test mode: no real charges)"}`);
  console.log(apply ? "Mode: applying changes\n" : "Mode: dry run (pass --apply to create anything)\n");

  // Prices are fetched per product rather than with `expand[]=data.prices`. Not because expand
  // is wrong, but because a silently-ignored expand has no failure mode: the request succeeds,
  // the field is simply absent, and the reuse check below concludes the price does not exist
  // and mints another one. One extra request per plan is worth a check that cannot go blind.
  const productList = await stripe(secretKey, "GET", "/products", { limit: "100" });
  const byPlan = new Map();
  for (const product of productList.data || []) {
    const planId = planIdOfProduct(product);
    if (planId) byPlan.set(planId, product);
  }

  const envLines = [];
  const created = [];
  const reused = [];

  for (const plan of SELLABLE_PLANS) {
    let product = byPlan.get(plan.planId) ?? null;
    if (product) {
      const prices = await stripe(secretKey, "GET", "/prices", { product: product.id, limit: "100" });
      const price = activeRecurringPriceAt({ prices: { data: prices.data } }, plan.amountUsd, currency);
      if (price) {
        reused.push(`${plan.planId}: product ${product.id}, price ${price.id} at $${plan.amountUsd}/month`);
        envLines.push([`STRIPE_PRICE_${plan.planId.toUpperCase()}`, price.id]);
        continue;
      }
      console.log(`${plan.planId}: product ${product.id} exists but has no active $${plan.amountUsd}/${currency} monthly price.`);
      if (apply) {
        const price = await stripe(secretKey, "POST", "/prices", {
          product: product.id,
          currency,
          unit_amount: plan.amountUsd * 100,
          "recurring[interval]": "month",
          nickname: `${plan.name} monthly ($${plan.amountUsd})`,
          "metadata[backspyne_plan]": plan.planId,
        });
        created.push(`${plan.planId}: new price ${price.id} at $${plan.amountUsd}/month on existing product ${product.id}`);
        envLines.push([`STRIPE_PRICE_${plan.planId.toUpperCase()}`, price.id]);
      }
      continue;
    }

    if (!apply) {
      console.log(`${plan.planId}: would create product "${plan.name}" with a $${plan.amountUsd}/${currency} monthly price.`);
      continue;
    }
    product = await stripe(secretKey, "POST", "/products", {
      name: plan.name,
      description: plan.tagline,
      "metadata[backspyne_plan]": plan.planId,
    });
    const price = await stripe(secretKey, "POST", "/prices", {
      product: product.id,
      currency,
      unit_amount: plan.amountUsd * 100,
      "recurring[interval]": "month",
      nickname: `${plan.name} monthly ($${plan.amountUsd})`,
      "metadata[backspyne_plan]": plan.planId,
    });
    created.push(`${plan.planId}: product ${product.id}, price ${price.id} at $${plan.amountUsd}/month`);
    envLines.push([`STRIPE_PRICE_${plan.planId.toUpperCase()}`, price.id]);
  }

  const rotateWebhook = argv.includes("--rotate-webhook");
  const endpoints = await stripe(secretKey, "GET", "/webhook_endpoints", { limit: "100" });
  const existing = (endpoints.data || []).find((endpoint) => endpoint.url === webhookUrl);
  let webhookLine = null;
  if (existing && rotateWebhook && apply) {
    // Replacing is the only way back to a usable secret: the old one was shown once and is
    // now unknown to everybody, which is indistinguishable from a secret that never worked.
    await stripe(secretKey, "DELETE", `/webhook_endpoints/${existing.id}`);
    console.log(`\nWebhook: removed ${existing.id} (${webhookUrl}) to mint a fresh signing secret.`);
    const endpoint = await stripe(secretKey, "POST", "/webhook_endpoints", {
      url: webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      description: "BackSpyne subscription state",
    });
    webhookLine = endpoint.secret;
    console.log(`Webhook: created ${endpoint.id} for ${webhookUrl}, listening to ${WEBHOOK_EVENTS.join(", ")}.`);
  } else if (existing) {
    console.log(`\nWebhook: an endpoint for ${webhookUrl} already exists (${existing.id}, status ${existing.status}).`);
    if (apply && !rotateWebhook) {
      console.log("Stripe reveals a signing secret only at creation, so this script cannot read it back.");
      console.log("If the deployment does not verify that endpoint's secret (check with scripts/probe-stripe-webhook.mjs),");
      console.log("re-run with --apply --rotate-webhook to replace it with one whose secret is known.");
    }
  } else if (!apply) {
    console.log(`\nWebhook: would create an endpoint for ${webhookUrl} listening to ${WEBHOOK_EVENTS.join(", ")}.`);
  } else {
    const endpoint = await stripe(secretKey, "POST", "/webhook_endpoints", {
      url: webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      description: "BackSpyne subscription state",
    });
    webhookLine = endpoint.secret;
    console.log(`\nWebhook: created ${endpoint.id} for ${webhookUrl}, listening to ${WEBHOOK_EVENTS.join(", ")}.`);
  }

  if (created.length) {
    console.log("\nCreated:");
    for (const line of created) console.log(`  ${line}`);
  }
  if (reused.length) {
    console.log("\nAlready in place:");
    for (const line of reused) console.log(`  ${line}`);
  }

  if (argv.includes("--write-local-env") && (envLines.length || webhookLine)) {
    // The script writes the values rather than printing them, so a signing secret that Stripe
    // shows exactly once can be recorded without being pasted around: a secret that only ever
    // existed in a terminal scrollback is a secret that has to be rotated next week.
    const path = ".env.stripe.local";
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = "";
    }
    const kept = existing.split(/\r?\n/).find((line) => line.startsWith("STRIPE_SECRET_KEY=")) ?? "";
    const header = [
      "# Stripe configuration for this checkout (gitignored — .gitignore matches `.env*`).",
      "# Written by scripts/setup-stripe-billing.mjs. Price ids and the webhook signing secret",
      "# below are the ones the live objects in this Stripe account actually carry; a signing",
      "# secret is shown once at creation, so this file is the only record of it.",
    ];
    const written = [...header, kept, ...envLines.map(([name, value]) => `${name}=${value}`)];
    if (webhookLine) written.push(`STRIPE_WEBHOOK_SECRET=${webhookLine}`);
    writeFileSync(path, `${written.filter(Boolean).join("\n")}\n`);
    console.log(`\nRecorded ${envLines.length + (webhookLine ? 1 : 0)} value(s) in ${path} (gitignored).`);
  } else if (envLines.length || webhookLine) {
    console.log("\nEnvironment lines for the deployment:\n");
    for (const [name, value] of envLines) console.log(`${name}=${value}`);
    if (webhookLine) console.log(`STRIPE_WEBHOOK_SECRET=${webhookLine}`);
    console.log("\nRe-run with --write-local-env to record these in .env.stripe.local instead of printing them.");
  } else if (!apply) {
    console.log("\nNothing to do. Re-run with --apply to create the objects above.");
  }
}

// Importing this module must not touch a payment account; only running it does.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) await main();
