import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  evidenceRecords,
  rfDevices,
  rfSightings,
  scanNodes,
  scanSessions,
  sensingSnapshots,
  telemetryEvents,
} from "@workspace/db/schema";
import { desc, eq, and } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { ownerEntitlements } from "../lib/billing/subscriptions";
import { storeObservations } from "../lib/ingest";
import { emit, registerStreamClient, unregisterStreamClient } from "../lib/stream";
import {
  DEFAULT_RADIO_MODEL,
  estimatePosition,
  estimateTrack,
  impliedDistanceMeters,
  latestPerRelay,
} from "../lib/localization";
import { calibratedRadioModel } from "../lib/calibration";
import { readActiveCalibration } from "../lib/calibrationStore";
import { ensureNodePlacementSchema } from "../lib/locationSchema";
import { deploymentCredential, resolveRelayCredential, type ResolvedRelayCredential } from "../lib/relayAuth";
import { ownerForRelayTokenHash, touchRelayToken } from "../lib/relays";
import { vantagePointFor } from "../lib/vantage";
import { dbmFromLinkQualityPercent, usableDbm } from "../lib/signal";

const router: IRouter = Router();

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

// Where a radio was heard from — a relay's placement, or the position a phone recorded —
// lives in `lib/vantage.ts`, because the calibration walk reads the same vantage points and
// the two must agree on how they are bucketed.

/**
 * Resolves the operator a relay request may report for. The request must carry a valid
 * HMAC over the exact body keyed by its own token; that token is then matched against
 * the deployment-wide credential or a per-operator pairing token.
 */
async function resolveIngestCredential(req: import("express").Request, rawBody: string): Promise<ResolvedRelayCredential | null> {
  return resolveRelayCredential(
    {
      rawBody,
      suppliedToken: req.header("x-backspyne-node-token"),
      signatureHeader: req.header("x-backspyne-signature"),
    },
    deploymentCredential(process.env),
    { operatorForTokenHash: ownerForRelayTokenHash },
  );
}

function parseDate(value: unknown, fallback: Date) {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/**
 * Relay allowance for an operator, from the plan they are actually entitled to. Read
 * failures fall back to the free allowance, so a billing problem can never widen access.
 */
async function mayRegisterAdditionalRelay(ownerId: string): Promise<{ allowed: boolean; maxRelays: number }> {
  const { entitlements } = await ownerEntitlements(ownerId);
  const existing = await db.select({ id: scanNodes.id }).from(scanNodes).where(eq(scanNodes.ownerId, ownerId));
  return { allowed: existing.length < entitlements.maxRelays, maxRelays: entitlements.maxRelays };
}

router.get("/me", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ userId: req.userId });
});

