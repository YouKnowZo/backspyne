// The device ledger: every observation this account has stored.
//
// The filters live in the URL rather than in the component, so the view an operator is looking
// at survives a refresh, can be bookmarked, and can be shared with a colleague — the same four
// values describe the same slice of the ledger to anyone who opens the link. This is a real
// ledger of 250-odd rows, so the row set is what it is; sorting and filtering are done on the
// stored values, never by re-querying with guessed parameters.

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link } from 'wouter';
import { AlertTriangle, Check, ChevronRight, Clock, Download, FileDown, Filter, RefreshCw, Search, Shield, Star, Trash2 } from 'lucide-react';

import { useConsoleData } from '../lib/console-data';
import { timeAgo } from '../lib/format';
import { DEVICE_SORTS, VIEW_PATHS, type DeviceSort, type PurgeResultPayload, type RetentionPolicyPayload } from '../lib/types';

export type { DeviceSort };

const DEFAULT_SORT: DeviceSort = 'signal-strongest';

interface LedgerFilters {
  query: string;
  protocol: string;
  sort: DeviceSort;
  showGhosts: boolean;
}

/**
 * Reads the ledger's filters from the query string. Unknown or malformed values fall back to
 * the defaults instead of leaving the ledger in a state it cannot render.
 */
function filtersFromSearch(search: string): LedgerFilters {
  const params = new URLSearchParams(search);
  const protocol = params.get('protocol');
  const sort = params.get('sort');
  return {
    query: (params.get('q') ?? '').slice(0, 120),
    protocol: protocol === 'WiFi' || protocol === 'BLE' ? protocol : 'all',
    sort: DEVICE_SORTS.includes(sort as DeviceSort) ? sort as DeviceSort : DEFAULT_SORT,
    showGhosts: params.get('ghosts') === '1',
  };
}

/** Writes only the values that differ from the defaults, so a plain ledger keeps a plain URL. */
function replaceLedgerSearch(filters: LedgerFilters) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set('q', filters.query);
  if (filters.protocol !== 'all') params.set('protocol', filters.protocol);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.showGhosts) params.set('ghosts', '1');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

export function FilterToolbar({ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, sort, setSort, onExport }: { query: string; setQuery: (v: string) => void; protocol: string; setProtocol: (v: string) => void; showGhosts: boolean; setShowGhosts: (v: boolean) => void; sort: DeviceSort; setSort: (v: DeviceSort) => void; onExport: () => void }) {
  return <div className="toolbar"><div className="search-box"><Search /><input data-testid="input-device-search" className="search-input" type="search" name="device-search" autoComplete="off" spellCheck={false} aria-label="Search observations" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search MAC, vendor, type, name…" /></div><select data-testid="select-protocol" className="select-filter" aria-label="Protocol filter" value={protocol} onChange={event => setProtocol(event.target.value)}><option value="all">All protocols</option><option value="WiFi">WiFi</option><option value="BLE">BLE</option></select><label className="sort-control"><span>Sort</span><select data-testid="select-device-sort" className="select-filter" value={sort} onChange={event => setSort(event.target.value as DeviceSort)}><option value="signal-strongest">Signal · strongest first</option><option value="signal-weakest">Signal · weakest first</option><option value="type">Device type · A–Z</option><option value="vendor">Vendor · A–Z</option><option value="channel">Channel</option><option value="last-seen">Last seen · newest</option><option value="first-seen">First seen · oldest</option><option value="address">Address · A–Z</option></select></label><button data-testid="button-toggle-ghosts" className="toggle-filter" aria-pressed={showGhosts} onClick={() => setShowGhosts(!showGhosts)}><span className={`switch ${showGhosts ? 'on' : ''}`} /> include ghosts</button><button className="btn" data-testid="button-export-ledger" onClick={onExport}><Download size={13} /> Export CSV</button></div>;
}

