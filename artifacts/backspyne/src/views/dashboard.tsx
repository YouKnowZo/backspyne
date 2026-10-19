// The dashboard: what this relay is hearing, right now.
//
// Everything on this page is read from the one console data provider and stated in the relay's
// own vocabulary. Navigation is a link rather than a callback, so a view can be opened in a
// new tab and every panel here stays readable on its own.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useUser } from '@clerk/react';
import {
  ArrowDownToLine, BarChart3, Check, CheckCircle2, ChevronRight, Compass, Cpu, Download, FileDown, Gauge, MapPin, Plus, Radio, RefreshCw,
  Shield, Signal, Sparkles,
  TrendingDown, TrendingUp, X,
} from 'lucide-react';

import { BridgeDownload } from '../components/bridge-download';
import { CountBars, DeviceRows, NodeList, RelayChecklist, SignalChart, SignalScope } from '../components/console';
import { useConsoleData } from '../lib/console-data';
import { ShareReportLink } from '../components/share-report';
import {
  buildFirstRunProgress,
  FIRST_RUN_EVENT,
  markFirstRunReportExported,
  readFirstRunDismissed,
  readFirstRunReportExported,
  writeFirstRunDismissed,
  type FirstRunStepId,
} from '../lib/first-run';
import { relaySlug, usd } from '../lib/format';
import { clientReportUrl } from '../lib/reports';
import { VIEW_PATHS, type BillingCatalog, type IssuedRelay, type RelayListPayload, type RelayTokenSummary } from '../lib/types';

/**
 * Guided first-run setup checklist on the dashboard.
 *
 * Walks a new operator through the three real actions needed for a client handover:
 *   1. Pair a relay (with inline 1-click relay token generation + .env download, or browser relay link)
 *   2. Run a room scan (live observation collection from the desktop bridge or browser relay)
 *   3. Export or share a client report (opens the printable document or copies a signed client link)
 */
