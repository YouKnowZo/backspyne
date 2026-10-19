// Database-backed observation retention preferences, expired-observation pruning, and
// one-click site data purge.
//
// Like `calibrationStore.ts` and `siteOriginStore.ts`, the preference table is created
// lazily and idempotently on first use so deployments do not depend on a manual migration
// before serving traffic.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { ownerEntitlements } from "./billing/subscriptions";
import {
  resolveRetentionPolicy,
  type EffectiveRetentionPolicy,
  type PurgeScope,
  type RetentionDaysOption,
} from "./retention";

const CREATE_RETENTION_POLICIES = sql`
  CREATE TABLE IF NOT EXISTS backspyne_retention_policies (
    owner_id text PRIMARY KEY,
    retention_days integer,
    auto_prune boolean NOT NULL DEFAULT true,
    last_purged_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

const CREATE_SIGHTINGS_RETENTION_INDEX = sql`
  CREATE INDEX IF NOT EXISTS backspyne_rf_sightings_owner_observed_idx
    ON backspyne_rf_sightings (owner_id, observed_at DESC)
`;

const CREATE_DEVICES_RETENTION_INDEX = sql`
  CREATE INDEX IF NOT EXISTS backspyne_rf_devices_owner_last_seen_idx
    ON backspyne_rf_devices (owner_id, last_seen_at DESC)