/**
 * Operator-configurable observation retention window and one-click site data purge control.
 *
 * Reads and updates `/api/retention` and `/api/retention/purge`. The server enforces the
 * effective retention window on `/api/devices`, `/api/devices/:id/trail`, and `/api/report/assessment`,
 * and automatically prunes expired sightings and devices when `autoPrune` is enabled.
 */
function DataRetentionAndPurgePanel() {
  const { refreshConsoleData } = useConsoleData();
  const [retention, setRetention] = useState<RetentionPolicyPayload | null>(null);
  const [selectedDays, setSelectedDays] = useState<string>('plan');
  const [autoPrune, setAutoPrune] = useState(true);
  const [resetRelays, setResetRelays] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [busy, setBusy] = useState<'none' | 'save' | 'prune' | 'purge'>('none');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const syncFormFromPayload = (payload: RetentionPolicyPayload) => {
    setRetention(payload);
    setSelectedDays(payload.configuredDays === null ? 'plan' : String(payload.configuredDays));
    setAutoPrune(payload.autoPrune);
  };

  const loadRetention = useCallback(async () => {
    try {
      const response = await fetch('/api/retention', { credentials: 'include' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 503) {
          setError('Retention controls are unavailable while the operator API is offline.');
          return;
        }
        setError(`Could not read retention policy (${response.status}).`);
        return;
      }
      const payload = await response.json() as RetentionPolicyPayload;
      syncFormFromPayload(payload);
      setError('');
    } catch {
      setError('Could not read retention policy; check your connection.');
    }
  }, []);

  useEffect(() => {
    void loadRetention();
  }, [loadRetention]);

  const savePolicy = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const retentionDays = selectedDays === 'plan' ? null : Number.parseInt(selectedDays, 10);
      const response = await fetch('/api/retention', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays, autoPrune }),
      });
      const body = await response.json().catch(() => null) as (RetentionPolicyPayload & { error?: string }) | null;
      if (!response.ok || !body || typeof body.effectiveDays !== 'number') {
        setError(body?.error || `Could not save retention policy (${response.status}).`);
        return;
      }
      syncFormFromPayload(body);
      setNotice(`Retention window saved: enforcing ${body.effectiveDays} day${body.effectiveDays === 1 ? '' : 's'} (${body.autoPrune ? 'automatic pruning enabled' : 'manual pruning only'}).`);
      await refreshConsoleData();
    } catch {
      setError('Could not save retention policy; check your connection.');
    } finally {
      setBusy('none');
    }
  };

  const pruneExpiredNow = async () => {
    setBusy('prune');
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/retention/purge', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'expired' }),
      });
      const body = await response.json().catch(() => null) as (PurgeResultPayload & { error?: string }) | null;
      if (!response.ok || !body?.purged) {
        setError(body?.error || `Could not prune expired observations (${response.status}).`);
        return;
      }
      syncFormFromPayload(body.retention);
      const del = body.purged.deleted;
      setNotice(`Pruned ${del.devices} expired radio${del.devices === 1 ? '' : 's'} and ${del.sightings} sighting${del.sightings === 1 ? '' : 's'} older than ${body.retention.effectiveDays} day${body.retention.effectiveDays === 1 ? '' : 's'}.`);
      await refreshConsoleData();
    } catch {
      setError('Could not prune expired observations; check your connection.');
    } finally {
      setBusy('none');
    }
  };

  const executeSitePurge = async () => {
    setBusy('purge');
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/retention/purge', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'site', confirm: 'PURGE', resetRelays }),
      });
      const body = await response.json().catch(() => null) as (PurgeResultPayload & { error?: string }) | null;
      if (!response.ok || !body?.purged) {
        setError(body?.error || `Site data purge failed (${response.status}).`);
        return;
      }
      syncFormFromPayload(body.retention);
      setConfirmArmed(false);
      setResetRelays(false);
      const del = body.purged.deleted;
      setNotice(
        `Site data purged: removed ${del.devices} radio${del.devices === 1 ? '' : 's'}, ${del.sightings} sighting${del.sightings === 1 ? '' : 's'}, ${del.telemetryEvents} telemetry event${del.telemetryEvents === 1 ? '' : 's'}, and retired ${del.calibrationsRetired} calibration${del.calibrationsRetired === 1 ? '' : 's'}${del.relaysRemoved ? ` plus ${del.relaysRemoved} relay node${del.relaysRemoved === 1 ? '' : 's'}` : ''}. Paired relay tokens and billing remain intact.`,
      );
      await refreshConsoleData();
    } catch {
      setError('Site data purge failed; check your connection.');
    } finally {
      setBusy('none');
    }
  };

  const expiredTotal = (retention?.footprint.devicesExpired ?? 0) + (retention?.footprint.sightingsExpired ?? 0);

  return <section className="panel retention-panel" data-testid="panel-data-retention">
    <div className="panel-header">
      <div>
        <div className="panel-title">Observation retention &amp; site data purge</div>
        <div className="panel-subtitle">
          {retention
            ? `Enforcing ${retention.effectiveDays}-day window (${retention.configuredDays === null ? `${retention.planName} plan default` : 'operator-configured'}) · ${retention.footprint.devicesTotal} stored radios · ${retention.footprint.sightingsTotal} sightings`
            : 'Reading server-enforced retention window and stored footprint…'}
        </div>
      </div>
      <div className="panel-tools">
        <span className={`hardware-status ${retention?.autoPrune !== false ? 'connected' : 'permission'}`} data-testid="retention-status-badge">
          {retention ? `${retention.effectiveDays}D WINDOW` : 'LOADING'}
        </span>
      </div>
    </div>

    {error && <div className="billing-notice error" role="status" data-testid="retention-error">{error}</div>}
    {notice && <div className="billing-notice" role="status" data-testid="retention-notice">{notice}</div>}

    {retention && (
      <div className="retention-grid">
        <div className="retention-column">
          <div className="eyebrow"><Clock size={12} aria-hidden="true" /> Retention window</div>
          <p className="retention-copy">
            Observations older than this window are excluded from the ledger, trail, and client assessment report, and are automatically pruned from PostgreSQL when auto-prune is enabled. Your <strong>{retention.planName}</strong> plan permits up to <strong>{retention.planUnlimited ? 'unlimited' : `${retention.planMaxDays} days`}</strong> (<Link href={VIEW_PATHS.billing}>change plan</Link>).
          </p>
          <div className="retention-controls">
            <div className="field">
              <label htmlFor="select-retention-days">Retention window</label>
              <select
                id="select-retention-days"
                className="select-filter"
                data-testid="select-retention-days"
                value={selectedDays}
                disabled={busy !== 'none'}
                onChange={event => setSelectedDays(event.target.value)}
              >
                <option value="plan">
                  Plan ceiling ({retention.planUnlimited ? 'Unlimited / 3650 days' : `${retention.planMaxDays} days`})
                </option>
                {retention.options.map(option => (
                  <option key={option.days} value={String(option.days)} disabled={!option.allowedByPlan}>
                    {option.label}{!option.allowedByPlan ? ` (requires plan upgrade)` : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="toggle-filter"
              data-testid="button-toggle-auto-prune"
              aria-pressed={autoPrune}
              disabled={busy !== 'none'}
              onClick={() => setAutoPrune(!autoPrune)}
            >
              <span className={`switch ${autoPrune ? 'on' : ''}`} /> auto-prune expired rows
            </button>
          </div>
          <div className="retention-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="button-save-retention"
              disabled={busy !== 'none'}
              onClick={() => void savePolicy()}
            >
              {busy === 'save' ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Saving…</> : <><Check size={13} aria-hidden="true" /> Save retention window</>}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="button-prune-expired"
              disabled={busy !== 'none'}
              onClick={() => void pruneExpiredNow()}
            >
              {busy === 'prune' ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Pruning…</> : <>Prune expired now ({expiredTotal})</>}
            </button>
          </div>
          <div className="retention-meta" data-testid="retention-footprint-meta">
            <span>Cutoff: <strong>{new Date(retention.cutoffDate).toLocaleDateString()}</strong></span>
            <span>Oldest stored radio: <strong>{retention.footprint.oldestObservationAt ? timeAgo(retention.footprint.oldestObservationAt) : 'none'}</strong></span>
            <span>Last purge: <strong>{retention.lastPurgedAt ? timeAgo(retention.lastPurgedAt) : 'never'}</strong></span>
          </div>
        </div>

        <div className="retention-column retention-purge-column">
          <div className="eyebrow"><Trash2 size={12} aria-hidden="true" /> One-click site data purge</div>
          <p className="retention-copy">
            Finished a client engagement or moving your relays to a new building? Purge all stored devices, sightings, telemetry events, active calibration models, and the site origin in one step. Paired relay tokens and your subscription are preserved.
          </p>
          <label className="retention-checkbox">
            <input
              type="checkbox"
              data-testid="checkbox-purge-reset-relays"
              checked={resetRelays}
              disabled={busy !== 'none'}
              onChange={event => setResetRelays(event.target.checked)}
            />
            <span>Also clear registered relay nodes &amp; map placements (tokens stay active and re-register on next heartbeat)</span>
          </label>
          {!confirmArmed ? (
            <div className="retention-actions">
              <button
                type="button"
                className="btn btn-danger"
                data-testid="button-arm-site-purge"
                disabled={busy !== 'none'}
                onClick={() => setConfirmArmed(true)}
              >
                <Trash2 size={13} aria-hidden="true" /> Purge all site data…
              </button>
            </div>
          ) : (
            <div className="retention-confirm-box" role="alert" data-testid="site-purge-confirm-box">
              <div className="retention-confirm-copy">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>
                  <strong>Confirm permanent site data purge:</strong> This immediately deletes{' '}
                  <strong>{retention.footprint.devicesTotal}</strong> stored radio{retention.footprint.devicesTotal === 1 ? '' : 's'} and{' '}
                  <strong>{retention.footprint.sightingsTotal}</strong> sighting{retention.footprint.sightingsTotal === 1 ? '' : 's'} from this workspace.
                </span>
              </div>
              <div className="retention-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  data-testid="button-confirm-site-purge"
                  disabled={busy !== 'none'}
                  onClick={() => void executeSitePurge()}
                >
                  {busy === 'purge' ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Purging site…</> : <><Trash2 size={13} aria-hidden="true" /> Confirm &amp; purge site now</>}
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="button-cancel-site-purge"
                  disabled={busy !== 'none'}
                  onClick={() => setConfirmArmed(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <p className="retention-footnote">
            <Shield size={12} aria-hidden="true" /> Export a CSV or printable client report before purging if you need an offline archive of this site.
          </p>
        </div>
      </div>
    )}
  </section>;
}

export function Ledger() {
  const { devices, selectedId, select, toggleFavorite, exportLedger, detailsOpen, closeDetails } = useConsoleData();
  const initial = useMemo(() => filtersFromSearch(window.location.search), []);
  const [query, setQuery] = useState(initial.query);
  const [protocol, setProtocol] = useState(initial.protocol);
  const [showGhosts, setShowGhosts] = useState(initial.showGhosts);
  const [sort, setSort] = useState<DeviceSort>(initial.sort);
  // Roving focus: the ledger can hold hundreds of rows, so only one row is in the tab order
  // and the arrow keys walk the list. Without this, reaching the footer would mean pressing
  // Tab once per stored observation.
  const [focusedRow, setFocusedRow] = useState(0);

  useEffect(() => {
    replaceLedgerSearch({ query, protocol, sort, showGhosts });
  }, [query, protocol, sort, showGhosts]);

  const filtered = useMemo(() => {
    const matches = devices.filter(device => (showGhosts || device.status !== 'ghost') && (protocol === 'all' || device.protocol === protocol) && [device.mac, device.vendor, device.deviceType, device.node, device.details.ssid, device.details.localName, device.details.name].join(' ').toLowerCase().includes(query.toLowerCase()));
    return matches.sort((a, b) => {
      const textCompare = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
      switch (sort) {
        case 'signal-strongest': return (b.signal ?? Number.NEGATIVE_INFINITY) - (a.signal ?? Number.NEGATIVE_INFINITY);
        case 'signal-weakest': return (a.signal ?? Number.POSITIVE_INFINITY) - (b.signal ?? Number.POSITIVE_INFINITY);
        case 'type': return textCompare(a.deviceType, b.deviceType) || textCompare(a.vendor, b.vendor);
        case 'vendor': return textCompare(a.vendor, b.vendor) || textCompare(a.deviceType, b.deviceType);
        case 'channel': return textCompare(a.channel, b.channel);
        case 'last-seen': return (b.lastSeenTimestamp ?? 0) - (a.lastSeenTimestamp ?? 0);
        case 'first-seen': return (a.firstSeenTimestamp ?? Number.POSITIVE_INFINITY) - (b.firstSeenTimestamp ?? Number.POSITIVE_INFINITY);
        case 'address': return textCompare(a.mac, b.mac);
      }
    });
  }, [devices, protocol, query, showGhosts, sort]);
  const rowInTabOrder = Math.min(focusedRow, Math.max(0, filtered.length - 1));
  const moveFocus = (event: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, index + step));
    setFocusedRow(next);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return <><div className="page-heading"><div><div className="page-kicker">Device ledger</div><h1>Every signal leaves a trace.</h1><p>Search and review adapter observations. Signal strength is not a reliable distance estimate; network discovery does not reveal every client device.</p></div><div className="header-actions"><button className="btn btn-primary" data-testid="button-export-ledger-header" onClick={exportLedger}><FileDown size={14} /> Export ledger</button></div></div><DataRetentionAndPurgePanel /><div className="panel view-panel"><FilterToolbar {...{ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, sort, setSort, onExport: exportLedger }} /><div className="ledger-table-wrap">{filtered.length ? <table className="ledger-table"><thead><tr><th>Target</th><th>Vendor</th><th>Protocol</th><th>Signal</th><th>Proximity</th><th>Node</th><th>Last seen</th><th>Status</th><th /></tr></thead><tbody>{filtered.map((device, index) => <tr key={device.id} data-testid={`ledger-row-${device.id}`} tabIndex={index === rowInTabOrder ? 0 : -1} aria-label={`Show details for ${device.mac}`} onClick={() => { if (detailsOpen && device.id === selectedId) { closeDetails(); return; } select(device.id); }} aria-expanded={detailsOpen && device.id === selectedId} onFocus={() => setFocusedRow(index)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(device.id); return; } moveFocus(event, index); }}><td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><button className="icon-button" aria-label={device.favorite ? `Remove ${device.mac} from favorites` : `Add ${device.mac} to favorites`} data-testid={`ledger-favorite-${device.id}`} onClick={event => { event.stopPropagation(); void toggleFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} /></button><span className="strong">{device.mac}</span></span></td><td>{device.vendor}</td><td>{device.protocol}</td><td>{device.signal === null ? '—' : `${device.signal} dBm`}{device.signalQualityPercent !== null ? ` · ${device.signalQualityPercent}% quality` : ''}</td><td>{device.maxProximity}</td><td>{device.node}</td><td>{device.lastSeen}</td><td><span className={`state ${device.status}`}>{device.status}</span></td><td><ChevronRight size={14} /></td></tr>)}</tbody></table> : <div className="empty-state"><Filter size={23} /><h3>No matching observations</h3><p>Nothing in the ledger matches the current filters.</p><button className="btn" data-testid="button-clear-filters" onClick={() => { setQuery(''); setProtocol('all'); setSort(DEFAULT_SORT); setShowGhosts(false); }}>Clear filters</button></div>}</div></div></>;
}
