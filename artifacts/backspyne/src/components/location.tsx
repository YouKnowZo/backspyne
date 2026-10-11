// Site map, position estimate, and relay placement.
//
// Two ideas hold this file together. A relay is a vantage point only once the operator has
// placed it, so placement is an explicit action with a visible coordinate rather than
// something inferred from a local address. And a position is drawn together with what
// supports it — the ring, the candidate points, the residual spread — because a marker on
// its own reads as a measurement, and this measurement is a model with inputs the operator
// can see and change.

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'wouter';
import { Crosshair, MapPin, RefreshCw, Trash2 } from 'lucide-react';

import { useConsoleData } from '../lib/console-data';
import { timeAgo } from '../lib/format';
import { isPlaced } from '../lib/observations';
import { VIEW_PATHS, type DeviceLocation, type ScanNode } from '../lib/types';

type MapPoint = { x: number; y: number };

const EMPTY_FRAME = { minX: -5, minY: -5, span: 10 };

/**
 * Every metre in the site frame is drawn to the same scale, and the frame follows whatever
 * has been placed or estimated so the picture always contains the whole answer.
 */
function frameFor(points: MapPoint[]) {
  if (!points.length) return EMPTY_FRAME;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(10, (maxX - minX) * 1.35, (maxY - minY) * 1.35);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return { minX: centerX - span / 2, minY: centerY - span / 2, span };
}

function gridStep(span: number): number {
  if (span <= 12) return 1;
  if (span <= 30) return 5;
  if (span <= 80) return 10;
  return 25;
}

const ESTIMATE_LABELS: Record<string, { text: string; tone: 'connected' | 'limited' }> = {
  estimated: { text: 'FIX', tone: 'connected' },
  ambiguous: { text: 'AMBIGUOUS', tone: 'limited' },
  single_relay: { text: 'RING ONLY', tone: 'limited' },
  no_signal: { text: 'NO MEASUREMENT', tone: 'limited' },
};

/**
 * The site, seen from above. North is up and the grid is one metre unless the frame is large
 * enough that finer lines would be noise. Clicking is only accepted while a relay is being
 * placed, so a stray click can never move a vantage point.
 */