router.get("/devices", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rows = await db
      .select()
      .from(rfDevices)
      .where(eq(rfDevices.ownerId, req.userId!))
      .orderBy(desc(rfDevices.lastSeenAt))
      .limit(250);
    const sightings = await db
      .select({ deviceId: rfSightings.deviceId, signalQualityPercent: rfSightings.metadata })
      .from(rfSightings)
      .where(eq(rfSightings.ownerId, req.userId!))
      .orderBy(desc(rfSightings.observedAt))
      .limit(1000);
    const latestQuality = new Map<string, number>();
    const latestSource = new Map<string, string>();
    for (const sighting of sightings) {
      const meta = sighting.signalQualityPercent as Record<string, unknown>;
      if (!latestQuality.has(sighting.deviceId) && typeof meta.signalQualityPercent === "number") {
        latestQuality.set(sighting.deviceId, meta.signalQualityPercent);
      }
      if (!latestSource.has(sighting.deviceId) && typeof meta.signalSource === "string") {
        latestSource.set(sighting.deviceId, meta.signalSource);
      }
    }
    res.json({
      devices: rows.map((device) => ({
        ...device,
        signalQualityPercent: latestQuality.get(device.id) ?? null,
        // Where the stored level came from. A sighting written since levels began to be
        // derived from link quality says so itself; an older row is read from what it holds,
        // so a WiFi access point seen from Windows is labelled as a derived level rather than
        // passed off as a driver measurement.
        signalSource: storedLevelSource(device.lastSignalDbm, latestSource.get(device.id), latestQuality.has(device.id)),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Where a device's stored level came from, in the vocabulary `lib/signal.ts` defines.
 *
 * A recorded source is authoritative. Without one, a device that holds a level got it from a
 * dBm the adapter reported; a device with no level but a known percentage is reported as a
 * link-quality measurement, which is what it is.
 */
function storedLevelSource(lastSignalDbm: number | null, recorded: string | undefined, percentKnown: boolean): string | null {
  if (recorded === "adapter dBm" || recorded === "link-quality percentage") return recorded;
  if (typeof lastSignalDbm === "number" && Number.isFinite(lastSignalDbm)) return "adapter dBm";
  return percentKnown ? "link-quality percentage" : null;
}

/**
 * The level to model from, for one stored sighting: the adapter's own dBm when it reported
 * one, otherwise the level its link-quality percentage maps to. Returns null when the sighting
 * holds neither, because a row with no level cannot constrain a position.
 */
function sightingLevel(sighting: { signalDbm: number | null; metadata: unknown }): { dbm: number; derived: boolean } | null {
  if (usableDbm(sighting.signalDbm)) return { dbm: sighting.signalDbm, derived: false };
  const metadata = sighting.metadata && typeof sighting.metadata === "object" ? sighting.metadata as Record<string, unknown> : {};
  const derived = dbmFromLinkQualityPercent(metadata.signalQualityPercent);
  return derived === null ? null : { dbm: derived, derived: true };
}

/**
 * The relay list, which the console polls, so it must answer even when the placement
 * columns could not be added. The fallback selects the columns that have always existed and
 * reports no placement rather than failing the whole request.
 */
async function relayRowsForOwner(ownerId: string) {
  if (await ensureNodePlacementSchema()) {
    return db
      .select()
      .from(scanNodes)
      .where(eq(scanNodes.ownerId, ownerId))
      .orderBy(desc(scanNodes.lastHeartbeatAt));
  }
  return db
    .select({
      id: scanNodes.id,
      ownerId: scanNodes.ownerId,
      name: scanNodes.name,
      address: scanNodes.address,
      role: scanNodes.role,
      status: scanNodes.status,
      lastHeartbeatAt: scanNodes.lastHeartbeatAt,
      capabilities: scanNodes.capabilities,
      createdAt: scanNodes.createdAt,
    })
    .from(scanNodes)
    .where(eq(scanNodes.ownerId, ownerId))
    .orderBy(desc(scanNodes.lastHeartbeatAt));
}

router.get("/nodes", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rows = await relayRowsForOwner(req.userId!);
    const now = Date.now();
    const nodes = rows.map((node) => {
      const age = node.lastHeartbeatAt ? now - node.lastHeartbeatAt.getTime() : Number.POSITIVE_INFINITY;
      return {
        ...node,
        status: age < 45_000 ? "online" : node.lastHeartbeatAt ? "degraded" : "offline",
      };
    });
    res.json({ nodes });
  } catch (error) {
    next(error);
  }
});

router.post("/nodes", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    const address = typeof req.body?.address === "string" ? req.body.address.trim().slice(0, 200) : "";
    const role = typeof req.body?.role === "string" ? req.body.role.trim().slice(0, 80) : "Sensor relay";
    if (!name || !address) {
      res.status(400).json({ error: "name and address are required" });
      return;
    }
    const allowance = await mayRegisterAdditionalRelay(req.userId!);
    if (!allowance.allowed) {
      res.status(403).json({
        error: `The current plan allows ${allowance.maxRelays} authorized relay${allowance.maxRelays === 1 ? "" : "s"}`,
        code: "relay_limit_reached",
        maxRelays: allowance.maxRelays,
      });
      return;
    }
    const node = {
      id: id("node"),
      ownerId: req.userId!,
      name,
      address,
      role,
      status: "offline" as const,
      capabilities: Array.isArray(req.body?.capabilities)
        ? req.body.capabilities.filter((value: unknown): value is string => typeof value === "string").slice(0, 20)
        : [],
    };
    await db.insert(scanNodes).values(node);
    res.status(201).json({ node });
  } catch (error) {
    next(error);
  }
});

router.patch("/nodes/:id", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const values: Partial<typeof scanNodes.$inferInsert> = {};
    if (typeof req.body?.name === "string") values.name = req.body.name.trim().slice(0, 120);
    if (typeof req.body?.address === "string") values.address = req.body.address.trim().slice(0, 200);
    if (typeof req.body?.role === "string") values.role = req.body.role.trim().slice(0, 80);
    if (req.body?.status === "online" || req.body?.status === "offline" || req.body?.status === "degraded") {
      values.status = req.body.status;
    }
    // Placement is operator-entered, so it is validated here rather than trusted: a site
    // frame further than 10 km across is a typo, not a site.
    const placementRequested = req.body?.positionX !== undefined || req.body?.positionY !== undefined || req.body?.positionLabel !== undefined;
    if (placementRequested) {
      if (!(await ensureNodePlacementSchema())) {
        res.status(503).json({ error: "Relay placement is unavailable on this deployment", code: "placement_unavailable" });
        return;
      }
      const readCoordinate = (value: unknown): number | null | undefined => {
        if (value === null) return null;
        if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) return undefined;
        return Math.round(value * 10) / 10;
      };
      const x = readCoordinate(req.body?.positionX);
      const y = readCoordinate(req.body?.positionY);
      if (x === undefined || y === undefined || (x === null) !== (y === null)) {
        res.status(400).json({ error: "positionX and positionY must both be numbers within ±10000 metres, or both null to clear a placement" });
        return;
      }
      values.positionX = x;
      values.positionY = y;
      const label = typeof req.body?.positionLabel === "string" ? req.body.positionLabel.trim().slice(0, 80) : "";
      values.positionLabel = x === null ? null : label || null;
    }
    const [node] = await db
      .update(scanNodes)
      .set(values)
      .where(and(eq(scanNodes.id, String(req.params.id)), eq(scanNodes.ownerId, req.userId!)))
      .returning();
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json({ node });
  } catch (error) {
    next(error);
  }
});

