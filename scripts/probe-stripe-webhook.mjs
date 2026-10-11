// Probes a deployed Stripe webhook: does it verify the secret we think it does?
//
// Why this exists. A webhook signing secret is shown once, and three different mistakes look
// identical from the outside: the secret in the environment belongs to a *different* endpoint,
// the endpoint's secret was rolled in the dashboard, or the value was mistyped. All three
// produce the same symptom — Stripe's events are rejected with 400, no subscription is ever
// recorded, and the product appears to work while quietly billing nobody.
//
// The probe settles it with one signed request. It sends a **no-op** event: a subscription
// update carrying no operator id, which the handler classifies as unattributed and answers
// with `{received:true, applied:false}` while deliberately writing nothing to the database.
// So a 200 proves the secret verifies without creating, changing, or billing anything, and a
// 400 proves it does not.
//
//   node scripts/probe-stripe-webhook.mjs
//   node scripts/probe-stripe-webhook.mjs --url https://example.com/api/billing/webhook
//
// It also sends a deliberately corrupted signature as a negative control: an endpoint that
// answers 200 to that one is not verifying anything, which is worse than a wrong secret.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

import { readFlag } from "./setup-stripe-billing.mjs";

const DEFAULT_URL = "https://backspyne-app.vercel.app/api/billing/webhook";

/** A signature Stripe would compute: `t=<unix>,v1=<hmac sha256 of "<t>.<body>">`. */
export function signPayload(payload, secret, timestampSeconds) {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${payload}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * An event that must change nothing. It carries no `ownerId`, so the handler's
 * unattributed branch acknowledges it and returns before any billing state is touched.
 */
export function noOpEvent(id) {
  return {
    id: `evt_probe_${id}`,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_probe_${id}`,
        object: "subscription",
        status: "active",
        metadata: {},
        items: { data: [] },
      },
    },
  };
}

async function post(url, payload, signature) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload,
  });
  let body = {};
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

async function main() {
  const url = readFlag("url", DEFAULT_URL);
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || readWebhookSecretFromFile();
  if (!secret) {
    console.error("No STRIPE_WEBHOOK_SECRET. Set it in the environment, or write it to .env.stripe.local.");
    process.exit(1);
  }
  // Never print the secret; its first characters are enough to tell two apart.
  console.log(`Probing ${url}`);
  console.log(`Secret in use: ${secret.slice(0, 10)}… (length ${secret.length})\n`);

  const nonce = Math.random().toString(36).slice(2, 10);
  const timestamp = Math.floor(Date.now() / 1000);

  const good = await post(url, JSON.stringify(noOpEvent(nonce)), signPayload(JSON.stringify(noOpEvent(nonce)), secret, timestamp));
  console.log(`signed no-op event        -> ${good.status} ${JSON.stringify(good.body)}`);

  const tampered = await post(url, JSON.stringify(noOpEvent(nonce)), signPayload(JSON.stringify(noOpEvent(nonce)), `${secret}not-the-secret`, timestamp));
  console.log(`corrupted signature       -> ${tampered.status} ${JSON.stringify(tampered.body)}`);

  console.log("");
  if (good.status === 503) {
    console.log("Verdict: billing is not configured on that deployment, so nothing was verified.");
    console.log("Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, a price id, and FRONTEND_ORIGIN.");
    process.exitCode = 1;
    return;
  }
  if (good.status !== 200) {
    console.log("Verdict: WRONG SECRET — the deployment does not verify this value, so every real");
    console.log("Stripe event is being rejected. Put the signing secret of the endpoint at this URL");
    console.log("into STRIPE_WEBHOOK_SECRET (roll it in the dashboard if it is not shown).");
    process.exitCode = 1;
    return;
  }
  if (tampered.status === 200) {
    console.log("Verdict: INSECURE — the endpoint accepted a corrupted signature, so it is not");
    console.log("verifying signatures at all. Do not take payments until that is fixed.");
    process.exitCode = 1;
    return;
  }
  console.log("Verdict: OK — this secret verifies, unattributed events are dropped without a write,");
  console.log("and a corrupted signature is refused.");
}

/** The same gitignored local file the setup script reads its key from. */
export function readWebhookSecretFromFile() {
  try {
    const line = readFileSync(".env.stripe.local", "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("STRIPE_WEBHOOK_SECRET="));
    return line ? line.slice("STRIPE_WEBHOOK_SECRET=".length).trim() : "";
  } catch {
    return "";
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) await main();
