from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
from datetime import datetime, timezone
from typing import Any

import requests

from .config import Config
from .csi_source import CsiSourceClient
from .inference import derive_metrics
from .observers import BleObserver, CsiObserver, WifiObserver

LOGGER = logging.getLogger("backspyne.bridge")


class ApiClient:
    def __init__(self, config: Config) -> None:
        self.config = config

    def send(self, payload: dict[str, Any]) -> bool:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        signature = hmac.new(
            self.config.node_token.encode("utf-8"),
            body.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        try:
            response = requests.post(
                f"{self.config.api_url}/ingest/telemetry",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Backspyne-Node-Token": self.config.node_token,
                    "X-Backspyne-Signature": signature,
                },
                timeout=12,
            )
        except requests.RequestException as error:
            LOGGER.error("API upload failed: %s", error)
            return False
        if response.status_code >= 300:
            LOGGER.error("API rejected telemetry (%s): %s", response.status_code, response.text[:300])
            return False
        return True


class Bridge:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.wifi = WifiObserver()
        self.ble = BleObserver()
        self.csi = CsiObserver(config.csi_serial_port, config.csi_baudrate)
        self.csi_source = CsiSourceClient(
            config.csi_api_url,
            config.csi_api_token,
            config.csi_source_allowlist,
            config.csi_max_age_seconds,
        )
        self.api = ApiClient(config)

    async def collect(self) -> dict[str, Any]:
        wifi, ble = await asyncio.gather(
            asyncio.to_thread(self.wifi.scan),
            self.ble.scan(),
        )

        csi_rows = await asyncio.to_thread(self.csi.read)
        csi_values: list[float] = []
        for row in csi_rows:
            values = row.get("amplitude", row.get("amplitudes", []))
            if isinstance(values, (int, float)) and not isinstance(values, bool):
                values = [values]
            if isinstance(values, list):
                csi_values.extend(
                    float(value)
                    for value in values
                    if isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and math.isfinite(float(value))
                )
        LOGGER.info(
            "scan cycle: wifi=%d ble=%d csi=%d mode=%s",
            len(wifi),
            len(ble),
            len(csi_values),
            self.config.mode,
        )
        csi_snapshot = await asyncio.to_thread(self.csi_source.read)
        csi_values = csi_snapshot["amplitudes"] if csi_snapshot else csi_values
        if not wifi and not ble and not csi_values:
            LOGGER.warning(
                "no observations collected; verify Bluetooth permission, a powered WiFi adapter, "
                "and that the bridge is running in live mode"
            )
        metrics = derive_metrics(wifi, ble, csi_values)
        metrics["collectionMode"] = self.config.mode
        metrics["sensingMode"] = "research" if csi_snapshot else "measurements_only"
        metrics["csiSource"] = csi_snapshot["source"] if csi_snapshot else ("serial_measurements_only" if csi_values else "none")
        metrics["csiNodeIds"] = csi_snapshot["nodeIds"] if csi_snapshot else []
        metrics["csiSampleAgeMilliseconds"] = csi_snapshot["ageMilliseconds"] if csi_snapshot else None
        metrics["csiSampleTimestamp"] = csi_snapshot["sampleTimestamp"] if csi_snapshot else None
        metrics["csiSampleCount"] = len(csi_values)
        metrics["classification"] = csi_snapshot["classification"] if csi_snapshot else {}
        metrics["calibratedEvidence"] = csi_snapshot["calibratedEvidence"] if csi_snapshot else None
        metrics["researchVitalSigns"] = csi_snapshot["vitalSigns"] if csi_snapshot else None
        metrics["numericVitalsAuthorized"] = csi_snapshot["numericVitalsAuthorized"] if csi_snapshot else False
        metrics["poseKeypoints"] = csi_snapshot["poseKeypoints"] if csi_snapshot else None
        metrics["poseModelStatus"] = csi_snapshot["poseModelStatus"] if csi_snapshot else {}
        metrics["csiFeatures"] = csi_snapshot["features"] if csi_snapshot else {}
        metrics["csiSourceState"] = csi_snapshot["sourceState"] if csi_snapshot else "disconnected"
        metrics["csiTick"] = csi_snapshot["tick"] if csi_snapshot else None
        metrics["qualityVerdict"] = csi_snapshot["qualityVerdict"] if csi_snapshot else None
        metrics["inferenceStatus"] = "calibrated_research_evidence" if csi_snapshot and csi_snapshot["calibratedEvidence"] else "research_uncalibrated" if csi_snapshot else "measurements_only"
        metrics["researchDisclaimer"] = "Experimental research output; not validated for safety, occupancy, medical, identity, or emergency use." if csi_snapshot else None
        return {
            "nodeId": self.config.node_id,
            "nodeName": self.config.node_name,
            "ownerId": self.config.owner_id,
            "protocol": "system",
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "capabilities": [
                "wifi_os_scan",
                "ble_advertisement_scan",
                *(["csi_serial_measurements_only"] if self.config.csi_serial_port else []),
                *(["csi_engine_research_stream"] if csi_snapshot else []),
            ],
            "observations": [*wifi, *ble],
            "metrics": metrics,
        }

    async def run(self) -> None:
        LOGGER.info(
            "BackSpyne bridge online: node=%s mode=%s interval=%ss",
            self.config.node_id,
            self.config.mode,
            self.config.interval_seconds,
        )
        while True:
            payload = await self.collect()
            if await asyncio.to_thread(self.api.send, payload):
                LOGGER.info(
                    "uploaded %s measured observations",
                    len(payload["observations"]),
                )
            await asyncio.sleep(self.config.interval_seconds)


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def main() -> None:
    configure_logging()
    config = Config.from_environment()
    asyncio.run(Bridge(config).run())