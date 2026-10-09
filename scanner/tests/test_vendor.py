from __future__ import annotations

import unittest

# _OUI_ASSIGNMENTS is imported deliberately: it is the only place the raw
# per-vendor prefix lists survive, so a duplicated prefix (which would silently
# collapse in the flattened OUI_PREFIXES mapping) can be detected here.
from backspyne_bridge.vendor import (
    BASIS_BLE,
    BASIS_MASKED,
    BASIS_NONE,
    BASIS_OUI,
    BASIS_RANDOMIZED,
    BASIS_REGISTRY,
    BLE_COMPANIES,
    OUI_PREFIXES,
    UNKNOWN_VENDOR,
    _OUI_ASSIGNMENTS,
    address_kind,
    ble_manufacturer_for,
    registry_vendor,
    vendor_category,
    vendor_for,
    vendor_hint_from_name,
    vendor_profile,
)

PROFILE_KEYS = {"vendor", "category", "ouiPrefix", "basis", "evidenceQuality"}
BASIS_VALUES = {BASIS_OUI, BASIS_REGISTRY, BASIS_BLE, BASIS_RANDOMIZED, BASIS_MASKED, BASIS_NONE}

# Flat fixtures: 0x02 bit clear (globally administered), low bit clear (unicast).
GLOBALLY_ADMINISTERED_APPLE = "00:03:93:12:34:56"
GLOBALLY_ADMINISTERED_UNASSIGNED = "A8:00:00:00:00:01"
RANDOMIZED = "02:00:5E:10:00:01"
MULTICAST = "01:00:5E:00:00:01"


class VendorDatasetTests(unittest.TestCase):
    def test_oui_prefixes_are_six_uppercase_hex_characters(self) -> None:
        for prefix in OUI_PREFIXES:
            with self.subTest(prefix=prefix):
                self.assertRegex(prefix, r"^[0-9A-F]{6}$")

    def test_no_prefix_is_assigned_twice(self) -> None:
        assigned = [prefix for prefixes in _OUI_ASSIGNMENTS.values() for prefix in prefixes]
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(len(assigned), len(OUI_PREFIXES))

    def test_dataset_covers_the_documented_minimum(self) -> None:
        self.assertGreaterEqual(len(OUI_PREFIXES), 200)

    def test_ble_company_identifiers_are_integer_keys(self) -> None:
        # Only identifiers whose value could be confirmed have been recorded,
        # so this asserts the structural minimum rather than a target count.
        self.assertGreaterEqual(len(BLE_COMPANIES), 20)
        for company_id, name in BLE_COMPANIES.items():
            with self.subTest(company_id=company_id):
                self.assertIsInstance(company_id, int)
                self.assertTrue(name)

    def test_every_dataset_vendor_has_a_category(self) -> None:
        for vendor in sorted(set(OUI_PREFIXES.values()) | set(BLE_COMPANIES.values())):
            with self.subTest(vendor=vendor):
                self.assertNotEqual(vendor_category(vendor), "Unclassified")


class AddressKindTests(unittest.TestCase):
    def test_documented_labels(self) -> None:
        self.assertEqual(address_kind(GLOBALLY_ADMINISTERED_APPLE), "globally administered address")
        self.assertEqual(address_kind(RANDOMIZED), "private/randomized address")
        self.assertEqual(address_kind(MULTICAST), "multicast address")
        self.assertEqual(address_kind(None), "unknown address type")
        self.assertEqual(address_kind("not-an-address"), "unknown address type")

    def test_hyphenated_addresses_are_supported(self) -> None:
        self.assertEqual(address_kind("00-03-93-12-34-56"), "globally administered address")


