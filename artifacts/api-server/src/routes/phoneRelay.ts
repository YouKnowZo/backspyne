// The phone relay: a signed-in browser reporting its own sensor readings.
//
// Why this path exists. A desktop relay needs a Python service installed on a machine with
// an adapter; a phone browser has hardware too — a GNSS receiver, motion sensors, and on
// Android Chrome the BLE advertisement scanning API — and the operator already owns it. This
// route accepts those readings under the operator's own session, so nothing has to be
// downloaded or paired to start measuring.
//
// Two rules keep it honest:
//   * It is authenticated by the operator session, not by a paired relay token, so it does
//     not consume a paired-relay allowance. The session is what proves whose account the
//     readings belong to.
//   * A reading is only used as a position if the fix that came with it is accurate enough
//     to be one. A coarse fix is stored and displayed as a coarse fix, never quietly turned
//     into a distance measurement.

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { scanNodes, sensingSnapshots, telemetryEvents } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { storeObservations, validSignal } from "../lib/ingest";
import { ensureNodePlacementSchema } from "../lib/locationSchema";
import {
  MAX_FIX_ACCURACY_METERS,
  MAX_VANTAGE_ACCURACY_METERS,
  fixIsReportable,
  isUsableVantage,
  projectToSiteFrame,
  readGeoFix,
} from "../lib/siteFrame";
import {
  clearSiteOrigin,
  ensureSiteOriginSchema,
  readSiteOrigin,
  setSiteOrigin,
} from "../lib/siteOriginStore";
import { emit } from "../lib/stream";

const router: IRouter = Router();

/** Phone relays name themselves, and the prefix is what keeps the two ingest paths apart. */
const PHONE_NODE_PREFIX = "phone_";
const OBSERVATION_LIMIT = 200;
/** Same freshness rule as the bridge: a reading from the past is not a live measurement. */
const TIMESTAMP_WINDOW_MS = 5 * 60_000;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function readMetrics(value: unknown): Record<string, number | string | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metrics: Record<string, number | string | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "number" && Number.isFinite(entry)) metrics[key.slice(0, 60)] = Math.round(entry * 1000) / 1000;
    else if (typeof entry === "string") metrics[key.slice(0, 60)] = entry.slice(0, 200);
    else if (typeof entry === "boolean") metrics[key.slice(0, 60)] = entry;
  }
  return metrics;
}

/** One measured advertisement, in the vocabulary the ledger already understands. */
function readObservations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const address = typeof record.address === "string" ? record.address.trim() : "";
    if (!address) return [];
    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown>
      : {};
    return [{
      address,
      vendor: typeof record.vendor === "string" ? record.vendor.slice(0, 120) : "Unknown vendor",
      signalDbm: validSignal(record.signalDbm) ? record.signalDbm : undefined,
      signalQualityPercent: typeof record.signalQualityPercent === "number" ? record.signalQualityPercent : undefined,
      channel: typeof record.channel === "string" ? record.channel.slice(0, 40) : undefined,
      serviceUuids: Array.isArray(record.serviceUuids) ? record.serviceUuids.filter((uuid): uuid is string => typeof uuid === "string").slice(0, 64) : undefined,
      payload,
    }];
  });
}

/**
 * One sample from a phone: a heartbeat, whatever it heard, and where it was when it heard it.
 */
