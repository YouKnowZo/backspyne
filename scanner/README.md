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

The bridge defaults to `BACKSPYNE_MODE=live` and uses the computer's real
WiFi/Bluetooth adapters. Set `BACKSPYNE_MODE=simulate` only for a deliberate
signed connectivity test; simulated observations are never presented by the
operator dashboard as live hardware telemetry.

## Live adapters

- **BLE:** `bleak` performs a normal OS-approved scan. The user must grant
  Bluetooth permission and the host adapter must be available.
- **WiFi:** Linux uses `nmcli` first and `iw` as a fallback; macOS uses the
  system `airport` command; Windows uses `netsh wlan`. These are observation
  APIs only; the bridge does not enable monitor mode, inject frames, or bypass
  permissions.
- **ESP32/CSI:** Set `BACKSPYNE_CSI_SERIAL_PORT` to a serial port that emits one
  JSON object per line, for example
  `{"amplitudes":[0.8,1.1,0.9],"timestamp":"..."}`. CSI values are used only
  for environmental variance metrics.

## Privacy and model boundary

The bridge sends only the configured owner ID, node ID, observed addresses,
signal metadata, and conservative environmental heuristics. It does not send
camera or microphone content. Presence and motion outputs are explicitly
non-medical heuristics; no heart-rate, apnea, or fall claim is made without a
validated model and approved data collection protocol.