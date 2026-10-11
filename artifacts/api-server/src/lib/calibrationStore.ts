// Storing the site's fitted radio model.
//
// One row per fit, and the active one is the newest row that has not been retired. Nothing is
// deleted: retiring a calibration keeps the record of what the model was, when it was fitted,
// and what evidence produced it — which is the same reason a client report can cite its
// limits. A cleared calibration therefore means "back to the deployed defaults", not "forget
// that anything was ever measured".
//
// Kept apart from the arithmetic in `calibration.ts` so the solver stays testable without a
// database.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { CalibrationFit, CalibrationTargetSolution } from "./calibration";
import { logger } from "./logger";

const CREATE_CALIBRATIONS = sql`
  CREATE TABLE IF NOT EXISTS backspyne_site_calibrations (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    method text NOT NULL,
    reference_dbm real NOT NULL,
    path_loss_exponent real NOT NULL,
    reference_meters real NOT NULL,
    targets jsonb NOT NULL DEFAULT '[]'::jsonb,
    samples integer NOT NULL,
    vantages integer NOT NULL,
    residual_rms_db real,
    clamped_exponent boolean NOT NULL DEFAULT false,
    warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
    calibrated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  )
`;

const CREATE_CALIBRATION_INDEX = sql`
  CREATE INDEX IF NOT EXISTS backspyne_site_calibrations_owner_index
    ON backspyne_site_calibrations (owner_id, calibrated_at DESC)
`;

let schemaReady: Promise<boolean> | null = null;

async function createCalibrationTable(): Promise<boolean> {
  try {
    await db.execute(CREATE_CALIBRATIONS);
    await db.execute(CREATE_CALIBRATION_INDEX);
    return true;
  } catch (error) {
    logger.error({ err: error }, "Unable to create the site calibration table; estimates stay on the generic model");
    return false;
  }
}

/** Memoized, so the DDL runs at most once per process. */
export function ensureCalibrationSchema(): Promise<boolean> {
  if (!schemaReady) schemaReady = createCalibrationTable();
  return schemaReady;
}

export interface StoredCalibration {
  id: string;
  method: string;
  referenceDbm: number;
  pathLossExponent: number;
  referenceMeters: number;
  targets: CalibrationTargetSolution[];
  samples: number;
  vantages: number;
  residualRmsDb: number | null;
  clampedExponent: boolean;
  warnings: string[];
  calibratedAt: string;
  revokedAt: string | null;
}

type CalibrationRow = {
  id: string;
  method: string;
  reference_dbm: number;
  path_loss_exponent: number;
  reference_meters: number;
  targets: CalibrationTargetSolution[];
  samples: number;
  vantages: number;
  residual_rms_db: number | null;
  clamped_exponent: boolean;
  warnings: string[];
  calibrated_at: Date;
  revoked_at: Date | null;
};

const COLUMNS = "id, method, reference_dbm, path_loss_exponent, reference_meters, targets, samples, vantages, residual_rms_db, clamped_exponent, warnings, calibrated_at, revoked_at";

function fromRow(row: CalibrationRow): StoredCalibration {
  return {
    id: row.id,
    method: row.method,
    referenceDbm: row.reference_dbm,
    pathLossExponent: row.path_loss_exponent,
    referenceMeters: row.reference_meters,
    targets: Array.isArray(row.targets) ? row.targets : [],
    samples: row.samples,
    vantages: row.vantages,
    residualRmsDb: row.residual_rms_db,
    clampedExponent: row.clamped_exponent === true,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    calibratedAt: row.calibrated_at instanceof Date ? row.calibrated_at.toISOString() : String(row.calibrated_at),
    revokedAt: row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at.toISOString() : String(row.revoked_at)) : null,
  };
}

/** The model in force for this operator, or null when estimates still use the defaults. */
export async function readActiveCalibration(ownerId: string): Promise<StoredCalibration | null> {
  if (!(await ensureCalibrationSchema())) return null;
  try {
    const result = await pool.query<CalibrationRow>(
      `SELECT ${COLUMNS} FROM backspyne_site_calibrations WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY calibrated_at DESC LIMIT 1`,
      [ownerId],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to read the site calibration; estimates fall back to the generic model");
    return null;
  }
}

/** Recent fits, newest first, including retired ones. */
export async function listCalibrations(ownerId: string, limit = 10): Promise<StoredCalibration[]> {
  if (!(await ensureCalibrationSchema())) return [];
  try {
    const result = await pool.query<CalibrationRow>(
      `SELECT ${COLUMNS} FROM backspyne_site_calibrations WHERE owner_id = $1 ORDER BY calibrated_at DESC LIMIT $2`,
      [ownerId, Math.max(1, Math.min(50, limit))],
    );
    return result.rows.map(fromRow);
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to list site calibrations");
    return [];
  }
}

/**
 * Stores a fit. Retiring the previous one is part of the same call, so there is never a
 * moment with two active models.
 */
export async function saveCalibration(ownerId: string, fit: CalibrationFit, options: { method?: string; id: string; calibratedAt?: Date }): Promise<StoredCalibration | null> {
  if (!(await ensureCalibrationSchema())) return null;
  try {
    await pool.query("UPDATE backspyne_site_calibrations SET revoked_at = now() WHERE owner_id = $1 AND revoked_at IS NULL", [ownerId]);
    const result = await pool.query<CalibrationRow>(
      `INSERT INTO backspyne_site_calibrations
        (id, owner_id, method, reference_dbm, path_loss_exponent, reference_meters, targets, samples, vantages, residual_rms_db, clamped_exponent, warnings, calibrated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13)
       RETURNING ${COLUMNS}`,
      [
        options.id,
        ownerId,
        options.method ?? "calibration walk",
        fit.referenceDbm,
        fit.pathLossExponent,
        fit.referenceMeters,
        JSON.stringify(fit.targets),
        fit.samples,
        fit.vantages,
        fit.residualRmsDb,
        fit.clampedExponent,
        JSON.stringify(fit.warnings),
        options.calibratedAt ?? new Date(),
      ],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to store the site calibration");
    return null;
  }
}

/** Retires the active calibration. Returns the row that was retired, if there was one. */
export async function revokeActiveCalibration(ownerId: string): Promise<StoredCalibration | null> {
  if (!(await ensureCalibrationSchema())) return null;
  try {
    const result = await pool.query<CalibrationRow>(
      `UPDATE backspyne_site_calibrations SET revoked_at = now() WHERE owner_id = $1 AND revoked_at IS NULL RETURNING ${COLUMNS}`,
      [ownerId],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to retire the site calibration");
    return null;
  }
}
