// Unit tests for the assessment report. These run on Node's built-in test runner with
// native TypeScript type stripping, with no database and no HTTP server:
//
//   node --test artifacts/api-server/test/assessmentReport.test.ts
//
// The model and the renderer are imported by relative path on purpose: type stripping is
// not performed for files resolved through node_modules, so the workspace package
// specifier would not load here even though the server bundles it fine.

import test from "node:test";
import assert from "node:assert/strict";

import { buildAssessment } from "../../../lib/assessment/src/index.ts";
import type { AssessmentDevice } from "../../../lib/assessment/src/index.ts";
import { renderAssessmentReport } from "../src/lib/report.ts";
import { LABEL_BASIS, toAssessmentDevice } from "../src/lib/assessmentInput.ts";
import type { RfDevice } from "@workspace/db/schema";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const HOSTILE_LABEL = "</title><script>alert(1)</script>";

interface DeviceOverrides {
  protocol?: AssessmentDevice["protocol"];
  channel?: string | null;
  security?: string | null;
  ssid?: string | null;
  signal?: number | null;
  addressMasked?: boolean;
}

/** One model device, for cases where the stored-row shape is not what is under test. */
function device(overrides: DeviceOverrides = {}): AssessmentDevice {
  return {
    protocol: overrides.protocol ?? "WiFi",
    signal: overrides.signal === undefined ? -55 : overrides.signal,
    channel: overrides.channel === undefined ? "11" : overrides.channel,
    status: "active",
    vendor: null,
    vendorBasis: null,
    addressMasked: overrides.addressMasked ?? false,
    security: overrides.security === undefined ? null : overrides.security,
    ssid: overrides.ssid === undefined ? null : overrides.ssid,
    lastSeenTimestamp: NOW,
    firstSeenTimestamp: NOW,
  };
}

interface RowOverrides {
  id?: string;
  address?: string;
  vendor?: string;
  protocol?: RfDevice["protocol"];
  lastSignalDbm?: number | null;
  channel?: string | null;
  seenSecondsAgo?: number;
  payload?: Record<string, unknown>;
}

/** A stored observation row shaped like the ingest path writes it. */
function storedRow(overrides: RowOverrides = {}): RfDevice {
  const seenSecondsAgo = overrides.seenSecondsAgo ?? 5;
  return {
    id: overrides.id ?? "device_1",
    ownerId: "user_operator",
    address: overrides.address ?? "B0:19:21:AA:BB:CC",
    vendor: overrides.vendor ?? "TP-Link Systems Inc",
    protocol: overrides.protocol ?? "WiFi",
    lastSignalDbm: overrides.lastSignalDbm === undefined ? -47 : overrides.lastSignalDbm,
    channel: overrides.channel === undefined ? "6" : overrides.channel,
    firstSeenAt: new Date(NOW - 3_600_000),
    lastSeenAt: new Date(NOW - seenSecondsAgo * 1000),
    favorite: false,
    metadata: { serviceUuids: [], payload: overrides.payload ?? {} },
  } as unknown as RfDevice;
}

function mappedRows(): AssessmentDevice[] {
  return [
    storedRow({
      payload: {
        ssid: "Front Desk",
        security: "WPA2",
        vendorOui: "B01921",
        vendorBasis: LABEL_BASIS.registry,
        addressType: "globally administered address",
      },
    }),
    storedRow({
      id: "device_2",
      address: "06:93:7C:11:22:33",
      vendor: "Unknown vendor",
      lastSignalDbm: -71,
      channel: "11",
      payload: {
        addressMasked: true,
        addressType: "private/randomized address",
        vendorBasis: LABEL_BASIS.masked,
      },
    }),
    storedRow({
      id: "device_3",
      address: "5C:8D:4E:00:11:22",
      vendor: "",
      protocol: "BLE",
      lastSignalDbm: null,
      channel: null,
      payload: { advertisedManufacturer: "Apple, Inc.", vendorBasis: LABEL_BASIS.bleCompanyCode },
    }),
    storedRow({
      id: "device_4",
      address: "3C:5A:37:99:88:77",
      vendor: "Samsung Electronics",
      lastSignalDbm: -83,
      channel: "36",
      seenSecondsAgo: 20 * 60,
      payload: { vendorBasis: LABEL_BASIS.registry },
    }),
  ].map((row) => toAssessmentDevice(row, NOW));
}