router.post("/phone-relay/sample", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const ownerId = req.userId!;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Sample body must be a JSON object" });
      return;
    }
    const payload = body as Record<string, unknown>;
    const nodeId = typeof payload.nodeId === "string" ? payload.nodeId.trim() : "";
    if (!nodeId.startsWith(PHONE_NODE_PREFIX) || nodeId.length > 160) {
      res.status(400).json({ error: "nodeId must identify a phone relay (phone_…)" });
      return;
    }
    const nodeName = typeof payload.nodeName === "string" && payload.nodeName.trim()
      ? payload.nodeName.trim().slice(0, 120)
      : "Phone relay";
    const now = new Date();
    const observedAt = parseDate(payload.observedAt, now);
    if (Math.abs(now.getTime() - observedAt.getTime()) > TIMESTAMP_WINDOW_MS) {
      res.status(400).json({ error: "Sample timestamp is outside the permitted 5-minute window" });
      return;
    }
    if (Array.isArray(payload.observations) && payload.observations.length > OBSERVATION_LIMIT) {
      res.status(413).json({ error: `A sample may carry at most ${OBSERVATION_LIMIT} observations` });
      return;
    }
    const observations = readObservations(payload.observations);
    const capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((entry): entry is string => typeof entry === "string").slice(0, 20)
      : [];
    const metrics = readMetrics(payload.metrics);

    const [placementReady, originReady] = await Promise.all([ensureNodePlacementSchema(), ensureSiteOriginSchema()]);

    // The phone node belongs to whoever registered it, exactly as a bridge node does.
    const [existingNode] = await db
      .select({ ownerId: scanNodes.ownerId })
      .from(scanNodes)
      .where(eq(scanNodes.id, nodeId))
      .limit(1);
    if (existingNode && existingNode.ownerId !== ownerId) {
      res.status(403).json({ error: "Node ID is already assigned to another operator" });
      return;
    }

    const fix = readGeoFix(payload.fix);
    const origin = originReady ? await readSiteOrigin(ownerId) : null;
    let originJustSet = false;
    let site: {
      origin: { lat: number; lon: number; setAt: string } | null;
      originIsThisDevice: boolean;
      justSet: boolean;
    } = { origin: null, originIsThisDevice: false, justSet: false };
    let position: {
      x: number | null;
      y: number | null;
      accuracyMeters: number | null;
      usedAsVantagePoint: boolean;
      accepted: boolean;
      reason: string | null;
    } | null = null;

    if (fix && !fixIsReportable(fix)) {
      position = {
        x: null,
        y: null,
        accuracyMeters: fix.accuracyMeters,
        usedAsVantagePoint: false,
        accepted: false,
        reason: `This fix is reported as ±${fix.accuracyMeters} m, which is too coarse to place anything. Position estimates need a fix accurate to ±${MAX_FIX_ACCURACY_METERS} m or better.`,
      };
    } else if (fix) {
      // The first accepted fix becomes the site origin; every later fix is projected into it.
      let resolvedOrigin = origin;
      if (!resolvedOrigin && originReady) {
        resolvedOrigin = await setSiteOrigin(ownerId, fix, nodeId);
        originJustSet = resolvedOrigin !== null;
      }
      if (resolvedOrigin) {
        const projected = projectToSiteFrame(fix, resolvedOrigin);
        const usable = isUsableVantage(fix);
        position = {
          ...projected,
          accuracyMeters: fix.accuracyMeters,
          usedAsVantagePoint: usable,
          accepted: usable,
          reason: usable
            ? null
            : fix.accuracyMeters === null
              ? `This fix did not report its accuracy, so it is shown as the phone's position but never used as a vantage point: without an accuracy there is no way to know how much of a measured distance is the phone's own error.`
              : `This fix is reported as ±${fix.accuracyMeters} m, so it is shown but not used as a vantage point: a distance measured from it would be dominated by its own error. Estimates use fixes of ±${MAX_VANTAGE_ACCURACY_METERS} m or better.`,
        };
        site = {
          origin: { lat: resolvedOrigin.lat, lon: resolvedOrigin.lon, setAt: resolvedOrigin.setAt },
          originIsThisDevice: resolvedOrigin.nodeId === nodeId,
          justSet: originJustSet,
        };
      } else {
        position = {
          x: null,
          y: null,
          accuracyMeters: fix.accuracyMeters,
          usedAsVantagePoint: false,
          accepted: false,
          reason: "The site origin could not be read or created on this deployment, so nothing can be placed in metres yet.",
        };
      }
    } else if (origin) {
      site = {
        origin: { lat: origin.lat, lon: origin.lon, setAt: origin.setAt },
        originIsThisDevice: origin.nodeId === nodeId,
        justSet: false,
      };
    }

    const protocol = observations.length ? "ble" as const : "system" as const;
    const normalizedProtocol = observations.length ? "BLE" as const : "system" as const;
    const placement = placementReady && position && typeof position.x === "number" && typeof position.y === "number"
      ? {
          positionX: position.x,
          positionY: position.y,
          positionLabel: position.accuracyMeters === null ? "phone fix" : `phone fix ±${position.accuracyMeters} m`,
        }
      : {};
    const nodeValues = {
      id: nodeId,
      ownerId,
      name: nodeName,
      address: "signed-in browser session",
      role: "PHONE",
      status: "online" as const,
      lastHeartbeatAt: now,
      capabilities,
    };
    await db
      .insert(scanNodes)
      .values({ ...nodeValues, ...placement })
      .onConflictDoUpdate({
        target: scanNodes.id,
        set: { name: nodeName, status: "online" as const, lastHeartbeatAt: now, capabilities, ...placement },
      });

    const event = {
      id: newId("telemetry"),
      ownerId,
      nodeId,
      protocol: normalizedProtocol,
      observedAt,
      observations,
      metrics,
    };
    await db.insert(telemetryEvents).values(event);

    const stored = await storeObservations({
      ownerId,
      nodeId,
      protocol: normalizedProtocol,
      observedAt,
      observations,
      vantage: position && position.usedAsVantagePoint && typeof position.x === "number" && typeof position.y === "number"
        ? { x: position.x, y: position.y, accuracyMeters: position.accuracyMeters, source: "geolocation" }
        : null,
    });

    if (Object.keys(metrics).length) {
      const confidence = typeof metrics.confidence === "number" ? metrics.confidence : null;
      await db.insert(sensingSnapshots).values({
        id: newId("sensing"),
        ownerId,
        nodeId,
        observedAt,
        metrics,
        confidence,
        uncertainty: {
          method: typeof metrics.motionState === "string" ? `phone sensor sample: ${metrics.motionState}` : "phone sensor sample",
          nonMedical: true,
        },
      });
    }

    // The console's own session hears a phone sample the moment it lands, like any relay.
    emit("telemetry", event, ownerId);

    res.status(202).json({
      accepted: true,
      eventId: event.id,
      observationsStored: stored,
      site,
      position,
      limits: { maxVantageAccuracyMeters: MAX_VANTAGE_ACCURACY_METERS, maxFixAccuracyMeters: MAX_FIX_ACCURACY_METERS },
    });
  } catch (error) {
    next(error);
  }
});

