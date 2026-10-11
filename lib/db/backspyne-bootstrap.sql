-- Initial schema for a NEW, empty BackSpyne database.
-- Matches src/schema/backspyne.ts; not an upgrade migration for existing tables.
-- Run the entire transaction. Existing types/tables cause an error and rollback.
BEGIN;
CREATE TYPE backspyne_scan_session_status AS ENUM ('active', 'paused', 'closed');
CREATE TYPE backspyne_node_status AS ENUM ('online', 'offline', 'degraded');
CREATE TYPE backspyne_rf_protocol AS ENUM ('WiFi', 'BLE', 'CSI', 'system');
CREATE TABLE backspyne_scan_sessions (
  id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
  status backspyne_scan_session_status NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, consent_note text
);
CREATE TABLE backspyne_scan_nodes (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  address text NOT NULL, role text NOT NULL,
  status backspyne_node_status NOT NULL DEFAULT 'offline', last_heartbeat_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  position_x real, position_y real, position_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE backspyne_rf_devices (
  id text PRIMARY KEY, owner_id text NOT NULL, address text NOT NULL,
  vendor text NOT NULL DEFAULT 'Unknown vendor', protocol backspyne_rf_protocol NOT NULL,
  last_signal_dbm real, channel text,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  favorite boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX backspyne_rf_devices_owner_address_unique ON backspyne_rf_devices (owner_id, address);
CREATE TABLE backspyne_rf_sightings (
  id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL, node_id text NOT NULL,
  observed_at timestamptz NOT NULL, signal_dbm real, distance_meters real, bearing_degrees real,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE backspyne_telemetry_events (
  id text PRIMARY KEY, owner_id text NOT NULL, node_id text NOT NULL,
  protocol backspyne_rf_protocol NOT NULL, observed_at timestamptz NOT NULL,
  observations jsonb NOT NULL DEFAULT '[]'::jsonb, metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE backspyne_evidence_records (
  id text PRIMARY KEY, owner_id text NOT NULL, session_id text,
  kind text NOT NULL, source text NOT NULL, confidence real,
  uncertainty jsonb NOT NULL DEFAULT '{}'::jsonb, provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE backspyne_sensing_snapshots (
  id text PRIMARY KEY, owner_id text NOT NULL, node_id text NOT NULL, observed_at timestamptz NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb, confidence real, uncertainty jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Placement columns for a database created before relay placement existed. The API adds
-- these itself on first use (lib/locationSchema.ts); this block is the same upgrade for an
-- operator who would rather run it by hand. A no-op on a new database.
ALTER TABLE backspyne_scan_nodes ADD COLUMN IF NOT EXISTS position_x real;
ALTER TABLE backspyne_scan_nodes ADD COLUMN IF NOT EXISTS position_y real;
ALTER TABLE backspyne_scan_nodes ADD COLUMN IF NOT EXISTS position_label text;
COMMIT;
