from __future__ import annotations

import json
import logging
import platform
import re
import shutil
import subprocess
from typing import Any

from .vendor import (
    address_kind,
    ble_manufacturer_for,
    vendor_for,
    vendor_hint_from_name,
    vendor_profile,
)

LOGGER = logging.getLogger("backspyne.bridge")


def _with_name_hints(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach a self-reported brand hint when a scan reported a name.

    Many access points embed their brand in the SSID. That is useful context when the
    address prefix is not in the local table, but it is chosen by the device owner, so
    it is published as a separate hint rather than as the resolved vendor.
    """
    for observation in observations:
        payload = observation.get("payload")
        if not isinstance(payload, dict):
            continue
        hint = vendor_hint_from_name(payload.get("ssid") or payload.get("localName") or payload.get("name"))
        if hint:
            payload["advertisedVendorHint"] = hint
    return observations


def _annotate_wifi(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Record whether the host operating system handed us a masked BSSID.

    Real access points use globally administered addresses, so a locally administered
    WiFi BSSID means the OS replaced it (Windows does this for callers without location
    access). The address is still reported as observed, but the flag lets the console
    explain why no vendor can be resolved instead of implying an unknown device.
    """
    for observation in observations:
        payload = observation.get("payload")
        if isinstance(payload, dict):
            payload["addressMasked"] = address_kind(observation.get("address")) == "private/randomized address"
    return observations


def _run(command: list[str], timeout: float = 12.0) -> str:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if completed.returncode != 0:
            detail = completed.stderr.strip().replace("\n", " ")
            LOGGER.warning(
                "adapter command failed (%s): %s",
                " ".join(command),
                detail[:240] or f"exit {completed.returncode}",
            )
        return completed.stdout
    except (OSError, subprocess.SubprocessError) as error:
        LOGGER.debug("command unavailable: %s (%s)", command[0], error)
        return ""


def _number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _split_nmcli(line: str) -> list[str]:
    """Split nmcli terse output, preserving escaped colons in MAC addresses."""
    fields: list[str] = []
    current: list[str] = []
    escaped = False
    for character in line:
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(character)
    if escaped:
        current.append("\\")
    fields.append("".join(current))
    return fields


class WifiObserver:
    """Use the host OS's authorized WiFi observation command.

    This does not enable monitor mode, inject frames, or bypass permissions.
    """

    def scan(self) -> list[dict[str, Any]]:
        system = platform.system()
        if system == "Linux":
            return _annotate_wifi(_with_name_hints(self._linux()))
        if system == "Darwin":
            return _annotate_wifi(_with_name_hints(self._macos()))
        if system == "Windows":
            return _annotate_wifi(_with_name_hints(self._windows()))
        return []

    def _linux(self) -> list[dict[str, Any]]:
        if shutil.which("nmcli"):
            output = _run([
                "nmcli",
                "-t",
                "--escape",
                "yes",
                "-f",
                "BSSID,SSID,SIGNAL,CHAN,SECURITY",
                "dev",
                "wifi",
                "list",
                "--rescan",
                "yes",
            ])
            observations: list[dict[str, Any]] = []
            for line in output.splitlines():
                parts = _split_nmcli(line)
                if len(parts) < 5:
                    continue
                address, ssid, signal, channel, security = parts[:5]
                if not re.fullmatch(r"[0-9A-Fa-f:]{17}", address):
                    continue
                signal_percent = _number(signal)
                profile = vendor_profile(address, observation_kind="wifi")
                observations.append(
                    {
                        "address": address.upper(),
                        "vendor": vendor_for(address),
                        "signalQualityPercent": int(signal_percent) if signal_percent is not None else None,
                        "channel": channel or None,
                        "payload": {
                            "ssid": ssid,
                            "security": security,
                            "addressType": address_kind(address),
                            "source": "wifi_os_api",
                            "vendorCategory": profile["category"],
                            "vendorOui": profile["ouiPrefix"],
                            "vendorBasis": profile["basis"],
                            "evidenceQuality": profile["evidenceQuality"],
                        },
                    }
                )
            if observations:
                return observations

        if shutil.which("iw"):
            output = _run(["iw", "dev"])
            interface = next(
                (line.split()[-1] for line in output.splitlines() if line.strip().startswith("Interface ")),
                None,
            )
            if interface:
                scan_state = _run(["iw", "dev", interface, "link"])
                if "Connected to " in scan_state:
                    LOGGER.warning("Linux WiFi interface %s is associated with a network; scan may be constrained", interface)
            if not interface:
                return []
            scan = _run(["iw", "dev", interface, "scan"])
            observations = []
            current: dict[str, Any] | None = None
            for line in scan.splitlines():
                bss = re.search(r"BSS ([0-9a-f:]{17})", line, re.IGNORECASE)
                if bss:
                    if current:
                        observations.append(current)
                    address = bss.group(1).upper()
                    profile = vendor_profile(address, observation_kind="wifi")
                    current = {
                        "address": address,
                        "vendor": vendor_for(address),
                        "payload": {
                            "addressType": address_kind(address),
                            "source": "wifi_os_api",
                            "vendorCategory": profile["category"],
                            "vendorOui": profile["ouiPrefix"],
                            "vendorBasis": profile["basis"],
                            "evidenceQuality": profile["evidenceQuality"],
                        },
                    }
                    continue
                if current:
                    ssid = re.search(r"^\s*SSID:\s*(.*)$", line)
                    if ssid:
                        current.setdefault("payload", {})["ssid"] = ssid.group(1).strip()
                    signal = re.search(r"signal:\s*(-?\d+(?:\.\d+)?)", line)
                    if signal:
                        current["signalDbm"] = float(signal.group(1))
                    channel = re.search(r"DS Parameter set: channel (\d+)", line)
                    if not channel:
                        channel = re.search(r"primary channel:\s*(\d+)", line, re.IGNORECASE)
                    if channel:
                        current["channel"] = channel.group(1)
            if current:
                observations.append(current)
            if not observations:
                LOGGER.warning("WiFi adapter returned no nearby access points")
            return observations
        LOGGER.warning("No supported Linux WiFi scanner found; install NetworkManager (nmcli) or iw")
        return []

    def _macos(self) -> list[dict[str, Any]]:
        try:
            import CoreWLAN
        except ImportError:
            LOGGER.warning("macOS WiFi scanning requires PyObjC CoreWLAN; install requirements.txt")
            return []
        interface = CoreWLAN.CWInterface.interface()
        networks, error = interface.scanForNetworksWithName_includeHidden_error_(None, True, None)
        if error:
            LOGGER.warning("CoreWLAN scan failed: %s", error)
            return []
        observations: list[dict[str, Any]] = []
        for network in networks or []:
            address = network.bssid()
            if not address:
                continue
            channel = network.wlanChannel()
            profile = vendor_profile(address, observation_kind="wifi")
            observations.append({
                "address": address.upper(),
                "vendor": vendor_for(address),
                "signalDbm": int(network.rssiValue()),
                "channel": str(channel.channelNumber()) if channel else None,
                "payload": {
                    "ssid": network.ssid() or "",
                    "security": str(network.security()) if hasattr(network, "security") else "unknown",
                    "addressType": address_kind(address),
                    "source": "wifi_os_api",
                    "vendorCategory": profile["category"],
                    "vendorOui": profile["ouiPrefix"],
                    "vendorBasis": profile["basis"],
                    "evidenceQuality": profile["evidenceQuality"],
                },
            })
        if not observations:
            LOGGER.warning("CoreWLAN returned no nearby access points; confirm Location Services permission")
        return observations

    def _windows(self) -> list[dict[str, Any]]:
        if not shutil.which("netsh"):
            LOGGER.warning("Windows netsh is unavailable; WiFi discovery returned no results")
            return []
        output = _run(["netsh", "wlan", "show", "networks", "mode=bssid"])
        if not re.search(r"BSSID\s+\d+\s*:", output, re.IGNORECASE):
            output = _run(["netsh", "wlan", "show", "networks", "mode=bssid"], timeout=30.0)
        observations: list[dict[str, Any]] = []
        current_ssid = ""
        # netsh states the protection mode once per network, above its BSSID entries, so it
        # is carried onto every BSSID in that block. Without this the encryption section of
        # an assessment is empty on Windows, which is where most relays actually run.
        current_authentication = ""
        current: dict[str, Any] | None = None
        for line in output.splitlines():
            ssid = re.search(r"^\s*SSID\s+\d+\s*:\s*(.*)$", line)
            if ssid:
                current_ssid = ssid.group(1).strip()
                current_authentication = ""
            authentication = re.search(r"^\s*Authentication\s*:\s*(.*)$", line)
            if authentication:
                current_authentication = authentication.group(1).strip()
                continue
            bssid = re.search(r"BSSID\s+\d+\s*:\s*([0-9a-f:]{17})", line, re.IGNORECASE)
            if bssid:
                if current:
                    observations.append(current)
                address = bssid.group(1).upper()
                profile = vendor_profile(address, observation_kind="wifi")
                current = {
                    "address": address,
                    "vendor": vendor_for(address),
                    "payload": {
                        "ssid": current_ssid,
                        "security": current_authentication,
                        "addressType": address_kind(address),
                        "source": "wifi_os_api",
                        "vendorCategory": profile["category"],
                        "vendorOui": profile["ouiPrefix"],
                        "vendorBasis": profile["basis"],
                        "evidenceQuality": profile["evidenceQuality"],
                    },
                }
                continue
            if current:
                signal = re.search(r"Signal\s*:\s*(\d+)%", line)
                if signal:
                    current["signalQualityPercent"] = int(signal.group(1))
                channel = re.search(r"Channel\s*:\s*(\d+)", line)
                if channel:
                    current["channel"] = channel.group(1)
        if current:
            observations.append(current)
        if not observations:
            LOGGER.warning("Windows WiFi adapter returned no nearby access points")
        return observations


class BleObserver:
    async def scan(self, timeout: float = 5.0) -> list[dict[str, Any]]:
        try:
            from bleak import BleakScanner
        except ImportError:
            LOGGER.warning("BLE support is not installed; install requirements.txt")
            return []
        try:
            discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
        except Exception as error:  # adapter/OS permission errors vary by platform
            LOGGER.warning("BLE scan unavailable: %s", error)
            return []

        observations = []
        for device, advertisement in discovered.values():
            address = getattr(device, "address", None)
            if not address:
                continue
            manufacturer_data = getattr(advertisement, "manufacturer_data", {}) or {}
            profile = vendor_profile(address, manufacturer_data, observation_kind="ble")
            observations.append(
                {
                    "address": address.upper(),
                    "vendor": "Unknown vendor",
                    "signalDbm": getattr(advertisement, "rssi", None),
                    "serviceUuids": list(getattr(advertisement, "service_uuids", []) or []),
                    "payload": {
                        "source": "ble_adapter",
                        "name": getattr(device, "name", None),
                        "localName": getattr(advertisement, "local_name", None),
                        "addressType": "BLE address type not exposed by adapter",
                        "advertisedManufacturer": ble_manufacturer_for(manufacturer_data),
                        "manufacturerData": {
                            str(key): value.hex()
                            for key, value in manufacturer_data.items()
                        },
                        "vendorCategory": profile["category"],
                        "vendorOui": profile["ouiPrefix"],
                        "vendorBasis": profile["basis"],
                        "evidenceQuality": profile["evidenceQuality"],
                    },
                }
            )
        if not observations:
            LOGGER.warning("Bluetooth adapter returned no nearby advertising devices")
        else:
            LOGGER.info("Bluetooth scan found %d nearby advertising devices", len(observations))
        return _with_name_hints(observations)


class CsiObserver:
    """Read newline-delimited JSON from an ESP32/CSI serial adapter."""

    def __init__(self, port: str | None, baudrate: int) -> None:
        self.port = port
        self.baudrate = baudrate
        self._serial: Any = None

    def read(self) -> list[dict[str, Any]]:
        if not self.port:
            return []
        try:
            import serial
        except ImportError:
            LOGGER.warning("CSI serial support is not installed; install requirements.txt")
            return []
        if self._serial is None:
            try:
                self._serial = serial.Serial(self.port, self.baudrate, timeout=0.2)
            except Exception as error:
                LOGGER.warning("CSI serial adapter unavailable: %s", error)
                return []
        readings: list[dict[str, Any]] = []
        for _ in range(100):
            raw = self._serial.readline()
            if not raw:
                break
            try:
                payload = json.loads(raw.decode("utf-8", errors="ignore"))
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                readings.append(payload)
        return readings
