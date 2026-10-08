from __future__ import annotations

import logging
import math
import time
from typing import Any

import requests

LOGGER = logging.getLogger("backspyne.bridge")
MAX_CSI_SAMPLES = 4096


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except OverflowError:
        return None
    return result if math.isfinite(result) else None


class CsiSourceClient:
    """Read only recent, explicitly live CSI snapshots from a local engine."""

    def __init__(
        self,
        base_url: str | None,
        token: str | None,
        allowed_sources: tuple[str, ...],
        max_age_seconds: float,
    ) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self.token = token
        self.allowed_sources = frozenset(source.lower() for source in allowed_sources)
        self.max_age_seconds = max_age_seconds
        self._last_identity: tuple[str, float, int, int | None] | None = None

    @property
    def enabled(self) -> bool:
        return self.base_url is not None

    def read(self) -> dict[str, Any] | None:
        if not self.base_url or not self.token:
            return None
        try:
            headers = {"Authorization": f"Bearer {self.token}"}
            health_response = requests.get(
                f"{self.base_url}/health/ready",
                headers=headers,
                timeout=2.5,
            )
            health_response.raise_for_status()
            health = health_response.json()
            response = requests.get(
                f"{self.base_url}/api/v1/sensing/latest",
                headers=headers,
                timeout=2.5,
            )
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError, TypeError) as error:
            LOGGER.warning("CSI analytics source unavailable: %s", error)
            return None
        if not isinstance(payload, dict) or not isinstance(health, dict):
            return None
        if "timestamp" not in payload and "timestamp_ms" not in payload:
            LOGGER.info("CSI analytics source has no live sensing frame yet")
            return None
        source_value = payload.get("source")
        health_source_value = health.get("source")
        source = source_value.lower() if isinstance(source_value, str) else ""
        health_source = health_source_value.lower() if isinstance(health_source_value, str) else ""
        source_state = health.get("source_state")
        if source not in self.allowed_sources or source != health_source or payload.get("synthetic") is True or source_state != "live_unverified":
            LOGGER.warning("CSI source rejected: health and latest must match allowlisted live hardware")
            return None
        timestamp_ms = _finite_number(payload.get("timestamp_ms"))
        if timestamp_ms is None:
            timestamp = _finite_number(payload.get("timestamp"))
            timestamp_ms = timestamp * 1000 if timestamp is not None else None
        if timestamp_ms is not None and timestamp_ms <= 0:
            timestamp_ms = None
        now_ms = time.time() * 1000
        if timestamp_ms is None or timestamp_ms > now_ms + 5_000 or now_ms - timestamp_ms > self.max_age_seconds * 1000:
            LOGGER.warning("CSI source rejected: sample is stale or has an invalid timestamp")
            return None
        nodes = payload.get("nodes")
        if not isinstance(nodes, list):
            return None
        amplitudes: list[float] = []
        node_ids: list[int] = []
        for node in nodes[:16]:
            if not isinstance(node, dict):
                continue
            node_id = node.get("node_id")
            if not isinstance(node_id, int) or isinstance(node_id, bool) or not 0 <= node_id <= 255:
                continue
            values = node.get("amplitude")
            if not isinstance(values, list):
                continue
            node_sample_count = 0
            for value in values:
                sample = _finite_number(value)
                if sample is not None and abs(sample) <= 1_000_000_000_000:
                    amplitudes.append(sample)
                    node_sample_count += 1
                    if len(amplitudes) >= MAX_CSI_SAMPLES:
                        break
            if node_sample_count and node_id not in node_ids:
                node_ids.append(node_id)
            if len(amplitudes) >= MAX_CSI_SAMPLES:
                break
        if not amplitudes or not node_ids:
            LOGGER.warning("CSI source has no current amplitude samples or valid hardware node IDs")
            return None
        trusted_node_ids = set(node_ids)
        engine_tick = payload.get("tick") if isinstance(payload.get("tick"), int) and not isinstance(payload.get("tick"), bool) and payload.get("tick") >= 0 else None
        if engine_tick is None:
            engine_tick = payload.get("timestamp_ms") if isinstance(payload.get("timestamp_ms"), int) and not isinstance(payload.get("timestamp_ms"), bool) and payload.get("timestamp_ms") >= 0 else int(timestamp_ms)
        identity = (source, timestamp_ms, len(amplitudes), engine_tick)
        if self._last_identity and self._last_identity[0] == source and self._last_identity[3] == engine_tick:
            return None
        raw_evidence = payload.get("calibrated_presence_evidence")
        evidence = None
        if isinstance(raw_evidence, dict):
            source_nodes = raw_evidence.get("source_node_ids")
            model_completed_at = _finite_number(raw_evidence.get("model_completed_at_unix_ms"))
            observed_at = _finite_number(raw_evidence.get("observed_at_unix_ms"))
            evidence_tick = raw_evidence.get("source_tick")
            inference_node_id = raw_evidence.get("inference_node_id")
            valid_evidence = (
                raw_evidence.get("schema") == "ruview.calibration.calibrated-presence-evidence.v2"
                and isinstance(raw_evidence.get("session_id"), str)
                and 0 < len(raw_evidence.get("session_id", "")) <= 128
                and isinstance(raw_evidence.get("model_id"), str)
                and 0 < len(raw_evidence.get("model_id", "")) <= 128
                and isinstance(source_nodes, list)
                and len(source_nodes) > 0
                and isinstance(raw_evidence.get("binding_digest"), str)
                and len(raw_evidence.get("binding_digest", "")) == 64
                and all(character in "0123456789abcdefABCDEF" for character in raw_evidence.get("binding_digest", ""))
                and isinstance(raw_evidence.get("boot_epoch"), str)
                and 0 < len(raw_evidence.get("boot_epoch", "")) <= 128
                and isinstance(raw_evidence.get("inference_method"), str)
                and 0 < len(raw_evidence.get("inference_method", "")) <= 128
                and isinstance(raw_evidence.get("presence"), bool)
                and isinstance(raw_evidence.get("person_count"), int)
                and not isinstance(raw_evidence.get("person_count"), bool)
                and 0 <= raw_evidence.get("person_count", -1) <= 255
                and raw_evidence.get("presence") == (raw_evidence.get("person_count", 0) > 0)
                and all(isinstance(node_id, int) and not isinstance(node_id, bool) and 0 <= node_id <= 255 for node_id in source_nodes)
                and source_nodes == [inference_node_id]
                and isinstance(inference_node_id, int)
                and not isinstance(inference_node_id, bool)
                and inference_node_id in trusted_node_ids
                and isinstance(evidence_tick, int)
                and not isinstance(evidence_tick, bool)
                and evidence_tick == engine_tick
                and evidence_tick >= 0
                and evidence_tick == payload.get("tick")
                and observed_at is not None
                and abs(observed_at - timestamp_ms) <= 1
                and model_completed_at is not None
                and 0 <= model_completed_at <= observed_at
                and timestamp_ms <= now_ms + 5_000
                and now_ms - timestamp_ms <= self.max_age_seconds * 1000
            )
            if valid_evidence:
                evidence = {
                    "schema": "backspyne.calibrated-presence-evidence.v2",
                    **{
                        key: raw_evidence.get(key)
                        for key in ("session_id", "model_id", "binding_digest", "source_node_ids", "model_completed_at_unix_ms", "inference_method", "presence", "person_count")
                    },
                }
        vital_signs = payload.get("vital_signs")
        safe_vitals = None
        if isinstance(vital_signs, dict):
            permitted_vitals: dict[str, float] = {}
            for key, value in vital_signs.items():
                numeric_value = _finite_number(value)
                if key in {"breathing_rate_bpm", "heart_rate_bpm"} and numeric_value is not None and 0 <= numeric_value <= 300:
                    permitted_vitals[key] = numeric_value
                elif key in {"breathing_confidence", "heartbeat_confidence", "signal_quality"} and numeric_value is not None and 0 <= numeric_value <= 1:
                    permitted_vitals[key] = numeric_value
            has_authority = payload.get("numeric_vitals_authorized") is not False and vital_signs.get("numeric_vitals_authorized") is not False
            has_published_rate = any(key in permitted_vitals for key in ("breathing_rate_bpm", "heart_rate_bpm"))
            if has_authority and permitted_vitals:
                safe_vitals = permitted_vitals
            numeric_vitals_authorized = has_authority and has_published_rate
        else:
            numeric_vitals_authorized = False
        pose_model = payload.get("model_status")
        safe_model_status = None
        if isinstance(pose_model, dict):
            safe_model_status = {
                key: value[:128]
                for key, value in pose_model.items()
                if key in {"version", "message"} and isinstance(value, str)
            }
            if isinstance(pose_model.get("loaded"), bool):
                safe_model_status["loaded"] = pose_model["loaded"]
        pose_keypoints = payload.get("pose_keypoints")
        safe_pose = None
        if isinstance(pose_model, dict) and pose_model.get("loaded") is True and isinstance(pose_keypoints, list):
            safe_pose = [
                [_finite_number(number) for number in point]
                for point in pose_keypoints[:17]
                if isinstance(point, list) and len(point) == 4 and all(
                    (number := _finite_number(value)) is not None
                    and abs(number) <= 1_000_000
                    and (index != 3 or 0 <= number <= 1)
                    for index, value in enumerate(point)
                )
            ]
            if not safe_pose:
                safe_pose = None
        raw_classification = payload.get("classification")
        classification: dict[str, Any] = {}
        if isinstance(raw_classification, dict):
            presence = raw_classification.get("presence")
            confidence = _finite_number(raw_classification.get("confidence"))
            motion_level = raw_classification.get("motion_level")
            if isinstance(presence, bool):
                classification["presence"] = presence
            if confidence is not None:
                classification["confidence"] = min(1.0, max(0.0, confidence))
            if isinstance(motion_level, str) and len(motion_level) <= 80:
                classification["motion_level"] = motion_level
            if presence is not None or confidence is not None or motion_level is not None:
                classification["experimental"] = True
        features = payload.get("features") if isinstance(payload.get("features"), dict) else {}
        safe_features = {
            key: number for key in ("mean_rssi", "variance", "motion_band_power", "breathing_band_power", "dominant_freq_hz", "spectral_power")
            if (number := _finite_number(features.get(key))) is not None and abs(number) <= 1_000_000_000_000
        }
        self._last_identity = identity
        return {
            "source": source,
            "sampleTimestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp_ms / 1000)),
            "ageMilliseconds": max(0, int(now_ms - timestamp_ms)),
            "sampleCount": len(amplitudes),
            "nodeIds": node_ids,
            "amplitudes": amplitudes,
            "classification": classification,
            "calibratedEvidence": evidence,
            "vitalSigns": safe_vitals,
            "poseKeypoints": safe_pose,
            "poseModelStatus": safe_model_status,
            "features": safe_features,
            "qualityVerdict": payload.get("quality_verdict")[:80] if isinstance(payload.get("quality_verdict"), str) else None,
            "numericVitalsAuthorized": numeric_vitals_authorized,
            "tick": engine_tick,
            "sourceState": source_state,
        }
