from __future__ import annotations

import unittest

from backspyne_bridge.inference import derive_metrics


class MeasurementMetricsTests(unittest.TestCase):
    def test_radio_and_uncalibrated_serial_csi_remain_descriptive(self) -> None:
        metrics = derive_metrics(
            [{"signalDbm": -55.0}],
            [{"signalDbm": -70.0}],
            [1.0, 2.0, 3.0],
        )
        self.assertIsNone(metrics["presenceProbability"])
        self.assertIsNone(metrics["motionIndex"])
        self.assertIsNone(metrics["occupancyEstimate"])
        self.assertIsNone(metrics["confidence"])
        self.assertFalse(metrics["medicalInference"])
        self.assertEqual(metrics["inferenceStatus"], "measurements_only")
        self.assertEqual(metrics["csiSampleCount"], 3)
        self.assertAlmostEqual(metrics["csiAmplitudeVariance"], 2 / 3, places=5)


if __name__ == "__main__":
    unittest.main()
