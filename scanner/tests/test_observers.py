from __future__ import annotations

import unittest
from unittest.mock import patch

from backspyne_bridge.observers import WifiObserver

# A trimmed transcript in the exact shape netsh writes: the protection mode is stated once
# per network, above that network's BSSID entries.
NETSH_OUTPUT = """Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : Front Desk
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP

    BSSID 1                 : a0:1b:2c:3d:4e:01
         Signal             : 82%
         Radio type         : 802.11n
         Channel            : 6
         Basic rates (Mbps) : 1 2 5.5 11

SSID 2 : Guest Open
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None

    BSSID 1                 : a0:1b:2c:3d:4e:02
         Signal             : 61%
         Channel            : 1

SSID 3 :
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP

    BSSID 1                 : 0A:93:7c:11:22:33
         Signal             : 45%
         Channel            : 11
"""


class WindowsWifiObserverTests(unittest.TestCase):
    def scan(self) -> list[dict]:
        with patch("backspyne_bridge.observers.platform.system", return_value="Windows"), patch(
            "backspyne_bridge.observers.shutil.which", return_value="C:/Windows/System32/netsh.exe"
        ), patch("backspyne_bridge.observers._run", return_value=NETSH_OUTPUT):
            return WifiObserver().scan()

    def test_every_access_point_carries_the_mode_netsh_reported_for_its_network(self) -> None:
        observations = self.scan()
        self.assertEqual([entry["address"] for entry in observations], ["A0:1B:2C:3D:4E:01", "A0:1B:2C:3D:4E:02", "0A:93:7C:11:22:33"])

        by_address = {entry["address"]: entry for entry in observations}
        front_desk = by_address["A0:1B:2C:3D:4E:01"]
        self.assertEqual(front_desk["payload"]["ssid"], "Front Desk")
        self.assertEqual(front_desk["payload"]["security"], "WPA2-Personal")
        self.assertEqual(front_desk["channel"], "6")
        self.assertEqual(front_desk["signalQualityPercent"], 82)

        # An open network says so, and the hidden name stays empty rather than inheriting a
        # neighbouring network's details.
        self.assertEqual(by_address["A0:1B:2C:3D:4E:02"]["payload"]["security"], "Open")
        hidden = by_address["0A:93:7C:11:22:33"]
        self.assertEqual(hidden["payload"]["ssid"], "")
        self.assertEqual(hidden["payload"]["security"], "WPA3-Personal")
        self.assertEqual(hidden["channel"], "11")

    def test_a_locally_administered_bssid_is_marked_as_masked(self) -> None:
        # Windows replaces BSSIDs with locally administered addresses for callers without
        # location access; the flag is what stops the console implying an unknown device.
        by_address = {entry["address"]: entry for entry in self.scan()}
        self.assertTrue(by_address["0A:93:7C:11:22:33"]["payload"]["addressMasked"])
        self.assertFalse(by_address["A0:1B:2C:3D:4E:01"]["payload"]["addressMasked"])

    def test_an_adapter_that_states_no_mode_reports_an_empty_string(self) -> None:
        transcript = """Interface name : Wi-Fi

SSID 1 : Silent AP
    Network type            : Infrastructure

    BSSID 1                 : a0:1b:2c:3d:4e:09
         Signal             : 30%
         Channel            : 3
"""
        with patch("backspyne_bridge.observers.platform.system", return_value="Windows"), patch(
            "backspyne_bridge.observers.shutil.which", return_value="netsh"
        ), patch("backspyne_bridge.observers._run", return_value=transcript):
            observations = WifiObserver().scan()
        self.assertEqual(len(observations), 1)
        # Empty means "not reported"; the assessment counts it that way instead of assuming
        # the network is protected.
        self.assertEqual(observations[0]["payload"]["security"], "")


if __name__ == "__main__":
    unittest.main()
