# BackSpyne production launch gate

Status: billing reliability repairs verified locally; production release verification is recorded below. The earlier review is retained as history, not current evidence. Full commercial readiness still requires a real payment lifecycle, production identity configuration, legal/tax decisions, and the remaining acceptance checks.

## Billing reliability repair — October 2026

- Webhook event deduplication and subscription updates now commit in one PostgreSQL transaction. A failed write or Stripe lookup rolls back the event receipt, so delivery can be retried. An owner-scoped transaction lock serializes reconciliation; current Stripe state is retrieved inside the lock with bounded network/lock waits to prevent stale delivery order from resurrecting canceled access. This synchronous design avoids relying on non-durable serverless background tasks.
- Checkout, async payment success/failure, subscription lifecycle, invoice paid, and invoice payment failure events reconcile the current subscription. The current configured price determines access, not stale plan metadata. Unknown prices fail closed.
- Checkout reuses an idempotently created, persisted customer and existing open sessions; existing ongoing subscriptions are directed to the portal rather than charged for a duplicate plan. Checkout returns to `/user-portal/plan` with a session reference. `POST /api/billing/sync` verifies both session ownership references against the authenticated user and retrieves Stripe state; a redirect alone grants nothing.
- The catalog exposes `portalAvailable` and `subscriptionExists`; past-due/free-effective accounts retain payment recovery. The view refreshes after Checkout/portal returns, shows confirmation-pending honestly, and displays the actual API error without consuming the response twice. Private billing responses are no-store; foreign-Origin billing mutations are refused.
- The live Stripe account reports charges/payouts enabled, details submitted, and no currently-due requirements. No live subscriptions existed during this audit. Three existing prices were reused; no card was charged.
- The previously missing BackSpyne Portal configuration was created with payment-method update, invoice history, end-of-period cancellation, and price-only tier changes with invoiced prorations. Its ID is stored in `STRIPE_PORTAL_CONFIGURATION_ID`. Setup reruns preserve existing secrets, never print a newly minted webhook secret, and repair event subscriptions without secret rotation.
- PostgreSQL-backed tests use an isolated PGlite engine (test dependency only), not the production database. The actual billing router is exercised over HTTP with explicit identity/Stripe test doubles. These tests prove application behavior, not a real Stripe sandbox payment or multi-connection PostgreSQL concurrency.
- Browser verification uses the actual Billing component and router with isolated PostgreSQL and clearly labeled simulated Stripe. Past-due portal navigation, return, refresh and clean console/network checks passed. Screenshot capture was unavailable because the embedded webview produced no composited frames.
- Verification: workspace typecheck, production web/API build, and 137 Node tests. Vite emits an existing non-fatal tooltip sourcemap warning. Scanner code is untouched.
- Limits: no test-mode Stripe API key is available; Vercel sensitive database credentials are returned redacted. A real sandbox Checkout/payment/renewal/cancellation and live paid customer portal remain unverified. Legal placeholders, production Clerk setup and taxes are not resolved by billing code. Do not treat this as blanket production readiness.

### Release verification

Production deployment succeeded at `https://backspyne-2ejg5azkd-alonzo-locketts-projects.vercel.app` and is aliased to `https://backspyne-app.vercel.app`. Vercel's build completed successfully (about one minute end-to-end); the hosted build reports an existing >500 kB frontend chunk warning. No Git commit or push is part of this repair; task changes remain uncommitted. The deployment uploads the reviewed workspace, not a new commit hash.

Deployed verification: signed no-op webhook 200 with `received:true, applied:false`; forged signature 400. Anonymous catalog/checkout/portal/sync 401; foreign-Origin checkout 403. A real authenticated $39 USD Solo live Checkout was created, its amount/currency/metadata/return URL inspected, and a repeated request returned the same session. The verification session was then expired without payment. A fresh session after that expiry was also verified, so Stripe idempotency cannot trap the account in an expired checkout; the second session was expired without payment as well. The first customer mapping persists for the administrator's billing profile; it grants no subscription access. A real hosted Customer Portal session was created for that customer and returned HTML 200; paid-subscription controls remain untested. Authenticated billing sync/catalog succeeded, and the real signed-in operator plan page rendered owner access and refreshed successfully. Production admin revenue and operator database-backed reads succeeded; no Stripe payment or paid subscription exists from verification.