router.delete("/nodes/:id", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const deleted = await db
      .delete(scanNodes)
      .where(and(eq(scanNodes.id, String(req.params.id)), eq(scanNodes.ownerId, req.userId!)))
      .returning({ id: scanNodes.id });
    if (!deleted.length) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.patch("/devices/:id", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (typeof req.body?.favorite !== "boolean") {
      res.status(400).json({ error: "favorite must be a boolean" });
      return;
    }
    const [device] = await db
      .update(rfDevices)
      .set({ favorite: req.body.favorite })
      .where(and(eq(rfDevices.id, String(req.params.id)), eq(rfDevices.ownerId, req.userId!)))
      .returning();
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json({ device });
  } catch (error) {
    next(error);
  }
});

router.get("/devices/:id/trail", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const sightings = await db
      .select()
      .from(rfSightings)
      .where(and(eq(rfSightings.deviceId, String(req.params.id)), eq(rfSightings.ownerId, req.userId!)))
      .orderBy(desc(rfSightings.observedAt))
      .limit(250);
    res.json({ sightings: sightings.map((sighting) => {
      // A trail reads the level the model would use, so a WiFi access point with only a
      // link-quality percentage shows the level it maps to, labelled with where it came from.
      const level = sightingLevel(sighting);
      const metadata = sighting.metadata as Record<string, unknown>;
      return {
        observedAt: sighting.observedAt,
        signalDbm: level ? level.dbm : null,
        distanceMeters: null,
        signalQualityPercent: metadata.signalQualityPercent ?? null,
        levelDerived: level ? level.derived : false,
      };
    }) });
  } catch (error) {
    next(error);
  }
});

/** How far back a position looks, and how the track is bucketed. */
const LOCATION_WINDOW_MINUTES = 30;
const LOCATION_SIGHTING_LIMIT = 400;
const TRACK_BUCKET_SECONDS = 60;