export function SiteMap({ nodes, estimate, track, walkPoints, placingId, onPlace }: {
  nodes: ScanNode[];
  estimate?: DeviceLocation['estimate'] | null;
  track?: DeviceLocation['track'] | null;
  /**
   * Places a calibration walk recorded, drawn as the ground the phone actually covered. The
   * frame follows them, so a walk that wandered off the plan is visible rather than cropped.
   */
  walkPoints?: MapPoint[] | null;
  placingId?: string | null;
  onPlace?: (x: number, y: number) => void;
}) {
  const placed = nodes.filter(isPlaced);
  const points: MapPoint[] = placed.map(node => ({ x: node.positionX, y: node.positionY }));
  if (estimate && typeof estimate.x === 'number' && typeof estimate.y === 'number') points.push({ x: estimate.x, y: estimate.y });
  for (const candidate of estimate?.candidates ?? []) points.push(candidate);
  for (const point of track ?? []) points.push({ x: point.x, y: point.y });
  for (const point of walkPoints ?? []) points.push(point);

  const frameKey = points.map(point => `${point.x},${point.y}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the point set
  const frame = useMemo(() => frameFor(points), [frameKey]);
  const step = gridStep(frame.span);
  const sx = (x: number) => ((x - frame.minX) / frame.span) * 100;
  const sy = (y: number) => 100 - ((y - frame.minY) / frame.span) * 100;
  const units = (meters: number) => (meters / frame.span) * 100;
  const ticks = Math.floor(frame.span / step);

  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!onPlace || !placingId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    onPlace(
      Math.round((frame.minX + px * frame.span) * 10) / 10,
      Math.round((frame.minY + (1 - py) * frame.span) * 10) / 10,
    );
  };

  const placing = placingId ? placed.find(node => node.id === placingId) ?? nodes.find(node => node.id === placingId) : undefined;
  const walkCount = walkPoints?.length ?? 0;
  const label = `Site map, ${frame.span.toFixed(0)} metres across, ${placed.length} placed relay${placed.length === 1 ? '' : 's'}${estimate && typeof estimate.x === 'number' ? ', one estimated position' : ''}${walkCount ? `, ${walkCount} recorded walk place${walkCount === 1 ? '' : 's'}` : ''}`;

  return <div className="site-map-wrap">
    <svg
      className={`site-map ${placingId ? 'placing' : ''}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
      data-testid="site-map"
      onClick={handleClick}
    >
      {Array.from({ length: ticks + 1 }, (_, index) => index * step).map(offset => <g key={`grid-${offset}`}>
        <line className="map-grid" x1={sx(frame.minX + offset)} x2={sx(frame.minX + offset)} y1={0} y2={100} />
        <line className="map-grid" x1={0} x2={100} y1={sy(frame.minY + offset)} y2={sy(frame.minY + offset)} />
      </g>)}
      <line className="map-axis" x1={0} x2={100} y1={sy(0)} y2={sy(0)} />
      <line className="map-axis" x1={sx(0)} x2={sx(0)} y1={0} y2={100} />

      {walkPoints?.map(point => <circle
        key={`walk-${point.x}-${point.y}`}
        className="map-walk-dot"
        cx={sx(point.x)}
        cy={sy(point.y)}
        r={1.3}
      />)}
      {track && track.length > 1 && <polyline
        className="map-track"
        points={track.map(point => `${sx(point.x)},${sy(point.y)}`).join(' ')}
      />}
      {track?.map(point => <circle key={`track-${point.at}`} className="map-track-dot" cx={sx(point.x)} cy={sy(point.y)} r={1.1} />)}

      {estimate?.ring && <circle
        className="map-ring"
        cx={sx(estimate.ring.x)} cy={sy(estimate.ring.y)} r={units(estimate.ring.distanceMeters)}
      />}
      {estimate && typeof estimate.x === 'number' && typeof estimate.y === 'number' && <>
        {typeof estimate.uncertaintyMeters === 'number' && <circle
          className="map-uncertainty"
          cx={sx(estimate.x)} cy={sy(estimate.y)} r={units(estimate.uncertaintyMeters)}
        />}
        <circle className="map-estimate" cx={sx(estimate.x)} cy={sy(estimate.y)} r={2.4} />
      </>}
      {estimate?.candidates.map(candidate => <g key={`candidate-${candidate.x}-${candidate.y}`} className="map-candidate">
        <circle cx={sx(candidate.x)} cy={sy(candidate.y)} r={2.4} />
        <text x={sx(candidate.x) + 3.4} y={sy(candidate.y) + 1.2}>?</text>
      </g>)}

      {placed.map(node => <g key={node.id} className={`map-relay ${node.id === placingId ? 'selected' : ''} ${node.status === 'online' ? 'online' : ''}`}>
        <rect x={sx(node.positionX) - 2} y={sy(node.positionY) - 2} width={4} height={4} />
        <text x={sx(node.positionX) + 3} y={sy(node.positionY) - 2.6}>{node.name.slice(0, 16)}</text>
      </g>)}
    </svg>
    <p className="site-map-caption">
      {placing
        ? <>Click the map to place <strong>{placing.name}</strong>. The frame shows {frame.span.toFixed(0)} m across with a {step} m grid.</>
        : placed.length || walkCount
          ? <>{frame.span.toFixed(0)} m across · {step} m grid · metres east and north of the site origin.{walkCount ? ` · ${walkCount} place${walkCount === 1 ? '' : 's'} recorded by the walk` : ''}</>
          : <>No relay has a placement yet, so there is nothing to draw. <Link href={VIEW_PATHS.nodes}>Place a relay</Link> to start modelling positions.</>}
    </p>
  </div>;
}

/** Where the selected radio is, what supports that, and what it does not mean. */
export function DeviceLocationPanel() {
  const { location, locationLoading, nodes, selectedId } = useConsoleData();
  if (!selectedId) return null;

  if (locationLoading && !location) {
    return <section className="panel location-panel" data-testid="device-location">
      <div className="panel-header"><div><div className="panel-title">Position estimate</div><div className="panel-subtitle">Reading this radio's sightings</div></div><RefreshCw className="spin" size={15} aria-hidden="true" /></div>
    </section>;
  }
  if (!location) {
    return <section className="panel location-panel" data-testid="device-location">
      <div className="panel-header"><div><div className="panel-title">Position estimate</div><div className="panel-subtitle">Not available</div></div><MapPin size={15} aria-hidden="true" /></div>
      <p className="location-note">The position request did not complete, so no estimate is shown. Nothing is inferred from a failed request.</p>
    </section>;
  }
  if (!location.available) {
    return <section className="panel location-panel" data-testid="device-location">
      <div className="panel-header"><div><div className="panel-title">Position estimate</div><div className="panel-subtitle">Unavailable on this deployment</div></div><MapPin size={15} aria-hidden="true" /></div>
      <p className="location-note" data-testid="location-unavailable">{location.reason ?? 'Relay placement is unavailable, so no position can be modelled.'}</p>
    </section>;
  }

  const estimate = location.estimate ?? null;
  const relays = location.relays ?? [];
  const track = location.track ?? [];
  const status = estimate ? ESTIMATE_LABELS[estimate.status] ?? ESTIMATE_LABELS.no_signal : ESTIMATE_LABELS.no_signal;
  const placedCount = location.placement?.placed ?? 0;
  const heardCount = location.placement?.heard ?? relays.length;

  return <section className="panel location-panel" data-testid="device-location">
    <div className="panel-header">
      <div>
        <div className="panel-title">Position estimate</div>
        <div className="panel-subtitle">
          {heardCount} relay{heardCount === 1 ? '' : 's'} heard this radio in the last {location.model?.windowMinutes ?? 30} minutes · {placedCount} placed
        </div>
      </div>
      <span className={`hardware-status ${status.tone}`} data-testid="location-status">{status.text}</span>
    </div>
    <SiteMap nodes={nodes} estimate={estimate} track={track} />
    <div className="device-details-grid location-grid">
      <div className="device-detail"><span>Method</span><strong>{estimate?.method ?? 'none'}</strong></div>
      <div className="device-detail"><span>{location.vantages?.fromPhone ? 'Vantage points used' : 'Placed relays used'}</span><strong>{estimate?.relays ?? 0}{location.vantages?.fromPhone ? ` · ${location.vantages.fromPhone} recorded by a phone on the move` : ''}</strong></div>
      <div className="device-detail"><span>Uncertainty radius</span><strong>{estimate && typeof estimate.uncertaintyMeters === 'number' ? `± ${estimate.uncertaintyMeters} m` : 'not applicable'}</strong></div>
      <div className="device-detail"><span>Position</span><strong>{estimate && typeof estimate.x === 'number' && typeof estimate.y === 'number' ? `${estimate.x} m east · ${estimate.y} m north` : 'no point estimate'}</strong></div>
      <div className="device-detail"><span>Modelled reference</span><strong>{location.model ? `${location.model.referenceDbm} dBm at ${location.model.referenceMeters} m · exponent ${location.model.pathLossExponent}` : 'unknown'}</strong></div>
      <div className="device-detail"><span>Track</span><strong>{track.length ? `${track.length} fix${track.length === 1 ? '' : 'es'} · newest ${timeAgo(track[track.length - 1].at)}` : 'no fix in the window'}</strong></div>
    </div>
    <p className="location-note" data-testid="location-note">{estimate?.note ?? 'No estimate was returned.'}</p>
    {estimate?.residuals.length ? <div className="location-table" data-testid="location-residuals">
      <div className="list-head" aria-hidden="true"><span>Relay</span><span>Reported</span><span>Implied distance</span><span>Distance to fit</span><span>Residual</span></div>
      {estimate.residuals.map(residual => <div className="location-row" key={residual.nodeId}>
        <span title={residual.nodeName}>{residual.nodeName}</span>
        <span>{residual.reportedDbm} dBm</span>
        <span>{residual.impliedMeters} m</span>
        <span>{residual.modelledMeters} m</span>
        <span>{residual.residualMeters} m</span>
      </div>)}
    </div> : null}
    {relays.length ? <div className="location-relays" data-testid="location-relays">
      {relays.map(relay => <div className="location-relay" key={relay.nodeId}>
        <span className="location-relay-name" title={relay.name}>{relay.name}</span>
        <span className="location-relay-meta">{relay.signalDbm === null ? 'no numeric level' : `${Math.round(relay.signalDbm)} dBm · about ${relay.impliedDistanceMeters ?? '—'} m implied`} · heard {timeAgo(relay.lastObservedAt)}</span>
        <span className={`hardware-status ${relay.placed ? 'connected' : 'limited'}`}>{relay.placed ? `placed ${relay.x}, ${relay.y} m` : 'not placed'}</span>
      </div>)}
    </div> : null}
    <p className="location-disclaimer">
      This is a modelled estimate, not a measurement of a person. Distance comes from the received level through the
      path-loss model above, which does not know about walls, furniture, antenna orientation, or a radio's transmit power,
      and a randomised address can be a new address on the same physical device. Three or more vantage points are needed
      for a fix — three placed relays, or one phone that reported the same radio from three places as it was carried — and
      fewer give a ring or two candidates, which is what is shown.
    </p>
  </section>;
}

/**
 * The placement editor. It is deliberately a first-class panel rather than a hidden setting:
 * a position estimate is only as good as the coordinates the operator typed here.
 */
export function RelayPlacementPanel() {
  const { nodes, placeNode } = useConsoleData();
  const placed = nodes.filter(isPlaced);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState({ x: '', y: '', label: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const node = nodes.find(item => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!node) {
      setDraft({ x: '', y: '', label: '' });
      return;
    }
    setDraft({
      x: node.positionX === null ? '' : String(node.positionX),
      y: node.positionY === null ? '' : String(node.positionY),
      label: node.positionLabel ?? '',
    });
  }, [node?.id, node?.positionX, node?.positionY, node?.positionLabel]);

  const save = async (x: number, y: number, label: string) => {
    if (!node) return;
    setBusy(true);
    setError('');
    setSaved('');
    const ok = await placeNode(node.id, x, y, label);
    setBusy(false);
    if (ok) setDraft({ x: String(x), y: String(y), label });
    setSaved(ok ? `${node.name} placed at ${x} m east, ${y} m north.` : '');
    if (!ok) setError('The placement could not be saved. Check that the relay still belongs to this account.');
  };

  const saveFromDraft = async () => {
    const x = Number(draft.x.trim());
    const y = Number(draft.y.trim());
    if (!draft.x.trim() || !draft.y.trim() || !Number.isFinite(x) || !Number.isFinite(y)) {
      setError('Enter both coordinates as numbers in metres, for example 3.5 and -1.');
      return;
    }
    await save(x, y, draft.label.trim());
  };

  const clear = async () => {
    if (!node) return;
    setBusy(true);
    setError('');
    setSaved('');
    const ok = await placeNode(node.id, null, null);
    setBusy(false);
    setDraft({ x: '', y: '', label: '' });
    setSaved(ok ? `${node.name} no longer has a placement.` : '');
    if (!ok) setError('The placement could not be cleared.');
  };

  return <section className="panel relay-placement" data-testid="relay-placement">
    <div className="panel-header">
      <div>
        <div className="panel-title">Relay placement</div>
        <div className="panel-subtitle">{placed.length} of {nodes.length} relays placed · three placed relays that hear the same radio produce a fix</div>
      </div>
      <MapPin size={16} aria-hidden="true" style={{ color: 'hsl(var(--muted-foreground))' }} />
    </div>
    <p className="relay-pairing-note">
      Coordinates are metres east (x) and north (y) of the site origin you choose — place one relay at 0, 0 to act as that
      origin if you have not surveyed the site. Only placed relays are vantage points, so an unplaced relay is reported as
      a relay that heard a radio and nothing more.
    </p>
    {error && <div className="billing-notice error" role="status" data-testid="relay-placement-error">{error}</div>}
    {saved && <div className="billing-notice" role="status" aria-live="polite" data-testid="relay-placement-saved">{saved}</div>}
    {nodes.length ? <>
      <div className="relay-placement-picker">
        {nodes.map(item => <button
          key={item.id}
          type="button"
          className={`relay-chip ${item.id === selectedId ? 'selected' : ''} ${isPlaced(item) ? 'placed' : ''}`}
          data-testid={`placement-chip-${item.id}`}
          aria-pressed={item.id === selectedId}
          onClick={() => setSelectedId(item.id === selectedId ? '' : item.id)}
        >
          <span className="relay-chip-name" title={item.name}>{item.name}</span>
          <span className="relay-chip-state">{isPlaced(item) ? `${item.positionX}, ${item.positionY} m` : 'not placed'}</span>
        </button>)}
      </div>
      {node ? <>
        <SiteMap nodes={nodes} placingId={node.id} onPlace={(x, y) => void save(x, y, draft.label.trim())} />
        <div className="relay-placement-form">
          <div className="field"><label htmlFor="relay-x">Metres east</label><input id="relay-x" name="relay-x" inputMode="decimal" autoComplete="off" data-testid="input-relay-x" value={draft.x} onChange={event => setDraft(current => ({ ...current, x: event.target.value }))} placeholder="0" /></div>
          <div className="field"><label htmlFor="relay-y">Metres north</label><input id="relay-y" name="relay-y" inputMode="decimal" autoComplete="off" data-testid="input-relay-y" value={draft.y} onChange={event => setDraft(current => ({ ...current, y: event.target.value }))} placeholder="0" /></div>
          <div className="field"><label htmlFor="relay-position-label">Placement note (optional)</label><input id="relay-position-label" name="relay-position-label" autoComplete="off" data-testid="input-relay-position-label" value={draft.label} maxLength={80} onChange={event => setDraft(current => ({ ...current, label: event.target.value }))} placeholder="Corner of the east corridor" /></div>
          <div className="relay-placement-actions">
            <button className="btn btn-primary" data-testid="button-save-placement" disabled={busy} onClick={() => void saveFromDraft()}><Crosshair size={13} aria-hidden="true" /> {busy ? 'Saving' : 'Save placement'}</button>
            {isPlaced(node) && <button className="btn" data-testid="button-clear-placement" disabled={busy} onClick={() => void clear()}><Trash2 size={13} aria-hidden="true" /> Clear</button>}
          </div>
        </div>
      </> : <p className="relay-pairing-note">Select a relay above to place it, either by clicking the map or by typing exact coordinates.</p>}
    </> : <div className="empty-state"><MapPin size={23} aria-hidden="true" /><h3>No relays to place</h3><p>Pair a relay first, then give it a position here.</p></div>}
  </section>;
}
