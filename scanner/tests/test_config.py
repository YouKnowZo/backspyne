from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from backspyne_bridge.config import Config


class ConfigTests(unittest.TestCase):
    def required_environment(self) -> dict[str, str]:
        return {
            "BACKSPYNE_OWNER_ID": "operator_test",
            "BACKSPYNE_NODE_TOKEN": "n" * 40,
            "BACKSPYNE_MODE": "live",
        }

    def test_existing_measurement_only_configuration_needs_no_csi_endpoint(self) -> None:
        with patch.dict(os.environ, self.required_environment(), clear=True):
            config = Config.from_environment()
        self.assertIsNone(config.csi_api_url)
        self.assertIsNone(config.csi_api_token)
        self.assertEqual(config.csi_source_allowlist, ("esp32", "realtek_csi", "mediatek_csi", "qualcomm_csi"))

    def test_requires_both_csi_url_and_token(self) -> None:
        environment = {**self.required_environment(), "BACKSPYNE_CSI_API_URL": "https://sensor.example"}
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ValueError, "Set both"):
                Config.from_environment()

    def test_rejects_non_https_remote_csi_endpoint(self) -> None:
        environment = {
            **self.required_environment(),
            "BACKSPYNE_CSI_API_URL": "http://sensor.example",
            "BACKSPYNE_CSI_API_TOKEN": "server-secret",
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                Config.from_environment()

    def test_rejects_non_loopback_http_alias_and_embedded_credentials(self) -> None:
        for url in ("http://192.168.1.2:8080", "http://localhost.example:8080", "http://user@localhost:8080"):
            with self.subTest(url=url):
                environment = {
                    **self.required_environment(),
                    "BACKSPYNE_CSI_API_URL": url,
                    "BACKSPYNE_CSI_API_TOKEN": "server-secret",
                }
                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaises(ValueError):
                        Config.from_environment()

    def test_accepts_local_authenticated_engine_and_bounds_sample_age(self) -> None:
        environment = {
            **self.required_environment(),
            "BACKSPYNE_CSI_API_URL": "http://127.0.0.1:8080",
            "BACKSPYNE_CSI_API_TOKEN": "server-secret",
            "BACKSPYNE_CSI_MAX_AGE_SECONDS": "20",
        }
        with patch.dict(os.environ, environment, clear=True):
            config = Config.from_environment()
        self.assertEqual(config.csi_api_url, "http://127.0.0.1:8080")
        self.assertEqual(config.csi_max_age_seconds, 20)

    def test_rejects_empty_source_allowlist(self) -> None:
        environment = {**self.required_environment(), "BACKSPYNE_CSI_SOURCE_ALLOWLIST": ",,,"}
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ValueError, "at least one"):
                Config.from_environment()


if __name__ == "__main__":
    unittest.main()