test("a stored row maps onto the assessment vocabulary", () => {
  const devices = mappedRows();
  const [labelled, masked, advertised, stale] = devices;

  assert.equal(labelled.protocol, "WiFi");
  assert.equal(labelled.vendor, "TP-Link Systems Inc");
  assert.equal(labelled.vendorBasis, LABEL_BASIS.registry);
  assert.equal(labelled.signal, -47);
  assert.equal(labelled.channel, "6");
  assert.equal(labelled.ssid, "Front Desk");
  assert.equal(labelled.security, "WPA2");
  assert.equal(labelled.addressMasked, false);
  assert.equal(labelled.status, "active");
  assert.equal(labelled.lastSeenTimestamp, NOW - 5_000);

  // A host-masked address can never carry a vendor, and says why.
  assert.equal(masked.addressMasked, true);
  assert.equal(masked.vendor, null);
  assert.equal(masked.vendorBasis, LABEL_BASIS.masked);
  assert.equal(masked.channel, "11");

  // An empty stored vendor falls back to the advertiser's own company code.
  assert.equal(advertised.vendor, "Apple, Inc.");
  assert.equal(advertised.vendorBasis, LABEL_BASIS.bleCompanyCode);
  assert.equal(advertised.signal, null);
  assert.equal(advertised.protocol, "BLE");

  // Twenty minutes without a sighting is no longer current.
  assert.equal(stale.status, "ghost");
});

test("an unattributable row is labelled, never guessed", () => {
  const unknown = toAssessmentDevice(
    storedRow({ vendor: "Unknown vendor", payload: { addressType: "private/randomized address" } }),
    NOW,
  );
  assert.equal(unknown.vendor, null);
  assert.equal(unknown.vendorBasis, LABEL_BASIS.randomized);

  const nothing = toAssessmentDevice(storedRow({ vendor: "", payload: {} }), NOW);
  assert.equal(nothing.vendor, null);
  assert.equal(nothing.vendorBasis, LABEL_BASIS.none);
});

test("the model built from stored rows reports real totals and never an empty finding list", () => {
  const devices = mappedRows();
  const assessment = buildAssessment({ devices, now: NOW });

  assert.equal(assessment.totals.devices, 4);
  assert.equal(assessment.totals.wifi, 3);
  assert.equal(assessment.totals.ble, 1);
  assert.equal(assessment.totals.fresh, 3);
  assert.equal(assessment.totals.ghost, 1);
  assert.equal(assessment.vendors.masked, 1);
  assert.equal(assessment.signals.reported, 3);
  assert.equal(assessment.signals.strongest, -47);
  assert.equal(assessment.signals.weakest, -83);
  assert.ok(assessment.channelPlan.distinctChannels >= 3);
  assert.ok(assessment.findings.length > 0);
  assert.ok(assessment.limits.length > 0);
});

test("the model reports its own absence on an empty account", () => {
  const assessment = buildAssessment({ devices: [], now: NOW });
  assert.equal(assessment.totals.devices, 0);
  assert.equal(assessment.signals.median, null);
  assert.ok(assessment.findings.length > 0);
  assert.equal(assessment.findings[0].id, "no-observations");
});

