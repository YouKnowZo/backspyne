// The calibration walk, over HTTP.
//
// The console needs three things and nothing more: what radios a walk could be fitted from
// right now, what the fit would say if it were solved, and a way to keep or discard the
// result. Solving lives in `lib/calibration.ts` and storing in `lib/calibrationStore.ts`, so
// this file only gathers the measurements, decides what may be fitted, and reports the
// outcome in the console's own words.
//
// The seed matters and is reported: a first calibration starts from the deployed defaults,
// and a later one starts from the model already in force. A second walk therefore refines the
// site rather than replacing it with a fit from one short walk.

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import {
  EXPONENT_BOUNDS,
  LARGE_RESIDUAL_DB,
  MAX_TARGET_DISTANCE_METERS,
  MIN_LEVEL_SPREAD_DB,
  MIN_VANTAGES_PER_TARGET,
  MIN_VANTAGE_SPREAD_METERS,
  REFERENCE_DBM_BOUNDS,
  compareAtLevel,
  fitSiteCalibration,
  summarizeCalibrationSamples,
  type CalibrationFit,
  type CalibrationSample,
} from "../lib/calibration";
import { listCalibrations, readActiveCalibration, revokeActiveCalibration, saveCalibration } from "../lib/calibrationStore";
import { DEFAULT_RADIO_MODEL } from "../lib/localization";
import { DERIVED_LEVEL_NOTE, dbmFromLinkQualityPercent, usableDbm } from "../lib/signal";
import { vantageFromSighting, vantageKeyFor } from "../lib/vantage";

const router: IRouter = Router();

const DEFAULT_WINDOW_MINUTES = 180;
const MAX_WINDOW_MINUTES = 24 * 60;
const SIGHTING_LIMIT = 5000;
/** Levels the console compares the two models at, so the difference is visible in metres. */
const COMPARISON_LEVELS = [-50, -60, -70, -80];

type SightingRow = {
  device_id: string;
  node_id: string;
  signal_dbm: number | null;
  metadata: Record<string, unknown> | null;
};

type DeviceRow = { id: string; address: string; vendor: string; protocol: string };

/**
 * The level to fit from, for one stored sighting: the adapter's own dBm when it reported one,
 * otherwise the level its link-quality percentage maps to.
 *
 * A WiFi access point heard from a Windows relay reports `Signal: NN%` and no power, so before
 * this mapping those readings could not calibrate anything while BLE advertisers from the same
 * machine could. A row that holds neither is skipped, because a reading with no level
 * constrains nothing.
 */
function sightingLevel(row: { signal_dbm: number | null; metadata: Record<string, unknown> | null }): { dbm: number; derived: boolean } | null {
  if (usableDbm(row.signal_dbm)) return { dbm: row.signal_dbm, derived: false };
  const derived = dbmFromLinkQualityPercent(row.metadata?.signalQualityPercent);
  return derived === null ? null : { dbm: derived, derived: true };
}

function readWindowMinutes(value: unknown): number {
  const requested = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(requested)) return DEFAULT_WINDOW_MINUTES;
  return Math.max(10, Math.min(MAX_WINDOW_MINUTES, Math.round(requested)));
}