Upload audit found that Vercel's implicit ignores would include local credential files and verification logs despite Git ignores. `.vercelignore` now explicitly excludes all environment files, private logs/harnesses, workspace metadata, generated builds, caches and maps. A second dry run confirmed zero private/generated paths in 359 upload files; the public scanner `.env.example` is explicitly preserved. Source scans found no local secret values in task source changes.

The browser console after a clean production reload reports Clerk development-key configuration only; an earlier service-worker MIME error did not recur, and `/sw.js` serves JavaScript. Screenshot capture remains unavailable in the embedded webview. Full commercial launch still requires the unresolved identity, payment, tax and legal gates above.

## Confirmed in this review

- The public sign-in page renders Clerk's email sign-in form with an explicit Development mode label. A subsequent browser check confirmed the user reached `/user-portal` with a Clerk user and active session. Full sign-out/re-sign-in and account-isolation tests remain unperformed.
- The frontend requires `VITE_CLERK_PUBLISHABLE_KEY`; the API requires matching `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
- Clerk's production deployment guide requires an owned domain and DNS access; `*.vercel.app` cannot be the production Clerk domain. Source: https://clerk.com/docs/guides/development/deployment/vercel
- Clerk and Vercel browser dashboard sign-in has now been verified. A separate `BackSpyne` Clerk application was created with email authentication only; its instance is Development, not Production. Existing `ExpressiveAi.online` was not modified.
- Clerk application ID: `app_3KMDTadvAobv71sNwl0iXkfoQb3`; development instance ID: `ins_3KMDTcuiJBMiJwUbVJbrVo4tRaM`. No secret values are recorded here.
- Vercel's variable form is now working. Saved and verified in the Production deployment scope: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `FRONTEND_ORIGIN`. The Clerk keys belong to the Development instance even though the Vercel deployment scope is Production.
- The matching Clerk secret was copied directly from its dashboard to Vercel through the clipboard; its value was not printed or written into tracked files.
- Vercel redeployments were observed during the shared browser session, and the public sign-in form subsequently rendered. This review does not establish who triggered those redeployments or prove authenticated API functionality.
- Only `backspyne-app.vercel.app` is attached. The user chose that Vercel domain; this permits development-auth testing, not a production Clerk instance.
- After the user signed into Tiger Cloud, a free `backspyne` PostgreSQL service was created in AWS us-east-1 (shared compute, 1 GiB, $0/hour). Project: `p399fcbddk`; service: `oaxbvye5t1`. No paid upgrade was purchased.
- `DATABASE_URL` was copied directly into Vercel's Production secrets; its URI contains a password and `sslmode=require`. `BACKSPYNE_NODE_OWNER_ID` was saved from the real signed-in application's user. A 32-byte cryptographically random hex `BACKSPYNE_NODE_TOKEN` was generated and saved as a secret. No secret values were printed or recorded here. The local bridge still does not have the token; because the Vercel secret cannot be revealed, rotate/configure both ends securely when local execution is restored.
- The database SQL editor confirmed zero existing BackSpyne tables before initialization. A transaction matching `lib/db/backspyne-bootstrap.sql` created the three enums, seven tables, and owner/address unique index. A subsequent SQL query returned seven tables. This file is for new empty databases, not an upgrade migration.
- Redeployed existing application source through Vercel's dashboard without build cache: deployment `Fcp7wwEZyTXQWzodFk6GsfvhgGxA`, URL `https://backspyne-5flgvntjg-alonzo-locketts-projects.vercel.app`, public alias `https://backspyne-app.vercel.app`. Vercel reported Ready (52-second build).
- Final live checks: `/api/healthz` 200 with database configured; authenticated `/api/me` 200 with the correct user; `/api/devices`, `/api/nodes`, `/api/sessions`, `/api/sensing/summary` all 500. Runtime logs identify `SELF_SIGNED_CERT_IN_CHAIN` (self-signed certificate in certificate chain), not missing tables.
- Tiger documentation explicitly says free services do not supply publicly signed SSL certificates: https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/strict-ssl . Certificate verification was not disabled. Secure certificate retrieval/trust configuration or a compatible database with publicly trusted TLS is required before these routes work.
- Terminal execution fails before commands run: `ENOENT ... C:\Program Files\Git\bin\bash.exe`. Builds, tests, Git operations, and CLI deployment cannot run until the configured shell is restored or corrected in Freebuff.
- Existing legal copy contains business/contact/effective-date placeholders. Its presence does not establish legal compliance.
- No local source changes have been built, committed, or pushed in this review. Remote configuration changed as noted above; application typechecks and tests cannot be run through the broken terminal.

