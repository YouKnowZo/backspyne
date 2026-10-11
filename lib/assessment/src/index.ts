/**
 * The BackSpyne assessment model.
 *
 * This module owns every derived statement BackSpyne makes about a set of radio
 * observations. The operator console renders it live and the client report renders the
 * same object, so a document handed to a client can never disagree with the screen it
 * came from. It is pure: no database, no network, no framework, no clock of its own.
 *
 * Everything here is descriptive. Nothing infers occupancy, identity, distance, or
 * intent from signal strength, and the `limits` field carries that statement into the
 * generated document.
 */

export type AssessmentProtocol = "WiFi" | "BLE" | "CSI" | "system";

export interface AssessmentDevice {
  protocol: AssessmentProtocol | string;
  /**
   * Level in dBm, or null when nothing usable was reported. A level derived from a
   * link-quality percentage is a level: `levelSource` says which it is, and the assessment
   * counts the two separately rather than treating a driver's scale as a measurement.
   */
  signal: number | null;
  /** `adapter dBm` for a measured level, `link-quality percentage` for a derived one. */
  levelSource?: "adapter dBm" | "link-quality percentage" | null;
  channel: string | null;
  status: "active" | "idle" | "ghost" | string;
  /** Resolved vendor label, or null/"Unknown vendor" when unattributed. */
  vendor: string | null;
  /** How the vendor label was derived, exactly as the relay reported it. */
  vendorBasis: string | null;
  /** True when the host operating system hid this radio's real address. */
  addressMasked: boolean;
  /** Reported security mode, or null when the adapter did not report one. */
  security: string | null;
  ssid: string | null;
  lastSeenTimestamp: number | null;
  firstSeenTimestamp: number | null;
}

export interface AssessmentInput {
  devices: readonly AssessmentDevice[];
  /** Milliseconds since epoch; supplied by the caller so the model stays pure. */
  now: number;
}

export interface AssessmentTotals {
  devices: number;
  wifi: number;
  ble: number;
  other: number;
  fresh: number;
  idle: number;
  ghost: number;
}

export interface BandCount {
  band: string;
  count: number;
}

export interface ChannelCount {
  channel: string;
  band: string;
  count: number;
}

export interface AssessmentChannelPlan {
  distinctChannels: number;
  withoutChannel: number;
  bands: BandCount[];
  channels: ChannelCount[];
  busiest: ChannelCount[];
}

/**
 * Encryption is a property of an access point, never of a Bluetooth advertiser, so every
 * figure here is counted against the WiFi access points in scope. Mixing the two protocols
 * into one denominator would make a site look less encrypted than it is.
 */
export interface AssessmentSecurity {
  /** WiFi access points in scope, the denominator for every figure below. */
  accessPoints: number;
  /** True when at least one access point reported a security mode. */
  assessed: boolean;
  reported: number;
  unreported: number;
  open: number;
  secured: number;
  openNetworks: Array<{ ssid: string; channel: string | null }>;
}

export interface AssessmentVendors {
  labelled: number;
  unknown: number;
  masked: number;
  byBasis: Array<{ basis: string; label: string; count: number }>;
  top: Array<{ vendor: string; count: number }>;
}

export interface AssessmentSignals {
  reported: number;
  missing: number;
  /**
   * How many of the reported levels came from a driver's 0-100 link-quality percentage rather
   * than from measured power. They are included in the distribution because the position
   * model uses them, and counted here so the report can say so.
   */
  derived: number;
  strongest: number | null;
  weakest: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  buckets: Array<{ label: string; count: number }>;
}

export type FindingSeverity = "attention" | "info";

export interface AssessmentFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
}

export interface Assessment {
  generatedAt: number;
  totals: AssessmentTotals;
  channelPlan: AssessmentChannelPlan;
  security: AssessmentSecurity;
  vendors: AssessmentVendors;
  signals: AssessmentSignals;
  findings: AssessmentFinding[];
  /** Plain-language statements the report must carry verbatim. */
  limits: string[];
}

export const UNATTRIBUTED_VENDOR = "Unknown vendor";

/**
 * The limitation that applies only when the relay reported a link-quality percentage instead
 * of power, which Windows WiFi and NetworkManager do. It is added to an assessment's limits
 * only when such a level is actually in scope, so a report never carries a caveat about a
 * method it did not use.
 */
