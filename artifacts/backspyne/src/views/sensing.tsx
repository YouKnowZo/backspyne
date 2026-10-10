// Assessment and sensing.
//
// One view, two kinds of evidence, kept visibly apart: the measured assessment (built by the
// shared model from WiFi/BLE observations the relay actually reported) and the experimental
// CSI research panels, which only appear when a compatible engine is connected and which are
// labelled as research at every point where they could be mistaken for a measurement.

import { CameraOff, CheckCircle2, CircleHelp, Gauge, Zap } from 'lucide-react';

import { MeasurementAssessment } from './dashboard';
import { RelayChecklist } from '../components/console';
import { useConsoleData } from '../lib/console-data';
import type { SensingMetric, SensingSnapshot } from '../lib/types';

function sensingMetricsFromSnapshot(snapshot: SensingSnapshot | null): SensingMetric[] {
  const metrics = snapshot?.metrics ?? {};
  const number = (key: string, digits = 1) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]) ? (metrics[key] as number).toFixed(digits) : '—';
  const status = snapshot ? 'Signed node sample' : 'Awaiting telemetry';
  const csiActive = metrics.sensingMode === 'research';
  const classification = metrics.classification && typeof metrics.classification === 'object' ? metrics.classification as Record<string, unknown> : {};
  const researchVitals = metrics.researchVitalSigns && typeof metrics.researchVitalSigns === 'object' ? metrics.researchVitalSigns as Record<string, unknown> : {};
  const modelStatus = metrics.poseModelStatus && typeof metrics.poseModelStatus === 'object' ? metrics.poseModelStatus as Record<string, unknown> : {};
  const pose = Array.isArray(metrics.poseKeypoints) ? metrics.poseKeypoints : [];
  const numericVitalsAuthorized = metrics.numericVitalsAuthorized === true;
  const rawEvidence = metrics.calibratedEvidence && typeof metrics.calibratedEvidence === 'object' ? metrics.calibratedEvidence as Record<string, unknown> : null;
  const evidenceCount = rawEvidence?.person_count;
  const evidence = rawEvidence?.schema === 'backspyne.calibrated-presence-evidence.v2' && typeof evidenceCount === 'number' && Number.isInteger(evidenceCount) && evidenceCount >= 0 && evidenceCount <= 255 && typeof rawEvidence.presence === 'boolean' && rawEvidence.presence === (evidenceCount > 0) && Array.isArray(rawEvidence.source_node_ids) ? rawEvidence : null;
  const rows: SensingMetric[] = [
    { label: 'Radio signal floor', value: number('signalFloorDbm', 1), unit: 'dBm', status, trend: typeof metrics.signalFloorDbm === 'number' ? 'measured AP/BLE sample' : 'no measurement' },
    { label: 'Radio signal variance', value: number('signalVarianceDb', 2), unit: 'dB²', status, trend: typeof metrics.signalVarianceDb === 'number' ? 'measured AP/BLE sample' : 'no measurement' },
    { label: 'CSI amplitude variance', value: number('csiAmplitudeVariance', 4), unit: 'amplitude²', status, trend: csiActive ? `${String(metrics.csiSampleCount ?? 0)} live source samples` : 'compatible CSI source not connected' },
    { label: 'Observed radios', value: typeof metrics.observationCount === 'number' ? String(metrics.observationCount) : '—', unit: '/ scan', status, trend: typeof metrics.observationCount === 'number' ? 'signed WiFi/BLE observations' : 'no radio observations' },
    { label: 'CSI source', value: csiActive ? String(metrics.csiSource ?? 'live') : '—', unit: '', status, trend: csiActive ? `node ${Array.isArray(metrics.csiNodeIds) ? metrics.csiNodeIds.join(', ') || 'unknown' : 'unknown'} · ${String(metrics.csiSampleAgeMilliseconds ?? '—')} ms old` : 'awaiting compatible live CSI engine' },
    { label: 'Research classification', value: typeof classification.motion_level === 'string' ? classification.motion_level.replaceAll('_', ' ') : 'Not available', unit: '', status: csiActive ? 'Experimental' : 'No CSI inference', trend: evidence ? 'calibration evidence attached' : 'uncalibrated research output' },
    { label: 'Calibrated room state', value: evidence ? (evidence.presence === true ? 'Presence' : 'No presence') : 'Not established', unit: '', status: evidence ? 'Calibration-bound · experimental' : 'Abstaining', trend: evidence ? `experimental output · count ${String(evidence.person_count)} · model ${String(evidence.model_id ?? 'unknown')}` : 'requires fresh explicit room calibration' },
    { label: 'Research breathing rate', value: numericVitalsAuthorized && typeof researchVitals.breathing_rate_bpm === 'number' && Number.isFinite(researchVitals.breathing_rate_bpm) ? Number(researchVitals.breathing_rate_bpm).toFixed(1) : 'Not released', unit: 'BPM', status: 'Research · non-medical', trend: numericVitalsAuthorized ? 'engine publication gate confirmed' : 'not published by the engine' },
    { label: 'Research heart rate', value: numericVitalsAuthorized && typeof researchVitals.heart_rate_bpm === 'number' && Number.isFinite(researchVitals.heart_rate_bpm) ? Number(researchVitals.heart_rate_bpm).toFixed(1) : 'Not released', unit: 'BPM', status: 'Research · non-medical', trend: numericVitalsAuthorized ? 'engine publication gate confirmed' : 'not published by the engine' },
    { label: 'Pose model', value: modelStatus.loaded === true ? 'Model loaded' : 'Not available', unit: '', status: modelStatus.loaded === true ? 'Experimental model output' : 'No trained model', trend: pose.length ? `${pose.length} model keypoints` : 'no pose points published' },
  ];
  return rows;
}

