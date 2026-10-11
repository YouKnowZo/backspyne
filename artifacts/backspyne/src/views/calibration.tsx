// The calibration walk.
//
// Every distance this product reports comes from the path-loss model: a received level, a
// reference level one metre from the transmitter, and an exponent saying how fast the level
// falls away. The deployed constants are a reasonable indoor guess. This view replaces them
// with constants measured in the building they are used in, and it is built around three
// honest positions:
//
//   * The walk is recorded, not typed. A phone running the relay reports where it stood with
//     each reading, so walking the site with that phone is what supplies the known positions.
//     This view never asks an operator to type a coordinate for a measurement that was not
//     taken there, and it draws the places that were actually recorded, so a walk that never
//     moved is visible before anything is fitted.
//   * A fit is judged before it is kept. Solving is free and repeatable; keeping is the
//     decision, and it is made against the fitted constants, the residuals, and what the model
//     says in metres next to what the defaults say.
//   * A walk that cannot support a fit is refused with its reason. The server makes that
//     judgement, the console shows its words unchanged, and no button here overrides it.
//
// The constants in force are shown as what they are: the model the server actually uses for
// this account, with its provenance, whether that is a walk or the generic defaults.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { CheckCircle2, CircleHelp, Crosshair, Loader2, RefreshCw, Ruler, Trash2, X } from 'lucide-react';

import { SiteMap } from '../components/location';
import { useConsoleData } from '../lib/console-data';
import { timeAgo } from '../lib/format';
import {
  WALK_WINDOWS,
  describeWalkEvidence,
  keepCalibration,
  modelDiffersFromDefaults,
  previewCalibration,
  readCalibrationCandidates,
  readCalibrationOverview,
  retireCalibration,
  walkChecklist,
  walkWindowLabel,
  type CalibrationCandidate,
  type CalibrationComparison,
  type CalibrationOverview,
  type CalibrationRequirements,
  type CalibrationSolveResult,
} from '../lib/calibration';
import { VIEW_PATHS } from '../lib/types';

/** How often the walk's collected measurements are re-read while this view is open. */
const WALK_POLL_MS = 10_000;

/** The walk is recorded by the phone relay, so this view points at the view that lists relays. */
const PHONE_RELAY_PATH = VIEW_PATHS.nodes;

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';
type ModelConstants = CalibrationOverview['defaults'];

function isUnavailableMessage(message: string): boolean {
  return /not signed in|database/.test(message);
}

/**
 * What a level implies under each model, in metres. The server answers this, so the distance
 * maths has one implementation and the console cannot drift from what positions actually use.
 */
function ComparisonTable({ comparison, defaults, active }: { comparison: CalibrationComparison[]; defaults: ModelConstants; active: boolean }) {
  if (!comparison.length) return null;
  return <div className="location-table calibration-comparison" data-testid="calibration-comparison">
    <div className="list-head" aria-hidden="true"><span>Level</span><span>Generic defaults</span><span>{active ? 'In force here' : 'No calibration'}</span></div>
    {comparison.map(row => <div className="location-row" key={row.levelDbm}>
      <span>{row.levelDbm} dBm heard</span>
      <span>{row.genericMeters} m</span>
      <span className={active && row.calibratedMeters !== row.genericMeters ? 'calibration-shift' : ''}>
        {active ? `${row.calibratedMeters} m` : 'same as defaults'}
      </span>
    </div>)}
    <p className="location-note">
      The generic model is {defaults.referenceDbm} dBm at {defaults.referenceMeters} m with an exponent of {defaults.pathLossExponent}.
      {active
        ? ' Every position estimate on this account uses the “in force here” column.'
        : ' No walk has been kept, so both columns are the same and every estimate uses the defaults.'}
    </p>
  </div>;
}