test("the rendered document escapes operator-supplied labels and makes no external requests", () => {
  const assessment = buildAssessment({ devices: mappedRows(), now: NOW });
  const html = renderAssessmentReport(assessment, {
    operatorName: "Acme MSP <ops>",
    planName: "Team",
    trial: false,
    generatedAt: new Date(NOW),
    relays: [{ name: "West hallway", lastHeartbeat: new Date(NOW - 30_000) }],
    considered: 4,
    siteLabel: HOSTILE_LABEL,
  });

  assert.equal(html.includes(HOSTILE_LABEL), false);
  assert.ok(html.includes("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("http://"), false);
  assert.equal(html.includes("https://"), false);
  assert.ok(html.includes("Acme MSP &lt;ops&gt;"));
  assert.ok(html.includes("West hallway"));
  assert.ok(html.includes("Team"));
  assert.equal(html.includes("Trial report"), false);
});

test("a plan without export entitlement is marked rather than refused", () => {
  const assessment = buildAssessment({ devices: mappedRows(), now: NOW });
  const html = renderAssessmentReport(assessment, {
    operatorName: "Licensed operator",
    planName: "Free",
    trial: true,
    generatedAt: new Date(NOW),
    relays: [],
    considered: 4,
    siteLabel: "Unnamed site",
  });

  assert.ok(html.includes("Trial report"));
  assert.ok(html.includes("No relay is currently registered to this account"));
  // The document is still complete: every section is present.
  for (const heading of ["What was measured", "Channel occupancy", "Encryption posture", "Findings", "Method and limits"]) {
    assert.ok(html.includes(heading), `expected the report to contain ${heading}`);
  }
});
test("encryption is counted against access points, never against Bluetooth advertisers", () => {
  const devices: AssessmentDevice[] = [
    device({ protocol: "WiFi", channel: "6", security: "WPA2-PSK (CCMP)", ssid: "one" }),
    device({ protocol: "WiFi", channel: "1", security: "--", ssid: "two", addressMasked: true }),
    device({ protocol: "WiFi", channel: null, security: null, ssid: null }),
    // A Bluetooth advertiser never declares a security mode, so it must not appear in any of
    // these figures: counting it as "unreported" would understate a site's encryption.
    device({ protocol: "BLE", channel: null, security: null, signal: -82 }),
  ];
  const assessment = buildAssessment({ devices, now: NOW });

  assert.equal(assessment.security.accessPoints, 3);
  assert.equal(assessment.security.reported, 2);
  assert.equal(assessment.security.unreported, 1);
  assert.equal(assessment.security.open, 1);
  assert.equal(assessment.security.secured, 1);

  const detail = assessment.findings.find((finding) => finding.id === "open-networks")?.detail ?? "";
  assert.ok(detail.includes("2 of 3 access points"), detail);
  assert.equal(detail.includes("observations"), false);
});

test("each adapter's own vocabulary is read, and an unreadable mode is never called protected", () => {
  const devices = [
    device({ security: "--" }), // NetworkManager writes this for an open network.
    device({ security: "Open" }), // netsh writes this.
    device({ security: "CWSecurityNone" }), // CoreWLAN writes its own enum name.
    device({ security: "CWSecurityWPA2Personal" }),
    device({ security: "WPA1 WPA2" }),
    device({ security: "unknown" }), // The adapter declined to describe the mode.
    device({ security: null }),
  ];
  const assessment = buildAssessment({ devices, now: NOW });

  assert.equal(assessment.security.accessPoints, 7);
  assert.equal(assessment.security.open, 3);
  assert.equal(assessment.security.secured, 2);
  assert.equal(assessment.security.reported, 5);
  assert.equal(assessment.security.unreported, 2);

  // The unreadable modes are stated on the page too, not silently dropped from the split.
  const html = renderAssessmentReport(assessment, {
    operatorName: "Licensed operator",
    planName: "Solo",
    trial: false,
    generatedAt: new Date(NOW),
    relays: [],
    considered: devices.length,
    siteLabel: "Sample site",
  });
  assert.ok(html.includes("described no mode this relay could read"));
});

test("a relay that describes no security mode says so instead of assuming protection", () => {
  const devices = [device({ security: null }), device({ security: "unknown" }), device({ security: "", protocol: "BLE" })];
  const assessment = buildAssessment({ devices, now: NOW });
  assert.equal(assessment.security.assessed, false);
  assert.equal(assessment.security.secured, 0);
  assert.equal(assessment.security.reported, 0);

  const html = renderAssessmentReport(assessment, {
    operatorName: "Licensed operator",
    planName: "Solo",
    trial: false,
    generatedAt: new Date(NOW),
    relays: [],
    considered: devices.length,
    siteLabel: "Sample site",
  });
  assert.ok(html.includes("encryption could not be assessed"));
  assert.ok(html.includes("Windows through netsh, or Linux through NetworkManager"));
});

test("a complete signal set produces no sentence about missing levels", () => {
  const devices = [device({ signal: -44 }), device({ signal: -61, protocol: "BLE" }), device({ signal: -78, channel: "36" })];
  const assessment = buildAssessment({ devices, now: NOW });
  const html = renderAssessmentReport(assessment, {
    operatorName: "Licensed operator",
    planName: "Solo",
    trial: false,
    generatedAt: new Date(NOW),
    relays: [],
    considered: devices.length,
    siteLabel: "Sample site",
  });

  assert.equal(assessment.signals.missing, 0);
  assert.equal(html.includes("reported no numeric level"), false);
  // The ruler carries its own scale, so a reader can read a value off the drawing.
  for (const tick of ["-30", "-50", "-70", "-90"]) {
    assert.ok(html.includes(`>${tick}</span>`), `expected the ruler scale to label ${tick} dBm`);
  }
});