function Sensing() {
  const { liveMode, sensingSnapshot, apiConnected, devices, nodes, apiStatus } = useConsoleData();
  const snapshot = sensingSnapshot;
  const metrics = sensingMetricsFromSnapshot(snapshot);
  const snapshotMetrics = snapshot?.metrics ?? {};
  const csiActive = snapshotMetrics.sensingMode === 'research';
  const csiFeatures = snapshotMetrics.csiFeatures && typeof snapshotMetrics.csiFeatures === 'object' ? snapshotMetrics.csiFeatures as Record<string, unknown> : {};
  const qualityVerdict = typeof snapshotMetrics.qualityVerdict === 'string' ? snapshotMetrics.qualityVerdict : 'not provided';
  const notes = snapshot ? [
    `Last signed bridge sample: ${new Date(snapshot.observedAt).toLocaleString()}.`,
    csiActive ? `CSI source: ${String(snapshotMetrics.csiSource)} · ${String(snapshotMetrics.csiSampleAgeMilliseconds)} ms upstream age · quality ${qualityVerdict}.` : 'The current bridge cycle contains WiFi/BLE measurements only; CSI inference is not active.',
    'Research classifications and estimates are experimental signals, not proof of occupancy, identity, motion, or health; absence of a result means the system abstained.',
  ] : ['No sensing snapshot has been received.', 'Only actual adapter observations are displayed; synthetic data is not generated.', 'No image, audio, or biometric stream is used.'];
  const researchFeatures = [
    ['Mean RSSI', 'mean_rssi', 'dBm'], ['Signal variance', 'variance', ''], ['Motion-band power', 'motion_band_power', ''], ['Breathing-band power', 'breathing_band_power', ''], ['Dominant frequency', 'dominant_freq_hz', 'Hz'], ['Spectral power', 'spectral_power', ''],
  ] as const;
  const rawCalibratedEvidence = snapshotMetrics.calibratedEvidence && typeof snapshotMetrics.calibratedEvidence === 'object' ? snapshotMetrics.calibratedEvidence as Record<string, unknown> : null;
  const evidenceCount = rawCalibratedEvidence?.person_count;
  const calibratedEvidence = rawCalibratedEvidence?.schema === 'backspyne.calibrated-presence-evidence.v2' && typeof evidenceCount === 'number' && Number.isInteger(evidenceCount) && evidenceCount >= 0 && evidenceCount <= 255 && typeof rawCalibratedEvidence.presence === 'boolean' && rawCalibratedEvidence.presence === (evidenceCount > 0) && Array.isArray(rawCalibratedEvidence.source_node_ids) ? rawCalibratedEvidence : null;
  const poseKeypoints = Array.isArray(snapshotMetrics.poseKeypoints) ? snapshotMetrics.poseKeypoints : [];
  return <><div className="page-heading"><div><div className="page-kicker">Assessment and sensing</div><h1>What the relay measured.</h1><p>CSI-enabled research mode is available through a compatible, authenticated local sensing engine. Standard WiFi access-point/BLE scans remain descriptive measurements only.</p></div><div className={`status-pill ${liveMode ? '' : 'paused'}`}><span className="pulse-dot" />{liveMode ? 'RELAY REPORTING' : 'AWAITING MEASUREMENTS'}</div></div>
    <div className={`signal-banner ${csiActive ? 'research-banner' : ''}`}><CameraOff /><span><strong>{csiActive ? 'Experimental research output.' : 'Measurement-only mode.'}</strong> {csiActive ? 'CSI measurements and model outputs below are sourced from the authenticated live engine and are research-only. No safety, clinical, identity, or emergency interpretation.' : apiConnected ? (snapshot ? 'The latest signed local-node sample has WiFi/BLE measurements; configure compatible CSI hardware to enable WiFi sensing research.' : 'The API is connected, but no sensing sample has arrived yet.') : 'Connect to the operator API to load sensing telemetry.'} No images or audio are used.</span><CircleHelp size={14} style={{ marginLeft: 'auto' }} /></div>
    <RelayChecklist nodes={nodes} devices={devices} apiStatus={apiStatus} />
    <div className="assessment-heading"><div className="eyebrow">Measured assessment</div><p>Built only from observations the relay actually reported. Nothing here is inferred about people, and a section that has no data says so instead of showing a zero.</p></div>
    <MeasurementAssessment />
    <div className="sensing-grid">{metrics.map(metric => <div className="panel sensing-card" key={metric.label} data-testid={`sensing-${metric.label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-icon"><Gauge size={17} /></div><div className="eyebrow">{metric.label}</div><div className="sensing-value">{metric.value}<span className="sensing-unit">{metric.unit}</span></div><div className="confidence"><span>{metric.status} · {metric.trend}</span></div></div>)}</div>
    {csiActive && <div className="panel research-panel"><div className="panel-header"><div><div className="panel-title">Engine measurements</div><div className="panel-subtitle">Measured features from live CSI frames · not person-level evidence</div></div><span className="hardware-status limited">RESEARCH</span></div><div className="notes-grid">{researchFeatures.map(([label, key, unit]) => <div className="note-cell" key={key}><div className="eyebrow">{label}</div><strong className="research-feature-value">{typeof csiFeatures[key] === 'number' && Number.isFinite(csiFeatures[key]) ? (csiFeatures[key] as number).toFixed(3) : '—'} <small>{unit}</small></strong></div>)}</div></div>}
    {calibratedEvidence && <div className="panel research-panel"><div className="panel-header"><div><div className="panel-title">Calibration provenance</div><div className="panel-subtitle">The engine attached a calibration-bound research result</div></div><CheckCircle2 size={16} style={{ color: 'hsl(var(--primary))' }} /></div><div className="device-details-grid"><div className="device-detail"><span>Evidence schema</span><strong>{String(calibratedEvidence.schema ?? 'unknown')}</strong></div><div className="device-detail"><span>Model ID</span><strong>{String(calibratedEvidence.model_id ?? 'unknown')}</strong></div><div className="device-detail"><span>Inference method</span><strong>{String(calibratedEvidence.inference_method ?? 'unknown')}</strong></div><div className="device-detail"><span>Bound node IDs</span><strong>{Array.isArray(calibratedEvidence.source_node_ids) ? calibratedEvidence.source_node_ids.join(', ') : 'unknown'}</strong></div></div></div>}
    {poseKeypoints.length > 0 && <div className="panel research-panel"><div className="panel-header"><div><div className="panel-title">Experimental model keypoints</div><div className="panel-subtitle">Coordinates emitted by a loaded model; not a validated pose or person identity</div></div><span className="hardware-status limited">MODEL OUTPUT</span></div><div className="pose-points">{poseKeypoints.map((point, index) => <span key={index}>{Array.isArray(point) ? point.map(value => typeof value === 'number' ? value.toFixed(2) : '—').join(' · ') : 'Invalid point'}</span>)}</div></div>}
    <div className="panel" style={{ marginTop: 11 }}><div className="panel-header"><div><div className="panel-title">Provenance & limits</div><div className="panel-subtitle">Source mode, calibration state, and safe interpretation</div></div><Zap size={15} style={{ color: 'hsl(var(--accent))' }} /></div><div className="notes-grid">{notes.map((note, index) => <div className="note-cell" key={note}><div className="eyebrow">{index === 0 && snapshot ? 'LATEST' : 'BOUNDARY'}</div><p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5, margin: '9px 0 0' }}>{note}</p></div>)}</div></div>
  </>;
}

export { Sensing };