/** Every measured sighting from a relay that reported where it was, inside the window. */
async function gatherSamples(ownerId: string, windowMinutes: number): Promise<{
  samples: CalibrationSample[];
  devices: Map<string, DeviceRow>;
  staticOnlyLabels: string[];
  heardFromPlacementOnly: number;
  /** Readings whose level came from a link-quality percentage rather than measured power. */
  derivedLevels: number;
  /** The same count per radio, so a fit over selected radios reports its own share. */
  derivedLevelsByTarget: Map<string, number>;
}> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const [sightings, devices] = await Promise.all([
    pool.query<SightingRow>(
      "SELECT device_id, node_id, signal_dbm, metadata FROM backspyne_rf_sightings WHERE owner_id = $1 AND observed_at >= $2 ORDER BY observed_at DESC LIMIT $3",
      [ownerId, since, SIGHTING_LIMIT],
    ),
    pool.query<DeviceRow>("SELECT id, address, vendor, protocol FROM backspyne_rf_devices WHERE owner_id = $1", [ownerId]),
  ]);
  const deviceById = new Map(devices.rows.map((device) => [device.id, device]));
  const samples: CalibrationSample[] = [];
  const placementOnly = new Map<string, number>();
  const samplesPerDevice = new Map<string, number>();
  const derivedLevelsByTarget = new Map<string, number>();
  let derivedLevels = 0;
  for (const row of sightings.rows) {
    const vantage = vantageFromSighting({ nodeId: row.node_id, metadata: row.metadata });
    const label = deviceById.get(row.device_id)?.address ?? row.device_id;
    if (!vantage) {
      placementOnly.set(label, (placementOnly.get(label) ?? 0) + 1);
      continue;
    }
    const level = sightingLevel(row);
    if (!level) continue;
    if (level.derived) {
      derivedLevels += 1;
      derivedLevelsByTarget.set(row.device_id, (derivedLevelsByTarget.get(row.device_id) ?? 0) + 1);
    }
    samples.push({
      targetId: row.device_id,
      label,
      // The same bucketing the position maths uses: two reports from one place are one
      // vantage point, not two independent measurements.
      vantageKey: vantageKeyFor(row.node_id, vantage.x, vantage.y),
      x: vantage.x,
      y: vantage.y,
      rssi: level.dbm,
    });
    samplesPerDevice.set(row.device_id, (samplesPerDevice.get(row.device_id) ?? 0) + 1);
  }
  // A placed relay stands in one place, so its measurements cannot calibrate anything; those
  // radios are named so the console can explain why they are missing instead of just omitting them.
  const staticOnlyLabels = [...placementOnly.entries()]
    .filter(([label]) => {
      const id = [...deviceById.entries()].find(([, device]) => device.address === label)?.[0];
      return !id || !samplesPerDevice.has(id);
    })
    .map(([label]) => label)
    .slice(0, 5);
  return { samples, devices: deviceById, staticOnlyLabels, heardFromPlacementOnly: placementOnly.size, derivedLevels, derivedLevelsByTarget };
}

/**
 * What a walk should say about levels it did not measure. Composed here rather than in the
 * console so both the candidate list and the fit describe them in the same words.
 */
function derivedLevelNote(derivedLevels: number, samples: number): string | null {
  if (!derivedLevels) return null;
  return `${derivedLevels} of the ${samples} reading${samples === 1 ? "" : "s"} in this window reported a link-quality percentage rather than a level, and ${derivedLevels === 1 ? "that reading was" : "those readings were"} converted to dBm for the fit. ${DERIVED_LEVEL_NOTE}`;
}

function requirements() {
  return {
    minVantagesPerTarget: MIN_VANTAGES_PER_TARGET,
    minVantageSpreadMeters: MIN_VANTAGE_SPREAD_METERS,
    minLevelSpreadDb: MIN_LEVEL_SPREAD_DB,
    maxTargetDistanceMeters: MAX_TARGET_DISTANCE_METERS,
    exponentBounds: EXPONENT_BOUNDS,
    referenceDbmBounds: REFERENCE_DBM_BOUNDS,
    largeResidualDb: LARGE_RESIDUAL_DB,
  };
}

/** The model in force, the defaults it replaced, and what is needed to fit a new one. */
router.get("/calibration", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const [active, recent] = await Promise.all([
      readActiveCalibration(req.userId!),
      listCalibrations(req.userId!, 10),
    ]);
    // What the model in force says a level implies, next to what the deployed defaults say.
    // Solved here rather than in the console so the distance maths has one implementation.
    const inForce = active ?? { ...DEFAULT_RADIO_MODEL, targets: [] };
    res.json({
      active,
      retired: recent.filter((calibration) => calibration.revokedAt !== null).length,
      recent,
      defaults: DEFAULT_RADIO_MODEL,
      comparison: COMPARISON_LEVELS.map((levelDbm) => ({ levelDbm, ...compareAtLevel(levelDbm, inForce) })),
      requirements: requirements(),
      seededFrom: active ? "the calibration already in force" : "the deployed generic defaults",
    });
  } catch (error) {
    next(error);
  }
});

/**
 * What a walk has collected so far. The console polls this while a calibration walk is
 * running, so the operator can see a radio become fittable rather than guessing when to stop.
 */
router.get("/calibration/candidates", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const windowMinutes = readWindowMinutes(req.query.windowMinutes);
    const { samples, devices, staticOnlyLabels, derivedLevels } = await gatherSamples(req.userId!, windowMinutes);
    const summaries = summarizeCalibrationSamples(samples).map((summary) => {
      const device = devices.get(summary.targetId);
      return {
        ...summary,
        label: device ? `${device.vendor === "Unknown vendor" ? device.address : device.vendor} · ${device.address}` : summary.label,
        address: device?.address ?? null,
        vendor: device?.vendor ?? null,
        protocol: device?.protocol ?? null,
      };
    });
    res.json({
      windowMinutes,
      samples: samples.length,
      derivedLevels,
      derivedLevelNote: derivedLevelNote(derivedLevels, samples.length),
      candidates: summaries,
      eligibleCount: summaries.filter((summary) => summary.eligible).length,
      placementOnly: { count: staticOnlyLabels.length, labels: staticOnlyLabels },
      requirements: requirements(),
    });
  } catch (error) {
    next(error);
  }
});

