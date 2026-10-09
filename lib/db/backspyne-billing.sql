-- Billing tables for BackSpyne. Additive and safe to re-run on an existing database:
-- it only creates the two tables the billing routes need if they are missing.
--
-- The API also creates these tables lazily on first use, so running this file is
-- optional. It exists for operators who prefer to apply schema changes explicitly.
--
-- Run the whole file against the same database as DATABASE_URL.

BEGIN;
CREATE TABLE IF NOT EXISTS backspyne_subscriptions (
  owner_id text PRIMARY KEY,
  plan_id text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'inactive',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS backspyne_billing_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  owner_id text,
  received_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