## User-selected approach

Retain the Clerk integration and use the newly created separate BackSpyne application. The user subsequently requested the existing Vercel domain; an owned domain is still required for production Clerk. Add monitoring subscriptions for authorized RF environments. Prices, currency, country, plan limits, and business policies still require owner decisions. No paid service purchase is authorized by this document.

## Required account and configuration inputs

Configure secrets directly in the appropriate service dashboards or secure local environment files. Never commit them or put server secrets in `VITE_*` variables.

| Configuration | Where / purpose |
| --- | --- |
| Owned domain and DNS access | Vercel custom domain plus Clerk production-instance DNS verification |
| `VITE_CLERK_PUBLISHABLE_KEY` | Vercel production build; matching production Clerk instance |
| `CLERK_PUBLISHABLE_KEY` | API runtime; same value as frontend publishable key |
| `CLERK_SECRET_KEY` | API runtime only; same Clerk instance |
| `FRONTEND_ORIGIN` | Actual HTTPS production origin; review proxy and allowed-origin handling |
| `DATABASE_URL` | API runtime; provisioned PostgreSQL with application schema applied |
| `BACKSPYNE_NODE_TOKEN` | Cryptographically random shared credential, at least 32 characters; server and authorized local bridge must match |
| `BACKSPYNE_NODE_OWNER_ID` | Real signed-in Clerk operator ID; current relay implementation binds to one configured owner |
| `BACKSPYNE_API_URL` | Local bridge: actual production HTTPS origin plus `/api` |
| `BACKSPYNE_OWNER_ID` | Local bridge: same real owner ID as server |
| `BACKSPYNE_MODE` | Local bridge: `live`, never simulated observations |

Only configure `VITE_CLERK_PROXY_URL` if an explicitly tested Clerk proxy configuration is needed. Do not assume the existing Replit-oriented proxy is suitable for the new production domain without verification.

Owner must also supply: legal business name, operating country, support and privacy contacts, refund/cancellation terms, telemetry retention duration, deletion procedure, and approved billing currency/prices. Authentication account IDs must come from the configured instance, not a guessed value.

## Exact current environment inventory and API

### Located and saved

`VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_PUBLISHABLE_KEY` use the same public Development-instance key. The public key is safe to share, but is omitted here because it is already saved in Vercel. `CLERK_SECRET_KEY` is its matching server-only credential. `FRONTEND_ORIGIN=https://backspyne-app.vercel.app`.

Clerk API keys: https://dashboard.clerk.com/apps/app_3KMDTadvAobv71sNwl0iXkfoQb3/instances/ins_3KMDTcuiJBMiJwUbVJbrVo4tRaM/api-keys

Clerk Frontend API: `https://engaged-vulture-694.clerk.accounts.dev`. Backend API: `https://api.clerk.com`. The application SDKs handle these; do not replace the scanner API URL with a Clerk URL.

### Still required

- `DATABASE_URL` is now saved and the schema initialized. The remaining database blocker is trusted TLS certificate configuration, followed by real API persistence verification.
- `BACKSPYNE_NODE_OWNER_ID` is saved in Vercel. Match it in the scanner's `BACKSPYNE_OWNER_ID`; signing into the Clerk management dashboard alone does not create an application user.
- `BACKSPYNE_NODE_TOKEN` is saved in Vercel but not configured locally. Securely rotate/provision the same token on both ends before running the bridge. Do not use an invented example token or Clerk secret as the node token.

### Local scanner configuration

```dotenv
BACKSPYNE_API_URL=https://backspyne-app.vercel.app/api
BACKSPYNE_MODE=live
BACKSPYNE_INTERVAL_SECONDS=8
BACKSPYNE_NODE_ID=local-relay-01
BACKSPYNE_NODE_NAME=Local relay
# REQUIRED: fill with the real application user ID and matching generated node secret
BACKSPYNE_OWNER_ID=
BACKSPYNE_NODE_TOKEN=
```