/** Solves a fit from the chosen radios without keeping it, so a result can be judged first. */
async function solveForRequest(ownerId: string, body: unknown): Promise<{
  outcome: ReturnType<typeof fitSiteCalibration>;
  windowMinutes: number;
  seedSource: string;
  comparison: Array<{ levelDbm: number; genericMeters: number; calibratedMeters: number }>;
  derivedLevels: number;
  derivedLevelNote: string | null;
}> {
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const windowMinutes = readWindowMinutes(payload.windowMinutes);
  const requested = Array.isArray(payload.deviceIds)
    ? payload.deviceIds.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 200).slice(0, 12)
    : [];
  const { samples, derivedLevelsByTarget } = await gatherSamples(ownerId, windowMinutes);
  const selected = requested.length ? samples.filter((sample) => requested.includes(sample.targetId)) : samples;
  // Counted per radio and not per reading: `gatherSamples` counts what it read per radio, and a
  // radio contributes the same count however many of its readings were selected.
  const selectedTargets = new Set(selected.map((sample) => sample.targetId));
  const derivedLevels = [...selectedTargets].reduce((total, targetId) => total + (derivedLevelsByTarget.get(targetId) ?? 0), 0);
  // Seeding from the model in force is what makes a second walk a refinement, not a restart.
  const active = await readActiveCalibration(ownerId);
  const seedModel = active
    ? { referenceDbm: active.referenceDbm, pathLossExponent: active.pathLossExponent, referenceMeters: active.referenceMeters }
    : DEFAULT_RADIO_MODEL;
  const outcome = fitSiteCalibration(selected, { model: seedModel });
  const comparison = outcome.ok
    ? COMPARISON_LEVELS.map((levelDbm) => ({ levelDbm, ...compareAtLevel(levelDbm, outcome.fit, requested.length === 1 ? requested[0] : undefined) }))
    : [];
  return {
    outcome,
    windowMinutes,
    seedSource: active ? "the calibration already in force" : "the deployed generic defaults",
    comparison,
    derivedLevels,
    derivedLevelNote: derivedLevelNote(derivedLevels, selected.length),
  };
}

router.post("/calibration/preview", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { outcome, windowMinutes, seedSource, comparison, derivedLevels, derivedLevelNote: note } = await solveForRequest(req.userId!, req.body);
    res.json({
      ok: outcome.ok,
      ...(outcome.ok ? { fit: outcome.fit } : { reasons: outcome.reasons }),
      summaries: outcome.summaries,
      comparison,
      derivedLevels,
      derivedLevelNote: note,
      windowMinutes,
      seedSource,
      requirements: requirements(),
    });
  } catch (error) {
    next(error);
  }
});

/** Fits and keeps the model. A fit that cannot be supported is refused, never stored. */
router.post("/calibration", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { outcome, windowMinutes, seedSource, comparison, derivedLevels, derivedLevelNote: note } = await solveForRequest(req.userId!, req.body);
    if (!outcome.ok) {
      res.status(422).json({
        error: "This walk cannot support a calibration yet, so nothing was stored.",
        reasons: outcome.reasons,
        summaries: outcome.summaries,
        derivedLevels,
        derivedLevelNote: note,
        windowMinutes,
        requirements: requirements(),
      });
      return;
    }
    const method = outcome.fit.targets.length > 1
      ? `calibration walk over ${outcome.fit.targets.length} radios`
      : "calibration walk over one radio";
    const saved = await saveCalibration(req.userId!, outcome.fit as CalibrationFit, { id: `calibration_${randomUUID()}`, method });
    if (!saved) {
      res.status(503).json({ error: "The calibration could not be stored on this deployment." });
      return;
    }
    res.status(201).json({ saved, comparison, derivedLevels, derivedLevelNote: note, windowMinutes, seedSource, summaries: outcome.summaries });
  } catch (error) {
    next(error);
  }
});

/** Retires the active calibration, which puts estimates back on the deployed defaults. */
router.post("/calibration/clear", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const revoked = await revokeActiveCalibration(req.userId!);
    if (!revoked) {
      res.json({ revoked: null, active: null, note: "No calibration was in force, so estimates were already using the generic defaults." });
      return;
    }
    res.json({
      revoked,
      active: null,
      note: "The calibration was retired. Its record is kept, and estimates use the generic defaults until another walk is fitted.",
    });
  } catch (error) {
    next(error);
  }
});

export default router;