/** One radio the walk has heard, with what it still needs before it can be fitted. */
function CandidateCard({ candidate, requirements, onFit }: {
  candidate: CalibrationCandidate;
  requirements: CalibrationRequirements;
  onFit: (targetId: string) => void;
}) {
  const checklist = walkChecklist(candidate, requirements);
  const vendor = candidate.vendor && candidate.vendor !== 'Unknown vendor' ? candidate.vendor : candidate.label;
  return <div className={`calibration-candidate ${candidate.eligible ? 'ready' : ''}`} data-testid={`calibration-candidate-${candidate.targetId}`}>
    <div className="calibration-candidate-head">
      <div>
        <div className="calibration-candidate-name">{vendor}</div>
        <div className="calibration-candidate-meta">{candidate.label}{candidate.protocol ? ` · ${candidate.protocol}` : ''} · {describeWalkEvidence(candidate)}</div>
      </div>
      <span className={`hardware-status ${candidate.eligible ? 'connected' : 'limited'}`} data-testid={`calibration-state-${candidate.targetId}`}>
        {candidate.eligible ? 'READY TO FIT' : 'STILL WALKING'}
      </span>
    </div>
    <div className="checklist-steps">
      {checklist.map(item => <div className={`checklist-step ${item.met ? 'ok' : 'warn'}`} key={item.id} data-testid={`calibration-requirement-${candidate.targetId}-${item.id}`}>
        <span className="checklist-mark">{item.met ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleHelp size={14} aria-hidden="true" />}</span>
        <div><strong>{item.label}</strong><span>{item.detail}</span></div>
      </div>)}
    </div>
    {candidate.reasons.length > 0 && <ul className="calibration-reasons">
      {candidate.reasons.map(reason => <li key={reason}>{reason}</li>)}
    </ul>}
    {candidate.eligible && <div className="calibration-candidate-actions">
      <button className="btn" onClick={() => onFit(candidate.targetId)} data-testid={`button-fit-${candidate.targetId}`}>
        <Ruler size={13} aria-hidden="true" /> Solve this radio on its own
      </button>
    </div>}
  </div>;
}

