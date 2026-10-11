// The device ledger: every observation this account has stored.
//
// The filters live in the URL rather than in the component, so the view an operator is looking
// at survives a refresh, can be bookmarked, and can be shared with a colleague — the same four
// values describe the same slice of the ledger to anyone who opens the link. This is a real
// ledger of 250-odd rows, so the row set is what it is; sorting and filtering are done on the
// stored values, never by re-querying with guessed parameters.

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Download, FileDown, Filter, Search, Star } from 'lucide-react';

import { useConsoleData } from '../lib/console-data';
import { DEVICE_SORTS, type DeviceSort } from '../lib/types';

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
  return <><div className="page-heading"><div><div className="page-kicker">Device ledger</div><h1>Every signal leaves a trace.</h1><p>Search and review adapter observations. Signal strength is not a reliable distance estimate; network discovery does not reveal every client device.</p></div><div className="header-actions"><button className="btn btn-primary" data-testid="button-export-ledger-header" onClick={exportLedger}><FileDown size={14} /> Export ledger</button></div></div><div className="panel view-panel"><FilterToolbar {...{ query, setQuery, protocol, setProtocol, showGhosts, setShowGhosts, sort, setSort, onExport: exportLedger }} /><div className="ledger-table-wrap">{filtered.length ? <table className="ledger-table"><thead><tr><th>Target</th><th>Vendor</th><th>Protocol</th><th>Signal</th><th>Proximity</th><th>Node</th><th>Last seen</th><th>Status</th><th /></tr></thead><tbody>{filtered.map((device, index) => <tr key={device.id} data-testid={`ledger-row-${device.id}`} tabIndex={index === rowInTabOrder ? 0 : -1} aria-label={`Show details for ${device.mac}`} onClick={() => { if (detailsOpen && device.id === selectedId) { closeDetails(); return; } select(device.id); }} aria-expanded={detailsOpen && device.id === selectedId} onFocus={() => setFocusedRow(index)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(device.id); return; } moveFocus(event, index); }}><td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><button className="icon-button" aria-label={device.favorite ? `Remove ${device.mac} from favorites` : `Add ${device.mac} to favorites`} data-testid={`ledger-favorite-${device.id}`} onClick={event => { event.stopPropagation(); void toggleFavorite(device.id); }}><Star className={device.favorite ? 'star' : ''} /></button><span className="strong">{device.mac}</span></span></td><td>{device.vendor}</td><td>{device.protocol}</td><td>{device.signal === null ? '—' : `${device.signal} dBm`}{device.signalQualityPercent !== null ? ` · ${device.signalQualityPercent}% quality` : ''}</td><td>{device.maxProximity}</td><td>{device.node}</td><td>{device.lastSeen}</td><td><span className={`state ${device.status}`}>{device.status}</span></td><td><ChevronRight size={14} /></td></tr>)}</tbody></table> : <div className="empty-state"><Filter size={23} /><h3>No matching observations</h3><p>Nothing in the ledger matches the current filters.</p><button className="btn" data-testid="button-clear-filters" onClick={() => { setQuery(''); setProtocol('all'); setSort(DEFAULT_SORT); setShowGhosts(false); }}>Clear filters</button></div>}</div></div></>;
}
