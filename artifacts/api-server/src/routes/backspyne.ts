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

const router: IRouter = Router();
const streamClients = new Set<import("express").Response>();

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function emit(event: string, payload: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of streamClients) {
    try {
      client.write(message);
    } catch {
      streamClients.delete(client);
    }
  }
}

function verifyNodeSignature(req: import("express").Request, rawBody: string) {
  const configuredToken = process.env.BACKSPYNE_NODE_TOKEN;
  if (!configuredToken) return false;
  const suppliedToken = req.header("x-backspyne-node-token") || "";
  const signature = req.header("x-backspyne-signature") || "";
  if (suppliedToken !== configuredToken || !signature) return false;
  const digest = createHmac("sha256", configuredToken)
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(digest, "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function distanceFromSignal(signalDbm: number | null | undefined) {
  if (typeof signalDbm !== "number" || !Number.isFinite(signalDbm)) return null;
  return Math.max(0.5, Math.pow(10, (-45 - signalDbm) / 20));
}

function parseDate(value: unknown, fallback: Date) {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
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
    res.json({ devices: rows });
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
    res.json({ sightings });
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
  streamClients.add(res);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    streamClients.delete(res);
  });
});

router.post("/ingest/telemetry", async (req, res, next) => {
  const rawBody = JSON.stringify(req.body ?? {});
  if (!verifyNodeSignature(req, rawBody)) {
    res.status(401).json({ error: "Invalid local-node signature" });
    return;
  }
  try {
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
        channel?: string;
        serviceUuids?: string[];
        payload?: Record<string, unknown>;
      }>;
      metrics?: Record<string, number | string | boolean>;
      capabilities?: string[];
    };
    if (!body.nodeId || !body.ownerId || !body.protocol) {
      res.status(400).json({ error: "nodeId, ownerId, and protocol are required" });
      return;
    }
    const configuredOwnerId = process.env.BACKSPYNE_NODE_OWNER_ID;
    if (configuredOwnerId && configuredOwnerId !== body.ownerId) {
      res.status(403).json({ error: "Node is not assigned to this operator" });
      return;
    }
    const now = new Date();
    await db
      .insert(scanNodes)
      .values({
        id: body.nodeId,
        ownerId: body.ownerId,
        name: body.nodeName?.slice(0, 120) || body.nodeId,
        address: req.ip || "local",
        role: body.protocol.toUpperCase(),
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
      body.protocol === "wifi"
        ? ("WiFi" as const)
        : body.protocol === "ble"
          ? ("BLE" as const)
          : body.protocol === "csi"
            ? ("CSI" as const)
            : ("system" as const);
    const event = {
      id: id("telemetry"),
      ownerId: body.ownerId,
      nodeId: body.nodeId,
      protocol: normalizedProtocol,
      observedAt: parseDate(body.observedAt, now),
      observations: body.observations || [],
      metrics: body.metrics || {},
    };
    await db.insert(telemetryEvents).values(event);

    for (const observation of event.observations) {
      if (!observation.address) continue;
      const deviceId = id("device");
      const existing = await db
        .select({ id: rfDevices.id })
        .from(rfDevices)
        .where(
          and(
            eq(rfDevices.ownerId, body.ownerId),
            eq(rfDevices.address, observation.address),
          ),
        )
        .limit(1);
      const values = {
        ownerId: body.ownerId,
        address: observation.address,
        vendor: observation.vendor || "Unknown vendor",
        protocol:
          observation.payload?.source === "ble_adapter"
            ? ("BLE" as const)
            : ("WiFi" as const),
        lastSignalDbm: observation.signalDbm ?? null,
        channel: observation.channel || null,
        lastSeenAt: event.observedAt,
        metadata: {
          serviceUuids: observation.serviceUuids || [],
          payload: observation.payload || {},
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
        signalDbm: observation.signalDbm ?? null,
        distanceMeters: distanceFromSignal(observation.signalDbm),
        metadata: { channel: observation.channel || null },
      });
    }

    if (Object.keys(event.metrics).length) {
      const confidence = typeof event.metrics.confidence === "number" ? event.metrics.confidence : null;
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

    emit("telemetry", event);
    res.status(202).json({ accepted: true, eventId: event.id });
  } catch (error) {
    next(error);
  }
});

export default router;