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
        if mode not in {"simulate", "live"}:
            raise ValueError("BACKSPYNE_MODE must be either 'simulate' or 'live'")

        owner_id = os.getenv("BACKSPYNE_OWNER_ID", "").strip()
        node_token = os.getenv("BACKSPYNE_NODE_TOKEN", "").strip()
        if not owner_id:
            raise ValueError("BACKSPYNE_OWNER_ID is required")
        if not node_token:
            raise ValueError("BACKSPYNE_NODE_TOKEN is required")

        node_id = os.getenv("BACKSPYNE_NODE_ID", "").strip() or socket.gethostname()
        return cls(
            api_url=os.getenv("BACKSPYNE_API_URL", "http://127.0.0.1:8080/api").rstrip("/"),
            owner_id=owner_id,
            node_token=node_token,
            node_id=node_id,
            node_name=os.getenv("BACKSPYNE_NODE_NAME", node_id).strip() or node_id,
            mode=mode,
            interval_seconds=max(2.0, float(os.getenv("BACKSPYNE_INTERVAL_SECONDS", "8"))),
            csi_serial_port=os.getenv("BACKSPYNE_CSI_SERIAL_PORT", "").strip() or None,
            csi_baudrate=int(os.getenv("BACKSPYNE_CSI_BAUDRATE", "115200")),
            csi_udp_port=int(os.getenv("BACKSPYNE_CSI_UDP_PORT"))
            if os.getenv("BACKSPYNE_CSI_UDP_PORT", "").strip()
            else None,
        )