export function Calibration() {
  const { nodes, apiConnected, siteLabel } = useConsoleData();
  const [overview, setOverview] = useState<CalibrationOverview | null>(null);
  const [candidates, setCandidates] = useState<CalibrationCandidate[]>([]);
  const [requirements, setRequirements] = useState<CalibrationRequirements | null>(null);
  const [placementOnly, setPlacementOnly] = useState<{ count: number; labels: string[] }>({ count: 0, labels: [] });
  const [windowMinutes, setWindowMinutes] = useState(WALK_WINDOWS[1].minutes);
  const [state, setState] = useState<LoadState>('loading');
  const [message, setMessage] = useState('');
  const [walkSamples, setWalkSamples] = useState(0);
  const [preview, setPreview] = useState<CalibrationSolveResult | null>(null);
  const [busy, setBusy] = useState<'' | 'solving' | 'keeping' | 'retiring'>('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  // The walk's own places, for the map: every place any radio in the window was heard from.
  const walkPoints = useMemo(() => {
    const points = new Map<string, { x: number; y: number }>();
    for (const candidate of candidates) for (const point of candidate.vantagePoints) points.set(`${point.x}:${point.y}`, point);
    return [...points.values()];
  }, [candidates]);

  const refreshOverview = useCallback(async () => {
    try {
      const next = await readCalibrationOverview();
      setOverview(next);
      setRequirements(next.requirements);
      setMessage('');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The calibration could not be read.';
      setState(isUnavailableMessage(text) ? 'unavailable' : 'error');
      setMessage(text);
    }
  }, []);

  const refreshCandidates = useCallback(async () => {
    try {
      const next = await readCalibrationCandidates(windowMinutes);
      setCandidates(next.candidates);
      setRequirements(next.requirements);
      setPlacementOnly(next.placementOnly);
      setWalkSamples(next.samples);
      setState('ready');
      setMessage('');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The walk could not be read.';
      setState(isUnavailableMessage(text) ? 'unavailable' : 'error');
      setMessage(text);
    }
  }, [windowMinutes]);

  useEffect(() => { void refreshOverview(); }, [refreshOverview]);

  // The walk is polled rather than streamed: it changes over minutes, and a poll that fails is
  // reported as a failed read rather than silently ignored.
  useEffect(() => {
    if (!apiConnected) return;
    let disposed = false;
    const read = () => { if (!disposed) void refreshCandidates(); };
    read();
    const timer = window.setInterval(read, WALK_POLL_MS);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [apiConnected, refreshCandidates]);

  // A preview describes the measurements it was solved from, so changing which radios are in
  // the fit, or which window they were read from, discards it rather than showing a stale fit.
  const solveKey = `${windowMinutes}|${selected.join(',')}`;
  const solveKeyRef = useRef(solveKey);
  useEffect(() => {
    if (solveKeyRef.current === solveKey) return;
    solveKeyRef.current = solveKey;
    setPreview(null);
  }, [solveKey]);

  const eligible = candidates.filter(candidate => candidate.eligible);
  const chosen = selected.length ? candidates.filter(candidate => selected.includes(candidate.targetId)) : eligible;
  const chosenEligible = chosen.filter(candidate => candidate.eligible).length;

  const solve = async (deviceIds: string[]) => {
    setBusy('solving');
    setNotice('');
    try {
      setPreview(await previewCalibration({ windowMinutes, deviceIds }));
    } catch (error) {
      setPreview(null);
      setNotice(error instanceof Error ? error.message : 'The solve did not complete.');
    } finally {
      setBusy('');
    }
  };

  const keep = async () => {
    setBusy('keeping');
    setNotice('');
    try {
      const result = await keepCalibration({ windowMinutes, deviceIds: selected });
      if (!result.ok) {
        setNotice(result.reasons.join(' '));
        return;
      }
      setNotice(`Kept: exponent ${result.saved.pathLossExponent} · ${result.saved.referenceDbm} dBm at ${result.saved.referenceMeters} m, fitted from ${result.saved.samples} readings at ${result.saved.vantages} places. Position estimates on this account use it from now on.`);
      setPreview(null);
      await refreshOverview();
      await refreshCandidates();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The calibration could not be kept.');
    } finally {
      setBusy('');
    }
  };

  const retire = async () => {
    setBusy('retiring');
    setNotice('');
    try {
      const result = await retireCalibration();
      setNotice(result.note);
      await refreshOverview();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The calibration could not be retired.');
    } finally {
      setBusy('');
    }
  };

  const toggleSelected = (targetId: string) => {
    setSelected(current => current.includes(targetId) ? current.filter(id => id !== targetId) : [...current, targetId]);
  };

  const active = overview?.active ?? null;
  const defaults = overview?.defaults ?? null;
  const noData = state === 'unavailable' || state === 'error';

  return <>
    <div className="page-heading">
      <div>
        <div className="page-kicker">Site calibration</div>
        <h1>Fit the radio model to {siteLabel}.</h1>
        <p>
          Walk the site with a phone running the relay. The phone records where it stood with every reading, the server
          solves the site's path-loss constants from those known positions, and every position estimate this account
          produces uses the fitted values instead of the deployed generic ones.
        </p>
      </div>
      <div className={`status-pill ${active ? '' : 'paused'}`} data-testid="calibration-status">
        <span className="pulse-dot" />{active ? 'FITTED MODEL IN FORCE' : 'GENERIC DEFAULTS IN FORCE'}
      </div>
    </div>

    {notice && <div className="billing-notice" role="status" aria-live="polite" data-testid="calibration-notice">{notice}</div>}

    <section className="panel" data-testid="calibration-model">        <div className="panel-header">
        <div>
          <div className="panel-title">The model in force</div>
          <div className="panel-subtitle">
            {active
              ? `Fitted in this site ${timeAgo(active.calibratedAt)} from ${active.samples} readings at ${active.vantages} places · ${active.method}`
              : 'No calibration walk has been kept for this account, so every estimate uses the deployed defaults.'}
          </div>

        </div>
        {active && <button className="btn" disabled={busy !== ''} onClick={() => void retire()} data-testid="button-retire-calibration">
          {busy === 'retiring' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />} Retire this calibration
        </button>}
      </div>
      {defaults ? <div className="device-details-grid location-grid">
        <div className="device-detail"><span>Reference level</span><strong>{active ? `${active.referenceDbm} dBm at ${active.referenceMeters} m` : `${defaults.referenceDbm} dBm at ${defaults.referenceMeters} m (default)`}</strong></div>
        <div className="device-detail"><span>Path-loss exponent</span><strong>{active ? active.pathLossExponent : `${defaults.pathLossExponent} (default)`}</strong></div>
        <div className="device-detail"><span>Residual RMS</span><strong>{active && active.residualRmsDb !== null ? `${active.residualRmsDb} dB` : 'not applicable'}</strong></div>
        <div className="device-detail"><span>Radios fitted</span><strong>{active ? active.targets.length : 0}</strong></div>
        <div className="device-detail"><span>Fitted at</span><strong>{active ? new Date(active.calibratedAt).toLocaleString() : 'never'}</strong></div>
        <div className="device-detail"><span>Earlier walks retired</span><strong>{overview?.retired ?? 0}</strong></div>
      </div> : null}
      {active && defaults && modelDiffersFromDefaults(active, defaults) && <p className="location-note" data-testid="calibration-differs">
        The fitted model differs from the deployed defaults: exponent {active.pathLossExponent} against {defaults.pathLossExponent}, and a
        reference level of {active.referenceDbm} dBm against {defaults.referenceDbm} dBm. That difference is this building.
      </p>}
      {active && active.warnings.length > 0 && <ul className="calibration-reasons" data-testid="calibration-warnings">
        {active.warnings.map(warning => <li key={warning}>{warning}</li>)}
      </ul>}
      {active && active.targets.length > 0 && <div className="location-table" data-testid="calibration-targets">
        <div className="list-head" aria-hidden="true"><span>Radio</span><span>Level at 1 m</span><span>Position</span><span>Evidence</span><span>Residual</span></div>
        {active.targets.map(target => <div className="location-row" key={target.targetId}>
          <span title={target.label}>{target.label}</span>
          <span>{target.referenceDbm} dBm</span>
          <span>{target.x} m east · {target.y} m north</span>
          <span>{target.readings} readings at {target.samples} place{target.samples === 1 ? '' : 's'}</span>
          <span>{target.residualRmsDb} dB</span>
        </div>)}
      </div>}
      {overview && defaults ? <ComparisonTable comparison={overview.comparison} defaults={defaults} active={Boolean(active)} /> : null}
      {active && active.targets.length === 1 && <p className="location-note">
        This fit came from one radio, so its reference level carries that transmitter's own power and antenna as well as the
        building's loss. Calibrating a second radio separates the two, because the exponent is shared between radios while the
        reference level is not.
      </p>}
    </section>

    <section className="panel calibration-walk" data-testid="calibration-walk">
      <div className="panel-header">
        <div>
          <div className="panel-title">Calibration walk</div>
          <div className="panel-subtitle">
            {walkSamples} reading{walkSamples === 1 ? '' : 's'} from moving relays in the last {walkWindowLabel(windowMinutes)} · {eligible.length} radio{eligible.length === 1 ? '' : 's'} ready to fit
          </div>
        </div>
        <button className="btn" onClick={() => void refreshCandidates()} disabled={busy !== '' || !apiConnected} data-testid="button-refresh-walk">
          <RefreshCw size={13} aria-hidden="true" /> Re-read the walk
        </button>
      </div>

      <ol className="calibration-howto">
        <li>Open the <Link href={PHONE_RELAY_PATH}>phone relay</Link> on the phone you will carry, and let it run.</li>
        <li>Walk around one fixed radio — a beacon, a router, a tag left where it will be — and stand still for a few seconds at each place. Four places spread over eight metres is the minimum, and the levels have to vary, so pass the radio at different distances.</li>
        <li>Keep walking until that radio reads <strong>ready to fit</strong>. The places the phone recorded are drawn below, so a walk that never moved is visible rather than guessed at.</li>
        <li>Solve the fit, judge the constants and the residuals, then keep it. Keeping it is what changes the model this account uses.</li>
      </ol>

      <div className="calibration-windows" role="group" aria-label="Walk window">
        {WALK_WINDOWS.map(window => <button
          key={window.minutes}
          type="button"
          className={`relay-chip ${window.minutes === windowMinutes ? 'selected' : ''}`}
          aria-pressed={window.minutes === windowMinutes}
          data-testid={`button-window-${window.minutes}`}
          onClick={() => setWindowMinutes(window.minutes)}
        ><span className="relay-chip-name">Last {window.label}</span></button>)}
      </div>

      {apiConnected && !noData && <SiteMap nodes={nodes} walkPoints={walkPoints} />}

      {!apiConnected && <div className="empty-state"><Crosshair size={23} aria-hidden="true" /><h3>The operator API is not connected</h3><p>A walk cannot be read while the API is unreachable, and nothing here is estimated from a failed request.</p></div>}

      {apiConnected && noData && <div className="empty-state" data-testid="calibration-unavailable">
        <Crosshair size={23} aria-hidden="true" />
        <h3>{state === 'unavailable' ? 'Calibration is unavailable on this deployment' : 'The walk could not be read'}</h3>
        <p>{message || 'The calibration request did not complete.'}</p>
      </div>}

      {apiConnected && !noData && state === 'loading' && <div className="empty-state"><Loader2 className="spin" size={23} aria-hidden="true" /><h3>Reading the walk</h3><p>Asking the server what moving relays have heard.</p></div>}

      {apiConnected && !noData && state === 'ready' && <>
        {candidates.length === 0
          ? <div className="empty-state" data-testid="calibration-no-candidates">
            <Crosshair size={23} aria-hidden="true" />
            <h3>No moving relay has reported yet</h3>
            <p>A walk is recorded by a relay that reports where it was. Start the phone relay, then walk the site: readings taken from one fixed place cannot calibrate anything, because the distance to the radio never changes.</p>
          </div>
          : <div className="calibration-candidates" data-testid="calibration-candidates">
            {candidates.map(candidate => <div key={candidate.targetId} className={`calibration-select ${selected.includes(candidate.targetId) ? 'selected' : ''}`}>
              <label className="calibration-select-box">
                <input
                  type="checkbox"
                  checked={selected.includes(candidate.targetId)}
                  onChange={() => toggleSelected(candidate.targetId)}
                  data-testid={`checkbox-target-${candidate.targetId}`}
                />
                <span>include in the fit</span>
              </label>
              {requirements
                ? <CandidateCard candidate={candidate} requirements={requirements} onFit={targetId => void solve([targetId])} />
                : <div className="calibration-candidate"><div className="calibration-candidate-head"><div className="calibration-candidate-name">{candidate.label}</div></div></div>}
            </div>)}
          </div>}
        {placementOnly.count > 0 && <p className="location-note" data-testid="calibration-placement-only">
          {placementOnly.count} radio{placementOnly.count === 1 ? '' : 's'} ({placementOnly.labels.join(', ')}) {placementOnly.count === 1 ? 'was' : 'were'} heard only from relays standing in one place.
          Those readings cannot calibrate anything: a fixed relay never changes its distance to the radio, so the fall-off rate stays unidentified.
        </p>}
        <div className="calibration-actions">
          <button className="btn btn-primary" disabled={busy !== '' || !chosenEligible} onClick={() => void solve(selected)} data-testid="button-solve">
            {busy === 'solving' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <Ruler size={13} aria-hidden="true" />} Solve without keeping
          </button>
          <button className="btn" disabled={busy !== '' || !chosenEligible} onClick={() => void keep()} data-testid="button-keep">
            {busy === 'keeping' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />} Fit and keep
          </button>
          <span className="calibration-action-note">
            {selected.length
              ? `${chosenEligible} of ${selected.length} selected radio${selected.length === 1 ? '' : 's'} can be fitted now.`
              : eligible.length
                ? `All ${eligible.length} radio${eligible.length === 1 ? '' : 's'} ready to fit will be used. Exclude one above to fit it on its own.`
                : 'Nothing can be fitted yet. The checklist above says what each radio still needs.'}
          </span>
        </div>
      </>}
    </section>

    {preview && <section className="panel" data-testid="calibration-preview">
      <div className="panel-header">
        <div>
          <div className="panel-title">{preview.ok ? 'What the walk fits' : 'This walk cannot be fitted yet'}</div>
          <div className="panel-subtitle">
            {preview.ok ? 'Solved from the walk and not kept — nothing here changes how positions are estimated until you keep it.' : 'The solver refused it, and nothing was stored.'}
          </div>
        </div>
        <button className="btn" onClick={() => setPreview(null)} data-testid="button-dismiss-preview"><X size={13} aria-hidden="true" /> Dismiss</button>
      </div>
      {!preview.ok && <>
        <ul className="calibration-reasons" data-testid="calibration-preview-reasons">
          {preview.reasons.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
        <p className="location-note">Nothing was stored, and the model in force is unchanged.</p>
      </>}
      {preview.ok && <>
        <div className="device-details-grid location-grid">
          <div className="device-detail"><span>Path-loss exponent</span><strong data-testid="preview-exponent">{preview.fit.pathLossExponent}</strong></div>
          <div className="device-detail"><span>Shared reference level</span><strong>{preview.fit.referenceDbm} dBm at {preview.fit.referenceMeters} m</strong></div>
          <div className="device-detail"><span>Evidence fitted</span><strong>{preview.fit.samples} reading{preview.fit.samples === 1 ? '' : 's'} at {preview.fit.observations} place{preview.fit.observations === 1 ? '' : 's'}</strong></div>
          <div className="device-detail"><span>Residual RMS</span><strong>{preview.fit.residualRmsDb} dB</strong></div>
          <div className="device-detail"><span>Seed</span><strong>{preview.seedSource}</strong></div>
          <div className="device-detail"><span>Radios fitted</span><strong>{preview.fit.targets.length}</strong></div>
        </div>
        <div className="location-table" data-testid="preview-targets">
          <div className="list-head" aria-hidden="true"><span>Radio</span><span>Level at 1 m</span><span>Position</span><span>Distance range</span><span>Residual</span></div>
          {preview.fit.targets.map(target => <div className="location-row" key={target.targetId}>
            <span title={target.label}>{target.label}</span>
            <span>{target.referenceDbm} dBm</span>
            <span>{target.x} m east · {target.y} m north</span>
            <span>{target.minDistanceMeters}–{target.maxDistanceMeters} m</span>
            <span>{target.residualRmsDb} dB</span>
          </div>)}
        </div>
        {defaults ? <ComparisonTable comparison={preview.comparison} defaults={defaults} active /> : null}
        {preview.fit.warnings.length > 0 && <ul className="calibration-reasons" data-testid="preview-warnings">
          {preview.fit.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>}
        <div className="calibration-actions">
          <button className="btn btn-primary" disabled={busy !== ''} onClick={() => void keep()} data-testid="button-keep-preview">
            {busy === 'keeping' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />} Keep this fit
          </button>
          <span className="calibration-action-note">
            Keeping it retires any calibration already in force, and every position estimate on this account uses the new
            constants from then on. Radios that were not solved keep the shared reference level rather than their own.
          </span>
        </div>
      </>}
    </section>}

    <section className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">Why this is worth doing</div>
          <div className="panel-subtitle">What the model decides, and what it cannot</div>
        </div>
      </div>
      <div className="notes-grid">
        <div className="note-cell"><div className="eyebrow">WHAT IT CHANGES</div><p className="calibration-prose">A received level becomes a distance through the model. Wrong constants do not make an estimate noisy, they make it biased: a site that loses signal faster than the defaults assume puts every radio further away than it is. The table above shows that gap in metres.</p></div>
        <div className="note-cell"><div className="eyebrow">WHAT A WALK NEEDS</div><p className="calibration-prose">One fixed radio heard from at least four places, spread over eight metres, with the levels varying by eight decibels. The exponent is shared between radios; the reference level is where a transmitter's own power is separated from the building's loss.</p></div>
        <div className="note-cell"><div className="eyebrow">WHAT IT CANNOT DO</div><p className="calibration-prose">The model still knows nothing about walls, furniture, antenna orientation, or people. Calibration removes a bias, not the need for vantage points, and a fit is only as good as the positions the phone reported while it was walked.</p></div>
      </div>
    </section>
  </>;
}
