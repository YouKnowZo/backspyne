from __future__ import annotations

import importlib
import tempfile
import unittest
from pathlib import Path

import backspyne_bridge.vendor as vendor_module
from backspyne_bridge.vendor import (
    BASIS_OUI,
    BASIS_REGISTRY,
    OUI_PREFIXES,
    UNHELPFUL_REGISTRY_ORGANIZATIONS,
    registry_match,
    registry_table,
    registry_vendor,
    vendor_profile,
)

# Prefixes confirmed present in the IEEE MA-L registry when the data file was generated.
ASSIGNED = {
    "B01921": "tp-link",
    "00000C": "cisco",
    "000393": "apple",
}
# A prefix observed in the logs of a host that masks BSSIDs; it is in no registry.
MASKED_PREFIX = "06937C"


def _first_usable(prefixes: list[str]) -> str | None:
    """A registry entry we can build a valid globally administered unicast address from."""
    for prefix in prefixes:
        if int(prefix[:2], 16) & 0x03:
            continue
        organization = registry_table().get(prefix, "")
        if not organization or organization in UNHELPFUL_REGISTRY_ORGANIZATIONS:
            continue
        return prefix
    return None


def _as_address(prefix: str) -> str:
    digits = (prefix + "0" * 12)[:12]
    return ":".join(digits[index:index + 2] for index in range(0, 12, 2))


class RegistryDataTests(unittest.TestCase):
    def test_the_authoritative_table_is_present_and_large(self) -> None:
        table = registry_table()
        self.assertGreater(len(table), 10_000, "the IEEE registry data file is missing or truncated")
        for prefix in table:
            with self.subTest(prefix=prefix):
                self.assertIn(len(prefix), (6, 7, 9))
                self.assertRegex(prefix, r"^[0-9A-F]+$")

    def test_known_registry_prefixes_resolve(self) -> None:
        for prefix, expected in ASSIGNED.items():
            with self.subTest(prefix=prefix):
                vendor = registry_vendor(prefix)
                self.assertIsNotNone(vendor)
                self.assertIn(expected, str(vendor).lower())

    def test_masked_prefix_is_absent_from_every_registry(self) -> None:
        self.assertIsNone(registry_vendor(MASKED_PREFIX))

    def test_lookup_rejects_empty_and_unparseable_input(self) -> None:
        for value in (None, "", "   ", "zz:zz", "not-an-address"):
            with self.subTest(value=value):
                self.assertIsNone(registry_match(value))

    def test_separators_in_the_address_are_ignored(self) -> None:
        self.assertEqual(registry_match("B0:19:21"), registry_match("b0-19-21"))
        self.assertIsNotNone(registry_match("B0:19:21"))


class RegistryPrecedenceTests(unittest.TestCase):
    def test_registry_beats_the_hand_curated_table(self) -> None:
        # 3C5A37 is Samsung in the authoritative registry and Google in the curated
        # table; the registry is right, and it must win.
        self.assertIn("3C5A37", OUI_PREFIXES)
        authoritative = registry_vendor("3C5A37")
        self.assertIsNotNone(authoritative)
        self.assertNotEqual(authoritative, OUI_PREFIXES["3C5A37"])
        profile = vendor_profile("3C:5A:37:11:22:33")
        self.assertEqual(profile["vendor"], authoritative)
        self.assertEqual(profile["ouiPrefix"], "3C5A37")
        self.assertEqual(profile["basis"], BASIS_REGISTRY)
        self.assertEqual(profile["evidenceQuality"], 80)

    def test_an_unusable_registry_name_falls_through_to_the_curated_table(self) -> None:
        match = registry_match("ACDE48")
        if match is None or match[1] not in UNHELPFUL_REGISTRY_ORGANIZATIONS:
            self.skipTest("the registry now supplies a usable name for ACDE48")
        profile = vendor_profile("AC:DE:48:00:00:01")
        self.assertEqual(profile["vendor"], OUI_PREFIXES["ACDE48"])
        self.assertEqual(profile["basis"], BASIS_OUI)
        self.assertEqual(profile["evidenceQuality"], 85)

    def test_longest_prefix_wins(self) -> None:
        table = registry_table()
        long_prefixes = sorted(prefix for prefix in table if len(prefix) == 9)
        mid_prefixes = sorted(prefix for prefix in table if len(prefix) == 7)
        self.assertTrue(long_prefixes, "expected 36-bit (MA-S) assignments in the registry")
        self.assertTrue(mid_prefixes, "expected 28-bit (MA-M) assignments in the registry")

        for prefixes, expected_length in ((long_prefixes, 9), (mid_prefixes, 7)):
            entry = _first_usable(prefixes)
            if entry is None:
                self.skipTest(f"no usable {expected_length}-character registry entry")
            match = registry_match(entry)
            self.assertEqual(match, (entry, table[entry]))
            profile = vendor_profile(_as_address(entry))
            self.assertEqual(profile["vendor"], table[entry])
            self.assertEqual(profile["ouiPrefix"], entry)
            self.assertEqual(profile["basis"], BASIS_REGISTRY)
            # When the shorter prefix is also assigned, the more specific entry wins.
            shorter = entry[:6]
            if shorter in table and shorter != entry:
                self.assertEqual(registry_match(_as_address(entry))[0], entry)
                self.assertNotEqual(registry_match(shorter)[0], entry)


class RegistryLoaderTests(unittest.TestCase):
    def test_the_table_is_not_read_at_import_time(self) -> None:
        module = importlib.reload(vendor_module)
        try:
            self.assertIsNone(module._REGISTRY_TABLE, "importing the module must not read the data file")
            self.assertIsNotNone(module.registry_vendor("B01921"), "the table loads on first use")
            self.assertIsNotNone(module._REGISTRY_TABLE)
        finally:
            # Leave the module in a clean state for the other tests.
            module._REGISTRY_TABLE = None

    def test_a_missing_data_file_degrades_to_the_curated_table(self) -> None:
        original_path = vendor_module._REGISTRY_PATH
        original_table = vendor_module._REGISTRY_TABLE
        missing = Path(tempfile.gettempdir()) / "backspyne-oui-registry-does-not-exist.csv.gz"
        try:
            vendor_module._REGISTRY_PATH = missing
            vendor_module._REGISTRY_TABLE = None
            self.assertIsNone(vendor_module.registry_vendor("B01921"))
            self.assertEqual(vendor_module.registry_table(), {})
            profile = vendor_module.vendor_profile("00:03:93:12:34:56")
            self.assertEqual(profile["basis"], BASIS_OUI)
            self.assertEqual(profile["vendor"], vendor_module.OUI_PREFIXES["000393"])
        finally:
            vendor_module._REGISTRY_PATH = original_path
            vendor_module._REGISTRY_TABLE = original_table

    def test_a_corrupt_data_file_does_not_raise(self) -> None:
        original_path = vendor_module._REGISTRY_PATH
        original_table = vendor_module._REGISTRY_TABLE
        corrupt = Path(tempfile.gettempdir()) / "backspyne-oui-registry-corrupt.csv.gz"
        try:
            corrupt.write_bytes(b"this is not a gzip stream")
            vendor_module._REGISTRY_PATH = corrupt
            vendor_module._REGISTRY_TABLE = None
            self.assertIsNone(vendor_module.registry_vendor("B01921"))
        finally:
            vendor_module._REGISTRY_PATH = original_path
            vendor_module._REGISTRY_TABLE = original_table
            corrupt.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