/**
 * Where a stored radio has been heard from, and how well that constrains it.
 *
 * Two rules decide the shape of this response. Only relays the operator has placed are
 * vantage points, so an unplaced relay is reported as a relay that heard the radio and
 * nothing more. And the geometry decides what is printed: the estimate carries its status,
 * so the portal can show a fix, two candidates, or a ring instead of a confident dot.
 */
router.get("/location/:deviceId", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const deviceId = String(req.params.deviceId);
    const [device] = await db
      .select()
      .from(rfDevices)
      .where(and(eq(rfDevices.id, deviceId), eq(rfDevices.ownerId, req.userId!)))
      .limit(1);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    if (!(await ensureNodePlacementSchema())) {
      res.json({
        available: false,
        reason: "Relay placement is unavailable on this deployment, so no position can be modelled.",
        device: { id: device.id, address: device.address, vendor: device.vendor, protocol: device.protocol },
      });
      return;
    }
    const since = new Date(Date.now() - LOCATION_WINDOW_MINUTES * 60_000);
    const [nodes, sightings, calibration] = await Promise.all([
      db.select().from(scanNodes).where(eq(scanNodes.ownerId, req.userId!)),
      db
        .select()
        .from(rfSightings)
        .where(and(eq(rfSightings.deviceId, deviceId), eq(rfSightings.ownerId, req.userId!)))
        .orderBy(desc(rfSightings.observedAt))
        .limit(LOCATION_SIGHTING_LIMIT),
      readActiveCalibration(req.userId!),
    ]);
    // The model in force: this site's fitted constants when a calibration walk has been kept,
    // otherwise the deployed defaults. A radio that was itself calibrated uses its own
    // reference level, because that is where its transmit power was actually measured.
    const model = calibration ? calibratedRadioModel(calibration, device.id) : DEFAULT_RADIO_MODEL;
    const deviceCalibrated = Boolean(calibration?.targets.some((target) => target.targetId === device.id));
    const recent = sightings.filter((sighting) => sighting.observedAt >= since);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    // A WiFi access point heard only from a Windows relay reports a link-quality percentage
    // and no power, and an access point is exactly the radio an operator is trying to place,
    // so the level that percentage maps to is what the geometry below uses. Every row records
    // whether the level was derived, and the note printed with the estimate says so when any
    // of them were.
    let derivedRows = 0;
    const placedRows = recent.flatMap((sighting) => {
      const vantage = vantagePointFor(sighting, nodeById.get(sighting.nodeId));
      const level = sightingLevel(sighting);
      if (!vantage || !level) return [];
      if (level.derived) derivedRows += 1;
      return [{
        nodeId: vantage.key,
        nodeName: vantage.name,
        signalDbm: level.dbm,
        derived: level.derived,
        observedAt: sighting.observedAt,
        x: vantage.x,
        y: vantage.y,
      }];
    });

    // Per-relay detail that does not depend on placement: what each vantage point heard.
    const perNode = new Map<string, { nodeId: string; name: string; placed: boolean; x: number | null; y: number | null; levels: number[]; derived: boolean; lastObservedAt: string }>();
    for (const sighting of recent) {
      const node = nodeById.get(sighting.nodeId);
      const level = sightingLevel(sighting);
      const entry = perNode.get(sighting.nodeId) ?? {
        nodeId: sighting.nodeId,
        name: node?.name ?? "Unpaired relay",
        placed: typeof node?.positionX === "number" && typeof node?.positionY === "number",
        x: node?.positionX ?? null,
        y: node?.positionY ?? null,
        levels: [],
        derived: false,
        lastObservedAt: sighting.observedAt.toISOString(),
      };
      if (level && entry.levels.length < 5) {
        entry.levels.push(level.dbm);
        // A relay reports one vocabulary, so this marks the level this radio was heard at from
        // this vantage point; it travels beside the implied distance rather than per sample.
        entry.derived = entry.derived || level.derived;
      }
      perNode.set(sighting.nodeId, entry);
    }
    const relays = [...perNode.values()]
      .map((relay) => {
        const levels = [...relay.levels].sort((left, right) => left - right);
        const middle = Math.floor(levels.length / 2);
        const median = levels.length ? (levels.length % 2 ? levels[middle] : (levels[middle - 1] + levels[middle]) / 2) : null;
        return {
          nodeId: relay.nodeId,
          name: relay.name,
          placed: relay.placed,
          x: relay.x,
          y: relay.y,
          signalDbm: median,
          samples: levels.length,
          /** True when this level came from the driver's link-quality percentage. */
          levelDerived: relay.derived,
          lastObservedAt: relay.lastObservedAt,
          impliedDistanceMeters: median === null ? null : Math.round(impliedDistanceMeters(median, model) * 10) / 10,
        };
      })
      .sort((left, right) => (right.signalDbm ?? -999) - (left.signalDbm ?? -999));

    // One observation per vantage point: the median of the levels that vantage point reported,
    // which is the same measurement with less channel noise and no new claim.
    const vantageRows = latestPerRelay(placedRows);
    const mobileVantages = new Set(placedRows.filter((row) => row.nodeId.includes("#")).map((row) => row.nodeId));
    const estimate = estimatePosition(vantageRows, model);
    const derivedVantages = new Set(placedRows.filter((row) => row.derived).map((row) => row.nodeId)).size;
    if (mobileVantages.size) {
      estimate.note = `${estimate.note} ${mobileVantages.size} vantage point${mobileVantages.size === 1 ? "" : "s"} in this window ${mobileVantages.size === 1 ? "was" : "were"} recorded while a phone was moving, so ${mobileVantages.size === 1 ? "its" : "their"} own reported position error is part of this estimate as well as the radio model's.`;
    }
    if (derivedVantages) {
      estimate.note = `${estimate.note} ${derivedVantages} of these levels came from an adapter's link-quality percentage rather than measured power: the percentage is the driver's own 0-100 scale, which maps to half-decibel steps from -100 dBm at 0% to -50 dBm at 100% and saturates at the top, so distances modelled from it carry the driver's rounding and scale error on top of the usual wall and antenna uncertainty.`;
    }

    res.json({
      available: true,
      device: {
        id: device.id,
        address: device.address,
        vendor: device.vendor,
        protocol: device.protocol,
        lastSignalDbm: device.lastSignalDbm,
        lastSeenAt: device.lastSeenAt,
      },
      model: {
        ...model,
        windowMinutes: LOCATION_WINDOW_MINUTES,
        bucketSeconds: TRACK_BUCKET_SECONDS,
        calibrated: Boolean(calibration),
        calibratedAt: calibration?.calibratedAt ?? null,
        calibrationId: calibration?.id ?? null,
        calibrationSamples: calibration?.samples ?? null,
        calibrationVantages: calibration?.vantages ?? null,
        residualRmsDb: calibration?.residualRmsDb ?? null,
        fittedFrom: calibration?.targets.map((target) => target.label) ?? [],
        deviceCalibrated,
        source: calibration ? "calibration walk fitted in this site" : "deployed generic defaults",
      },
      placement: { heard: relays.length, placed: relays.filter((relay) => relay.placed).length },
      relays,
      estimate,
      vantages: { used: vantageRows.length, fromPhone: mobileVantages.size, derivedLevels: derivedVantages },
      track: estimateTrack(placedRows, { bucketSeconds: TRACK_BUCKET_SECONDS, model }),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/sessions", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const session = {
      id: id("session"),
      ownerId: req.userId!,
      label: typeof req.body?.label === "string" ? req.body.label.slice(0, 120) : "Local RF session",
      status: "active" as const,
      startedAt: new Date(),
    };
    await db.insert(scanSessions).values(session);
    res.status(201).json({ session });
  } catch (error) {
    next(error);
  }
});

