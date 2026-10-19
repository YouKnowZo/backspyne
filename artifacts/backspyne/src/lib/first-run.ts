// First-run operator setup checklist: pure progression model and local state helpers.
//
// A new operator arriving in the console needs three things to go from an empty account to a
// deliverable client handover:
//   1. Pair or connect a first relay (issue a relay token, or register a browser/desktop relay).
//   2. Run a room scan (collect live WiFi/BLE observations from the relay into the ledger).
//   3. Export or share a client report (open the printable assessment or copy a signed client link).
//
// Keeping the progression derivation pure means it can be tested without a browser and never
// disagrees with the live console state.

import { ageSecondsFrom, ageText, newestTimestamp } from './format.ts';
import type { ApiStatus, RFDevice, RelayTokenSummary, ScanNode } from './types.ts';

export type FirstRunStepId = 'pair-relay' | 'room-scan' | 'export-report';

export type FirstRunStepStatus = 'complete' | 'active' | 'pending';

export interface FirstRunStep {
  id: FirstRunStepId;
  number: string;
  title: string;
  summary: string;
  detail: string;
  status: FirstRunStepStatus;
}

export interface FirstRunProgressInput {
  apiStatus: ApiStatus;
  nodes: ScanNode[];
  devices: RFDevice[];
  pairedRelays?: RelayTokenSummary[];
  reportExportedAt?: string | null;
  now?: number;
}

export interface FirstRunProgress {
  steps: [FirstRunStep, FirstRunStep, FirstRunStep];
  completedCount: number;
  totalCount: 3;
  allComplete: boolean;
  activeStepId: FirstRunStepId | null;
  relayPaired: boolean;
  scanCompleted: boolean;
  reportExported: boolean;
}

const REPORT_EXPORTED_KEY_PREFIX = 'backspyne:first-run:report-exported:';
const DISMISSED_KEY_PREFIX = 'backspyne:first-run:dismissed:';
export const FIRST_RUN_EVENT = 'backspyne:first-run-updated';

function scopeKey(prefix: string, operatorScope?: string | null): string {
  const normalized = typeof operatorScope === 'string' && operatorScope.trim() ? operatorScope.trim() : 'default';
  return `${prefix}${normalized}`;
}

