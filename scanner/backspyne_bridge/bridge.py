from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

import requests

from .config import Config
from .inference import derive_metrics
from .observers import BleObserver, CsiObserver, WifiObserver, simulated_observations

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
        self.api = ApiClient(config)

    async def collect(self) -> dict[str, Any]:
        if self.config.mode == "simulate":
            wifi, ble = simulated_observations()
        else:
            wifi = await asyncio.to_thread(self.wifi.scan)
            ble = await self.ble.scan()

        csi_rows = await asyncio.to_thread(self.csi.read)
        csi_values = [
            float(value)
            for row in csi_rows
            for value in row.get("amplitude", row.get("amplitudes", []))
            if isinstance(value, (int, float))
        ]
        metrics = derive_metrics(wifi, ble, csi_values)
        metrics["csiSamples"] = len(csi_values)
        metrics["collectionMode"] = self.config.mode
        return {
            "nodeId": self.config.node_id,
            "nodeName": self.config.node_name,
            "ownerId": self.config.owner_id,
            "protocol": "system",
            "observedAt": datetime.now(UTC).isoformat(),
            "observations": [
                *[{**row, "payload": {**row.get("payload", {}), "source": "wifi_os_api"}} for row in wifi],
                *[{**row, "payload": {**row.get("payload", {}), "source": "ble_adapter"}} for row in ble],
            ],
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
            if self.api.send(payload):
                LOGGER.info(
                    "uploaded %s observations; presence=%s confidence=%s",
                    len(payload["observations"]),
                    payload["metrics"]["presenceProbability"],
                    payload["metrics"]["confidence"],
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