These empty required values intentionally fail scanner validation until configured. Optional variables: `BACKSPYNE_CSI_SERIAL_PORT` (separate compatible hardware required), `BACKSPYNE_CSI_BAUDRATE` (default `115200`). Node ID defaults to the machine hostname if omitted; name defaults to the node ID. Interval must be 2–3600 seconds. `BACKSPYNE_CSI_UDP_PORT` is not read by the current configuration.

Optional server variables: `LOG_LEVEL` (default `info`), `PORT` (default `8080`) and `HOST` (default `0.0.0.0`) for the standalone local listener. `BACKSPYNE_OWNER_USER_IDS` is a comma-separated allowlist of Clerk user ids that receive owner access — unlimited relays, full history, report export, and the experimental CSI research panels — ahead of any stored subscription. It is configuration and not a purchase: no Stripe record is involved, removing an id returns the account to the free plan, and it lifts the plan gate only (research hardware, engines and calibration are unaffected). Vercel manages runtime `NODE_ENV`; Vite supplies `BASE_URL` and `DEV`. Do not add those build/runtime-provided flags as authentication credentials. `VITE_CLERK_PROXY_URL` is optional and currently unset; keep it unset unless the proxy is explicitly tested.

### BackSpyne API contract

Base URL: `https://backspyne-app.vercel.app/api`.

- `GET /healthz`: public liveness/configuration check; does not prove database connectivity.
- `GET /me`: signed-in application user identity; current API configuration guard also requires the database.
- `GET /devices`; `PATCH /devices/:id`; `GET /devices/:id/trail`.
- `GET /nodes`; `POST /nodes`; `PATCH /nodes/:id`; `DELETE /nodes/:id`. A relay carries an optional placement: `positionX`, `positionY` (metres east and north of the site origin, ±10000) and `positionLabel`, set through `PATCH /nodes/:id` and cleared by sending both coordinates as `null`. The three columns are added on first use by the API (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), and `lib/db/backspyne-bootstrap.sql` carries the same statements for a hand-run upgrade.
- `GET /location/:deviceId`: where a stored radio has been heard from in the last 30 minutes. Returns one entry per relay that heard it (level, implied distance, placed or not), the fitted position with its status — `estimated`, `ambiguous`, `single_relay`, `no_signal` — its uncertainty radius, its residual per relay, and a one-point-per-minute track. Positions come from the log-distance path-loss model in `artifacts/api-server/src/lib/localization.ts` and only from relays the operator has placed; fewer than three placed relays that hear the same radio produce a ring or two candidates rather than a point, because that is all the geometry supports.
- `GET /sessions`; `POST /sessions`; `PATCH /sessions/:id`; `POST /sessions/:id/close`.
- `GET /sensing/summary`; `GET /evidence`; `POST /evidence`; `GET /stream` (SSE).
- `GET /report/assessment`: the printable client report, built from stored relay observations and the operator's own plan. Authorized either by the operator's session or by a `?share=<token>` link; the link is signed, scoped to the account that issued it, and expires after seven days. `POST /report/assessment/share` (session required) creates that link. Sharing reports `503` only when neither `BACKSPYNE_REPORT_SHARE_SECRET` nor `BACKSPYNE_NODE_TOKEN` is configured.
- `POST /ingest/telemetry`: local bridge ingestion. Requires `X-Backspyne-Node-Token` and `X-Backspyne-Signature`, an HMAC-SHA256 hex digest over the exact JSON body bytes using the shared node token, plus validated owner/timestamp/payload. Use the existing bridge rather than hand-crafted unsigned requests. An observation may carry `signalDbm` (measured power) or `signalQualityPercent` (the 0-100 link-quality scale Windows WiFi and NetworkManager report). A percentage is converted to dBm at this one writer, and the sighting records which of the two it was, so a Windows-only relay can locate WiFi access points instead of dropping them for want of a level.
- `GET /calibration`, `POST /calibration`: the calibration walk. `GET` reports the fitted site constants in force, the requirements a walk must meet, and what each radio contributed; `POST` solves a walked set of known positions for the site's path-loss constants and keeps the result, after which position estimates use it in place of the deployed defaults. A fit that does not beat the defaults, or a walk that never moved or never varied its levels, is refused rather than stored.
- `GET /billing/catalog`, `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/webhook`: the revenue surface. The webhook is public by necessity and is authenticated by Stripe's signature over the raw body.
- `GET /public/plans`: the pricing page. Public by design; needs no database and no session.
- `POST /admin/login`, `POST /admin/logout`, `GET /admin/session`, `GET /admin/revenue`: the deployment owner's own account, configured by environment rather than by a database row. Sign-in, sign-out, and session read import no database module, so an administrator can open the console on a deployment whose database is not provisioned yet; only `/admin/revenue` needs rows.

