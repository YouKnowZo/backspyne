// Handing the desktop bridge to a signed-in operator from the site itself.
//
// The Python bridge reads the operating system's WiFi and Bluetooth adapters, so it cannot
// run in a browser tab. It is therefore packaged at build time (`scripts/build-scanner-zip.mjs`)
// into the serverless function's own bundle, listed, and downloaded from this origin — no
// repository clone, no guessing which folder to copy.
//
// Both endpoints require an operator session: the bridge talks to this deployment with the
// operator's own paired relay token, so the archive is part of the product rather than a
// public file, and the manifest is what lets the console show exactly what is inside the
// download before anyone runs it.

import { Router, type IRouter } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ARCHIVE_FILE = "scanner-bridge.zip";
const MANIFEST_FILE = "scanner-bridge.json";

/**
 * The built artifacts live in the repository's `dist/api` directory, which the deployment
 * ships with the function. The server is started from the repository root in production and
 * from the package directory during local development, so both are tried rather than
 * assuming one working directory.
 */
function candidatePaths(fileName: string): string[] {
  return [
    path.resolve(process.cwd(), "dist", "api", fileName),
    path.resolve(process.cwd(), "..", "..", "dist", "api", fileName),
    path.resolve(process.cwd(), "..", "dist", "api", fileName),
  ];
}

async function readArtifact(fileName: string): Promise<Buffer | null> {
  for (const candidate of candidatePaths(fileName)) {
    try {
      return await readFile(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** What the download contains, and how big it is. Read once per process. */
router.get("/bridge/manifest", requireAuth, async (_req, res, next) => {
  try {
    const manifest = await readArtifact(MANIFEST_FILE);
    if (!manifest) {
      res.json({ available: false, reason: "The bridge archive was not packaged into this deployment. Rebuild the API to include it." });
      return;
    }
    res.json({ available: true, ...JSON.parse(manifest.toString("utf8")) });
  } catch (error) {
    logger.error({ err: error }, "Unable to read the bridge manifest");
    next(error);
  }
});

router.get("/bridge/download", requireAuth, async (_req, res, next) => {
  try {
    const archive = await readArtifact(ARCHIVE_FILE);
    if (!archive) {
      res.status(503).json({ error: "The bridge archive was not packaged into this deployment. Rebuild the API to include it." });
      return;
    }
    res
      .type("application/zip")
      .set("Content-Disposition", 'attachment; filename="backspyne-scanner.zip"')
      .set("Cache-Control", "private, no-store")
      .send(archive);
  } catch (error) {
    next(error);
  }
});

export default router;
