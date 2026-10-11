// Tests that every route module is actually served.
//
//   node --experimental-strip-types --test artifacts/api-server/test/routerCoverage.test.ts
//
// Why this exists. A router file can be written, typed, exported, and imported by nothing.
// TypeScript will not warn — an unused module is not an error — and the endpoints inside it
// simply answer 404 on a deployment that shipped the code for them. That is exactly what
// happened to the calibration walk, the phone relay, and the bridge download: three complete,
// tested features that no request could reach, discovered only by asking a deployed origin
// for /api/calibration and reading 404 instead of 401.
//
// The check is deliberately about source rather than about a running app: importing the
// aggregate router would import `@workspace/db`, which throws at import time when
// DATABASE_URL is unset, so the test that guards routing has to work without a database.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const routesDirectory = new URL("../src/routes/", import.meta.url);

/** Files that are not mountable routers: the aggregate itself and the database-free aggregate. */
const AGGREGATES = new Set(["index.ts", "open.ts"]);

function declaresRoutes(source: string): boolean {
  return /\brouter\.(get|post|patch|delete|put|all)\(/.test(source);
}

function exportsRouter(source: string): boolean {
  return /export default router/.test(source);
}

/** The module specifiers a router file imports, as `./name` strings. */
function importedModules(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^import\s+\w+\s+from\s+"\.\/([a-zA-Z0-9_-]+)";/gm)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * The identifiers actually passed to `router.use(...)`. Deliberately not the import list: a
 * file can import a router and never mount it, which is the bug this guards against — an
 * import-only check passes while the endpoint still answers 404.
 */
function mountedRouters(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*router\.use\(\s*([A-Za-z0-9_]+)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** `phoneRelay.ts` mounts as `phoneRelayRouter`, which is the convention every file follows. */
function routerIdentifierFor(fileName: string): string {
  const base = fileName.replace(/\.ts$/, "");
  return `${base[0].toLowerCase()}${base.slice(1)}Router`;
}

test("every router module that declares routes is mounted by the aggregate router", async () => {
  const indexSource = await readFile(new URL("index.ts", routesDirectory), "utf8");
  const mounted = mountedRouters(indexSource);
  const entries = await readdir(routesDirectory, { withFileTypes: true });

  const orphans: string[] = [];
  let checked = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (AGGREGATES.has(entry.name)) continue;
    const source = await readFile(new URL(entry.name, routesDirectory), "utf8");
    if (!declaresRoutes(source) || !exportsRouter(source)) continue;
    checked += 1;
    if (!mounted.has(routerIdentifierFor(entry.name))) orphans.push(entry.name);
  }

  // A test that silently checked nothing would pass forever; this pins what it looked at.
  assert.ok(checked >= 8, `expected to inspect every route module, but only found ${checked}`);
  assert.deepEqual(orphans, [], `these routers declare routes and are never mounted: ${orphans.join(", ")}`);
});

test("the database-free aggregate is a subset of the aggregate router", async () => {
  // `open.ts` is what serves `/public/*` and the administrator's credential paths when
  // `@workspace/db` cannot be imported at all, so every router it mounts must also be mounted
  // by `index.ts` — otherwise the same endpoints answer differently depending on whether a
  // database is configured.
  const [indexSource, openSource] = await Promise.all([
    readFile(new URL("index.ts", routesDirectory), "utf8"),
    readFile(new URL("open.ts", routesDirectory), "utf8"),
  ]);
  const mounted = mountedRouters(indexSource);
  for (const name of mountedRouters(openSource)) {
    assert.ok(mounted.has(name), `open.ts mounts ${name} but index.ts does not`);
  }
});

test("the database-free aggregate imports no database module, directly or one hop away", async () => {
  // The failure this guards: importing `@workspace/db` throws when DATABASE_URL is unset, so a
  // route that only reads configuration must not reach it through its router's imports.
  const openSource = await readFile(new URL("open.ts", routesDirectory), "utf8");
  const mounted = [...importedModules(openSource)];

  const reachable = new Set<string>();
  const queue = [...mounted];
  while (queue.length) {
    const name = queue.pop() as string;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const source = await readFile(new URL(`${name}.ts`, routesDirectory), "utf8");
    for (const local of importedModules(source)) queue.push(local);
  }

  for (const name of reachable) {
    const source = await readFile(new URL(`${name}.ts`, routesDirectory), "utf8");
    assert.equal(
      /from\s+"@workspace\/db/.test(source),
      false,
      `./${name} is reachable from open.ts and imports @workspace/db, which throws without DATABASE_URL`,
    );
  }
});
