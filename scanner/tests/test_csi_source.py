from __future__ import annotations

import time
import unittest
from unittest.mock import Mock, patch

from backspyne_bridge.csi_source import CsiSourceClient


class CsiSourceClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = CsiSourceClient(
            "http://127.0.0.1:8080",
            "server-only-token",
            ("esp32", "realtek_csi"),
            10,
        )

    @staticmethod
    def response(payload: dict[str, object]) -> Mock:
        response = Mock()
        response.json.return_value = payload
        response.raise_for_status.return_value = None
        return response

    @staticmethod
    def live_frame(**overrides: object) -> dict[str, object]:
        return {
            "source": "esp32",
            "timestamp": time.time(),
            "tick": 4,
            "nodes": [{"node_id": 2, "amplitude": [1.0, float("nan"), 3.0]}],
            **overrides,
        }

    def mock_engine(self, frame: dict[str, object], source_state: str = "live_unverified", health_source: str | None = None) -> Mock:
        health = self.response({"source": health_source or frame.get("source", "esp32"), "source_state": source_state})
        latest = self.response(frame)
        return patch(
            "backspyne_bridge.csi_source.requests.get",
            side_effect=[health, latest],
        )

    def test_accepts_wire_schema_with_live_state_only_on_health_and_bounds_amplitudes(self) -> None:
        frame = self.live_frame(features={"variance": 1.5, "untrusted": "ignored"})
        with self.mock_engine(frame) as get:
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["amplitudes"], [1.0, 3.0])
        self.assertEqual(result["nodeIds"], [2])
        self.assertEqual(result["features"], {"variance": 1.5})
        self.assertEqual(result["sourceState"], "live_unverified")
        self.assertEqual(get.call_args_list[0].kwargs["headers"], {"Authorization": "Bearer server-only-token"})
        self.assertEqual(get.call_args_list[0].kwargs["timeout"], 2.5)

    def test_rejects_simulated_unallowlisted_stale_and_non_live_sources(self) -> None:
        cases = [
            self.live_frame(source="esp32:simulated"),
            self.live_frame(source="wifi"),
            self.live_frame(synthetic=True),
            self.live_frame(timestamp=time.time() - 30),
        ]
        for frame in cases:
            with self.subTest(frame=frame):
                self.client._last_identity = None
                with self.mock_engine(frame) as _:
                    self.assertIsNone(self.client.read())
        with self.mock_engine(self.live_frame(), source_state="disconnected"):
            self.assertIsNone(self.client.read())

    def test_rejects_invalid_live_health_payloads_without_raising(self) -> None:
        for health in ({"source": "esp32", "source_state": []}, [], None):
            with self.subTest(health=health):
                self.client._last_identity = None
                with patch(
                    "backspyne_bridge.csi_source.requests.get",
                    side_effect=[self.response(health), self.response(self.live_frame())],
                ):
                    self.assertIsNone(self.client.read())

    def test_rejects_source_mismatch_between_health_and_latest(self) -> None:
        with self.mock_engine(self.live_frame(source="realtek_csi"), health_source="esp32"):
            self.assertIsNone(self.client.read())

    def test_requires_amplitudes_to_belong_to_a_valid_hardware_node(self) -> None:
        for node in (
            {"node_id": True, "amplitude": [1.0]},
            {"node_id": 2, "amplitude": []},
        ):
            with self.subTest(node=node), self.mock_engine(self.live_frame(nodes=[node])):
                self.assertIsNone(self.client.read())

    def test_rejects_duplicate_engine_ticks(self) -> None:
        frame = self.live_frame()
        with self.mock_engine(frame) as get:
            self.assertIsNotNone(self.client.read())
            get.side_effect = [self.response({"source": "esp32", "source_state": "live_unverified"}), self.response(frame)]
            self.assertIsNone(self.client.read())

    def test_accepts_only_fresh_model_bound_room_evidence(self) -> None:
        timestamp_ms = int(time.time() * 1000)
        frame = self.live_frame(
            timestamp_ms=timestamp_ms,
            timestamp=timestamp_ms / 1000,
            calibrated_presence_evidence={
                "schema": "ruview.calibration.calibrated-presence-evidence.v2",
                "boot_epoch": "boot-1",
                "session_id": "session-1",
                "model_id": "model-1",
                "binding_digest": "a" * 64,
                "source_node_ids": [2],
                "model_completed_at_unix_ms": timestamp_ms - 1000,
                "inference_node_id": 2,
                "source_tick": 4,
                "observed_at_unix_ms": timestamp_ms,
                "inference_method": "calibrated_field_model",
                "presence": True,
                "person_count": 1,
            },
        )
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        assert result["calibratedEvidence"] is not None
        self.assertEqual(result["calibratedEvidence"]["model_id"], "model-1")
        self.assertEqual(result["calibratedEvidence"]["source_node_ids"], [2])

    def test_rejects_evidence_from_other_node_or_frame(self) -> None:
        timestamp_ms = int(time.time() * 1000)
        evidence = {
            "schema": "ruview.calibration.calibrated-presence-evidence.v2",
            "boot_epoch": "boot-1",
            "session_id": "session-1",
            "model_id": "model-1",
            "binding_digest": "a" * 64,
            "source_node_ids": [3],
            "model_completed_at_unix_ms": timestamp_ms - 1000,
            "inference_node_id": 3,
            "source_tick": 4,
            "observed_at_unix_ms": timestamp_ms,
            "inference_method": "calibrated_field_model",
            "presence": True,
            "person_count": 1,
        }
        frame = self.live_frame(timestamp_ms=timestamp_ms, timestamp=timestamp_ms / 1000, calibrated_presence_evidence=evidence)
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIsNone(result["calibratedEvidence"])

    def test_vitals_are_only_forwarded_for_live_engine_and_respect_explicit_gate(self) -> None:
        frame = self.live_frame(vital_signs={"breathing_rate_bpm": 15.0, "unexpected": "drop"})
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["vitalSigns"], {"breathing_rate_bpm": 15.0})
        self.assertTrue(result["numericVitalsAuthorized"])

        self.client._last_identity = None
        frame = self.live_frame(vital_signs={"breathing_rate_bpm": 15.0}, numeric_vitals_authorized=False)
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIsNone(result["vitalSigns"])
        self.assertFalse(result["numericVitalsAuthorized"])

    def test_evidence_rejects_malformed_numeric_authority_fields(self) -> None:
        timestamp_ms = int(time.time() * 1000)
        evidence = {
            "schema": "ruview.calibration.calibrated-presence-evidence.v2",
            "boot_epoch": "boot-1",
            "session_id": "session-1",
            "model_id": "model-1",
            "binding_digest": "a" * 64,
            "source_node_ids": [2],
            "model_completed_at_unix_ms": {"malformed": True},
            "inference_node_id": 2,
            "source_tick": 4,
            "observed_at_unix_ms": timestamp_ms,
            "inference_method": "calibrated_field_model",
            "presence": True,
            "person_count": 1,
        }
        frame = self.live_frame(timestamp_ms=timestamp_ms, timestamp=timestamp_ms / 1000, calibrated_presence_evidence=evidence)
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIsNone(result["calibratedEvidence"])

    def test_numeric_vitals_reject_out_of_range_and_explicitly_unauthorized_values(self) -> None:
        frame = self.live_frame(
            vital_signs={
                "breathing_rate_bpm": 15.0,
                "heart_rate_bpm": 301.0,
                "signal_quality": 2.0,
            }
        )
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["vitalSigns"], {"breathing_rate_bpm": 15.0})

        self.client._last_identity = None
        frame["vital_signs"] = {"breathing_rate_bpm": 15.0, "numeric_vitals_authorized": False}
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertIsNone(result["vitalSigns"])
        self.assertFalse(result["numericVitalsAuthorized"])

    def test_confidence_only_vitals_do_not_claim_numeric_rate_authorization(self) -> None:
        frame = self.live_frame(vital_signs={"breathing_confidence": 0.8})
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["vitalSigns"], {"breathing_confidence": 0.8})
        self.assertFalse(result["numericVitalsAuthorized"])

    def test_pose_points_require_loaded_model_and_finite_coordinates(self) -> None:
        frame = self.live_frame(
            model_status={"loaded": True},
            pose_keypoints=[[0.1, 0.2, 0.0, 0.9], [0.1, float("nan"), 0.0, 0.9], [0.1, 0.2, 0.0, 1.2]],
        )
        with self.mock_engine(frame):
            result = self.client.read()
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["poseKeypoints"], [[0.1, 0.2, 0.0, 0.9]])


if __name__ == "__main__":
    unittest.main()
