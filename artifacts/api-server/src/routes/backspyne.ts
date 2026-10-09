import { Router, type IRouter } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

const router: IRouter = Router();
const streamClients = new Map<import("express").Response, string>();

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function emit(event: string, payload: unknown, ownerId?: string) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [client, clientOwnerId] of streamClients) {
    if (ownerId && clientOwnerId !== ownerId) continue;
    try {
      client.write(message);
    } catch {
      streamClients.delete(client);
    }
  }
}

function verifyNodeSignature(req: import("express").Request, rawBody: string) {
  const configuredToken = process.env.BACKSPYNE_NODE_TOKEN;
  if (!configuredToken || configuredToken.length < 32) return false;
  const suppliedToken = req.header("x-backspyne-node-token") || "";
  const signature = req.header("x-backspyne-signature") || "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const suppliedTokenBytes = Buffer.from(suppliedToken);
  const configuredTokenBytes = Buffer.from(configuredToken);
  if (suppliedTokenBytes.length !== configuredTokenBytes.length || !timingSafeEqual(suppliedTokenBytes, configuredTokenBytes)) return false;
  const digest = createHmac("sha256", configuredToken)
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(digest, "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validSignal(signalDbm: unknown): signalDbm is number {
  return typeof signalDbm === "number" && Number.isFinite(signalDbm) && signalDbm >= -127 && signalDbm <= 20;
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
    for (const sighting of sightings) {
      const meta = sighting.signalQualityPercent as Record<string, unknown>;
      if (!latestQuality.has(sighting.deviceId) && typeof meta.signalQualityPercent === "number") {
        latestQuality.set(sighting.deviceId, meta.signalQualityPercent);
      }
    }
    res.json({ devices: rows.map((device) => ({ ...device, signalQualityPercent: latestQuality.get(device.id) ?? null })) });
  } catch (error) {
    next(error);
  }
});

router.get("/nodes", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rows = await db
      .select()
      .from(scanNodes)
      .where(eq(scanNodes.ownerId, req.userId!))
      .orderBy(desc(scanNodes.lastHeartbeatAt));
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
    res.json({ sightings: sightings.map((sighting) => ({
      observedAt: sighting.observedAt,
      signalDbm: sighting.signalDbm,
      distanceMeters: null,
      signalQualityPercent: (sighting.metadata as Record<string, unknown>).signalQualityPercent ?? null,
    })) });
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
  streamClients.set(res, req.userId!);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    streamClients.delete(res);
  });
});