function FirstRunSetupChecklist({ onOpenClientReport }: { onOpenClientReport: () => void }) {
  const { user } = useUser();
  const { nodes, devices, apiStatus, siteLabel, operatorName } = useConsoleData();
  const operatorScope = user?.id ?? operatorName;

  const [pairedRelays, setPairedRelays] = useState<RelayTokenSummary[]>([]);
  const [allowance, setAllowance] = useState<RelayListPayload['allowance'] | null>(null);
  const [reportExportedAt, setReportExportedAt] = useState<string | null>(() => readFirstRunReportExported(operatorScope));
  const [dismissed, setDismissed] = useState<boolean>(() => readFirstRunDismissed(operatorScope));
  const [selectedStep, setSelectedStep] = useState<FirstRunStepId | null>(null);

  const [relayLabel, setRelayLabel] = useState('Primary room scanner');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState('');
  const [issuedRelay, setIssuedRelay] = useState<IssuedRelay | null>(null);
  const [copiedEnv, setCopiedEnv] = useState(false);

  const loadRelays = useCallback(async () => {
    try {
      const response = await fetch('/api/relays', { credentials: 'include' });
      if (!response.ok) return;
      const payload = await response.json() as RelayListPayload;
      setPairedRelays(payload.relays ?? []);
      setAllowance(payload.allowance ?? null);
    } catch {
      // Keep existing relay list if offline.
    }
  }, []);

  useEffect(() => {
    void loadRelays();
  }, [loadRelays, nodes.length]);

  useEffect(() => {
    setReportExportedAt(readFirstRunReportExported(operatorScope));
    setDismissed(readFirstRunDismissed(operatorScope));
  }, [operatorScope]);

  useEffect(() => {
    const syncFromStorage = () => {
      setReportExportedAt(readFirstRunReportExported(operatorScope));
      setDismissed(readFirstRunDismissed(operatorScope));
    };
    window.addEventListener(FIRST_RUN_EVENT, syncFromStorage);
    return () => window.removeEventListener(FIRST_RUN_EVENT, syncFromStorage);
  }, [operatorScope]);

  const progress = buildFirstRunProgress({
    apiStatus,
    nodes,
    devices,
    pairedRelays,
    reportExportedAt,
  });

  const focusedStepId: FirstRunStepId = selectedStep ?? progress.activeStepId ?? 'export-report';

  const createQuickRelay = async () => {
    const trimmed = relayLabel.trim() || 'Primary room scanner';
    setPairingBusy(true);
    setPairingError('');
    setCopiedEnv(false);
    try {
      const response = await fetch('/api/relays', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      });
      const body = await response.json().catch(() => null) as { token?: unknown; relay?: RelayTokenSummary; error?: unknown } | null;
      if (response.ok && typeof body?.token === 'string' && body.token) {
        setIssuedRelay({
          token: body.token,
          label: trimmed,
          nodeId: `relay-${relaySlug(trimmed)}-${body.relay?.id.slice(-6) ?? '01'}`,
        });
        await loadRelays();
        return;
      }
      setPairingError(typeof body?.error === 'string' && body.error ? body.error : `Could not pair relay (${response.status}).`);
    } catch {
      setPairingError('Could not reach the operator API to pair a relay.');
    } finally {
      setPairingBusy(false);
    }
  };

  const envSnippet = issuedRelay ? [
    '# scanner/.env',
    `BACKSPYNE_API_URL=${window.location.origin}/api`,
    `BACKSPYNE_NODE_TOKEN=${issuedRelay.token}`,
    `BACKSPYNE_NODE_ID=${issuedRelay.nodeId}`,
    `BACKSPYNE_OWNER_ID=${user?.id ?? '<your operator user id>'}`,
    'BACKSPYNE_MODE=live',
  ].join('\n') : '';

  const copyEnvSnippet = async () => {
    if (!envSnippet) return;
    try {
      await navigator.clipboard.writeText(envSnippet);
      setCopiedEnv(true);
    } catch {
      setPairingError('Clipboard access was blocked; use Save as .env or copy the lines below.');
    }
  };

  const downloadEnvFile = () => {
    if (!envSnippet) return;
    const blob = new Blob([`${envSnippet}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '.env';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const toggleDismiss = (next: boolean) => {
    setDismissed(next);
    writeFirstRunDismissed(operatorScope, next);
  };

  if (dismissed) {
    return <div className="first-run-collapsed" data-testid="first-run-collapsed">
      <span><Compass size={14} aria-hidden="true" /> <strong>Operator setup guide</strong> · {progress.completedCount} of {progress.totalCount} milestones complete</span>
      <button type="button" className="btn" data-testid="button-reopen-first-run" onClick={() => toggleDismiss(false)}>Show setup checklist</button>
    </div>;
  }

  return <section className="panel first-run-wizard" data-testid="panel-first-run-wizard" aria-label="First-run operator setup checklist">
    <div className="panel-header">
      <div>
        <div className="panel-title">First-run operator setup</div>
        <div className="panel-subtitle">
          {progress.allComplete
            ? 'All 3 milestones completed — your relay, room scan, and client report workflow are ready'
            : `${progress.completedCount} of ${progress.totalCount} milestones complete · follow each step to produce your first client assessment`}
        </div>
      </div>
      <div className="panel-tools">
        <span className={`hardware-status ${progress.allComplete ? 'connected' : 'permission'}`} data-testid="first-run-progress-badge">
          {progress.completedCount}/{progress.totalCount} COMPLETE
        </span>
        <button
          type="button"
          className="icon-button"
          data-testid="button-dismiss-first-run"
          aria-label="Hide first-run setup checklist"
          title="Hide setup checklist"
          onClick={() => toggleDismiss(true)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>

    <div className="first-run-track" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={progress.completedCount}>
      <b style={{ width: `${Math.round((progress.completedCount / progress.totalCount) * 100)}%` }} />
    </div>

    <ol className="first-run-steps">
      {progress.steps.map(step => {
        const isFocused = focusedStepId === step.id;
        return <li
          key={step.id}
          data-testid={`first-run-step-${step.id}`}
          className={`first-run-step ${step.status} ${isFocused ? 'focused' : ''}`}
        >
          <button
            type="button"
            className="first-run-step-trigger"
            data-testid={`button-focus-step-${step.id}`}
            aria-expanded={isFocused}
            onClick={() => setSelectedStep(step.id)}
          >
            <span className="first-run-step-mark">
              {step.status === 'complete' ? <Check size={13} aria-hidden="true" /> : step.number}
            </span>
            <div className="first-run-step-copy">
              <div className="first-run-step-top">
                <strong>{step.title}</strong>
                <span className={`hardware-status ${step.status === 'complete' ? 'connected' : step.status === 'active' ? 'permission' : 'unsupported'}`}>
                  {step.status === 'complete' ? 'done' : step.status === 'active' ? 'next step' : 'queued'}
                </span>
              </div>
              <span className="first-run-step-summary">{step.summary}</span>
            </div>
          </button>
        </li>;
      })}
    </ol>

    <div className="first-run-stage" data-testid={`first-run-stage-${focusedStepId}`}>
      {focusedStepId === 'pair-relay' && (
        <div className="first-run-stage-body">
          <div className="first-run-stage-copy">
            <span className="eyebrow">Step 01 · Pair your first relay</span>
            <h3>Connect a scanner to this operator account</h3>
            <p>{progress.steps[0].detail}</p>
            {pairingError && <div className="billing-notice error" role="status" data-testid="first-run-pair-error">{pairingError}</div>}
            {!issuedRelay ? (
              <div className="first-run-inline-form">
                <div className="field">
                  <label htmlFor="first-run-relay-label">Relay label</label>
                  <input
                    id="first-run-relay-label"
                    name="first-run-relay-label"
                    autoComplete="off"
                    data-testid="input-first-run-relay-label"
                    value={relayLabel}
                    maxLength={120}
                    onChange={event => setRelayLabel(event.target.value)}
                    placeholder="Primary room scanner"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="button-first-run-pair-relay"
                  disabled={pairingBusy || (allowance ? !allowance.unlimited && allowance.remaining <= 0 : false)}
                  onClick={() => void createQuickRelay()}
                >
                  {pairingBusy ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Issuing token</> : <><Plus size={13} aria-hidden="true" /> Pair desktop relay now</>}
                </button>
                <Link className="btn" data-testid="link-first-run-browser-relay" href={VIEW_PATHS.hardware}>
                  Or use browser relay (no install) <ChevronRight size={13} aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <div className="relay-token" data-testid="first-run-relay-issued" aria-live="polite">
                <strong>Relay paired — save this <code>.env</code> into your <code>scanner/</code> folder now (shown once).</strong>
                <pre>{envSnippet}</pre>
                <div className="relay-token-actions">
                  <button type="button" className="btn btn-primary" data-testid="button-first-run-download-env" onClick={downloadEnvFile}>
                    <Download size={13} aria-hidden="true" /> Save as .env
                  </button>
                  <button type="button" className="btn" data-testid="button-first-run-copy-env" onClick={() => void copyEnvSnippet()}>
                    {copiedEnv ? <><Check size={13} aria-hidden="true" /> Copied</> : 'Copy .env lines'}
                  </button>
                  <button type="button" className="btn" data-testid="button-first-run-advance-scan" onClick={() => setSelectedStep('room-scan')}>
                    Continue to Step 02 <ChevronRight size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {focusedStepId === 'room-scan' && (
        <div className="first-run-stage-body">
          <div className="first-run-stage-copy">
            <span className="eyebrow">Step 02 · Run a room scan</span>
            <h3>Collect live WiFi &amp; Bluetooth observations</h3>
            <p>{progress.steps[1].detail}</p>
            <div className="checklist-commands">
              <code>Windows&nbsp;&nbsp;scanner\start.bat</code>
              <code>macOS / Linux&nbsp;&nbsp;./scanner/start.sh</code>
            </div>
            <div className="first-run-actions">
              <Link className="btn btn-primary" data-testid="link-first-run-hardware-scan" href={VIEW_PATHS.hardware}>
                <Radio size={14} aria-hidden="true" /> Open Hardware &amp; browser relay
              </Link>
              <Link className="btn" data-testid="link-first-run-calibration" href={VIEW_PATHS.calibration}>
                <MapPin size={14} aria-hidden="true" /> Run a calibration walk
              </Link>
              {progress.scanCompleted && (
                <button type="button" className="btn" data-testid="button-first-run-advance-report" onClick={() => setSelectedStep('export-report')}>
                  Continue to Step 03 <ChevronRight size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            <BridgeDownload testId="bridge-download-first-run" />
          </div>
        </div>
      )}

      {focusedStepId === 'export-report' && (
        <div className="first-run-stage-body">
          <div className="first-run-stage-copy">
            <span className="eyebrow">Step 03 · Export a client report</span>
            <h3>Hand over the printable assessment or signed client link</h3>
            <p>{progress.steps[2].detail}</p>
            <div className="first-run-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="button-first-run-export-report"
                onClick={onOpenClientReport}
              >
                <FileDown size={14} aria-hidden="true" /> Open printable client report
              </button>
              <Link className="btn" data-testid="link-first-run-assessment" href={VIEW_PATHS.sensing}>
                Inspect full assessment <ChevronRight size={13} aria-hidden="true" />
              </Link>
            </div>
            <ShareReportLink siteLabel={siteLabel} operatorName={operatorName} operatorScope={operatorScope} />
            {progress.reportExported && (
              <p className="first-run-complete-note" data-testid="first-run-complete-note">
                <CheckCircle2 size={14} aria-hidden="true" /> Setup complete. Your printable assessment and shareable link reflect every new observation stored by your relays.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  </section>;
}

/**
 * Where this account's radios can actually be placed.
 *
 * A position needs a level, and a level arrives in one of two vocabularies: measured dBm, or a
 * driver's link-quality percentage. The second used to mean a radio could not be placed at all,
 * which left every WiFi access point seen from Windows out of the map. Saying how many radios
 * are locatable, and which vocabulary each level came from, is how an operator can tell whether
 * a missing fix is a modelling limit or simply a radio nobody has walked past yet.
 */
function PositionCoveragePanel() {
  const { devices, nodes, liveMode } = useConsoleData();
  const placedRelays = nodes.filter(node => typeof node.positionX === 'number' && typeof node.positionY === 'number').length;
  const withLevels = devices.filter(device => device.signal !== null);
  const measured = withLevels.filter(device => !device.signalDerived).length;
  const derived = withLevels.filter(device => device.signalDerived).length;
  const wifiLocatable = withLevels.filter(device => device.protocol === 'WiFi').length;
  const bleLocatable = withLevels.filter(device => device.protocol === 'BLE').length;
  const withoutLevel = devices.length - withLevels.length;
  return <section className="panel" data-testid="panel-position-coverage">
    <div className="panel-header">
      <div>
        <div className="panel-title">Position coverage</div>
        <div className="panel-subtitle">{withLevels.length} of {devices.length} radios reported a usable level · {placedRelays} placed relay{placedRelays === 1 ? '' : 's'}</div>
      </div>
      <MapPin size={16} className="panel-glyph" />
    </div>
    <div className="device-details-grid location-grid">
      <div className="device-detail"><span>WiFi access points with a level</span><strong>{wifiLocatable}</strong></div>
      <div className="device-detail"><span>BLE advertisers with a level</span><strong>{bleLocatable}</strong></div>
      <div className="device-detail"><span>Level measured by the adapter</span><strong>{measured}</strong></div>
      <div className="device-detail"><span>Level derived from link quality</span><strong>{derived}</strong></div>
      <div className="device-detail"><span>No usable level</span><strong>{withoutLevel}</strong></div>
      <div className="device-detail"><span>Vantage points for a fix</span><strong>{placedRelays >= 3 ? `${placedRelays} placed relays` : liveMode ? 'a walked phone counts too' : 'fewer than three'}</strong></div>
    </div>
    <p className="location-note">
      A level plus a vantage point is what a position needs. Windows WiFi and NetworkManager report a 0-100 link-quality
      percentage instead of power; it is mapped into decibels so those access points can be placed rather than dropped,
      and marked as derived wherever a level is shown. {derived > 0 ? `${derived} radio${derived === 1 ? '' : 's'} in scope rely on that mapping.` : 'No level here relies on that mapping.'} Radios with no level stay in the inventory and are never assigned a default, because a made-up level would move an estimate silently.
    </p>
    <p className="location-note">A fit is only as good as the site's own constants, and the deployed ones are a generic indoor guess. <Link href={VIEW_PATHS.calibration}>Calibrate this site</Link> with a walk to replace them.</p>
  </section>;
}

/**
 * The commercial surface on the dashboard: which plan this account is on, what it entitles an
 * operator to, and what an upgrade would add. It reads the server's catalog, so a price shown
 * here is a price the server would actually charge, and it says plainly when checkout is not
 * configured rather than offering a button that cannot complete.
 */
function PlanPanel() {
  const { nodes, devices } = useConsoleData();
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [unavailable, setUnavailable] = useState('');
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch('/api/billing/catalog', { credentials: 'include' });
        if (disposed) return;
        if (!response.ok) {
          setUnavailable(response.status === 401 || response.status === 503 ? 'The plan cannot be read while the operator API is unavailable.' : `The plan request failed (${response.status}).`);
          return;
        }
        setCatalog(await response.json() as BillingCatalog);
        setUnavailable('');
      } catch {
        if (!disposed) setUnavailable('The plan could not be read.');
      }
    })();
    return () => { disposed = true; };
  }, []);
  const relays = nodes.length;
  const allowance = catalog?.entitlements.unlimited ? 'unlimited' : catalog ? String(catalog.entitlements.maxRelays) : 'unknown';
  const paid = catalog ? catalog.entitlements.reportExport : false;
  return <section className="panel" data-testid="panel-plan">
    <div className="panel-header">
      <div>
        <div className="panel-title">Plan and allowance</div>
        <div className="panel-subtitle">{catalog ? `${catalog.currentPlanName ?? catalog.currentPlanId} · ${catalog.status}` : 'Reading the current plan'}</div>
      </div>
      <Sparkles size={16} className="panel-glyph" />
    </div>
    {unavailable
      ? <p className="location-note" data-testid="plan-unavailable">{unavailable}</p>
      : catalog ? <>
        <div className="device-details-grid location-grid">
          <div className="device-detail"><span>Authorized relays</span><strong>{relays} of {allowance}</strong></div>
          <div className="device-detail"><span>Observation history</span><strong>{catalog.entitlements.unlimited ? 'full' : `${catalog.entitlements.historyDays} days`}</strong></div>
          <div className="device-detail"><span>Client report export</span><strong>{catalog.entitlements.reportExport ? 'included' : 'not included'}</strong></div>
          <div className="device-detail"><span>Radios observed</span><strong>{devices.length}</strong></div>
        </div>
        <div className="plan-upsell">
          {paid
            ? <p className="location-note">This account carries the paid entitlements above. <Link href={VIEW_PATHS.billing}>Manage the plan</Link> to change or cancel it.</p>
            : <p className="location-note">
              This account is on the free plan: one relay, seven days of history, and no client report export. Paid plans add relays,
              longer history, and the report export a client handover needs{catalog.plans[1] ? `, from ${usd(catalog.plans[1].priceMonthlyUsd)} per month` : ''}.
              {catalog.configured ? ' ' : ' Checkout is not configured on this deployment yet, so the plans are listed but cannot be bought here.'}
              {' '}<Link href={VIEW_PATHS.billing}>See the plans</Link>.
            </p>}
        </div>
      </> : <p className="location-note">Reading the plan…</p>}
  </section>;
}

/**
 * The assessment, shown on screen. Every number here comes from the shared assessment module
 * that also renders the printable client report, so the document and the screen it came from
 * cannot disagree about what was measured.
 */
export function MeasurementAssessment() {
  const { user } = useUser();
  const { assessment, operatorName, siteLabel } = useConsoleData();
  const operatorScope = user?.id ?? operatorName;
  const openReport = () => {
    markFirstRunReportExported(operatorScope);
    window.open(clientReportUrl(siteLabel, operatorName), '_blank', 'noopener');
  };
  const { channelPlan, security, vendors, signals, totals, findings } = assessment;
  return <div className="assessment-grid">
    <section className="panel assessment-card" data-testid="assessment-channel-plan">
      <div className="panel-header"><div><div className="panel-title">Channel plan</div><div className="panel-subtitle">{channelPlan.distinctChannels} distinct channels · {channelPlan.withoutChannel} access points reported no channel</div></div><Radio size={15} className="panel-glyph" /></div>
      <CountBars entries={channelPlan.bands.map(entry => [entry.band, entry.count] as [string, number])} emptyMessage="No access point reported a channel yet." testId="assessment-band-split" />
      <CountBars entries={channelPlan.busiest.map(entry => [`Channel ${entry.channel}`, entry.count] as [string, number])} emptyMessage="No busy channels to rank yet." testId="assessment-busiest-channels" />
      <p className="assessment-note">A band is inferred from the channel number by convention, 1–14 as 2.4 GHz and 15 upwards as 5 GHz, and anything ambiguous is reported as unclassified. 5 GHz and 6 GHz share their numbering, so a 6 GHz network can be counted inside 5 GHz here. {channelPlan.busiest[0] ? ` The busiest observed channel, ${channelPlan.busiest[0].channel}, carries ${channelPlan.busiest[0].count} access points.` : ''}</p>
    </section>
    <section className="panel assessment-card" data-testid="assessment-security">      <div className="panel-header"><div><div className="panel-title">Encryption posture</div><div className="panel-subtitle">{security.accessPoints} access points · {security.assessed ? `${security.reported} described a security mode` : 'no mode was described'}</div></div><Shield size={15} className="panel-glyph" /></div>
      {security.assessed
        ? <CountBars entries={[['Reported an encryption mode', security.secured], ['Reported no encryption', security.open], ...(security.unreported > 0 ? [['Reported no readable mode', security.unreported] as [string, number]] : [])]} emptyMessage="No reported security modes." testId="assessment-security-split" />
        : <p className="assessment-empty" data-testid="assessment-security-split">{security.accessPoints} access points are in scope and this adapter described a security mode for none of them, so protected and open access points cannot be told apart here. A relay whose adapter reports the mode — Windows through netsh, or Linux through NetworkManager — fills this section.</p>}
      {security.open > 0 && <p className="assessment-note warn">{security.open} access point{security.open === 1 ? '' : 's'} advertise no encryption. That is a statement about those access points, not about anything connected to them.</p>}
      {security.openNetworks.length > 0 && <ul className="open-networks" data-testid="assessment-open-networks">{security.openNetworks.map(network => <li key={`${network.ssid}-${network.channel}`}><span>{network.ssid || 'name not advertised'}</span><small>{network.channel ? `channel ${network.channel}` : 'channel not reported'}</small></li>)}</ul>}
      {security.unreported > 0 && security.assessed && <p className="assessment-note">{security.unreported} access point{security.unreported === 1 ? '' : 's'} described no mode this relay could read. Those are counted as not reported rather than assumed protected.</p>}
      {security.assessed && <p className="assessment-note">Encryption mode is declared by the access point itself. A reported mode is not evidence that a network is well configured or authorized.</p>}
    </section>
    <section className="panel assessment-card" data-testid="assessment-vendors">
      <div className="panel-header"><div><div className="panel-title">Vendor inventory</div><div className="panel-subtitle">{vendors.labelled} of {totals.devices} radios carry a vendor label</div></div><Cpu size={15} className="panel-glyph" /></div>
      <CountBars entries={vendors.byBasis.map(entry => [entry.label, entry.count] as [string, number])} emptyMessage="No observations to label yet." testId="assessment-vendor-basis" />
      <CountBars entries={vendors.top.map(entry => [entry.vendor, entry.count] as [string, number])} emptyMessage="No vendor could be attributed yet." testId="assessment-top-vendors" />
      <p className="assessment-note">{vendors.masked} of {totals.devices} radios report an address the host operating system masked. A masked address carries no manufacturer information at all, so those rows can never show a vendor, and they are not extra devices.</p>
    </section>
    <section className="panel assessment-card" data-testid="assessment-signals">
      <div className="panel-header"><div><div className="panel-title">Level distribution</div><div className="panel-subtitle">{signals.reported} of {totals.devices} radios reported a level in dBm</div></div><Signal size={15} className="panel-glyph" /></div>
      <div className="assessment-stats"><div><div className="eyebrow">Strongest</div><strong>{signals.strongest === null ? '—' : `${signals.strongest} dBm`}</strong></div><div><div className="eyebrow">Median</div><strong>{signals.median === null ? '—' : `${signals.median} dBm`}</strong></div><div><div className="eyebrow">Weakest</div><strong>{signals.weakest === null ? '—' : `${signals.weakest} dBm`}</strong></div></div>
      <CountBars entries={signals.buckets.map(bucket => [bucket.label, bucket.count] as [string, number])} emptyMessage="No numeric level was reported." testId="assessment-signal-buckets" />
      {signals.derived > 0 && <p className="assessment-note">{signals.derived} of these levels came from the driver's link-quality percentage rather than measured power — Windows WiFi and NetworkManager report that scale — and are mapped into decibels so they can be modelled. The mapping is a convention between −100 dBm at 0% and −50 dBm at 100% that saturates at the top, so a distance from one is less certain than from a measured level.</p>}
      {signals.missing > 0 && <p className="assessment-note">{signals.missing} radios reported no usable level at all: no dBm and no percentage. Those cannot be placed or calibrated from, and are counted here instead of being given a default.</p>}
    </section>
    <section className="panel assessment-card" data-testid="assessment-quality">
      <div className="panel-header"><div><div className="panel-title">Observation quality</div><div className="panel-subtitle">{totals.devices} radios in the current scope</div></div><Gauge size={15} className="panel-glyph" /></div>
      <div className="assessment-stats"><div><div className="eyebrow">Last minute</div><strong>{totals.fresh}</strong></div><div><div className="eyebrow">Last five minutes</div><strong>{totals.idle}</strong></div><div><div className="eyebrow">No longer current</div><strong>{totals.ghost}</strong></div></div>
      <CountBars entries={[['Address usable for a vendor lookup', totals.devices - vendors.masked], ['Address hidden by the host OS', vendors.masked]]} emptyMessage="No observations yet." testId="assessment-address-quality" />
      <p className="assessment-note">A radio the relay reported within the last minute is current, up to five minutes is idle, and anything older stays in scope as history. Older rows are the same devices seen earlier, not new ones.</p>
    </section>
    <section className="panel assessment-card assessment-wide" data-testid="assessment-findings">
      <div className="panel-header"><div><div className="panel-title">Findings</div><div className="panel-subtitle">{findings.length} statement{findings.length === 1 ? '' : 's'} this data supports, each with what it does not mean</div></div><button className="btn btn-primary" data-testid="button-client-report-sensing" onClick={openReport}><FileDown size={14} /> Prepare client report</button></div>
      <ol className="findings">{findings.map(finding => <li key={finding.id} className={`finding ${finding.severity}`} data-testid={`finding-${finding.id}`}><span className="chip">{finding.severity === 'attention' ? 'Needs a look' : 'Context'}</span><h3>{finding.title}</h3><p>{finding.detail}</p></li>)}</ol>
      <p className="assessment-note">The client report is this same assessment as a printable document: sectioned so it can be cited, with the method and its limits printed after the findings. On a plan without reporting it carries a trial notice.</p>
      <ShareReportLink siteLabel={siteLabel} operatorName={operatorName} operatorScope={operatorScope} />
    </section>
  </div>;
}

export function Dashboard() {
  const { user } = useUser();
  const {
    devices, nodes, assessment, operatorName, siteLabel, selectedId, select, toggleFavorite,
    liveMode: scanning, apiConnected, apiStatus, trail,
  } = useConsoleData();
  const operatorScope = user?.id ?? operatorName;
  const openClientReport = () => {
    markFirstRunReportExported(operatorScope);
    window.open(clientReportUrl(siteLabel, operatorName), '_blank', 'noopener');
  };
  const selected = devices.find(d => d.id === selectedId);
  const visibleDevices = devices.filter(d => d.status !== 'ghost');
  const activeNodes = nodes.filter(node => node.status === 'online').length;

  const signalSamples = trail.flatMap(sighting => typeof sighting.signalDbm === 'number' && Number.isFinite(sighting.signalDbm) ? [sighting.signalDbm] : []);
  const historyValues = signalSamples.length > 1 ? [...signalSamples].reverse().map(value => Math.abs(value)) : [];
  const latestSampleDbm = signalSamples.length ? signalSamples[0] : null;
  const oldestSampleDbm = signalSamples.length ? signalSamples[signalSamples.length - 1] : null;
  const latestSampleText = latestSampleDbm === null ? '—' : `${Math.round(latestSampleDbm)} dBm`;
  const oldestSampleText = oldestSampleDbm === null ? '—' : `${Math.round(oldestSampleDbm)} dBm`;
  const sampleSpanMinutes = trail.length < 2 ? null : (() => {
    const newest = new Date(trail[0].observedAt).getTime();
    const oldest = new Date(trail[trail.length - 1].observedAt).getTime();
    return Number.isFinite(newest) && Number.isFinite(oldest) ? Math.max(0, Math.round((newest - oldest) / 60000)) : null;
  })();
  const strengthTrend = latestSampleDbm === null || oldestSampleDbm === null ? null : latestSampleDbm - oldestSampleDbm > 3 ? 'stronger' : oldestSampleDbm - latestSampleDbm > 3 ? 'weaker' : 'steady';
  const historyEmptyMessage = trail.length ? 'Not enough reported signal samples to show a trend' : undefined;
  return <><div className="page-heading"><div><div className="page-kicker">Wireless assessment</div><h1>What this relay is hearing.</h1><p>WiFi access points and Bluetooth advertisers reported by your authorized relay at one vantage point. Standard scanning does not enumerate every nearby client device, and these measurements describe radios, not people.</p></div><div className="header-actions"><button className="btn btn-primary" data-testid="button-client-report-dashboard" onClick={openClientReport}><FileDown size={14} /> Prepare client report</button><button className="btn" data-testid="button-refresh-dashboard" onClick={() => window.location.reload()}><RefreshCw size={14} /> Refresh view</button></div></div>
     <div className="signal-banner"><Shield /><span><strong>Authorized environment only.</strong> {scanning ? 'Signed observations from an authorized local node are flowing into this session.' : apiStatus === 'error' ? 'The API returned an error reading scan data; the relay status cannot be confirmed. The database connection must be repaired before scans can be stored.' : apiStatus === 'unavailable' ? 'The operator API is unavailable, so relay status cannot be checked.' : nodes.length ? 'An authorized node is registered, but it has not reported an observation yet. Check its local bridge permissions and logs.' : apiConnected ? 'The operator API is connected, but no local relay is connected. Start the bridge from Hardware scan.' : 'Checking operator API and authorized relay status.'} This dashboard lists WiFi APs/BLE advertisers only, not all nearby phones or people.</span><Link className="banner-action" href={VIEW_PATHS.hardware}>Hardware scan <ChevronRight size={14} /></Link></div>
     <FirstRunSetupChecklist onOpenClientReport={openClientReport} />
     <RelayChecklist nodes={nodes} devices={devices} apiStatus={apiStatus} />
     <div className="lower-grid"><PlanPanel /><PositionCoveragePanel /></div>
     <section className="panel hero-plate" data-testid="panel-live-summary">
       <div className="hero-head"><div><div className="panel-title">What this relay is hearing</div><div className="panel-subtitle">{scanning ? 'Signed observations are arriving from an authorized relay' : nodes.length ? 'A relay is registered but has not reported an observation yet' : 'No relay is registered to this account yet'}</div></div><div className={`status-pill ${scanning ? '' : 'paused'}`}><span className="pulse-dot" />{scanning ? 'RELAY REPORTING' : 'AWAITING RELAY'}</div></div>
       <div className="hero-readouts">
         <div><span className="eyebrow">Radios in scope</span><strong>{assessment.totals.devices}</strong><small>{activeNodes} relay{activeNodes === 1 ? '' : 's'} reporting</small></div>
         <div><span className="eyebrow">WiFi access points</span><strong>{assessment.totals.wifi}</strong><small>{assessment.channelPlan.distinctChannels} distinct channels</small></div>
         <div><span className="eyebrow">BLE advertisers</span><strong>{assessment.totals.ble}</strong><small>{assessment.vendors.labelled} with a vendor label</small></div>
         <div><span className="eyebrow">Reported in the last minute</span><strong>{assessment.totals.fresh}</strong><small>{assessment.totals.ghost} no longer current</small></div>
         <div><span className="eyebrow">Levels from link quality</span><strong>{assessment.signals.derived}</strong><small>{assessment.signals.reported} radios reported a usable level</small></div>
         <div><span className="eyebrow">WiFi access points placeable</span><strong>{devices.filter(device => device.protocol === 'WiFi' && device.signal !== null).length}</strong><small>level plus a vantage point is what a fix needs</small></div>
       </div>
       {assessment.findings.filter(finding => finding.severity === 'attention').slice(0, 1).map(finding => <p className="hero-finding" key={finding.id} data-testid={`hero-finding-${finding.id}`}><span className="chip">Needs a look</span>{finding.title} — {finding.detail}</p>)}
     </section>     <div className="main-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Levels observed</div><div className="panel-subtitle">One mark per radio · select a mark to open its details in the side panel</div></div></div><SignalScope devices={devices} selectedId={selectedId} onSelect={select} /></section>
       <section className="panel"><div className="panel-header"><div><div className="panel-title">Signal history</div><div className="panel-subtitle">{selected ? `${selected.vendor} · ${selected.mac}` : 'Select a radio to follow its reported level'}</div></div><BarChart3 size={16} style={{ color: 'hsl(var(--muted-foreground))' }} /></div><div className="history"><SignalChart values={historyValues} emptyMessage={historyEmptyMessage} />{signalSamples.length > 0 && <div className="history-trend" data-testid="signal-history-trend"><div><div className="eyebrow">Samples</div><strong>{signalSamples.length}</strong></div><div><div className="eyebrow">Latest</div><strong>{latestSampleText}</strong></div><div><div className="eyebrow">Oldest</div><strong>{oldestSampleText}</strong></div><div><div className="eyebrow">Span</div><strong>{sampleSpanMinutes === null ? 'unknown' : `${sampleSpanMinutes} min`}</strong></div><div><div className="eyebrow">Reported strength</div><strong>{strengthTrend === null ? 'single sample' : strengthTrend}{strengthTrend === 'stronger' ? <TrendingUp size={13} /> : strengthTrend === 'weaker' ? <TrendingDown size={13} /> : null}</strong></div></div>}{signalSamples.length > 1 && <p className="history-note">Reported-strength trend compares the newest and oldest dBm readings in this sample set. It is a direction indicator only; RSSI is not a distance, position, occupancy, or person measurement.</p>}<div className="history-summary"><div><div className="eyebrow">Current signal</div><div className="history-value">{selected?.signal ?? '—'}<small>{selected?.signal !== null && selected ? 'dBm' : 'NO MEASUREMENT'}</small></div></div><div style={{ textAlign: 'right' }}><div className="eyebrow">Proximity</div><div className="history-value" style={{ fontSize: 14, marginTop: 7 }}>{selected?.maxProximity ?? '—'}</div></div></div></div></section>
    </div>
    <div className="lower-grid"><section className="panel"><div className="panel-header"><div><div className="panel-title">Latest discoveries</div><div className="panel-subtitle">{visibleDevices.length} visible targets · sorted by signal</div></div><Link className="btn" data-testid="button-open-ledger" href={VIEW_PATHS.ledger}>Open ledger <ArrowDownToLine size={13} /></Link></div><DeviceRows devices={visibleDevices.slice(0, 4)} selectedId={selectedId} onSelect={select} onFavorite={toggleFavorite} /></section><section className="panel"><div className="panel-header"><div><div className="panel-title">Scan nodes</div><div className="panel-subtitle">Local sensor topology</div></div><Link className="icon-button" data-testid="button-open-nodes" href={VIEW_PATHS.nodes} aria-label="Open relays"><ChevronRight /></Link></div><NodeList nodes={nodes} /></section></div>
  </>;
}