Operator routes require Clerk authentication. Setting environment variables does not replace database schema setup or grant access to another user's data.

### Billing variables — required to start charging

The subscription surface is implemented server-side (`artifacts/api-server/src/lib/billing/`, `routes/billing.ts`) and it is off until these are set. No client-side Stripe key is needed: Checkout and the billing portal are hosted sessions the server creates.

- `STRIPE_SECRET_KEY` — server key. Absent, `GET /api/billing/catalog` still lists the plans but reports checkout as unconfigured, and `POST /api/billing/checkout` answers `503 { code: "billing_not_configured" }` instead of failing halfway.
- `STRIPE_WEBHOOK_SECRET` — verifies `POST /api/billing/webhook`. Without it no subscription row is ever written, so the admin revenue view reports zero rather than guessing.
- `STRIPE_PORTAL_CONFIGURATION_ID` — BackSpyne-specific Customer Portal configuration created by the setup script; avoids depending on a missing or unrelated account default.
- `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_CONSULTANT` — server-side Price IDs for the three sellable plans. A plan without a price id is listed but cannot be bought, and the API never accepts a price from the request body.
- `FRONTEND_ORIGIN` — the origin Checkout returns to.

Prices come from one list (`lib/billing/plans.ts`): Free, Solo $39, Team $149, Consultant $399 monthly. The public pricing page reads that same list, so a displayed price cannot drift from the charged one.

### Creating the Stripe objects

The three prices and the webhook endpoint are created by a script rather than by hand, because a hand-made price is where the displayed amount and the charged amount come apart:

```
node scripts/setup-stripe-billing.mjs                              # dry run: report what is missing
node scripts/setup-stripe-billing.mjs --apply --write-local-env     # create, and record the ids
node scripts/setup-stripe-billing.mjs --apply --rotate-webhook      # mint a fresh signing secret
```

It reads `STRIPE_SECRET_KEY` from the environment or from a gitignored `.env.stripe.local`, sets `backspyne_plan` metadata on every product it creates, and reuses an existing active monthly price at the same amount instead of creating a second one — a Stripe price cannot be edited, only archived, so a duplicate is a mess to undo. `--write-local-env` records the price ids and the webhook signing secret in that file rather than printing them: Stripe shows a signing secret exactly once, and a secret that only ever existed in a terminal is a secret that has to be rotated next week.

`scripts/setup-stripe-billing.mjs` is idempotent and re-runnable. Two encoding rules inside it are load-bearing and are covered by `scripts/test/stripe-billing.test.mjs`: arrays need an index per element (`enabled_events[0]=…`), and `expand` must not go through that path, because Stripe ignores a malformed expand silently and the reuse check then goes blind.

### Proving the webhook actually verifies

A wrong signing secret has no symptom: Stripe's events are rejected with 400, no subscription is ever recorded, and the product looks fine while billing nobody. `scripts/probe-stripe-webhook.mjs` settles it with one signed request and one deliberately corrupted one:

```
node scripts/probe-stripe-webhook.mjs
```

It sends a no-op event — a subscription update carrying no operator id, which the handler classifies as unattributed and answers without writing anything — so a `200` proves the secret verifies without creating, changing, or billing anything, and a `400` proves it does not. It also asserts that a corrupted signature is refused, since an endpoint that answers `200` to that one is verifying nothing at all.

### Revenue enforcement, where it actually binds

Entitlements are enforced in the API rather than in the redirect: relay registration counts against `maxRelays` at ingest, history is windowed by `historyDays` on read, and CSV report export and the CSI research panels are gated on `reportExport` and `csiResearch`. A subscription counts only while its status is `active` or `trialing`; anything else falls back to the free plan (`effectivePlanId`), so a lapsed card loses paid limits on the next request rather than at the next invoice.

