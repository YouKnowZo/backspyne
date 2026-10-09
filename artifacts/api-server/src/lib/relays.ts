// Per-operator relay pairing.
//
// A relay is a machine the operator controls that scans nearby radios and reports
// measurements. Each operator pairs their own relay token rather than sharing one
// deployment-wide secret, which is what makes the deployment able to serve more than one
// customer. The plaintext token exists only in the response that creates it.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { relayTokens, type RelayToken } from "@workspace/db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { generateRelayToken, sha256Hex } from "./relayAuth";

// Statement text mirrors lib/db/backspyne-relays.sql. One statement per call: the
// driver uses the extended protocol, which rejects multi-statement queries.
const CREATE_RELAY_TOKENS = sql`
  CREATE TABLE IF NOT EXISTS backspyne_relay_tokens (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    label text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz
  )
`;

const CREATE_RELAY_TOKEN_HASH_INDEX = sql`
  CREATE UNIQUE INDEX IF NOT EXISTS backspyne_relay_tokens_token_hash_unique
    ON backspyne_relay_tokens (token_hash)
`;

const CREATE_RELAY_TOKEN_OWNER_INDEX = sql`
  CREATE INDEX IF NOT EXISTS backspyne_relay_tokens_owner_index
    ON backspyne_relay_tokens (owner_id)
`;

let schemaReady: Promise<boolean> | null = null;

async function createRelayTables(): Promise<boolean> {
  try {
    await db.execute(CREATE_RELAY_TOKENS);
    await db.execute(CREATE_RELAY_TOKEN_HASH_INDEX);
    await db.execute(CREATE_RELAY_TOKEN_OWNER_INDEX);
    return true;
  } catch (error) {
    logger.error({ err: error }, "Unable to create the relay token table");
    return false;
  }
}

export function ensureRelaySchema(): Promise<boolean> {
  if (!schemaReady) schemaReady = createRelayTables();
  return schemaReady;
}

export interface RelayTokenSummary {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
}

function summarize(row: RelayToken): RelayTokenSummary {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    active: row.revokedAt === null,
  };
}

/** Newest first. Never returns the token digest. */
export async function listRelayTokens(ownerId: string): Promise<RelayTokenSummary[]> {
  await ensureRelaySchema();
  const rows = await db
    .select()
    .from(relayTokens)
    .where(eq(relayTokens.ownerId, ownerId))
    .orderBy(desc(relayTokens.createdAt))
    .limit(100);
  return rows.map(summarize);
}

export async function countActiveRelayTokens(ownerId: string): Promise<number> {
  await ensureRelaySchema();
  const rows = await db
    .select({ id: relayTokens.id })
    .from(relayTokens)
    .where(and(eq(relayTokens.ownerId, ownerId), isNull(relayTokens.revokedAt)));
  return rows.length;
}

export interface CreatedRelayToken {
  relay: RelayTokenSummary;
  /** Shown once, at creation. Only the digest is stored. */
  token: string;
}

export async function createRelayToken(ownerId: string, label: string): Promise<CreatedRelayToken> {
  await ensureRelaySchema();
  const token = generateRelayToken();
  const row = {
    id: `relay_${randomUUID()}`,
    ownerId,
    label,
    tokenHash: sha256Hex(token),
  };
  const [inserted] = await db.insert(relayTokens).values(row).returning();
  return { relay: summarize(inserted), token };
}

/** Soft revoke. Idempotent: revoking an already-revoked token keeps the original time. */
export async function revokeRelayToken(ownerId: string, id: string): Promise<RelayTokenSummary | null> {
  await ensureRelaySchema();
  const [existing] = await db
    .select()
    .from(relayTokens)
    .where(and(eq(relayTokens.id, id), eq(relayTokens.ownerId, ownerId)))
    .limit(1);
  if (!existing) return null;
  if (existing.revokedAt) return summarize(existing);
  const [updated] = await db
    .update(relayTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(relayTokens.id, id), eq(relayTokens.ownerId, ownerId)))
    .returning();
  return updated ? summarize(updated) : null;
}

/** Looks up an unrevoked token by digest and returns the operator it belongs to. */
export async function ownerForRelayTokenHash(tokenHash: string): Promise<{ id: string; ownerId: string } | null> {
  try {
    await ensureRelaySchema();
    const [row] = await db
      .select({ id: relayTokens.id, ownerId: relayTokens.ownerId })
      .from(relayTokens)
      .where(and(eq(relayTokens.tokenHash, tokenHash), isNull(relayTokens.revokedAt)))
      .limit(1);
    return row ?? null;
  } catch (error) {
    // A lookup failure must reject the relay, never silently authorize it.
    logger.error({ err: error }, "Relay token lookup failed");
    return null;
  }
}

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/**
 * Records that a relay is in use, at most once a minute per token so a short reporting
 * interval does not turn into a write on every cycle.
 */
export async function touchRelayToken(id: string): Promise<void> {
  const now = Date.now();
  const previous = lastTouched.get(id) ?? 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  try {
    await db.update(relayTokens).set({ lastUsedAt: new Date() }).where(eq(relayTokens.id, id));
  } catch (error) {
    logger.warn({ err: error, relayTokenId: id }, "Unable to record relay token usage");
  }
}
