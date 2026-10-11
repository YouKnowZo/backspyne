// The console's side of the calibration walk.
//
// The site's path-loss constants decide what every received level means in metres, so the
// operator has to be able to see which constants are in force, what a walk has collected so
// far, and what a fit would say before keeping it. None of that is computed here: the server
// owns the arithmetic and the thresholds, and this module only asks for them and describes
// what came back. Where a number is derived locally it is derived from the server's own
// response, never invented.
//
// Two shapes are worth keeping straight. A *candidate* is a radio the walk has heard from
// enough places to fit, or the reasons it has not. A *fit* is the model that came out of
// solving it. The console previews a fit, the operator keeps or discards it, and the kept one
// is the model in force until another walk replaces it or it is retired.

export interface CalibrationModel {
  referenceDbm: number;
  pathLossExponent: number;
  referenceMeters: number;
}

/** One radio's placement and residual, as solved. */
export interface CalibrationSolution {
  targetId: string;
  label: string;
  referenceDbm: number;
  x: number;
  y: number;
  /** Places this radio's position was solved from: one observation each. */
  samples: number;
  /** Readings those places produced, which is what the walk actually collected. */
  readings: number;
  vantages: number;
  residualRmsDb: number;
  minDistanceMeters: number;
  maxDistanceMeters: number;
  seededByGeometry: boolean;
}

export interface CalibrationFit {
  pathLossExponent: number;
  referenceMeters: number;
  referenceDbm: number;
  targets: CalibrationSolution[];
  /** Readings the fit stands on, before repeats at one place were collapsed. */
  samples: number;
  /** Places the fit was solved from: one observation each, the median level at that place. */
  observations: number;
  vantages: number;
  residualRmsDb: number;
  clampedExponent: boolean;
  warnings: string[];
}

export interface StoredCalibration extends CalibrationFit {
  id: string;
  method: string;
  calibratedAt: string;
  revokedAt: string | null;
}

export interface CalibrationRequirements {
  minVantagesPerTarget: number;
  minVantageSpreadMeters: number;
  minLevelSpreadDb: number;
  maxTargetDistanceMeters: number;
  exponentBounds: [number, number];
  referenceDbmBounds: [number, number];
  largeResidualDb: number;
}

export interface CalibrationCandidate {
  targetId: string;
  label: string;
  address: string | null;
  vendor: string | null;
  protocol: string | null;
  samples: number;
  vantages: number;
  levelSpreadDb: number;
  vantageSpreadMeters: number;
  eligible: boolean;
  /** The places the walk recorded this radio from, in metres in the site frame. */
  vantagePoints: Array<{ x: number; y: number }>;
  reasons: string[];
}

/** What one level implies under each model, so the difference is visible in metres. */
export interface CalibrationComparison {
  levelDbm: number;
  genericMeters: number;
  calibratedMeters: number;
}

export interface CalibrationOverview {
  active: StoredCalibration | null;
  retired: number;
  recent: StoredCalibration[];
  defaults: CalibrationModel;
  comparison: CalibrationComparison[];
  requirements: CalibrationRequirements;
  seededFrom: string;
}

export interface CalibrationCandidates {
  windowMinutes: number;
  samples: number;
  candidates: CalibrationCandidate[];
  eligibleCount: number;
  placementOnly: { count: number; labels: string[] };
  requirements: CalibrationRequirements;
}

export type CalibrationSolveResult =
  | { ok: true; fit: CalibrationFit; summaries: CalibrationCandidate[]; comparison: CalibrationComparison[]; windowMinutes: number; seedSource: string; requirements: CalibrationRequirements }
  | { ok: false; reasons: string[]; summaries: CalibrationCandidate[]; windowMinutes: number; seedSource: string; requirements: CalibrationRequirements };

export type KeepCalibrationResult =
  | { ok: true; saved: StoredCalibration; comparison: CalibrationComparison[]; summaries: CalibrationCandidate[] }
  | { ok: false; reasons: string[] };

export interface WalkSelection {
  /** Only these radios are fitted; all of them when omitted. */
  deviceIds?: string[];
  windowMinutes: number;
}

async function readJson<T>(response: Response): Promise<T | null> {
  return await response.json().catch(() => null) as T | null;
}

function failureMessage(status: number, payload: { error?: unknown } | null): string {
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  if (status === 401) return "This console is not signed in, so the calibration could not be read.";
  if (status === 503) return "This deployment cannot reach its database, so no calibration is available.";
  return `The calibration request failed (${status}).`;
}

/** The model in force, the defaults it replaced, and what a walk needs to replace it. */
export async function readCalibrationOverview(): Promise<CalibrationOverview> {
  const response = await fetch("/api/calibration", { credentials: "include" });
  const payload = await readJson<CalibrationOverview & { error?: unknown }>(response);
  if (!response.ok || !payload) throw new Error(failureMessage(response.status, payload));
  return payload;
}

/** What a walk has collected so far. Polled while the operator walks the site. */
export async function readCalibrationCandidates(windowMinutes: number): Promise<CalibrationCandidates> {
  const response = await fetch(`/api/calibration/candidates?windowMinutes=${encodeURIComponent(String(windowMinutes))}`, { credentials: "include" });
  const payload = await readJson<CalibrationCandidates & { error?: unknown }>(response);
  if (!response.ok || !payload) throw new Error(failureMessage(response.status, payload));
  return payload;
}

/**
 * Solves the fit from the walk's measurements without keeping it. A refusal is an answer, not
 * an error: it comes back with the reasons, which are the same reasons the candidate list
 * shows.
 */
