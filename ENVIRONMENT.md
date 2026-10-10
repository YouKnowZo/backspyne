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
