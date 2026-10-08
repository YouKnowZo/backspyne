from __future__ import annotations

import ipaddress
import math
import os
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

from dotenv import load_dotenv

load_dotenv()


def _validate_service_url(value: str, setting: str) -> None:
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        parsed.port  # Validate malformed/out-of-range port syntax.
    except (ValueError, UnicodeError) as error:
        raise ValueError(f"{setting} must be a valid HTTPS URL (HTTP is allowed only on localhost)") from error
    if not hostname or parsed.username or parsed.password:
        raise ValueError(f"{setting} must include a host and must not contain embedded credentials")
    if any(character.isspace() for character in value):
        raise ValueError(f"{setting} must not contain whitespace")
    if parsed.query or parsed.fragment:
        raise ValueError(f"{setting} must not include a query or fragment")
    local_host = hostname.lower() == "localhost"
    try:
        local_host = local_host or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        pass
    if parsed.scheme not in {"https", "http"}:
        raise ValueError(f"{setting} must use HTTPS outside localhost")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local_host):
        raise ValueError(f"{setting} must use HTTPS outside localhost")


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
    csi_api_url: str | None
    csi_api_token: str | None
    csi_source_allowlist: tuple[str, ...]
    csi_max_age_seconds: float

    def __post_init__(self) -> None:
        if bool(self.csi_api_url) != bool(self.csi_api_token):
            raise ValueError("Set both BACKSPYNE_CSI_API_URL and BACKSPYNE_CSI_API_TOKEN, or leave both unset")
        if self.csi_api_url:
            _validate_service_url(self.csi_api_url, "BACKSPYNE_CSI_API_URL")
        if not self.csi_source_allowlist:
            raise ValueError("BACKSPYNE_CSI_SOURCE_ALLOWLIST must contain at least one live hardware source")
        if not math.isfinite(self.csi_max_age_seconds) or not 1 <= self.csi_max_age_seconds <= 120:
            raise ValueError("BACKSPYNE_CSI_MAX_AGE_SECONDS must be between 1 and 120")

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
        _validate_service_url(api_url, "BACKSPYNE_API_URL")
        try:
            interval_seconds = float(os.getenv("BACKSPYNE_INTERVAL_SECONDS", "8"))
        except ValueError as error:
            raise ValueError("BACKSPYNE_INTERVAL_SECONDS must be a number") from error
        if not math.isfinite(interval_seconds) or interval_seconds < 2 or interval_seconds > 3600:
            raise ValueError("BACKSPYNE_INTERVAL_SECONDS must be between 2 and 3600")
        csi_api_url = os.getenv("BACKSPYNE_CSI_API_URL", "").strip().rstrip("/") or None
        csi_api_token = os.getenv("BACKSPYNE_CSI_API_TOKEN", "").strip() or None
        if bool(csi_api_url) != bool(csi_api_token):
            raise ValueError("Set both BACKSPYNE_CSI_API_URL and BACKSPYNE_CSI_API_TOKEN, or leave both unset")
        if csi_api_url:
            _validate_service_url(csi_api_url, "BACKSPYNE_CSI_API_URL")
        source_allowlist = tuple(
            source.strip().lower()
            for source in os.getenv(
                "BACKSPYNE_CSI_SOURCE_ALLOWLIST",
                "esp32,realtek_csi,mediatek_csi,qualcomm_csi",
            ).split(",")
            if source.strip()
        )
        if not source_allowlist:
            raise ValueError("BACKSPYNE_CSI_SOURCE_ALLOWLIST must contain at least one live hardware source")
        try:
            csi_max_age_seconds = float(os.getenv("BACKSPYNE_CSI_MAX_AGE_SECONDS", "10"))
        except ValueError as error:
            raise ValueError("BACKSPYNE_CSI_MAX_AGE_SECONDS must be a number") from error
        if not math.isfinite(csi_max_age_seconds) or not 1 <= csi_max_age_seconds <= 120:
            raise ValueError("BACKSPYNE_CSI_MAX_AGE_SECONDS must be between 1 and 120")
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
            csi_api_url=csi_api_url,
            csi_api_token=csi_api_token,
            csi_source_allowlist=source_allowlist,
            csi_max_age_seconds=csi_max_age_seconds,
        )
