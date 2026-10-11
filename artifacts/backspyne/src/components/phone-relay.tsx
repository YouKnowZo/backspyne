// The phone relay panel: start measuring from the device in your hand.
//
// The panel is written for someone standing in a corridor. It starts and stops on one
// button, states every sensor it could and could not open with the reason, and reports each
// sample it sent — so "is it working?" is answered by the screen rather than by a guess. When
// a sensor is unavailable it says so and keeps measuring with the ones that are available.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, BatteryCharging, Bluetooth, CheckCircle2, Crosshair, MapPin, Play, RefreshCw,
  Satellite, Signal, Smartphone, Square, Trash2, X,
} from 'lucide-react';

import {
  phoneRelayNodeId,
  phoneRelayNodeName,
  rememberPhoneRelayNodeName,
  startPhoneRelay,
  type PhoneRelayController,
  type PhoneRelayStatus,
} from '../lib/phone-relay';
import { timeAgo } from '../lib/format';

const INTERVALS: Array<{ ms: number; label: string }> = [
  { ms: 5_000, label: 'Every 5 s' },
  { ms: 10_000, label: 'Every 10 s' },
  { ms: 30_000, label: 'Every 30 s' },
];

function SensorIcon({ id }: { id: string }) {
  if (id === 'geolocation') return <Satellite aria-hidden="true" />;
  if (id === 'bluetooth') return <Bluetooth aria-hidden="true" />;
  if (id === 'motion') return <Activity aria-hidden="true" />;
  if (id === 'wakelock') return <BatteryCharging aria-hidden="true" />;
  return <Signal aria-hidden="true" />;
}

const STATE_WORDS: Record<string, string> = {
  available: 'measuring',
  'needs-permission': 'permission needed',
  denied: 'declined',
  unsupported: 'not exposed here',
};