/** The site frame as it stands for this operator, so a phone can show where its origin is. */
router.get("/phone-relay/site", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const origin = await readSiteOrigin(req.userId!);
    const rows = await db
      .select({ id: scanNodes.id, name: scanNodes.name, positionX: scanNodes.positionX, positionY: scanNodes.positionY, lastHeartbeatAt: scanNodes.lastHeartbeatAt })
      .from(scanNodes)
      .where(eq(scanNodes.ownerId, req.userId!));
    const phoneNodes = rows
      .filter((row) => row.id.startsWith(PHONE_NODE_PREFIX))
      .map((row) => ({
        nodeId: row.id,
        name: row.name,
        x: row.positionX,
        y: row.positionY,
        lastHeartbeatAt: row.lastHeartbeatAt,
      }));
    res.json({
      origin,
      phoneNodes,
      limits: { maxVantageAccuracyMeters: MAX_VANTAGE_ACCURACY_METERS, maxFixAccuracyMeters: MAX_FIX_ACCURACY_METERS },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Moves or clears the origin. Setting it to a fresh fix is what an operator does at the door
 * of a new site; clearing it makes the next accepted fix the origin again.
 */
router.post("/phone-relay/site", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    if (action === "clear") {
      const cleared = await clearSiteOrigin(req.userId!);
      if (!cleared) {
        res.status(503).json({ error: "The site origin could not be cleared on this deployment" });
        return;
      }
      res.json({ origin: null });
      return;
    }
    if (action !== "set") {
      res.status(400).json({ error: "action must be set or clear" });
      return;
    }
    const fix = readGeoFix(req.body);
    if (!fix || !fixIsReportable(fix)) {
      res.status(400).json({ error: `A usable latitude and longitude are required, with accuracy ±${MAX_FIX_ACCURACY_METERS} m or better` });
      return;
    }
    const nodeId = typeof req.body?.nodeId === "string" && req.body.nodeId.trim() ? req.body.nodeId.trim().slice(0, 160) : null;
    const origin = await setSiteOrigin(req.userId!, fix, nodeId);
    if (!origin) {
      res.status(503).json({ error: "The site origin could not be stored on this deployment" });
      return;
    }
    res.json({ origin });
  } catch (error) {
    next(error);
  }
});

export default router;
