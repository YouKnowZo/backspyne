from __future__ import annotations

import os
import socket
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    api_url: str
    owner_id: str
    node_token: str
    node_id: str
    node_name: str
    mode: str
    interval_seconds: float
    csi_serial_port: str | None
    csi_baudrate: int
    csi_udp_port: int | None

    @classmethod
    def from_environment(cls) -> "Config":
        mode = os.getenv("BACKSPYNE_MODE", "live").strip().lower()
        if mode != "live":
            raise ValueError("Only BACKSPYNE_MODE=live is supported; synthetic telemetry is disabled")

        owner_id = os.getenv("BACKSPYNE_OWNER_ID", "").strip()
        node_token = os.getenv("BACKSPYNE_NODE_TOKEN", "").strip()
        if not owner_id or owner_id.startswith("replace_with_"):
            raise ValueError("Set BACKSPYNE_OWNER_ID to your real Clerk user ID")
        if not node_token or node_token.startswith("replace_with_") or len(node_token) < 32:
            raise ValueError("Set BACKSPYNE_NODE_TOKEN to the same random secret (at least 32 characters) configured on the API")

        node_id = os.getenv("BACKSPYNE_NODE_ID", "").strip() or socket.gethostname()
        api_url = os.getenv("BACKSPYNE_API_URL", "http://127.0.0.1:8080/api").strip().rstrip("/")
        if not api_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ValueError("BACKSPYNE_API_URL must use HTTPS outside localhost")
        try:
            interval_seconds = float(os.getenv("BACKSPYNE_INTERVAL_SECONDS", "8"))
        except ValueError as error:
            raise ValueError("BACKSPYNE_INTERVAL_SECONDS must be a number") from error
        if interval_seconds < 2 or interval_seconds > 3600:
            raise ValueError("BACKSPYNE_INTERVAL_SECONDS must be between 2 and 3600")
        return cls(
            api_url=api_url,
            owner_id=owner_id,
            node_token=node_token,
            node_id=node_id,
            node_name=os.getenv("BACKSPYNE_NODE_NAME", node_id).strip() or node_id,
            mode=mode,
            interval_seconds=interval_seconds,
            csi_serial_port=os.getenv("BACKSPYNE_CSI_SERIAL_PORT", "").strip() or None,
            csi_baudrate=int(os.getenv("BACKSPYNE_CSI_BAUDRATE", "115200")),
            csi_udp_port=None,
        )