# BackSpyne production launch gate

Status: BLOCKED — server-side authentication is verified for the existing signed-in session; database-backed API access, ingestion, and billing are not working. This document is a launch checklist, not a declaration of production readiness.

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

Optional server variables: `LOG_LEVEL` (default `info`), `PORT` (default `8080`) and `HOST` (default `0.0.0.0`) for the standalone local listener. Vercel manages runtime `NODE_ENV`; Vite supplies `BASE_URL` and `DEV`. Do not add those build/runtime-provided flags as authentication credentials. `VITE_CLERK_PROXY_URL` is optional and currently unset; keep it unset unless the proxy is explicitly tested.

### BackSpyne API contract

Base URL: `https://backspyne-app.vercel.app/api`.

- `GET /healthz`: public liveness/configuration check; does not prove database connectivity.
- `GET /me`: signed-in application user identity; current API configuration guard also requires the database.
- `GET /devices`; `PATCH /devices/:id`; `GET /devices/:id/trail`.
- `GET /nodes`; `POST /nodes`; `PATCH /nodes/:id`; `DELETE /nodes/:id`.
- `GET /sessions`; `POST /sessions`; `PATCH /sessions/:id`; `POST /sessions/:id/close`.
- `GET /sensing/summary`; `GET /evidence`; `POST /evidence`; `GET /stream` (SSE).
- `GET /report/assessment`: the printable client report, built from stored relay observations and the operator's own plan. Authorized either by the operator's session or by a `?share=<token>` link; the link is signed, scoped to the account that issued it, and expires after seven days. `POST /report/assessment/share` (session required) creates that link. Sharing reports `503` only when neither `BACKSPYNE_REPORT_SHARE_SECRET` nor `BACKSPYNE_NODE_TOKEN` is configured.
- `POST /ingest/telemetry`: local bridge ingestion. Requires `X-Backspyne-Node-Token` and `X-Backspyne-Signature`, an HMAC-SHA256 hex digest over the exact JSON body bytes using the shared node token, plus validated owner/timestamp/payload. Use the existing bridge rather than hand-crafted unsigned requests.

Operator routes require Clerk authentication. Setting environment variables does not replace database schema setup or grant access to another user's data.

### Future billing variables — NOT currently consumed by the code

If Stripe is selected and implemented, expected server configuration would include `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and approved server-side Price IDs (for example `STRIPE_PRICE_PRO_MONTHLY`). These names are proposed interface choices, not existing requirements or usable credentials. Hosted checkout need not require a frontend Stripe key. There is no working billing integration yet; adding these variables alone will not enable charging.

## Proposed revenue system (not implemented)

Subscription-based authorized monitoring is the selected model. A possible split is basic live monitoring versus paid history, exports, and more approved nodes; exact limits and prices are undecided.

Gravity Index was queried for subscription providers but returned no matching catalog entry. Official Stripe documentation supports hosted subscription Checkout and a customer billing portal:

- https://docs.stripe.com/billing/quickstart
- https://docs.stripe.com/customer-management

Stripe is a proposed provider, not a configured account. Validate supported business country, fees, tax responsibilities, and acceptable-use policy before selecting it. Start in test mode. Activate live charging only after owner approval and business verification.

Required implementation gates:

- Authenticated server-created checkout with a server-controlled price allowlist; never accept arbitrary client prices or owner IDs.
- Server-owned mapping of Clerk user to billing customer and subscription.
- Signed raw-body webhook verification with timestamp tolerance, persistent event idempotency, and safe handling of retries and out-of-order events.
- Durable entitlement state; enforce limits in API/ingestion, not only UI or checkout redirect parameters.
- Self-service billing portal authorized against the signed-in customer's mapping.
- Tested renewals, cancellation, failed payments, and entitlement removal according to published terms.
- Do not collect card details in the application, imply payment success from a redirect, or promise revenue.
- Replace the single globally configured relay owner/token model with per-owner, per-node credentials before supporting multiple paying operators.
- Confirm the hosting plan permits commercial use; do not upgrade a paid plan without approval.

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