class VendorLookupTests(unittest.TestCase):
    def test_known_prefix_resolves_to_its_vendor(self) -> None:
        # The authoritative IEEE registry supplies the name for an assigned prefix, so
        # the exact spelling belongs to that dataset; the curated table is the fallback.
        profile = vendor_profile(GLOBALLY_ADMINISTERED_APPLE)
        self.assertEqual(profile["ouiPrefix"], "000393")
        self.assertIn(profile["basis"], (BASIS_REGISTRY, BASIS_OUI))
        self.assertGreaterEqual(profile["evidenceQuality"], 80)
        self.assertTrue(str(profile["vendor"]).lower().startswith("apple"))
        expected = registry_vendor("000393") or OUI_PREFIXES["000393"]
        self.assertEqual(profile["vendor"], expected)
        self.assertEqual(vendor_for(GLOBALLY_ADMINISTERED_APPLE), expected)

    def test_randomized_address_is_never_attributed(self) -> None:
        profile = vendor_profile(RANDOMIZED)
        self.assertEqual(profile["vendor"], UNKNOWN_VENDOR)
        self.assertIsNone(profile["ouiPrefix"])
        self.assertEqual(profile["basis"], BASIS_RANDOMIZED)
        self.assertLessEqual(profile["evidenceQuality"], 20)
        self.assertEqual(vendor_for(RANDOMIZED), UNKNOWN_VENDOR)

    def test_multicast_address_is_never_attributed(self) -> None:
        profile = vendor_profile(MULTICAST)
        self.assertEqual(profile["vendor"], UNKNOWN_VENDOR)
        self.assertEqual(profile["basis"], BASIS_RANDOMIZED)
        self.assertEqual(vendor_for(MULTICAST), UNKNOWN_VENDOR)

    def test_unassigned_globally_administered_address_stays_unknown(self) -> None:
        if registry_vendor(GLOBALLY_ADMINISTERED_UNASSIGNED[:6]):
            self.skipTest(f"{GLOBALLY_ADMINISTERED_UNASSIGNED[:8]} is assigned in the current registry")
        profile = vendor_profile(GLOBALLY_ADMINISTERED_UNASSIGNED)
        self.assertEqual(profile["vendor"], UNKNOWN_VENDOR)
        self.assertIsNone(profile["ouiPrefix"])
        self.assertEqual(profile["basis"], BASIS_NONE)
        self.assertLessEqual(profile["evidenceQuality"], 20)

    def test_ble_company_code_is_reported_as_a_hint(self) -> None:
        profile = vendor_profile(RANDOMIZED, {0x004C: b"\x02\x15\x00\x00"})
        self.assertEqual(profile["vendor"], "Apple")
        self.assertIsNone(profile["ouiPrefix"])
        self.assertEqual(profile["basis"], BASIS_BLE)
        self.assertGreaterEqual(profile["evidenceQuality"], 50)
        self.assertLess(profile["evidenceQuality"], 80)
        self.assertEqual(ble_manufacturer_for({0x004C: b"\x02\x15"}), "Apple")

    def test_unrecognised_company_code_reports_no_evidence(self) -> None:
        manufacturer_data = {0xFFFE: b"\x00\x01"}
        self.assertIsNone(ble_manufacturer_for(manufacturer_data))
        profile = vendor_profile(GLOBALLY_ADMINISTERED_UNASSIGNED, manufacturer_data)
        self.assertEqual(profile["vendor"], UNKNOWN_VENDOR)
        self.assertEqual(profile["basis"], BASIS_NONE)

    def test_reviewed_prefix_wins_over_a_company_code(self) -> None:
        profile = vendor_profile(GLOBALLY_ADMINISTERED_APPLE, {0x0075: b"\x01"})
        self.assertEqual(profile["vendor"], registry_vendor("000393") or OUI_PREFIXES["000393"])
        self.assertIn(profile["basis"], (BASIS_REGISTRY, BASIS_OUI))
        self.assertNotEqual(profile["basis"], BASIS_BLE)

    def test_empty_manufacturer_data_returns_none(self) -> None:
        self.assertIsNone(ble_manufacturer_for(None))
        self.assertIsNone(ble_manufacturer_for({}))

    def test_profile_shape_is_stable_for_every_addressing_case(self) -> None:
        addresses = [f"{first:02X}:00:00:00:00:01" for first in range(256)]
        addresses.extend([GLOBALLY_ADMINISTERED_APPLE, RANDOMIZED, MULTICAST, None, "", "zz:zz"])
        for address in addresses:
            with self.subTest(address=address):
                profile = vendor_profile(address)
                self.assertEqual(set(profile), PROFILE_KEYS)
                self.assertIsInstance(profile["vendor"], str)
                self.assertIsInstance(profile["category"], str)
                self.assertTrue(profile["ouiPrefix"] is None or isinstance(profile["ouiPrefix"], str))
                self.assertIn(profile["basis"], BASIS_VALUES)
                self.assertIsInstance(profile["evidenceQuality"], int)
                self.assertGreaterEqual(profile["evidenceQuality"], 0)
                self.assertLessEqual(profile["evidenceQuality"], 100)
                if profile["vendor"] == UNKNOWN_VENDOR:
                    self.assertIsNone(profile["ouiPrefix"])

    def test_category_helper_marks_unknown_vendors_unclassified(self) -> None:
        self.assertEqual(vendor_category(UNKNOWN_VENDOR), "Unclassified")
        self.assertEqual(vendor_category(""), "Unclassified")


