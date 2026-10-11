# BackSpyne deployment environment
#
# Copy the variables you need into your host's secret store (for Vercel:
# `vercel env add <NAME> production`, or Project Settings -> Environment Variables).
# Never commit a real value. This file is a checklist of names and their purpose.
#
# The deployed site runs from the repository root: the Express API serves both /api and
# the built single-page app. Optional variables can be left unset; anything required
# for a feature means that feature reports itself as unavailable rather than pretending
# to work.

## ---------------------------------------------------------------------------
## Required for any authenticated operator data
## ---------------------------------------------------------------------------

# Postgres connection string for the BackSpyne schema (scan sessions, nodes, RF devices,
# sightings, telemetry, evidence, sensing snapshots, subscriptions).
DATABASE_URL=

# Optional but recommended for managed Postgres that presents a private CA.
# PEM contents of the CA certificate; when set, the connection is verified strictly
# against it instead of the ambient trust store.
DATABASE_CA_CERT=

# Clerk application keys. With the development keys the site works but shows a
# development-instance warning and has strict usage limits; a production launch needs
# a production Clerk instance.
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
# Same publishable key, exposed to the Vite build for the browser.
VITE_CLERK_PUBLISHABLE_KEY=

# Exact browser origin of the deployment. Used for CORS, Clerk's proxy host, and
# billing redirect URLs (Checkout success/cancel, Billing Portal return). Must be an
# https origin in production; http is only accepted for loopback development.
FRONTEND_ORIGIN=

## ---------------------------------------------------------------------------
## Required for the authorized local relay (scanner/backspyne_bridge)
## ---------------------------------------------------------------------------

# Shared secret the relay signs telemetry with. Use at least 32 random characters and
# set the identical value in the relay's scanner/.env as BACKSPYNE_NODE_TOKEN.
BACKSPYNE_NODE_TOKEN=

# Clerk user id that owns the relay. Ingest is rejected unless it matches the owner id
# in the telemetry body, so only this operator's account receives the data.
BACKSPYNE_NODE_OWNER_ID=

## ---------------------------------------------------------------------------
## Optional: client assessment links
## ---------------------------------------------------------------------------

# Signs the link an operator hands to a client who has no BackSpyne account. The account,
# the printed labels, and a seven-day expiry all travel inside the signature, so a
# recipient can only open the account that issued the link, and cannot extend it by
# editing the URL. When unset, BACKSPYNE_NODE_TOKEN signs these links instead (with
# domain separation), so sharing works without a second secret; set this one to rotate
# the two independently.
BACKSPYNE_REPORT_SHARE_SECRET=

## ---------------------------------------------------------------------------
## Optional: the deployment's own administrator (an account that does not need Clerk)
## ---------------------------------------------------------------------------

# The administrator is one identity, created from configuration rather than from a database
# row, and it signs in at /admin with a password. It exists because the owner of a deployment
# has to be able to open it — to read revenue and confirm relays are reporting — even where no
# Clerk instance is configured or reachable, and because there is no way to create a Clerk
# account from this repository.
#
# Generate the values with:  node scripts/issue-admin.mjs --email you@example.com
# which prints the three lines below and the password exactly once. Without all of them set,
# /admin says admin access is not configured instead of offering a form that cannot succeed.

# The administrator's email address. Entered at sign-in and compared case-insensitively.
BACKSPYNE_ADMIN_EMAIL=

# scrypt verifier (`scrypt$salt$hash`), from the script above. Never a plaintext password
# unless you choose the convenience variable below.
BACKSPYNE_ADMIN_PASSWORD_HASH=

# Convenience for a local checkout only: a plaintext password of at least 8 characters, hashed
# by the server. Prefer the hash above anywhere the value could be read by anyone else.
BACKSPYNE_ADMIN_PASSWORD=

# Signs the administrator's session cookie (12 hours). Generate one; it is issued by the script
# on line 3 and is not something to reuse elsewhere. When unset the server falls back to a
# domain-separated derivation of BACKSPYNE_NODE_TOKEN, then of the report-share secret.
BACKSPYNE_ADMIN_SESSION_SECRET=

# The owner id the administrator acts as. Their relays, devices, reports, and calibrations are
# scoped to it, and it counts as owner access for plan limits. Defaults to `admin`, which
# cannot collide with a Clerk user id. Point it at a real Clerk id only to hand that account's
# data to the administrator as well.
BACKSPYNE_ADMIN_OWNER_ID=

## ---------------------------------------------------------------------------
## Optional: owner access (unlimited plan limits for named accounts)
## ---------------------------------------------------------------------------

# Comma-separated Clerk user ids that receive owner access: unlimited authorized relays,
# full observation history, client report export, and the experimental CSI research
# panels. It is configuration rather than a subscription — no purchase, no payment
# record — and removing an id returns that account to the free plan on the next request.
# Owner access lifts the *plan* gate only. It cannot supply CSI hardware, a sensing
# engine, or a room calibration, so research panels still report those gates as closed.
# Find an id with GET /api/me while signed in, or from a report share link's owner.
BACKSPYNE_OWNER_USER_IDS=

## ---------------------------------------------------------------------------
## Required for billing / revenue features (optional until you sell plans)
## ---------------------------------------------------------------------------

# Stripe secret key (sk_live_... or sk_test_...). Without the full billing set below,
# the portal shows pricing as unconfigured and checkout returns
# 503 { code: "billing_not_configured" } instead of failing halfway.
STRIPE_SECRET_KEY=

# Signing secret of the Stripe webhook endpoint that points at:
#   POST https://<your-origin>/api/billing/webhook
# Events to subscribe to: checkout.session.completed,
# customer.subscription.created, customer.subscription.updated,
# customer.subscription.deleted
STRIPE_WEBHOOK_SECRET=

# One recurring monthly price id per paid plan. A plan with no price id is listed but
# not purchasable. Prices must match the catalog in
# artifacts/api-server/src/lib/billing/plans.ts (Solo 39, Team 149, Consultant 399 USD).
STRIPE_PRICE_SOLO=
STRIPE_PRICE_TEAM=
STRIPE_PRICE_CONSULTANT=

## ---------------------------------------------------------------------------
## Optional runtime tuning
## ---------------------------------------------------------------------------

# API listen port and bind address (defaults: 8080 and 0.0.0.0).
PORT=
HOST=

# pino log level (default: info).
LOG_LEVEL=

# Local relay only: telemetry target. Defaults to the public deployment.
# VITE_API_URL is read by the built web client when the API is not same-origin.
VITE_API_URL=
