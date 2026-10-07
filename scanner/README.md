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
- **ESP32/CSI:** Optional serial JSON-lines input can provide an `amplitudes` list for measured amplitude variance. It is not a person/presence/motion/medical sensor, and no inference is made from it. UDP CSI is not implemented.

## Privacy, use and measurement limits

Collect only on infrastructure and locations for which you have authorization and required consent. The bridge sends WiFi AP/BLE advertiser addresses, vendor guesses, signal/channel/SSID or BLE advertisement metadata, owner/node IDs, timestamps and measured aggregates to the configured API. Treat identifiers and SSIDs as potentially sensitive personal data: choose a lawful basis, provide required notices, minimize/retain/delete data appropriately, and secure access. No camera or microphone data is accessed. There is no person identity, tracking, distance, direction, occupancy, motion, or health inference. This software is not legal advice, and these notes are not a substitute for legal review or a jurisdiction-specific privacy policy. Operators assume responsibility for lawful use and their published terms.