export const DERIVED_LEVEL_LIMIT =
  "Some levels in this assessment are a driver's link-quality percentage rather than measured power, mapped to decibels between -100 dBm at 0 percent and -50 dBm at 100 percent in half-decibel steps, saturating above -50 dBm. Those levels carry the driver's own rounding and scale error in addition to the usual uncertainty about walls, furniture, and antenna orientation.";
export const BAND_24 = "2.4 GHz";
export const BAND_5 = "5 GHz";
export const BAND_UNKNOWN = "Unclassified";

/**
 * Band inference is a convention, not a measurement. Wi-Fi 6E reuses the 2.4/5 GHz
 * channel numbering, so a channel number alone cannot separate 5 GHz from 6 GHz; the
 * report says so rather than guessing.
 */
export function bandForChannel(channel: string | null): string {
  if (!channel) return BAND_UNKNOWN;
  const value = Number.parseInt(channel, 10);
  if (!Number.isFinite(value)) return BAND_UNKNOWN;
  if (value >= 1 && value <= 14) return BAND_24;
  if (value >= 15) return BAND_5;
  return BAND_UNKNOWN;
}

/** Human label for a relay-reported label basis. Unknown bases are shown as-is. */
export function basisLabel(basis: string | null): string {
  switch (basis) {
    case "hardware address prefix (IEEE registry match)":
      return "IEEE registry prefix match";
    case "hardware address prefix (local OUI match)":
      return "Reviewed prefix match";
    case "BLE manufacturer company code":
      return "BLE company code hint";
    case "unavailable: address is randomized":
      return "Randomized BLE address";
    case "unavailable: address masked or locally administered by the host operating system":
      return "Address hidden by the host OS";
    case "no manufacturer evidence reported":
    case null:
    case "":
      return "No manufacturer evidence";
    default:
      return basis;
  }
}

/**
 * What a relay-reported security mode actually tells us. Host adapters do not share one
 * vocabulary: NetworkManager writes "--" for an open network, netsh writes "Open", and
 * CoreWLAN writes its own enum name ("CWSecurityNone", "CWSecurityWPA2Personal"). A value
 * this cannot recognise is reported as *not reported* rather than as protected, so the
 * report never credits an access point with encryption the relay did not describe.
 */
export function securityClass(security: string | null): "open" | "protected" | "unreported" {
  const value = security?.trim().toLowerCase() ?? "";
  if (!value || value === "unknown" || value === "unsupported") return "unreported";
  if (value === "--" || value.includes("open") || value.includes("none")) return "open";
  if (/(wpa|wep|sae|owe|802\.1x|enterprise|personal|ccmp|tkip)/.test(value)) return "protected";
  return "unreported";
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index] ?? null;
}

const SIGNAL_BUCKETS: Array<{ label: string; matches: (value: number) => boolean }> = [
  { label: "−50 dBm or stronger", matches: (value) => value >= -50 },
  { label: "−50 to −60 dBm", matches: (value) => value < -50 && value >= -60 },
  { label: "−60 to −70 dBm", matches: (value) => value < -60 && value >= -70 },
  { label: "−70 to −80 dBm", matches: (value) => value < -70 && value >= -80 },
  { label: "weaker than −80 dBm", matches: (value) => value < -80 },
];

