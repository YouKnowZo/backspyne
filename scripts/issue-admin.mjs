// Issues the deployment's administrator credential.
//
// The administrator is configuration, not a database row (see
// artifacts/api-server/src/lib/adminAuth.ts), so creating one is: pick an email, hash a
// password, and put two values where the server can read them. This script does the hashing
// and prints the exact lines, because getting the verifier format wrong by hand produces a
// login that always fails with no clue why.
//
//   node scripts/issue-admin.mjs                       # generate a password and print it once
//   node scripts/issue-admin.mjs --email me@site.test  # choose the address
//   node scripts/issue-admin.mjs --password 'secret'   # hash a password you chose
//   node scripts/issue-admin.mjs --json                # machine-readable output
//
// It writes nothing: the lines it prints are the deliverable, and a password that was never
// stored is a password nobody can leak from a file. Pass no --password and it generates one
// with node:crypto, which is stronger than anything short enough to type from memory.

import { randomBytes, scryptSync } from "node:crypto";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Same format the API verifies: `scrypt$<salt hex>$<key hex>`. */
export function hashPassword(password, salt = randomBytes(SALT_BYTES)) {
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, KEY_BYTES).toString("hex")}`;
}

/** A password that is long, mixed, and safe to paste into a shell single-quoted. */
export function generatePassword() {
  return randomBytes(24).toString("base64url");
}

function readFlag(name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

/**
 * The credential set a deployment needs, without printing anything. Separated from the CLI so
 * a caller that wants to place the values itself — an operator script, a test — can ask for
 * them, and so importing this module has no side effects.
 */
export function issueAdminCredential(options = {}) {
  const email = options.email || "admin@backspyne.local";
  const password = options.password || generatePassword();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`"${email}" is not an email address the server would accept as an admin address.`);
  }
  if (password.length < 8) {
    throw new Error("The admin password must be at least 8 characters; the API refuses anything shorter.");
  }
  return { email, password, passwordHash: hashPassword(password), sessionSecret: randomBytes(32).toString("base64url") };
}

function main() {
  const credential = issueAdminCredential({ email: readFlag("email", "admin@backspyne.local"), password: readFlag("password") || undefined });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(credential, null, 2));
    return;
  }
  console.log("# BackSpyne administrator — add these to the server's environment (never to source control).");
  console.log(`BACKSPYNE_ADMIN_EMAIL=${credential.email}`);
  console.log(`BACKSPYNE_ADMIN_PASSWORD_HASH=${credential.passwordHash}`);
  console.log(`BACKSPYNE_ADMIN_SESSION_SECRET=${credential.sessionSecret}`);
  console.log("# Sign in at /admin with:");
  console.log(`#   email:    ${credential.email}`);
  console.log(`#   password: ${credential.password}`);
  console.log("# Store the password now: it is printed once and is not recoverable from the hash.");
}
// Importing this module must not issue, print, or store anything; only running it does.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();