router.get("/sessions", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const sessions = await db
      .select()
      .from(scanSessions)
      .where(eq(scanSessions.ownerId, req.userId!))
      .orderBy(desc(scanSessions.startedAt))
      .limit(50);
    res.json({ sessions });
  } catch (error) {
    next(error);
  }
});

router.post("/sessions/:id/close", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const [session] = await db
      .update(scanSessions)
      .set({ status: "closed", endedAt: new Date() })
      .where(and(eq(scanSessions.id, String(req.params.id)), eq(scanSessions.ownerId, req.userId!)))
      .returning();
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ session });
  } catch (error) {
    next(error);
  }
});

router.patch("/sessions/:id", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (req.body?.status !== "active" && req.body?.status !== "paused") {
      res.status(400).json({ error: "status must be active or paused" });
      return;
    }
    const [session] = await db
      .update(scanSessions)
      .set({ status: req.body.status })
      .where(and(eq(scanSessions.id, String(req.params.id)), eq(scanSessions.ownerId, req.userId!)))
      .returning();
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ session });
  } catch (error) {
    next(error);
  }
});

router.get("/sensing/summary", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const [latest] = await db
      .select()
      .from(sensingSnapshots)
      .where(eq(sensingSnapshots.ownerId, req.userId!))
      .orderBy(desc(sensingSnapshots.observedAt))
      .limit(1);
    const history = await db
      .select()
      .from(sensingSnapshots)
      .where(eq(sensingSnapshots.ownerId, req.userId!))
      .orderBy(desc(sensingSnapshots.observedAt))
      .limit(24);
    res.json({ latest: latest ?? null, history });
  } catch (error) {
    next(error);
  }
});