function counts<T>(items: readonly T[], key: (item: T) => string | null): Array<[string, number]> {
  const tally = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    tally.set(value, (tally.get(value) ?? 0) + 1);
  }
  return [...tally.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export const ASSESSMENT_LIMITS: string[] = [
  "Observations are WiFi access-point beacons and BLE advertisements reported by an authorized local relay. Client devices that do not advertise are not visible to these methods.",
  "Address prefixes identify the organization that registered a hardware block, or the company that declared a BLE code. They do not identify a product model, and a self-reported network name is a hint rather than evidence.",
  "Addresses that an operating system masks, or that a device rotates, cannot be attributed and are never guessed.",
  "Channel numbers imply a band by convention; the numbering is shared between 5 GHz and 6 GHz, so a band is reported only where the number itself is unambiguous.",
  "Signal strength is a relative measurement at the relay's own antenna. It is not distance, direction, position, occupancy, or identity.",
  "This assessment describes radio conditions at one moment from one vantage point. It is not a security audit, a certificate of compliance, or a guarantee of detection completeness.",
];

/**
 * Builds the assessment for a set of observations. Safe on empty input: every section
 * reports its own absence instead of a fabricated zero.
 */
export function buildAssessment(input: AssessmentInput): Assessment {
  const { devices } = input;
  const now = Number.isFinite(input.now) ? input.now : 0;

  const wifi = devices.filter((device) => device.protocol === "WiFi").length;
  const ble = devices.filter((device) => device.protocol === "BLE").length;
  const fresh = devices.filter((device) => device.status === "active").length;
  const idle = devices.filter((device) => device.status === "idle").length;
  const ghost = devices.filter((device) => device.status === "ghost").length;

  const channelTally = counts(devices, (device) => (device.protocol === "WiFi" ? device.channel : null));
  const channels: ChannelCount[] = channelTally.map(([channel, count]) => ({ channel, band: bandForChannel(channel), count }));
  channels.sort((left, right) => right.count - left.count || Number.parseInt(left.channel, 10) - Number.parseInt(right.channel, 10));
  const bandTally = counts(channels, (entry) => entry.band);

  const accessPoints = devices.filter((device) => device.protocol === "WiFi");
  const securityModes = accessPoints.map((device) => securityClass(device.security));
  const securityReported = securityModes.filter((mode) => mode !== "unreported").length;
  const secured = securityModes.filter((mode) => mode === "protected").length;
  const openNetworks = accessPoints
    .filter((_, index) => securityModes[index] === "open")
    .map((device) => ({ ssid: device.ssid?.trim() || "", channel: device.channel }));

  const masked = devices.filter((device) => device.addressMasked).length;
  const labelled = devices.filter((device) => {
    const vendor = device.vendor?.trim() ?? "";
    return Boolean(vendor) && vendor !== UNATTRIBUTED_VENDOR;
  }).length;
  const basisTally = counts(devices, (device) => (device.vendorBasis ? device.vendorBasis : device.addressMasked ? "__masked__" : "__none__"));
  const byBasis = basisTally.map(([basis, count]) => ({
    basis,
    label: basis === "__masked__" ? "Address hidden by the host OS" : basis === "__none__" ? "No manufacturer evidence" : basisLabel(basis),
    count,
  }));
  const top = counts(
    devices.filter((device) => {
      const vendor = device.vendor?.trim() ?? "";
      return Boolean(vendor) && vendor !== UNATTRIBUTED_VENDOR;
    }),
    (device) => device.vendor,
  )
    .slice(0, 8)
    .map(([vendor, count]) => ({ vendor, count }));

  const devicesWithLevels = devices.filter((device) => typeof device.signal === "number" && Number.isFinite(device.signal));
  const signals = devicesWithLevels.map((device) => device.signal as number).sort((left, right) => left - right);
  const signalSummary: AssessmentSignals = {
    reported: signals.length,
    missing: devices.length - signals.length,
    derived: devicesWithLevels.filter((device) => device.levelSource === "link-quality percentage").length,
    strongest: signals.length ? signals[signals.length - 1] : null,
    weakest: signals.length ? signals[0] : null,
    median: percentile(signals, 0.5),
    p25: percentile(signals, 0.25),
    p75: percentile(signals, 0.75),
    buckets: SIGNAL_BUCKETS.map((bucket) => ({ label: bucket.label, count: signals.filter(bucket.matches).length })),
  };

  const findings = buildFindings({
    devices,
    now,
    totals: { devices: devices.length, wifi, ble, other: devices.length - wifi - ble, fresh, idle, ghost },
    masked,
    signals: signalSummary,
    security: { accessPoints: accessPoints.length, reported: securityReported, open: openNetworks.length },
    channels,
  });

  return {
    generatedAt: now,
    totals: { devices: devices.length, wifi, ble, other: devices.length - wifi - ble, fresh, idle, ghost },
    channelPlan: {
      distinctChannels: channels.length,
      withoutChannel: devices.filter((device) => device.protocol === "WiFi" && !device.channel).length,
      bands: bandTally.map(([band, count]) => ({ band, count })),
      channels,
      busiest: channels.slice(0, 5),
    },
    security: {
      accessPoints: accessPoints.length,
      assessed: securityReported > 0,
      reported: securityReported,
      unreported: accessPoints.length - securityReported,
      open: openNetworks.length,
      secured,
      openNetworks: openNetworks.slice(0, 12),
    },
    vendors: { labelled, unknown: devices.length - labelled, masked, byBasis, top },
    signals: signalSummary,
    findings,
    limits: signalSummary.derived > 0 ? [...ASSESSMENT_LIMITS, DERIVED_LEVEL_LIMIT] : ASSESSMENT_LIMITS,
  };
}

interface FindingInput {
  devices: readonly AssessmentDevice[];
  now: number;
  totals: AssessmentTotals;
  masked: number;
  signals: AssessmentSignals;
  security: { accessPoints: number; reported: number; open: number };
  channels: readonly ChannelCount[];
}

function buildFindings(input: FindingInput): AssessmentFinding[] {
  const findings: AssessmentFinding[] = [];
  const { totals, channels, security, signals, masked } = input;

  if (!totals.devices) {
    findings.push({
      id: "no-observations",
      severity: "attention",
      title: "No observations in scope",
      detail: "No relay observations are stored for this account yet. Start the local relay and confirm this page updates before sending an assessment to anyone.",
    });
    return findings;
  }

  if (masked / totals.devices > 0.2) {
    findings.push({
      id: "masked-addresses",
      severity: "attention",
      title: `${masked} of ${totals.devices} radios report a masked address`,
      detail: "The scanning host's operating system hides these addresses, so they cannot be attributed to a vendor or compared across sites. They are not extra or duplicate devices.",
    });
  }

  const busiest = channels[0];
  if (busiest && busiest.count >= Math.max(5, Math.round(totals.wifi * 0.25))) {
    findings.push({
      id: "busiest-channel",
      severity: "attention",
      title: `Channel ${busiest.channel} carries ${busiest.count} of ${totals.wifi} detected access points`,
      detail: `The busiest observed channel in this scan was ${busiest.channel} (${busiest.band}). Concentrated occupancy on one channel is where interference between neighbouring networks is most likely to be felt.`,
    });
  }

  if (security.open > 0) {
    findings.push({
      id: "open-networks",
      severity: "attention",
      title: `${security.open} access point${security.open === 1 ? "" : "s"} report no encryption`,
      detail: `An encryption mode was reported for ${security.reported} of ${security.accessPoints} access points; ${security.open} of those declared no encryption. An unencrypted access point is a finding about that access point, not about any device connected to it.`,
    });
  } else if (!security.reported) {
    findings.push({
      id: "security-unreported",
      severity: "info",
      title: "Encryption could not be assessed",
      detail: "This host adapter did not report a security mode for any access point, so open and protected access points cannot be separated from these observations.",
    });
  }

  if (totals.ghost / totals.devices > 0.5) {
    findings.push({
      id: "stale-observations",
      severity: "info",
      title: `${totals.ghost} of ${totals.devices} observations are no longer current`,
      detail: "These radios were seen earlier but not in the most recent scans. Treat the current column as the live picture and the older rows as history.",
    });
  }

  if (signals.derived > 0) {
    findings.push({
      id: "derived-levels",
      severity: "info",
      title: `${signals.derived} of ${signals.reported} levels came from a link-quality percentage`,
      detail: "This host adapter reports a 0-100 link-quality scale for WiFi instead of power. Those levels are mapped to decibels so position estimates can use them, which makes WiFi access points locatable from a Windows or NetworkManager relay; the mapping is a driver convention rather than a calibration, so a distance modelled from one is less certain than a distance modelled from a measured level.",
    });
  }

  if (signals.median !== null && signals.median <= -75) {
    findings.push({
      id: "weak-median",
      severity: "info",
      title: "Most reported signals are weak",
      detail: `The median reported signal was ${signals.median} dBm at this vantage point. A single relay position sees the neighbourhood from one place; a second vantage point would measure what this one cannot.`,
    });
  }

  if (!findings.length) {
    findings.push({
      id: "baseline",
      severity: "info",
      title: "Baseline recorded without notable findings",
      detail: `${totals.devices} radios were observed (${totals.wifi} WiFi, ${totals.ble} BLE) with no concentration, masking, or encryption finding above threshold. Keep this document as the baseline to compare a later assessment against.`,
    });
  }

  return findings;
}
