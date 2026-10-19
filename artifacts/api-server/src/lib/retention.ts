// Observation retention windows and site data purge policy: pure model and validation.
//
// An operator collecting WiFi and BLE measurements at a client site needs two controls over
// how long those observations stay in the account:
//   1. An operator-configurable retention window (1, 3, 7, 14, 30, 90, or 365 days), bounded
//      above by the plan's historyDays entitlement so a configured window can narrow storage
//      for privacy/compliance without ever widening what the plan allows.
//   2. A one-click site data purge (either all stored observations for the workspace, or
//      everything older than the effective retention cutoff), while preserving paired relay
//      credentials and billing records.
//
// Everything here is pure so the rules can be unit-tested without a database.

export const ALLOWED_RETENTION_DAYS = [1, 3, 7, 14, 30, 90, 365] as const;

export type RetentionDaysOption = (typeof ALLOWED_RETENTION_DAYS)[number];

export type PurgeScope = "expired" | "site";

export interface RetentionWindowOption {
  days: RetentionDaysOption;
  label: string;
  allowedByPlan: boolean;
}

export interface EffectiveRetentionPolicy {
  /** Operator-selected retention window, or null when following the plan's ceiling. */
  configuredDays: number | null;
  /** Maximum retention days allowed by the operator's current plan. */
  planMaxDays: number;
  /** True when the account has unlimited/owner history. */
  planUnlimited: boolean;
  /** The retention window actually enforced by the server, in days. */
  effectiveDays: number;
  /** Whether observations older than effectiveDays are automatically pruned on ingest/read. */
  autoPrune: boolean;
  /** Cutoff timestamp before which observations are considered expired. */
  cutoffDate: Date;
  /** Available retention options with plan-entitlement eligibility. */
  options: RetentionWindowOption[];
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isAllowedRetentionDays(value: unknown): value is RetentionDaysOption {
  return typeof value === "number" && Number.isInteger(value) && (ALLOWED_RETENTION_DAYS as readonly number[]).includes(value);
}

/**
 * Parses an operator-requested retention window.
 * Accepts `null` (use plan default) or one of ALLOWED_RETENTION_DAYS.
 * Returns `undefined` when the input is malformed.
 */
export function parseRequestedRetentionDays(value: unknown): RetentionDaysOption | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && value.trim().toLowerCase() === "plan") return null;
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (isAllowedRetentionDays(numeric)) return numeric;
  return undefined;
}

export function formatRetentionLabel(days: number): string {
  if (days === 1) return "24 hours (1 day)";
  if (days === 365) return "1 year (365 days)";
  return `${days} days`;
}

/**
 * Resolves the effective retention policy for an operator given their stored preference and
 * their current plan's history entitlement.
 *
 * A configured window is always clamped to `planMaxDays`: if an operator configures 90 days on
 * a Team plan and later downgrades to Free (7 days), the server enforces 7 days without
 * losing the stored preference.
 */
export function resolveRetentionPolicy(input: {
  configuredDays: number | null | undefined;
  autoPrune?: boolean | null;
  planHistoryDays: number;
  planUnlimited?: boolean;
  now?: number;
}): EffectiveRetentionPolicy {
  const now = input.now ?? Date.now();
  const planUnlimited = Boolean(input.planUnlimited);
  const planMaxDays = Math.max(1, Math.round(input.planHistoryDays || 7));
  const validConfigured = isAllowedRetentionDays(input.configuredDays) ? input.configuredDays : null;
  const effectiveDays = validConfigured !== null
    ? (planUnlimited ? validConfigured : Math.min(validConfigured, planMaxDays))
    : planMaxDays;
  const autoPrune = input.autoPrune !== false;
  const cutoffDate = new Date(now - effectiveDays * DAY_MS);

  const options: RetentionWindowOption[] = ALLOWED_RETENTION_DAYS.map((days) => ({
    days,
    label: formatRetentionLabel(days),
    allowedByPlan: planUnlimited || days <= planMaxDays,
  }));

  return {
    configuredDays: validConfigured,
    planMaxDays,
    planUnlimited,
    effectiveDays,
    autoPrune,
    cutoffDate,
    options,
  };
}

/**
 * Validates a purge request body.
 *   - `scope: "expired"` purges observations older than the effective retention cutoff.
 *   - `scope: "site"` purges all observations (devices, sightings, telemetry, snapshots,
 *     evidence, calibrations, site origin) for the workspace, optionally resetting nodes.
 */
export function parsePurgeRequest(body: unknown): {
  scope: PurgeScope;
  resetRelays: boolean;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const scope = record.scope === "expired" || record.scope === "site" ? record.scope : null;
  if (!scope) return null;
  if (scope === "site" && record.confirm !== "PURGE") return null;
  return {
    scope,
    resetRelays: Boolean(record.resetRelays),
  };
}
