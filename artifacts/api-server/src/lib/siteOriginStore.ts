// Where the site origin is kept: one row per operator.
//
// Split from the frame arithmetic so the projection stays pure and testable without a
// database, and so a deployment that cannot create the table reports that plainly instead of
// failing the whole position request.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import type { SiteOrigin } from "./siteFrame";

// One statement per call: the driver uses the extended protocol, which rejects
// multi-statement queries.
const CREATE_SITE_ORIGINS = sql`
  CREATE TABLE IF NOT EXISTS backspyne_site_origins (
    owner_id text PRIMARY KEY,
    origin_lat double precision NOT NULL,
    origin_lon double precision NOT NULL,
    node_id text,
    set_at timestamptz NOT NULL DEFAULT now()
  )
`;

let schemaReady: Promise<boolean> | null = null;

async function createSiteOriginTable(): Promise<boolean> {
  try {
    await db.execute(CREATE_SITE_ORIGINS);
    return true;
  } catch (error) {
    logger.error({ err: error }, "Unable to create the site origin table; phone positioning stays unavailable");
    return false;
  }
}

/** Memoized, so the DDL runs at most once per process. */
export function ensureSiteOriginSchema(): Promise<boolean> {
  if (!schemaReady) schemaReady = createSiteOriginTable();
  return schemaReady;
}

function originFromRow(row: { origin_lat: number; origin_lon: number; node_id: string | null; set_at: Date | string }): SiteOrigin {
  return {
    lat: Number(row.origin_lat),
    lon: Number(row.origin_lon),
    nodeId: row.node_id,
    setAt: row.set_at instanceof Date ? row.set_at.toISOString() : String(row.set_at),
  };
}

export async function readSiteOrigin(ownerId: string): Promise<SiteOrigin | null> {
  if (!(await ensureSiteOriginSchema())) return null;
  try {
    const result = await pool.query<{ origin_lat: number; origin_lon: number; node_id: string | null; set_at: Date }>(
      "SELECT origin_lat, origin_lon, node_id, set_at FROM backspyne_site_origins WHERE owner_id = $1 LIMIT 1",
      [ownerId],
    );
    const row = result.rows[0];
    return row ? originFromRow(row) : null;
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to read the site origin");
    return null;
  }
}

/** Sets (or replaces) the origin. The first accepted fix is normally the caller. */
export async function setSiteOrigin(ownerId: string, fix: { lat: number; lon: number }, nodeId: string | null): Promise<SiteOrigin | null> {
  if (!(await ensureSiteOriginSchema())) return null;
  try {
    const result = await pool.query<{ origin_lat: number; origin_lon: number; node_id: string | null; set_at: Date }>(
      `INSERT INTO backspyne_site_origins (owner_id, origin_lat, origin_lon, node_id, set_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (owner_id) DO UPDATE SET origin_lat = EXCLUDED.origin_lat, origin_lon = EXCLUDED.origin_lon, node_id = EXCLUDED.node_id, set_at = now()
       RETURNING origin_lat, origin_lon, node_id, set_at`,
      [ownerId, fix.lat, fix.lon, nodeId],
    );
    const row = result.rows[0];
    return row ? originFromRow(row) : null;
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to set the site origin");
    return null;
  }
}

export async function clearSiteOrigin(ownerId: string): Promise<boolean> {
  if (!(await ensureSiteOriginSchema())) return false;
  try {
    await pool.query("DELETE FROM backspyne_site_origins WHERE owner_id = $1", [ownerId]);
    return true;
  } catch (error) {
    logger.error({ err: error, ownerId }, "Unable to clear the site origin");
    return false;
  }
}