export function readFirstRunReportExported(operatorScope?: string | null): string | null {
  try {
    const value = globalThis.localStorage?.getItem(scopeKey(REPORT_EXPORTED_KEY_PREFIX, operatorScope));
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function markFirstRunReportExported(operatorScope?: string | null, isoTimestamp = new Date().toISOString()): string {
  try {
    globalThis.localStorage?.setItem(scopeKey(REPORT_EXPORTED_KEY_PREFIX, operatorScope), isoTimestamp);
    globalThis.dispatchEvent?.(new CustomEvent(FIRST_RUN_EVENT));
  } catch {
    // Storage may be disabled in private browsing; callers still update in-memory state.
  }
  return isoTimestamp;
}

export function readFirstRunDismissed(operatorScope?: string | null): boolean {
  try {
    return globalThis.localStorage?.getItem(scopeKey(DISMISSED_KEY_PREFIX, operatorScope)) === '1';
  } catch {
    return false;
  }
}

export function writeFirstRunDismissed(operatorScope: string | null | undefined, dismissed: boolean): void {
  try {
    const key = scopeKey(DISMISSED_KEY_PREFIX, operatorScope);
    if (dismissed) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
    globalThis.dispatchEvent?.(new CustomEvent(FIRST_RUN_EVENT));
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Evaluates the three onboarding milestones from live console state.
 */
export function buildFirstRunProgress(input: FirstRunProgressInput): FirstRunProgress {
  const { apiStatus, nodes, devices, pairedRelays = [] } = input;
  const activeTokens = pairedRelays.filter(relay => relay.active);
  const onlineNodes = nodes.filter(node => node.status === 'online');

  const relayPaired = nodes.length > 0 || activeTokens.length > 0;
  const scanCompleted = devices.length > 0;
  const reportExported = Boolean(typeof input.reportExportedAt === 'string' && input.reportExportedAt.trim());

  const newestObservation = newestTimestamp(devices.map(device => device.lastSeenTimestamp));
  const observationAge = ageSecondsFrom(newestObservation);
  const freshObservations = observationAge !== null && observationAge < 300;

  const activeStepId: FirstRunStepId | null = !relayPaired
    ? 'pair-relay'
    : !scanCompleted
      ? 'room-scan'
      : !reportExported
        ? 'export-report'
        : null;

  const stepStatus = (id: FirstRunStepId, done: boolean): FirstRunStepStatus => {
    if (done) return 'complete';
    return activeStepId === id ? 'active' : 'pending';
  };

  const pairSummary = relayPaired
    ? nodes.length > 0
      ? `${nodes.length} relay${nodes.length === 1 ? '' : 's'} registered (${onlineNodes.length} online)`
      : `${activeTokens.length} relay credential${activeTokens.length === 1 ? '' : 's'} paired`
    : apiStatus === 'unavailable' || apiStatus === 'error'
      ? 'Waiting for operator API connection'
      : 'No relay paired yet';

  const pairDetail = relayPaired
    ? nodes.length > 0
      ? `Relay ${nodes[0].name} is registered to this operator account.`
      : `Token "${activeTokens[0].label}" is paired. Start the local bridge or browser relay so it sends its first heartbeat.`
    : 'Issue a one-time pairing credential for the desktop Python bridge, or start the no-install browser relay on this device.';

  const wifiCount = devices.filter(device => device.protocol === 'WiFi').length;
  const bleCount = devices.filter(device => device.protocol === 'BLE').length;

  const scanSummary = scanCompleted
    ? `${devices.length} radio${devices.length === 1 ? '' : 's'} observed (${wifiCount} WiFi · ${bleCount} BLE)`
    : relayPaired
      ? 'Ready to collect first room observations'
      : 'Pair a relay first to begin scanning';

  const scanDetail = scanCompleted
    ? freshObservations
      ? `Live observations are in scope (newest reading ${ageText(newestObservation)}). Walk the room with a phone relay or place fixed relays to refine position fixes.`
      : `${devices.length} stored radio${devices.length === 1 ? '' : 's'} in scope (last reading ${ageText(newestObservation)}). Run the scanner again anytime to refresh the room.`
    : onlineNodes.length > 0
      ? `${onlineNodes[0].name} is online and sending heartbeats. Ensure WiFi or Bluetooth scanning is enabled so observations land in the ledger.`
      : 'Start the downloaded scanner with start.bat / ./start.sh, or open Hardware scan to run a live browser scan from this device.';

  const reportSummary = reportExported
    ? 'Client assessment prepared'
    : scanCompleted
      ? `Ready to export (${devices.length} radio${devices.length === 1 ? '' : 's'} in scope)`
      : 'Awaiting room scan data';

  const reportDetail = reportExported
    ? 'You have opened or shared the printable client assessment. Re-open it or copy a fresh 7-day signed client link anytime.'
    : scanCompleted
      ? 'Open the printable client assessment for PDF handover, or copy a signed 7-day client link that opens without a login.'
      : 'Once your first room scan lands, generate a sectioned, printable client assessment or a signed share link from those measurements.';

  const steps: [FirstRunStep, FirstRunStep, FirstRunStep] = [
    {
      id: 'pair-relay',
      number: '01',
      title: 'Pair your first relay',
      summary: pairSummary,
      detail: pairDetail,
      status: stepStatus('pair-relay', relayPaired),
    },
    {
      id: 'room-scan',
      number: '02',
      title: 'Run a room scan',
      summary: scanSummary,
      detail: scanDetail,
      status: stepStatus('room-scan', scanCompleted),
    },
    {
      id: 'export-report',
      number: '03',
      title: 'Export a client report',
      summary: reportSummary,
      detail: reportDetail,
      status: stepStatus('export-report', reportExported),
    },
  ];

  const completedCount = (relayPaired ? 1 : 0) + (scanCompleted ? 1 : 0) + (reportExported ? 1 : 0);

  return {
    steps,
    completedCount,
    totalCount: 3,
    allComplete: completedCount === 3,
    activeStepId,
    relayPaired,
    scanCompleted,
    reportExported,
  };
}