`;

let schemaReady: Promise<boolean> | null = null;

async function createRetentionTable(): Promise<boolean> {
  try {
    await db.execute(CREATE_RETENTION_POLICIES);
    await db.execute(CREATE_SIGHTINGS_RETENTION_INDEX);
    await db.execute(CREATE_DEVICES_RETENTION_INDEX);
    return true;
  } catch (error) {
    logger.error({ err: error }, "Unable to create retention policy schema; falling back to plan defaults");
    return false;
  }
}

export function ensureRetentionSchema(): Promise<boolean> {
  if (!schemaReady) schemaReady = createRetentionTable();
  return schemaReady;
}

export interface StoredRetentionPreference {
  retentionDays: number | null;
  autoPrune: boolean;
  lastPurgedAt: string | null;
  updatedAt: string | null;
}

type RetentionRow = {
  retention_days: number | null;
  auto_prune: boolean;
  last_purged_at: Date | string | null;
  updated_at: Date | string | null;
};

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function readRetentionPreference(ownerId: string): Promise<StoredRetentionPreference> {
  if (!(await ensureRetentionSchema())) {
    return { retentionDays: null, autoPrune: true, lastPurgedAt: null, updatedAt: null };
  }
  try {
    const result = await pool.query<RetentionRow>(
      "SELECT retention_days, auto_prune, last_purged_at, updated_at FROM backspyne_retention_policies WHERE owner_id = $1 LIMIT 1",
      [ownerId],
    );
    const row = result.rows[0];
    if (!row) return { retentionDays: null, autoPrune: true, lastPurgedAt: null, updatedAt: null };
    return {
      retentionDays: typeof row.retention_days === "number" ? row.retention_days : null,
      autoPrune: row.auto_prune !== false,
      lastPurgedAt: isoOrNull(row.last_purged_at),
      updatedAt: isoOrNull(row.updated_at),
    };
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to read retention preference");
    return { retentionDays: null, autoPrune: true, lastPurgedAt: null, updatedAt: null };
  }
}

export async function saveRetentionPreference(
  ownerId: string,
  input: { retentionDays: RetentionDaysOption | null; autoPrune?: boolean },
): Promise<StoredRetentionPreference | null> {
  if (!(await ensureRetentionSchema())) return null;
  try {
    const autoPrune = input.autoPrune !== false;
    const result = await pool.query<RetentionRow>(
      `INSERT INTO backspyne_retention_policies (owner_id, retention_days, auto_prune, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (owner_id) DO UPDATE
         SET retention_days = EXCLUDED.retention_days,
             auto_prune = EXCLUDED.auto_prune,
             updated_at = now()
       RETURNING retention_days, auto_prune, last_purged_at, updated_at`,
      [ownerId, input.retentionDays, autoPrune],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      retentionDays: typeof row.retention_days === "number" ? row.retention_days : null,
      autoPrune: row.auto_prune !== false,
      lastPurgedAt: isoOrNull(row.last_purged_at),
      updatedAt: isoOrNull(row.updated_at),
    };
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to save retention preference");
    return null;
  }
}

export async function resolveOwnerRetention(ownerId: string, now = Date.now()): Promise<{
  policy: EffectiveRetentionPolicy;
  preference: StoredRetentionPreference;
  planId: string;
}> {
  const [preference, entitlementState] = await Promise.all([
    readRetentionPreference(ownerId),
    ownerEntitlements(ownerId),
  ]);
  const policy = resolveRetentionPolicy({
    configuredDays: preference.retentionDays,
    autoPrune: preference.autoPrune,
    planHistoryDays: entitlementState.entitlements.historyDays,
    planUnlimited: entitlementState.entitlements.unlimited,
    now,
  });
  return {
    policy,
    preference,
    planId: entitlementState.planId,
  };
}

export interface RetentionFootprint {
  devicesTotal: number;
  devicesExpired: number;
  sightingsTotal: number;
  sightingsExpired: number;
  telemetryEventsTotal: number;
  sensingSnapshotsTotal: number;
  oldestObservationAt: string | null;
}

export async function readRetentionFootprint(ownerId: string, cutoffDate: Date): Promise<RetentionFootprint> {
  try {
    const [devicesRes, sightingsRes, telemetryRes, snapshotsRes] = await Promise.all([
      pool.query<{ total: string; expired: string; oldest: Date | null }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE last_seen_at < $2)::text AS expired,
           MIN(first_seen_at) AS oldest
         FROM backspyne_rf_devices
         WHERE owner_id = $1`,
        [ownerId, cutoffDate],
      ),
      pool.query<{ total: string; expired: string }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE observed_at < $2)::text AS expired
         FROM backspyne_rf_sightings
         WHERE owner_id = $1`,
        [ownerId, cutoffDate],
      ),
      pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM backspyne_telemetry_events WHERE owner_id = $1",
        [ownerId],
      ),
      pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM backspyne_sensing_snapshots WHERE owner_id = $1",
        [ownerId],
      ),
    ]);

    const dev = devicesRes.rows[0];
    const sig = sightingsRes.rows[0];
    const tel = telemetryRes.rows[0];
    const snap = snapshotsRes.rows[0];

    return {
      devicesTotal: Number.parseInt(dev?.total ?? "0", 10) || 0,
      devicesExpired: Number.parseInt(dev?.expired ?? "0", 10) || 0,
      sightingsTotal: Number.parseInt(sig?.total ?? "0", 10) || 0,
      sightingsExpired: Number.parseInt(sig?.expired ?? "0", 10) || 0,
      telemetryEventsTotal: Number.parseInt(tel?.total ?? "0", 10) || 0,
      sensingSnapshotsTotal: Number.parseInt(snap?.total ?? "0", 10) || 0,
      oldestObservationAt: isoOrNull(dev?.oldest),
    };
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to read retention footprint");
    return {
      devicesTotal: 0,
      devicesExpired: 0,
      sightingsTotal: 0,
      sightingsExpired: 0,
      telemetryEventsTotal: 0,
      sensingSnapshotsTotal: 0,
      oldestObservationAt: null,
    };
  }
}

export interface PurgeSummary {
  scope: PurgeScope;
  purgedAt: string;
  cutoffDate: string | null;
  deleted: {
    devices: number;
    sightings: number;
    telemetryEvents: number;
    sensingSnapshots: number;
    evidenceRecords: number;
    calibrationsRetired: number;
    relaysRemoved: number;
  };
}

/**
 * Executes either an expired-window prune (`scope: "expired"`) or a full one-click site data
 * purge (`scope: "site"`). Paired relay tokens (`backspyne_relay_tokens`) and billing state
 * (`backspyne_subscriptions`) are never deleted so the operator's scanners and plan stay intact.
 */
export async function executeDataPurge(
  ownerId: string,
  options: { scope: PurgeScope; cutoffDate: Date; resetRelays?: boolean },
): Promise<PurgeSummary> {
  await ensureRetentionSchema();
  const nowIso = new Date().toISOString();

  if (options.scope === "expired") {
    const cutoff = options.cutoffDate;
    const [sightingsDel, devicesDel, telemetryDel, snapshotsDel, evidenceDel] = await Promise.all([
      pool.query("DELETE FROM backspyne_rf_sightings WHERE owner_id = $1 AND observed_at < $2", [ownerId, cutoff]),
      pool.query("DELETE FROM backspyne_rf_devices WHERE owner_id = $1 AND last_seen_at < $2", [ownerId, cutoff]),
      pool.query("DELETE FROM backspyne_telemetry_events WHERE owner_id = $1 AND observed_at < $2", [ownerId, cutoff]),
      pool.query("DELETE FROM backspyne_sensing_snapshots WHERE owner_id = $1 AND observed_at < $2", [ownerId, cutoff]),
      pool.query("DELETE FROM backspyne_evidence_records WHERE owner_id = $1 AND created_at < $2", [ownerId, cutoff]),
    ]);

    await pool.query(
      `INSERT INTO backspyne_retention_policies (owner_id, last_purged_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (owner_id) DO UPDATE SET last_purged_at = now()`,
      [ownerId],
    ).catch(() => undefined);

    return {
      scope: "expired",
      purgedAt: nowIso,
      cutoffDate: cutoff.toISOString(),
      deleted: {
        devices: devicesDel.rowCount ?? 0,
        sightings: sightingsDel.rowCount ?? 0,
        telemetryEvents: telemetryDel.rowCount ?? 0,
        sensingSnapshots: snapshotsDel.rowCount ?? 0,
        evidenceRecords: evidenceDel.rowCount ?? 0,
        calibrationsRetired: 0,
        relaysRemoved: 0,
      },
    };
  }

  // Full site data purge: clears all stored observations, sightings, telemetry events,
  // sensing snapshots, evidence records, active calibration models, and site origin.
  const [sightingsDel, devicesDel, telemetryDel, snapshotsDel, evidenceDel] = await Promise.all([
    pool.query("DELETE FROM backspyne_rf_sightings WHERE owner_id = $1", [ownerId]),
    pool.query("DELETE FROM backspyne_rf_devices WHERE owner_id = $1", [ownerId]),
    pool.query("DELETE FROM backspyne_telemetry_events WHERE owner_id = $1", [ownerId]),
    pool.query("DELETE FROM backspyne_sensing_snapshots WHERE owner_id = $1", [ownerId]),
    pool.query("DELETE FROM backspyne_evidence_records WHERE owner_id = $1", [ownerId]),
  ]);

  let calibrationsRetired = 0;
  try {
    const calRes = await pool.query(
      "UPDATE backspyne_site_calibrations SET revoked_at = now() WHERE owner_id = $1 AND revoked_at IS NULL",
      [ownerId],
    );
    calibrationsRetired = calRes.rowCount ?? 0;
  } catch {
    // Table may not exist yet if no calibration was run.
  }

  try {
    await pool.query("DELETE FROM backspyne_site_origins WHERE owner_id = $1", [ownerId]);
  } catch {
    // Table may not exist yet if no phone relay origin was set.
  }

  let relaysRemoved = 0;
  if (options.resetRelays) {
    const nodesDel = await pool.query("DELETE FROM backspyne_scan_nodes WHERE owner_id = $1", [ownerId]);
    relaysRemoved = nodesDel.rowCount ?? 0;
  }

  await pool.query(
    `INSERT INTO backspyne_retention_policies (owner_id, last_purged_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (owner_id) DO UPDATE SET last_purged_at = now()`,
    [ownerId],
  ).catch(() => undefined);

  return {
    scope: "site",
    purgedAt: nowIso,
    cutoffDate: null,
    deleted: {
      devices: devicesDel.rowCount ?? 0,
      sightings: sightingsDel.rowCount ?? 0,
      telemetryEvents: telemetryDel.rowCount ?? 0,
      sensingSnapshots: snapshotsDel.rowCount ?? 0,
      evidenceRecords: evidenceDel.rowCount ?? 0,
      calibrationsRetired,
      relaysRemoved,
    },
  };
}

/**
 * Throttled background enforcement per operator so ingest and read paths do not run
 * DELETE statements on every single poll/heartbeat. Runs at most once every 5 minutes per
 * operator process-wide when `autoPrune` is enabled.
 */
const lastAutoPruneByOwner = new Map<string, number>();
const AUTO_PRUNE_INTERVAL_MS = 5 * 60_000;

export async function enforceOwnerRetentionWindow(ownerId: string, now = Date.now()): Promise<EffectiveRetentionPolicy> {
  const { policy } = await resolveOwnerRetention(ownerId, now);
  if (!policy.autoPrune) return policy;

  const lastRun = lastAutoPruneByOwner.get(ownerId) ?? 0;
  if (now - lastRun >= AUTO_PRUNE_INTERVAL_MS) {
    lastAutoPruneByOwner.set(ownerId, now);
    void executeDataPurge(ownerId, { scope: "expired", cutoffDate: policy.cutoffDate }).catch((err) => {
      logger.warn({ err, ownerId }, "Background retention auto-prune failed");
    });
  }
  return policy;
}
