import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const scanSessionStatus = pgEnum("backspyne_scan_session_status", [
  "active",
  "paused",
  "closed",
]);
export const nodeStatus = pgEnum("backspyne_node_status", [
  "online",
  "offline",
  "degraded",
]);
export const rfProtocol = pgEnum("backspyne_rf_protocol", [
  "WiFi",
  "BLE",
  "CSI",
  "system",
]);

export const scanSessions = pgTable("backspyne_scan_sessions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  label: text("label").notNull(),
  status: scanSessionStatus("status").notNull().default("active"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  consentNote: text("consent_note"),
});

export const scanNodes = pgTable("backspyne_scan_nodes", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  role: text("role").notNull(),
  status: nodeStatus("status").notNull().default("offline"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rfDevices = pgTable("backspyne_rf_devices", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  address: text("address").notNull(),
  vendor: text("vendor").notNull().default("Unknown vendor"),
  protocol: rfProtocol("protocol").notNull(),
  lastSignalDbm: real("last_signal_dbm"),
  channel: text("channel"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  favorite: boolean("favorite").notNull().default(false),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => ({
  ownerAddressUnique: uniqueIndex("backspyne_rf_devices_owner_address_unique").on(table.ownerId, table.address),
}));

export const rfSightings = pgTable("backspyne_rf_sightings", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  deviceId: text("device_id").notNull(),
  nodeId: text("node_id").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  signalDbm: real("signal_dbm"),
  distanceMeters: real("distance_meters"),
  bearingDegrees: real("bearing_degrees"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const telemetryEvents = pgTable("backspyne_telemetry_events", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  nodeId: text("node_id").notNull(),
  protocol: rfProtocol("protocol").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  observations: jsonb("observations").notNull().default([]),
  metrics: jsonb("metrics").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceRecords = pgTable("backspyne_evidence_records", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  sessionId: text("session_id"),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  confidence: real("confidence"),
  uncertainty: jsonb("uncertainty").$type<Record<string, unknown>>().notNull().default({}),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sensingSnapshots = pgTable("backspyne_sensing_snapshots", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  nodeId: text("node_id").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  metrics: jsonb("metrics").$type<Record<string, number | string | boolean>>().notNull().default({}),
  confidence: real("confidence"),
  uncertainty: jsonb("uncertainty").$type<Record<string, unknown>>().notNull().default({}),
});

export const insertScanSessionSchema = createInsertSchema(scanSessions);
export const insertScanNodeSchema = createInsertSchema(scanNodes);
export const insertRfDeviceSchema = createInsertSchema(rfDevices);
export const insertRfSightingSchema = createInsertSchema(rfSightings);
export const insertTelemetryEventSchema = createInsertSchema(telemetryEvents);
export const insertEvidenceRecordSchema = createInsertSchema(evidenceRecords);
export const insertSensingSnapshotSchema = createInsertSchema(sensingSnapshots);

export type ScanSession = typeof scanSessions.$inferSelect;
export type ScanNode = typeof scanNodes.$inferSelect;
export type RfDevice = typeof rfDevices.$inferSelect;
export type RfSighting = typeof rfSightings.$inferSelect;
export type TelemetryEvent = typeof telemetryEvents.$inferSelect;
export type EvidenceRecord = typeof evidenceRecords.$inferSelect;
export type SensingSnapshot = typeof sensingSnapshots.$inferSelect;

export const telemetryObservationSchema = z.object({
  address: z.string().optional(),
  vendor: z.string().optional(),
  signalDbm: z.number().optional(),
  channel: z.string().optional(),
  serviceUuids: z.array(z.string()).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});