if __name__ == "__main__":
    unittest.main()


class VendorNameHintTests(unittest.TestCase):
    """Self-reported names are hints only and must never be treated as identity."""

    def test_brand_in_an_ssid_is_reported_as_a_hint(self):
        self.assertEqual(vendor_hint_from_name("TP-Link_447C"), "TP-Link Technologies")
        self.assertEqual(vendor_hint_from_name("NETGEAR57"), "Netgear, Inc.")
        self.assertEqual(vendor_hint_from_name("FRITZ!Box 7590 QV"), "AVM GmbH (FRITZ!)")
        self.assertEqual(vendor_hint_from_name("HP-Print-3A-Deskjet"), "HP Inc.")

    def test_hint_matching_is_case_insensitive_and_trimmed(self):
        self.assertEqual(vendor_hint_from_name("  sonos-roam  "), "Sonos, Inc.")
        self.assertEqual(vendor_hint_from_name("EERO-1042"), "Amazon Technologies, Inc.")

    def test_names_without_a_recognised_brand_return_no_hint(self):
        for name in (None, "", "   ", "Guest WiFi 2.4G", "Krusty Krab Guest WiFi", 42):
            with self.subTest(name=name):
                self.assertIsNone(vendor_hint_from_name(name))

    def test_a_name_hint_never_changes_the_resolved_vendor(self):
        # A hint can only ever be reported beside the vendor, never as the vendor. A BLE
        # advertiser with a randomized address is the case where no prefix can help.
        self.assertEqual(vendor_hint_from_name("TP-Link_447C"), "TP-Link Technologies")
        profile = vendor_profile(RANDOMIZED)
        self.assertEqual(profile["vendor"], UNKNOWN_VENDOR)
        self.assertEqual(profile["basis"], BASIS_RANDOMIZED)
        self.assertLessEqual(profile["evidenceQuality"], 20)

    def test_wifi_masking_is_reported_separately_from_a_ble_privacy_address(self) -> None:
        # Windows hands masked BSSIDs to callers without location access; a BLE privacy
        # address is genuinely the device's own. Only the caller knows which is which.
        masked = vendor_profile(RANDOMIZED, observation_kind="wifi")
        self.assertEqual(masked["vendor"], UNKNOWN_VENDOR)
        self.assertIsNone(masked["ouiPrefix"])
        self.assertEqual(masked["basis"], BASIS_MASKED)
        self.assertEqual(masked["evidenceQuality"], 0)
        for call in (vendor_profile(RANDOMIZED), vendor_profile(RANDOMIZED, observation_kind="ble")):
            with self.subTest(call=call["basis"]):
                self.assertEqual(call["basis"], BASIS_RANDOMIZED)
                self.assertEqual(call["evidenceQuality"], 10)
        # A multicast WiFi address is not host masking.
        self.assertEqual(vendor_profile(MULTICAST, observation_kind="wifi")["basis"], BASIS_RANDOMIZED)
        # A globally administered address is unaffected by the new parameter.
        self.assertEqual(
            vendor_profile(GLOBALLY_ADMINISTERED_APPLE, observation_kind="wifi")["vendor"],
            vendor_profile(GLOBALLY_ADMINISTERED_APPLE)["vendor"],
        )
