from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any


def derive_metrics(
    wifi: list[dict[str, Any]],
    ble: list[dict[str, Any]],
    csi: Iterable[float] | None = None,
) -> dict[str, float | str | bool]:
    """Calculate descriptive signal summaries from measurements only.

    Presence probability and occupancy are intentionally not inferred from RF
    signal strength: ambient APs and randomized client addresses do not support
    reliable person counting. No medical inference is attempted.
    """
    signals = [
        float(observation["signalDbm"])
        for observation in [*wifi, *ble]
        if isinstance(observation.get("signalDbm"), (int, float))
        and not isinstance(observation.get("signalDbm"), bool)
        and math.isfinite(float(observation["signalDbm"]))
    ]
    mean_signal = sum(signals) / len(signals) if signals else -92.0
    variance = (
        sum((signal - mean_signal) ** 2 for signal in signals) / len(signals)
        if signals
        else 0.0
    )
    csi_samples = []
    for sample in csi or []:
        if isinstance(sample, (int, float)) and not isinstance(sample, bool) and math.isfinite(float(sample)):
            csi_samples.append(float(sample))
    csi_variance = 0.0
    if len(csi_samples) > 1:
        mean_csi = sum(csi_samples) / len(csi_samples)
        csi_variance = sum((sample - mean_csi) ** 2 for sample in csi_samples) / len(csi_samples)

    return {
        "presenceProbability": None,
        "motionIndex": None,
        "occupancyEstimate": None,
        "signalVarianceDb": round(variance, 3) if signals else None,
        "signalVarianceDbSquared": round(variance, 3) if signals else None,
        "signalFloorDbm": round(min(signals), 2) if signals else None,
        "meanSignalDbm": round(mean_signal, 2) if signals else None,
        "signalSampleCount": len(signals),
        "observationCount": len(wifi) + len(ble),
        "csiSampleCount": len(csi_samples),
        "csiAmplitudeVariance": round(csi_variance, 6) if csi_samples else None,
        "confidence": None,
        "inferenceStatus": "measurements_only",
        "medicalInference": False,
    }