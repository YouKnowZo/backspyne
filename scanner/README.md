# BackSpyne local bridge

This service is the authorized hardware boundary for BackSpyne. It runs beside
the WiFi/BLE/CSI hardware and sends signed, owner-scoped observations to the
BackSpyne API.

## Start

1. Copy `.env.example` to `.env`.
2. Set `BACKSPYNE_OWNER_ID` to the Clerk operator ID that owns this node.
3. Set the same long random `BACKSPYNE_NODE_TOKEN` on the API server and in the
   bridge environment. Never commit either value.
4. Set `BACKSPYNE_NODE_OWNER_ID` on the API server to the same Clerk operator ID
   as `BACKSPYNE_OWNER_ID`. This binds the shared node token to one operator.
5. Start with:
   - macOS/Linux: `./start.sh`
   - Windows PowerShell: `./start.ps1`
   - Windows Command Prompt: `start.bat`

The bridge accepts only `BACKSPYNE_MODE=live`. Synthetic observations are disabled to prevent test data from being mistaken for measurements.

## Live adapters

- **BLE:** `bleak` performs an OS-approved active advertisement scan. The host adapter, runtime permissions and OS Bluetooth service must be available. BLE privacy addresses can rotate and many devices do not advertise.
- **WiFi:** Linux uses NetworkManager `nmcli` or `iw`; macOS uses Apple's CoreWLAN framework through PyObjC (location permission may be required); Windows uses `netsh wlan`. Results are nearby AP beacons, not all client devices. Access-point scans can be limited by the associated connection, adapter/driver and OS policy. Windows/Linux OS signal quality is kept as percent where provided and never mislabeled as dBm. The bridge does not enable monitor mode, inject frames, or bypass permissions.
- **ESP32/CSI serial:** Optional serial JSON-lines input can provide an `amplitudes` list for measured amplitude variance only. It is not used to infer presence, occupancy, motion, pose, or medical signals.
- **WiFi sensing research path:** Configure `BACKSPYNE_CSI_API_URL`, `BACKSPYNE_CSI_API_TOKEN`, and (optionally) `BACKSPYNE_CSI_SOURCE_ALLOWLIST` to poll a separate compatible sensing engine's authenticated `GET /api/v1/sensing/latest` endpoint. By default, use its HTTP API port (commonly `http://127.0.0.1:8080`). The token is server-side only; do not use a browser token. Only recent samples from configured live hardware sources are accepted; the bridge checks the authenticated health endpoint for a `live_unverified` state and matches its source name to the latest sensing frame. It rejects stale, synthetic, missing, mismatched, or non-allowlisted samples. It consumes the engine's latest aggregate/frame—the API is polled at the bridge interval, so it is not a full-rate CSI frame recorder. The source engine must be configured with compatible physical hardware, true live mode, and any required calibration. Outputs are surfaced as experimental research results; the console does not train/validate models, start calibration, or produce a valid result when the engine abstains. Pose points appear only when a trained model reports them. The bridge relies on the authenticated engine's health endpoint for live-source state. Numeric vital outputs are forwarded only when present in the engine's gated `vital_signs` object; that endpoint does not expose a separate numeric authorization flag.

## Vendor and evidence labelling

Every observation carries its own label evidence so the console can show how a vendor name was decided instead of presenting a guess as fact:

- **Address prefix (strongest local evidence):** a locally administered address can never be attributed, so a randomized BLE/WiFi address always reports `Unknown vendor`. A globally administered address is matched against a curated, non-exhaustive local prefix table; a match reports the vendor, a category, the matched prefix, and a high label-evidence score. The table is reviewed by hand and will not identify every device.
- **BLE company code:** Bluetooth SIG manufacturer-specific data identifies the company that declared the code, not the model. Reported with a middle-tier score and the exact company code.
- **Reported name hint:** an SSID or advertised BLE name that contains a known brand is published as `advertisedVendorHint` only. The owner of the device chooses that name, so it never sets the vendor and never raises the score.
- **Score meaning:** the label-evidence score (0-100) describes how the vendor label was derived. It says nothing about proximity, occupancy, identity, or how likely a device is to be present.

No address, SSID, or name is sent to a third-party lookup service; the tables ship with the bridge and every match happens locally.

## Privacy, use and measurement limits

Collect only on infrastructure and in locations for which you have authorization and any required consent. The bridge sends WiFi AP/BLE advertiser addresses, vendor guesses, signal/channel/SSID or BLE advertisement metadata, owner/node IDs, timestamps, and measured aggregates to the configured API. CSI amplitude frames are reduced to bounded summaries and are not persisted as raw CSI by this bridge. Treat identifiers and SSIDs as potentially sensitive personal data: choose a lawful basis, provide required notices, minimize and retain/delete data appropriately, and secure access. No camera or microphone data is accessed.

CSI-based presence, activity, vital signs, counting, and pose capabilities remain experimental and depend on the particular engine, hardware, calibration, model, and validation evidence. A calibration-bound engine result is shown with its provenance, but is not independently validated by this console. Numeric vital-sign outputs are included only when the engine publishes its gated `vital_signs` result; the latest sensing response does not include a separate authorization flag. These values are not for medical, emergency, safety-critical, identity, or covert monitoring use. No named-person identification is supported. RSSI or BLE/WiFi observation counts do not establish people. This software is not legal advice, and these notes are not a substitute for legal review or a jurisdiction-specific privacy policy. Operators assume responsibility for lawful use.

There is no person identity, tracking, distance, or direction inference from the standard WiFi/BLE scans. CSI research outputs are experimental and must not be treated as proof of occupancy or a safety/health outcome.