export async function previewCalibration(selection: WalkSelection): Promise<CalibrationSolveResult> {
  const response = await fetch("/api/calibration/preview", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windowMinutes: selection.windowMinutes, deviceIds: selection.deviceIds ?? [] }),
  });
  const payload = await readJson<{
    ok?: unknown; fit?: CalibrationFit; reasons?: string[]; summaries?: CalibrationCandidate[];
    comparison?: CalibrationComparison[]; windowMinutes?: number; seedSource?: string;
    requirements?: CalibrationRequirements; error?: unknown;
  }>(response);
  if (!response.ok || !payload || typeof payload.ok !== "boolean") throw new Error(failureMessage(response.status, payload));
  const common = {
    summaries: payload.summaries ?? [],
    windowMinutes: payload.windowMinutes ?? selection.windowMinutes,
    seedSource: payload.seedSource ?? "unknown",
    requirements: payload.requirements ?? ({} as CalibrationRequirements),
  };
  if (!payload.ok) return { ok: false, reasons: payload.reasons ?? [], ...common };
  if (!payload.fit) throw new Error("The solve came back without a fit.");
  return { ok: true, fit: payload.fit, comparison: payload.comparison ?? [], ...common };
}

/** Fits and keeps the model. A fit the data cannot support is refused, and never stored. */
export async function keepCalibration(selection: WalkSelection): Promise<KeepCalibrationResult> {
  const response = await fetch("/api/calibration", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windowMinutes: selection.windowMinutes, deviceIds: selection.deviceIds ?? [] }),
  });
  const payload = await readJson<{ saved?: StoredCalibration; comparison?: CalibrationComparison[]; summaries?: CalibrationCandidate[]; reasons?: string[]; error?: unknown }>(response);
  if (response.status === 422) return { ok: false, reasons: payload?.reasons ?? [typeof payload?.error === "string" ? payload.error : "This walk cannot support a calibration yet."] };
  if (!response.ok || !payload?.saved) throw new Error(failureMessage(response.status, payload));
  return { ok: true, saved: payload.saved, comparison: payload.comparison ?? [], summaries: payload.summaries ?? [] };
}

/** Retires the calibration in force, which puts estimates back on the deployed defaults. */
export async function retireCalibration(): Promise<{ revoked: StoredCalibration | null; active: null; note: string }> {
  const response = await fetch("/api/calibration/clear", { method: "POST", credentials: "include" });
  const payload = await readJson<{ revoked?: StoredCalibration | null; note?: string; error?: unknown }>(response);
  if (!response.ok || !payload) throw new Error(failureMessage(response.status, payload));
  return { revoked: payload.revoked ?? null, active: null, note: payload.note ?? "The calibration was retired." };
}

export type WalkRequirementId = "places" | "span" | "levels";

export interface WalkRequirement {
  id: WalkRequirementId;
  label: string;
  detail: string;
  met: boolean;
}

/**
 * The three things a walk has to collect, per radio, as a checklist.
 *
 * The server states the same requirements in prose and those sentences are shown unchanged;
 * this list exists so progress is visible at a glance while walking, and it is derived only
 * from the numbers the server reported.
 */
export function walkChecklist(summary: CalibrationCandidate, requirements: CalibrationRequirements): WalkRequirement[] {
  const needed = requirements.minVantagesPerTarget;
  const places = summary.vantages;
  const span = summary.vantageSpreadMeters;
  const levels = summary.levelSpreadDb;
  return [
    {
      id: "places",
      label: `${places} of ${needed} places`,
      detail: places >= needed
        ? `Heard from ${places} distinct places, which is enough for a fix and a fit.`
        : `Stand still and let a few scans run at ${needed - places} more place${needed - places === 1 ? "" : "s"}.`,
      met: places >= needed,
    },
    {
      id: "span",
      label: `Walk spanning ${span} of ${requirements.minVantageSpreadMeters} m`,
      detail: span >= requirements.minVantageSpreadMeters
        ? `The places recorded span ${span} m, so the distances to this radio differ enough to fit.`
        : `Walk at least ${requirements.minVantageSpreadMeters} m across the site, passing this radio at different distances.`,
      met: span >= requirements.minVantageSpreadMeters,
    },
    {
      id: "levels",
      label: `Levels varying ${levels} of ${requirements.minLevelSpreadDb} dB`,
      detail: levels >= requirements.minLevelSpreadDb
        ? `The levels varied by ${levels} dB, so the fall-off rate is identifiable.`
        : `Get closer to and further from this radio: ${requirements.minLevelSpreadDb} dB of variation is needed before the fall-off rate can be fitted.`,
      met: levels >= requirements.minLevelSpreadDb,
    },
  ];
}

/** One sentence describing what a walk has collected, for a radio's row. */
export function describeWalkEvidence(summary: CalibrationCandidate): string {
  const places = `${summary.vantages} place${summary.vantages === 1 ? "" : "s"}`;
  const spread = `${summary.vantageSpreadMeters} m across`;
  const levels = `${summary.levelSpreadDb} dB of level variation`;
  const samples = `${summary.samples} reading${summary.samples === 1 ? "" : "s"}`;
  return `${samples} · ${places} · ${spread} · ${levels}`;
}

/** Whether a fit actually moved the constants away from the deployed defaults. */
export function modelDiffersFromDefaults(model: CalibrationModel, defaults: CalibrationModel): boolean {
  return model.pathLossExponent !== defaults.pathLossExponent || model.referenceDbm !== defaults.referenceDbm;
}

/** The windows the console offers, in minutes, with the words it shows for them. */
export const WALK_WINDOWS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 45, label: "45 minutes" },
  { minutes: 180, label: "3 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "24 hours" },
];

/** The window in force, falling back to the middle of the range when asked for an unknown one. */
export function walkWindowLabel(minutes: number): string {
  return WALK_WINDOWS.find(window => window.minutes === minutes)?.label ?? `${minutes} minutes`;
}