## Revenue system

Subscription-based authorized monitoring is the model, and it is now built end to end: a public pricing page, authenticated hosted Checkout, a self-service billing portal, a signature-verified webhook that writes subscription state, plan-aware enforcement, and an owner revenue view at `/admin` that counts only what the verified webhook wrote.

Stripe is the configured provider. Start in test mode; activate live charging only after owner approval and business verification, and validate supported business country, fees, tax responsibilities, and acceptable-use policy first.

- https://docs.stripe.com/billing/quickstart
- https://docs.stripe.com/customer-management

What has been proven against the live account: the three products and prices exist and match the catalog; `POST /api/billing/checkout` creates a real `cs_live_…` subscription session for the right amount with the right plan metadata; the endpoint at `/api/billing/webhook` verifies its signing secret and refuses a corrupted signature; and a plan cannot be selected that the client names but the server has not priced.

Still to prove before relying on it:

- A completed purchase end to end: a real payment, the resulting webhook delivery, the entitlement lift it grants, and the admin revenue view counting it. Nothing has been bought yet.
- Portal self-service against a real billing customer (it correctly refuses an account with no billing profile).
- A deliberate duplicate and out-of-order delivery of a retried webhook event against the real endpoint.
- Refund, dunning, and tax behaviour for the jurisdictions you intend to sell into.
- Commercial-use permission on the hosting plan; do not upgrade a paid plan without approval.
- Do not collect card details in the application and never infer a completed purchase from a redirect.

## Production acceptance checks

A successful build or a deployment marked Ready does not satisfy these checks alone.

1. Restore terminal execution, inspect branch/status, and preserve unrelated edits. Confirm available disk space for package/tool caches.
2. Run the current project's typecheck and clean Vercel build after final changes. Inspect generated `dist/api/handler.mjs`, its declaration, and `dist/web` shell/assets.
3. Configure owned-domain HTTPS/DNS, production Clerk keys, redirect URLs, and allowed origins; rebuild because the frontend key is embedded at build time.
4. Sign up/sign in through the real public interface, reach the operator portal, sign out, and verify refresh/deep-link behavior without browser errors.
5. Verify anonymous API requests are denied; two distinct accounts cannot read or mutate each other's nodes, observations, sessions, exports, or billing.
6. Provision PostgreSQL, review/apply schema changes without destructive force, and prove connectivity and persistence. Configuration presence alone is not a database health check.
7. Run an authorized real WiFi/BLE bridge, verify signed ingestion, confirm records in PostgreSQL, and verify the same measured records appear in the signed-in dashboard after reload.
8. Verify tampered signatures, invalid tokens, wrong owners, old timestamps, duplicate/replayed submissions, oversized bodies, and excessive ingestion are rejected or handled safely. Timestamp windows alone do not prevent replay.
9. Audit the current service worker's navigation/offline caching and clear obsolete caches; do not cache account-scoped API responses or show an obsolete configuration shell after redeployment.
10. Test unavailable database/auth/relay states, bounded queries, exports, node freshness, and honest empty states. Address serverless SSE limitations; verify polling fallback.
11. Test billing in provider test mode, including bad signatures, duplicated webhooks, cancellation, failed payment, cross-account portal access, and bypass attempts.
12. Implement and test retention/deletion; publish accurate processor disclosures, terms, acceptable-use restrictions, and owner contacts. Have qualified counsel review applicable requirements; no liability guarantee.
13. Review actual production dependency advisories, security headers, request rate limits, origin handling, credential rotation, logs, and recovery procedures. Prior GitHub push reported critical/high advisories; their applicability and remediation remain unverified.
14. Review staged and unstaged diffs plus recent commit style; commit only owned task changes with required Codebuff attribution, push the authorized branch, deploy, and repeat browser/API checks on the final public origin.

## Completion evidence to capture

Record final commit, deployed domain, build/typecheck/test results, authenticated browser checks, real signed ingestion/persistence result, billing test outcomes, account-isolation tests, dependency/security findings, and every remaining limitation. Never record credential values. Do not call the product production-ready while essential gates are blocked.