router.get("/evidence", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const records = await db
      .select()
      .from(evidenceRecords)
      .where(eq(evidenceRecords.ownerId, req.userId!))
      .orderBy(desc(evidenceRecords.createdAt))
      .limit(250);
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

router.post("/evidence", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const kind = typeof req.body?.kind === "string" ? req.body.kind.trim().slice(0, 80) : "";
    const source = typeof req.body?.source === "string" ? req.body.source.trim().slice(0, 120) : "";
    if (!kind || !source) {
      res.status(400).json({ error: "kind and source are required" });
      return;
    }
    const record = {
      id: id("evidence"),
      ownerId: req.userId!,
      sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : null,
      kind,
      source,
      confidence: typeof req.body?.confidence === "number" ? req.body.confidence : null,
      uncertainty: req.body?.uncertainty && typeof req.body.uncertainty === "object" ? req.body.uncertainty : {},
      provenance: req.body?.provenance && typeof req.body.provenance === "object" ? req.body.provenance : {},
      payload: req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {},
    };
    await db.insert(evidenceRecords).values(record);
    res.status(201).json({ record });
  } catch (error) {
    next(error);
  }
});

router.get("/stream", requireAuth, (req: AuthenticatedRequest, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ userId: req.userId })}\n\n`);
  registerStreamClient(res, req.userId!);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unregisterStreamClient(res);
  });
});

router.post("/ingest/telemetry", async (req, res, next) => {
  const rawBody = ((req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString("utf8");
  let credential: ResolvedRelayCredential | null = null;
  try {
    credential = await resolveIngestCredential(req, rawBody);
  } catch (error) {
    next(error);
    return;
  }
  if (!credential) {
    res.status(401).json({ error: "Invalid local-node signature" });
    return;
  }
  if (credential.relayTokenId) void touchRelayToken(credential.relayTokenId);
  const ownerId = credential.ownerId;
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Telemetry body must be a JSON object" });
      return;
    }
    const body = req.body as {
      nodeId?: string;
      nodeName?: string;
      ownerId?: string;
      protocol?: "wifi" | "ble" | "csi" | "system";
      observedAt?: string;
      observations?: Array<{
        address?: string;
        vendor?: string;
        signalDbm?: number;
        signalQualityPercent?: number;
        channel?: string;
        serviceUuids?: string[];
        payload?: Record<string, unknown>;
      }>;
      metrics?: Record<string, number | string | boolean>;
      capabilities?: string[];
    };
    if (typeof body?.nodeId !== "string" || !body.nodeId.trim() || typeof body.ownerId !== "string" || !body.ownerId.trim() || !["wifi", "ble", "csi", "system"].includes(body.protocol || "")) {
      res.status(400).json({ error: "nodeId, ownerId, and a supported protocol are required" });
      return;
    }
    if (body.nodeId.length > 160 || body.ownerId.length > 255 || (body.observations !== undefined && (!Array.isArray(body.observations) || body.observations.length > 500))) {
      res.status(413).json({ error: "Telemetry payload exceeds allowed limits" });
      return;
    }
    // The relay must declare the operator its credential belongs to; a mismatch means a
    // token is being used to write into someone else's account and is refused.
    if (body.ownerId !== ownerId) {
      res.status(403).json({ error: "Node is not assigned to this operator" });
      return;
    }
    const nodeProtocol = body.protocol as "wifi" | "ble" | "csi" | "system";
    const now = new Date();
    const observedAt = parseDate(body.observedAt, now);
    if (Math.abs(now.getTime() - observedAt.getTime()) > 5 * 60_000) {
      res.status(400).json({ error: "Telemetry timestamp is outside the permitted 5-minute window" });
      return;
    }
    const currentNode = await db
      .select({ ownerId: scanNodes.ownerId })
      .from(scanNodes)
      .where(eq(scanNodes.id, body.nodeId))
      .limit(1);
    if (currentNode[0] && currentNode[0].ownerId !== ownerId) {
      res.status(403).json({ error: "Node ID is already assigned to another operator" });
      return;
    }
    // Only brand-new node ids consume relay allowance; an existing relay keeps reporting
    // even if the operator is over the limit for its current plan.
    if (!currentNode[0]) {
      const allowance = await mayRegisterAdditionalRelay(ownerId);
      if (!allowance.allowed) {
        res.status(403).json({
          error: `The current plan allows ${allowance.maxRelays} authorized relay${allowance.maxRelays === 1 ? "" : "s"}`,
          code: "relay_limit_reached",
          maxRelays: allowance.maxRelays,
        });
        return;
      }
    }
    await db
      .insert(scanNodes)
      .values({
        id: body.nodeId,
        ownerId,
        name: body.nodeName?.slice(0, 120) || body.nodeId,
        address: req.ip || "local",
        role: nodeProtocol.toUpperCase(),
        status: "online",
        lastHeartbeatAt: now,
      })
      .onConflictDoUpdate({
        target: scanNodes.id,
        set: {
          name: body.nodeName?.slice(0, 120) || body.nodeId,
          status: "online",
          lastHeartbeatAt: now,
          capabilities: body.capabilities?.slice(0, 20) || [],
        },
      });

    const normalizedProtocol =
      nodeProtocol === "wifi"
        ? ("WiFi" as const)
        : nodeProtocol === "ble"
          ? ("BLE" as const)
          : nodeProtocol === "csi"
            ? ("CSI" as const)
            : ("system" as const);
    const event = {
      id: id("telemetry"),
      ownerId,
      nodeId: body.nodeId,
      protocol: normalizedProtocol,
      observedAt,
      observations: body.observations || [],
      metrics: body.metrics || {},
    };
    await db.insert(telemetryEvents).values(event);

    // Every ingest path stores observations through one writer, so the ledger cannot
    // disagree with itself about how a device or a sighting is stored.
    await storeObservations({
      ownerId,
      nodeId: body.nodeId,
      protocol: normalizedProtocol,
      observedAt: event.observedAt,
      observations: event.observations,
    });

    if (Object.keys(event.metrics).length) {
      const confidence = typeof event.metrics.confidence === "number" && Number.isFinite(event.metrics.confidence) ? event.metrics.confidence : null;
      await db.insert(sensingSnapshots).values({
        id: id("sensing"),
        ownerId,
        nodeId: body.nodeId,
        observedAt: event.observedAt,
        metrics: event.metrics,
        confidence,
        uncertainty: {
          method: event.metrics.inferenceStatus || "unknown",
          nonMedical: event.metrics.medicalInference === false,
        },
      });
    }

  emit("telemetry", event, event.ownerId);
    res.status(202).json({ accepted: true, eventId: event.id });
  } catch (error) {
    next(error);
  }
});

export default router;