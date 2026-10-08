import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseCa = process.env.DATABASE_CA_CERT?.trim();
const databaseUrl = new URL(process.env.DATABASE_URL);

// node-postgres replaces the ssl options object when sslmode is present in the
// connection string. Remove that option when a CA is supplied so TLS validates
// the server against this explicit trust anchor (and still verifies its host).
if (databaseCa) databaseUrl.searchParams.delete("sslmode");

export const pool = new Pool({
  connectionString: databaseCa ? databaseUrl.toString() : process.env.DATABASE_URL,
  ...(databaseCa ? { ssl: { ca: databaseCa, rejectUnauthorized: true } } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