export function PhoneRelay() {
  const [status, setStatus] = useState<PhoneRelayStatus | null>(null);
  const [intervalMs, setIntervalMs] = useState(10_000);
  const [name, setName] = useState(() => phoneRelayNodeName());
  const [busy, setBusy] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState<{ lat: number; lon: number; setAt: string } | null>(null);
  const [siteError, setSiteError] = useState('');
  const controller = useRef<PhoneRelayController | null>(null);

  // The origin outlives a single relay run, so it is read on mount as well as after a start.
  const readSite = useCallback(async () => {
    try {
      const response = await fetch('/api/phone-relay/site', { credentials: 'include' });
      if (!response.ok) {
        setSiteError(response.status === 401 || response.status === 503 ? 'Sign in to read the site frame.' : `The site frame could not be read (${response.status}).`);
        return;
      }
      const payload = await response.json() as { origin: { lat: number; lon: number; setAt: string } | null };
      setSiteError('');
      setSiteOrigin(payload.origin ?? null);
    } catch {
      setSiteError('The site frame could not be read; check your connection.');
    }
  }, []);

  useEffect(() => { void readSite(); }, [readSite]);

  // Leaving the view stops the relay: a phone that keeps sampling after the operator walked
  // away from the panel would be measuring without anyone watching it.
  useEffect(() => () => { void controller.current?.stop(); }, []);

  const start = async () => {
    if (controller.current) return;
    setBusy(true);
    rememberPhoneRelayNodeName(name.trim() || 'Operator phone');
    try {
      controller.current = await startPhoneRelay({
        nodeId: phoneRelayNodeId(),
        nodeName: name.trim() || 'Operator phone',
        intervalMs,
        onStatus: setStatus,
      });
      setStatus(controller.current.current());
    } catch {
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await controller.current?.stop();
    } finally {
      controller.current = null;
      setBusy(false);
    }
  };

  const origin = status?.siteOrigin ?? siteOrigin;
  const fix = status?.fix ?? null;

  return <section className="panel phone-relay" data-testid="phone-relay">
    <div className="panel-header">
      <div>
        <div className="panel-title">Measure from this device</div>
        <div className="panel-subtitle">No download needed — this browser reports its own radio and position readings</div>
      </div>
      <Smartphone size={16} aria-hidden="true" style={{ color: 'hsl(var(--muted-foreground))' }} />
    </div>

    <div className="phone-relay-body">
      <p className="phone-relay-intro">
        A desktop relay scans WiFi access points, because the operating system exposes them to a local program and no
        browser exposes them to a page. What this device can do without any install is report where it is, whether it was
        still, and — on a browser that grants an advertisement scan — which Bluetooth advertisers it heard and how strong
        they were. Standing in one place gives a distance and no direction; walking a few metres and reporting from each
        place is what turns those distances into a position.
      </p>

      <div className="phone-relay-controls">
        <div className="field">
          <label htmlFor="phone-relay-name">Relay name</label>
          <input
            id="phone-relay-name"
            name="phone-relay-name"
            autoComplete="off"
            data-testid="input-phone-relay-name"
            value={name}
            maxLength={80}
            disabled={status?.running}
            onChange={(event) => setName(event.target.value)}
            placeholder="Operator phone"
          />
        </div>
        <div className="field">
          <label htmlFor="phone-relay-interval">Sample interval</label>
          <select
            id="phone-relay-interval"
            name="phone-relay-interval"
            data-testid="select-phone-relay-interval"
            value={intervalMs}
            disabled={status?.running}
            onChange={(event) => setIntervalMs(Number(event.target.value))}
          >
            {INTERVALS.map((option) => <option key={option.ms} value={option.ms}>{option.label}</option>)}
          </select>
        </div>
        <div className="phone-relay-actions">
          {status?.running
            ? <button className="btn" data-testid="button-stop-phone-relay" disabled={busy} onClick={() => void stop()}><Square size={13} aria-hidden="true" /> Stop relay</button>
            : <button className="btn btn-primary" data-testid="button-start-phone-relay" disabled={busy} onClick={() => void start()}>{busy ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Starting</> : <><Play size={13} aria-hidden="true" /> Start relay on this device</>}</button>}
          {status?.running && <button className="btn" data-testid="button-send-sample" disabled={busy} onClick={() => void controller.current?.sendNow()}><RefreshCw size={13} aria-hidden="true" /> Send a reading now</button>}
        </div>
      </div>

      {status?.lastError && <div className="billing-notice error" role="status" data-testid="phone-relay-error">{status.lastError}</div>}

      <div className="phone-relay-readouts">
        <div className="phone-relay-readout">
          <span className="eyebrow">Relay state</span>
          <strong data-testid="phone-relay-state">{status?.running ? 'RUNNING' : 'STOPPED'}</strong>
          <small>{status?.lastSentAt ? `last sample ${timeAgo(new Date(status.lastSentAt).toISOString())}` : 'nothing sent yet'}</small>
        </div>
        <div className="phone-relay-readout">
          <span className="eyebrow">Position</span>
          <strong data-testid="phone-relay-fix">{fix ? `±${fix.accuracyMeters ?? '?'} m` : 'none yet'}</strong>
          <small>{fix ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}` : 'waiting for a location fix'}</small>
        </div>
        <div className="phone-relay-readout">
          <span className="eyebrow">In site frame</span>
          <strong data-testid="phone-relay-site-position">
            {status?.sitePosition && typeof status.sitePosition.x === 'number' && typeof status.sitePosition.y === 'number'
              ? `${status.sitePosition.x} m E · ${status.sitePosition.y} m N`
              : 'not placed'}
          </strong>
          <small>{status?.sitePosition?.reason ?? (origin ? 'metres east and north of the site origin' : 'no site origin yet')}</small>
        </div>
        <div className="phone-relay-readout">
          <span className="eyebrow">Sent</span>
          <strong data-testid="phone-relay-counts">{status ? `${status.samplesSent} / ${status.observationsSent}` : '0 / 0'}</strong>
          <small>samples / advertisers reported</small>
        </div>
      </div>

      <div className="phone-relay-sensors">
        {(status?.sensors ?? []).map((entry) => <div className={`phone-relay-sensor ${entry.state}`} key={entry.id} data-testid={`phone-sensor-${entry.id}`}>
          <span className="phone-relay-sensor-icon"><SensorIcon id={entry.id} /></span>
          <div>
            <div className="phone-relay-sensor-top"><strong>{entry.label}</strong><span className={`hardware-status ${entry.state === 'available' ? 'connected' : entry.state === 'needs-permission' ? 'permission' : 'limited'}`}>{STATE_WORDS[entry.state] ?? entry.state}</span></div>
            <p>{entry.detail}</p>
          </div>
        </div>)}
        {!status && <p className="phone-relay-idle">Press <strong>Start relay on this device</strong> to open the sensors this browser will allow and begin reporting. Nothing is measured before that.</p>}
      </div>

      <div className="phone-relay-origin">
        <div>
          <span className="eyebrow">Site origin</span>
          <p data-testid="phone-relay-origin">
            {origin
              ? `Metres east and north are measured from ${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)} (set ${timeAgo(origin.setAt)}).`
              : 'No origin yet. The first accepted fix becomes it, and every placement and estimate is measured from there.'}
          </p>
        </div>
        <div className="phone-relay-actions">
          <button className="btn" data-testid="button-set-origin" disabled={!fix} onClick={() => void controller.current?.setOrigin('set')}><Crosshair size={13} aria-hidden="true" /> Set origin to here</button>
          <button className="btn" data-testid="button-clear-origin" disabled={!origin} onClick={() => void controller.current?.setOrigin('clear')}><Trash2 size={13} aria-hidden="true" /> Clear</button>
        </div>
      </div>
      {siteError && <p className="phone-relay-idle" data-testid="phone-relay-site-error">{siteError}</p>}

      {status?.log.length ? <ol className="phone-relay-log" data-testid="phone-relay-log">
        {[...status.log].slice(-6).reverse().map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.kind}>
          <span className="mono">{new Date(entry.at).toLocaleTimeString()}</span> {entry.message}
        </li>)}
      </ol> : null}

      <p className="phone-relay-note">
        This relay belongs to your signed-in account rather than a paired relay, so it does not use up a paired-relay
        allowance, and while it runs it <strong>is</strong> the placement of this phone: each accepted fix moves the
        phone's marker to where it actually is, which is what lets a walk around a room locate what it heard. A phone
        measures wireless levels, not people: nothing here identifies a person, and a device that randomises its address
        will appear as a new device when its address rotates. Phone GNSS is usable outdoors with a clear view of the sky
        and often is not indoors, which is what the accuracy readout is for — a fix too coarse to measure from is
        reported as too coarse rather than used.
      </p>
      {status?.running && <p className="phone-relay-note" data-testid="phone-relay-running-note"><CheckCircle2 size={12} aria-hidden="true" /> Keep this page open while you walk. Measurements are taken by this page, so closing or backgrounding it stops them.</p>}
      {!status?.running && status && <p className="phone-relay-note" data-testid="phone-relay-stopped-note"><X size={12} aria-hidden="true" /> The relay is stopped and the sensors are released.</p>}
      {origin && !status?.running && <p className="phone-relay-note"><MapPin size={12} aria-hidden="true" /> An origin is already set, so a relay started now places you in the existing site frame.</p>}
    </div>
  </section>;
}
