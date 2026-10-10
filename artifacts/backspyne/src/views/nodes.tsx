// Vantage points: the relays registered to this account, and pairing a new one.
//
// Pairing is per operator account, so the token belongs to this signed-in operator and is
// shown exactly once. A relay that stops reporting is revoked rather than edited, and the
// allowance is enforced by the server: this view only explains what the server already
// decided.

import { useEffect, useState } from 'react';
import { useUser } from '@clerk/react';
import { Antenna, Check, Network, Plus, RefreshCw, Shield, ShieldCheck, Trash2, X } from 'lucide-react';

import { useConsoleData } from '../lib/console-data';
import { relaySlug, relayUsage, timeAgo } from '../lib/format';
import type { IssuedRelay, RelayListPayload, RelayTokenSummary } from '../lib/types';

/** Pairing a relay is per operator account: the token is shown once and stored as a digest. */
function RelayPairing() {
  const { user } = useUser();
  const [payload, setPayload] = useState<RelayListPayload | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<IssuedRelay | null>(null);
  const [copied, setCopied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const load = async () => {
    try {
      const response = await fetch('/api/relays', { credentials: 'include' });
      if (response.status === 401 || response.status === 503) {
        setUnavailable(true);
        setPayload(null);
        return;
      }
      if (!response.ok) {
        setError(`The relay list could not be read (${response.status}).`);
        return;
      }
      setUnavailable(false);
      setError('');
      setPayload(await response.json() as RelayListPayload);
    } catch {
      setError('The relay list could not be read; check your connection.');
    }
  };
  useEffect(() => { void load(); }, []);

  const readError = async (response: Response, fallback: string) => {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof body?.error === 'string' && body.error ? body.error : fallback;
  };

  const create = async () => {
    const trimmed = label.trim();
    if (!trimmed) { setError('Give the relay a label so you can recognise it later.'); return; }
    setBusy(true); setError(''); setCopied(false);
    try {
      const response = await fetch('/api/relays', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: trimmed }) });
      const body = await response.json().catch(() => null) as { token?: unknown; relay?: RelayTokenSummary } | null;
      if (response.ok && typeof body?.token === 'string' && body.token) {
        setIssued({ token: body.token, label: trimmed, nodeId: `relay-${relaySlug(trimmed)}-${body.relay?.id.slice(-6) ?? '01'}` });
        setLabel('');
        await load();
        return;
      }
      setError(await readError(response, response.status === 403 ? 'Your current plan has no relay allowance left.' : `The pairing token could not be created (${response.status}).`));
    } catch {
      setError('The pairing token could not be created; check your connection.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (relay: RelayTokenSummary) => {
    if (!window.confirm(`Revoke "${relay.label}"? A relay using this token stops reporting immediately.`)) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/relays/${encodeURIComponent(relay.id)}/revoke`, { method: 'POST', credentials: 'include' });
      if (!response.ok) { setError(await readError(response, `The relay could not be revoked (${response.status}).`)); return; }
      await load();
    } catch {
      setError('The relay could not be revoked; check your connection.');
    } finally {
      setBusy(false);
    }
  };

  const snippet = issued ? [
    '# scanner/.env',
    `BACKSPYNE_API_URL=${window.location.origin}/api`,
    `BACKSPYNE_NODE_TOKEN=${issued.token}`,
    `BACKSPYNE_NODE_ID=${issued.nodeId}`,
    `BACKSPYNE_OWNER_ID=${user?.id ?? '<your operator user id>'}`,
    'BACKSPYNE_MODE=live',
  ].join('\n') : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setError('The clipboard is unavailable in this browser; select the text and copy it manually.');
    }
  };

  const active = payload?.relays.filter(relay => relay.active).length ?? 0;
  const allowance = payload?.allowance;

  return <section className="panel relay-pairing" data-testid="relay-pairing">
    <div className="panel-header"><div><div className="panel-title">Relay pairing</div><div className="panel-subtitle">{allowance ? `${active} of ${allowance.maxRelays} paired relay${allowance.maxRelays === 1 ? '' : 's'} in use` : 'Per-account relay credentials'}</div></div><ShieldCheck size={16} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
    {unavailable && <div className="billing-notice" role="status" data-testid="relay-pairing-unavailable">The operator API is unavailable, so paired relays cannot be listed or created right now.</div>}
    {error && <div className="billing-notice error" role="status" data-testid="relay-pairing-error">{error}</div>}
    <p className="relay-pairing-note">Each operator pairs their own relay. The token below is shown once and stored only as a digest, so a lost token is replaced by revoking the relay and pairing again.</p>
    {!unavailable && <div className="relay-create">
      <div className="field"><label htmlFor="relay-label">Relay label</label><input id="relay-label" name="relay-label" autoComplete="off" data-testid="input-relay-label" value={label} onChange={event => setLabel(event.target.value)} placeholder="Office AP sweep" maxLength={120} /></div>
      <button className="btn btn-primary" data-testid="button-create-relay" disabled={busy || (allowance ? allowance.remaining <= 0 : false)} onClick={() => void create()}>{busy ? <><RefreshCw className="spin" size={13} /> Working</> : <><Plus size={13} /> Pair a relay</>}</button>
    </div>}
    {allowance && allowance.remaining <= 0 && <p className="relay-pairing-note" data-testid="relay-allowance-full">This plan allows {allowance.maxRelays} paired relay{allowance.maxRelays === 1 ? '' : 's'}. Revoke one or upgrade the plan to pair another.</p>}
    {issued && <div className="relay-token" data-testid="relay-token-issued" aria-live="polite">
      <strong>Copy this now — it is not stored and cannot be shown again.</strong>
      <pre style={{ overflowX: 'auto', overflowWrap: 'anywhere' }}>{snippet}</pre>
      <div className="relay-token-actions"><button className="btn" data-testid="button-copy-relay-token" aria-label="Copy the relay environment lines" onClick={() => void copy()}>{copied ? <><Check size={13} /> Copied</> : 'Copy .env lines'}</button><button className="btn" aria-label={`Hide the token for ${issued.label}`} onClick={() => setIssued(null)}>Hide</button></div>
      <p className="relay-pairing-note">Paste these into <code>scanner/.env</code> on the machine that will scan, then start the relay with <code>scanner\start.bat</code> (Windows) or <code>./scanner/start.sh</code> (macOS/Linux). Keep it running; this page updates as soon as a signed heartbeat arrives.</p>
    </div>}
    {payload && payload.relays.length > 0 ? <div className="relay-list">{payload.relays.map(relay => <div className="relay-row" key={relay.id} data-testid={`relay-row-${relay.id}`}>
      <div style={{ minWidth: 0 }}><div className="relay-row-label" title={relay.label} style={{ overflowWrap: 'anywhere' }}>{relay.label}</div><div className="relay-row-meta">paired {timeAgo(relay.createdAt)} · {relayUsage(relay.lastUsedAt)}</div></div>
      <span className={`hardware-status ${relay.active ? 'connected' : 'limited'}`}>{relay.active ? 'active' : 'revoked'}</span>
      {relay.active && <button className="btn" disabled={busy} aria-label={`Revoke the relay ${relay.label}`} data-testid={`button-revoke-relay-${relay.id}`} onClick={() => void revoke(relay)}><Trash2 size={13} /> Revoke</button>}
    </div>)}</div> : payload ? <div className="empty-state"><Shield size={23} /><h3>No paired relays</h3><p>Pair a relay to send signed measurements from a machine you control.</p></div> : null}
  </section>;
}

function Nodes() {
  const { nodes, addNode, removeNode } = useConsoleData();
  const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [adding, setAdding] = useState(false);
  const submit = async () => { if (name.trim() && address.trim() && await addNode(name.trim(), address.trim())) { setName(''); setAddress(''); setAdding(false); } };
  return <><div className="page-heading"><div><div className="page-kicker">Relay network</div><h1>Know your vantage points.</h1><p>Local relay nodes keep collection scoped, inspectable, and close to the operator.</p></div><button className="btn btn-primary" data-testid="button-add-node" onClick={() => setAdding(!adding)}>{adding ? <X size={14} /> : <Plus size={14} />}{adding ? 'Cancel' : 'Add node'}</button></div><div className="nodes-layout"><section className="panel"><div className="panel-header"><div><div className="panel-title">Registered nodes</div><div className="panel-subtitle">{nodes.filter(n => n.status === 'online').length} online · {nodes.length} total</div></div><Network size={16} style={{ color: 'hsl(var(--muted-foreground))' }} /></div><div className="node-grid">{nodes.length ? nodes.map(node => <div className="node-card" key={node.id} data-testid={`node-detail-${node.id}`}><div className="node-card-top"><span className="node-name" title={node.name}>{node.name}</span><button className="icon-button" aria-label={`Remove ${node.name}`} data-testid={`button-remove-node-${node.id}`} onClick={() => void removeNode(node.id)}><Trash2 size={13} /></button></div><div className="node-address" title={node.address}>{node.address} · {node.role}</div><div className="node-meta"><span className={node.status === 'online' ? 'node-status' : 'node-status offline'}>{node.status === 'online' ? 'heartbeat nominal' : 'last heartbeat'}</span><span>{node.lastSeen}</span></div><div style={{ marginTop: 13, color: '#abc1bd', font: '10px var(--app-font-mono)' }}>{node.devices} <span style={{ color: 'hsl(var(--muted-foreground))' }}>observations in scope</span></div></div>) : <div className="empty-state"><Network size={23} /><h3>No relay nodes registered</h3><p>Add an authorized local relay or start the scanner bridge.</p></div>}</div></section><section className="panel node-add"><div className="panel-title">Add a local relay</div><p>Register an authorized sensor adapter by its local address. Registration is stored for this operator account.</p>{adding ? <div className="form-grid"><div className="field full"><label htmlFor="node-name">Node label</label><input id="node-name" name="node-name" autoComplete="off" data-testid="input-node-name" value={name} onChange={e => setName(e.target.value)} placeholder="West hallway" /></div><div className="field full"><label htmlFor="node-address">Local address</label><input id="node-address" name="node-address" autoComplete="off" inputMode="url" data-testid="input-node-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="10.42.0.14" /></div><div className="form-actions field full"><button className="btn" data-testid="button-cancel-node" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" data-testid="button-save-node" onClick={() => void submit()}><Check size={14} /> Register node</button></div></div> : <div className="node-hero"><div className="node-hero-title"><Antenna size={15} /> Adapter contract ready</div><p>Use the scanner bridge to send signed heartbeats and observations to this registered operator.</p></div>}</section></div><RelayPairing /></>;
}

export { Nodes, RelayPairing };
