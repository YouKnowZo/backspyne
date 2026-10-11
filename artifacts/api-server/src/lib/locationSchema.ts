// Relay placement columns, added on first use.
//
// The deployment owns the database and this API cannot assume a migration ran before it
// serves traffic, so the three placement columns are added idempotently the first time
// something needs them. A failure here is reported, never thrown away: without the columns
// there is no placement, and the relay list falls back to the columns that always existed
// rather than failing the polled request.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// One statement per call: the driver uses the extended protocol, which rejects
// multi-statement queries.
const STATEMENTS = [
  sql`ALTER TABLE backspyne_scan_nodes ADD COLUMN IF NOT EXISTS position_x real`,
  sql`ALTER TABLE backspyne_scan_nodes ADD COLUMN IF NOT EXISTS position_y real`,
  sql`ALTER TABLE backspyne_scan_nodes ADD COLUMN IF NOT EXISTS position_label text`,
];

let ready: Promise<boolean> | null = null;

async function addPlacementColumns(): Promise<boolean> {
  try {
    for (const statement of STATEMENTS) await db.execute(statement);
    return true;
  } catch (error) {
    logger.error({ err: error }, "Unable to add the relay placement columns; relay placement stays unavailable");
    return false;
  }
}

/** Memoized, so the DDL runs at most once per process. */
export function ensureNodePlacementSchema(): Promise<boolean> {
  if (!ready) ready = addPlacementColumns();
  return ready;
}