router.post("/ingest/telemetry", async (req, res, next) => {
  const rawBody = ((req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString("utf8");
  if (!verifyNodeSignature(req, rawBody)) {
    res.status(401).json({ error: "Invalid local-node signature" });
    return;
  }
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
    const configuredOwnerId = process.env.BACKSPYNE_NODE_OWNER_ID;
    if (!configuredOwnerId) {
      res.status(503).json({ error: "Node owner binding is not configured" });
      return;
    }
    if (configuredOwnerId !== body.ownerId) {
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
    if (currentNode[0] && currentNode[0].ownerId !== body.ownerId) {
      res.status(403).json({ error: "Node ID is already assigned to another operator" });
      return;
    }
    // Only brand-new node ids consume relay allowance; an existing relay keeps reporting
    // even if the operator is over the limit for its current plan.
    if (!currentNode[0]) {
      const allowance = await mayRegisterAdditionalRelay(body.ownerId);
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
        ownerId: body.ownerId,
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
      ownerId: body.ownerId,
      nodeId: body.nodeId,
      protocol: normalizedProtocol,
      observedAt,
      observations: body.observations || [],
      metrics: body.metrics || {},
    };
    await db.insert(telemetryEvents).values(event);

    for (const observation of event.observations) {
      if (typeof observation.address !== "string" || !/^[0-9A-Fa-f:.-]{1,80}$/.test(observation.address)) continue;
      const deviceId = id("device");
      const existing = await db
        .select({ id: rfDevices.id, vendor: rfDevices.vendor, channel: rfDevices.channel, metadata: rfDevices.metadata })
        .from(rfDevices)
        .where(
          and(
            eq(rfDevices.ownerId, body.ownerId),
            eq(rfDevices.address, observation.address),
          ),
        )
        .limit(1);
      const source = observation.payload?.source;
      const observationProtocol = source === "ble_adapter" ? "BLE" as const : source === "wifi_os_api" ? "WiFi" as const : normalizedProtocol;
      const observationPayload = { ...(observation.payload || {}) };
      delete observationPayload.source;
      const priorMetadata = existing[0]?.metadata ?? {};
      const priorPayload = priorMetadata.payload && typeof priorMetadata.payload === "object"
        ? priorMetadata.payload as Record<string, unknown>
        : {};
      const mergedPayload: Record<string, unknown> = {
        ...priorPayload,
        ...Object.fromEntries(Object.entries(observationPayload).filter(([, value]) => value !== null && value !== "")),
      };
      if (priorPayload.manufacturerData && observationPayload.manufacturerData && typeof priorPayload.manufacturerData === "object" && typeof observationPayload.manufacturerData === "object") {
        mergedPayload.manufacturerData = {
          ...priorPayload.manufacturerData as Record<string, unknown>,
          ...observationPayload.manufacturerData as Record<string, unknown>,
        };
      }
      const currentServiceUuids = observation.serviceUuids?.filter((uuid) => typeof uuid === "string") || [];
      const priorServiceUuids = Array.isArray(priorMetadata.serviceUuids) ? priorMetadata.serviceUuids.filter((uuid): uuid is string => typeof uuid === "string") : [];
      const submittedVendor = typeof observation.vendor === "string" ? observation.vendor.slice(0, 120) : "Unknown vendor";
      const values = {
        ownerId: body.ownerId,
        address: observation.address.slice(0, 80),
        vendor: submittedVendor !== "Unknown vendor"
          ? submittedVendor
          : observationProtocol === "BLE" || observationPayload.addressType === "private/randomized address"
            ? "Unknown vendor"
            : (existing[0]?.vendor ?? submittedVendor),
        protocol: observationProtocol,
        lastSignalDbm: validSignal(observation.signalDbm) ? observation.signalDbm : null,
        channel: typeof observation.channel === "string" ? observation.channel.slice(0, 40) : existing[0]?.channel ?? null,
        lastSeenAt: event.observedAt,
        metadata: {
          ...priorMetadata,
          serviceUuids: [...new Set([...priorServiceUuids, ...currentServiceUuids])].slice(0, 64),
          payload: mergedPayload,
        },
      };
      if (existing[0]) {
        await db.update(rfDevices).set(values).where(eq(rfDevices.id, existing[0].id));
      } else {
        await db.insert(rfDevices).values({ id: deviceId, ...values });
      }
      await db.insert(rfSightings).values({
        id: id("sighting"),
        ownerId: body.ownerId,
        deviceId: existing[0]?.id ?? deviceId,
        nodeId: body.nodeId,
        observedAt: event.observedAt,
        signalDbm: validSignal(observation.signalDbm) ? observation.signalDbm : null,
        distanceMeters: null,
        metadata: { channel: typeof observation.channel === "string" ? observation.channel.slice(0, 40) : null, signalQualityPercent: typeof observation.signalQualityPercent === "number" && observation.signalQualityPercent >= 0 && observation.signalQualityPercent <= 100 ? observation.signalQualityPercent : null },
      });
    }

    if (Object.keys(event.metrics).length) {
      const confidence = typeof event.metrics.confidence === "number" && Number.isFinite(event.metrics.confidence) ? event.metrics.confidence : null;
      await db.insert(sensingSnapshots).values({
        id: id("sensing"),
        ownerId: body.ownerId,
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