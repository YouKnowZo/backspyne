"""Curated, offline vendor identification for observed radio addresses.

Both datasets are small, hand-reviewed local subsets of the IEEE OUI registry
and the Bluetooth SIG company identifier list. They are deliberately
non-exhaustive: an address that is not present here is reported as
"Unknown vendor" instead of being guessed, and no address is ever sent to a
third-party lookup service.

Evidence quality describes the confidence in the *label only*. It says nothing
about the identity of a person, the exact product model, or the distance
between the observer and the radio.
"""

from __future__ import annotations

BASIS_OUI = "hardware address prefix (local OUI match)"
BASIS_BLE = "BLE manufacturer company code"
BASIS_RANDOMIZED = "unavailable: address is randomized"
BASIS_NONE = "no manufacturer evidence reported"

UNKNOWN_VENDOR = "Unknown vendor"
UNCLASSIFIED = "Unclassified"

# Descriptive confidence tiers for a vendor label (0-100).
QUALITY_OUI = 85
QUALITY_BLE = 60
QUALITY_RANDOMIZED = 10
QUALITY_NONE = 5

# Reviewed local lookup only. Addresses are never sent to a third-party service.
# Keys are the first three octets of a globally administered address (6 hex
# characters, uppercase, no separators).
_OUI_ASSIGNMENTS: dict[str, tuple[str, ...]] = {
    "Parallels, Inc.": (
        "001C42",
    ),
    "Apple, Inc.": (
        "000393", "000A27", "000A95", "001B63", "001EC2", "001FF3",
        "0021E9", "002241", "002312", "002332", "00236C", "0023DF",
        "002500", "00254B", "0025BC", "002608", "00264A", "0026B0",
        "0026BB", "003065", "003EE1", "0050E4", "0056CD", "006171",
        "008865", "00B362", "00C610", "00CDFE", "00DB70", "00F4B9",
        "00F76F", "040CCE", "041552", "041E64", "042665", "04489A",
        "0452F3", "045453", "0469F8", "04D3CF", "04DB56", "04E536",
        "04F13E", "04F7E4", "086698", "0C3021", "0C3E9F", "0C4DE9",
        "0C771A", "0CBC9F", "101C0C", "1040F3", "1093E9", "109ADD",
        "14109F", "145A05", "147DDA", "1499E2", "182032", "183451",
        "186590", "189EFC", "18AF61", "18AF8F", "18E7F4", "1C1AC0",
        "1C36BB", "1C5CF2", "1C9E46", "1CABA7", "2078F0", "207D74",
        "20A2E4", "20C9D0", "241EEB", "24A074", "24A2E1", "24AB81",
        "24E314", "24F094", "24F677", "280B5C", "283737", "286AB8",
        "286ABA", "28CFDA", "28CFE9", "28E02C", "28E14C", "28E7CF",
        "28ED6A", "28F076", "2C200B", "2C3361", "2CB43A", "2CF0A2",
        "2CF0EE", "44D884", "D8BB2C",
    ),
    "Google LLC": (
        "001A11", "20DFB9", "3C286D", "3C5A37", "48D6D5", "546009",
        "641666", "6CADF8", "94EB2C", "A47733", "CC3A61", "D86C63",
        "E4F042", "F4F5D8", "F4F5E8", "F88FCA",
    ),
    "Amazon Technologies, Inc.": (
        "0C47C9", "34D270", "38F73D", "40B4CD", "44650D", "50DCE7",
        "6837E9", "6854FD", "747548", "78E103", "84D6D0", "8871E5",
        "A002DC", "AC63BE", "B47C9C", "F0272D", "F08173",
    ),
    "Samsung Electronics": (
        "0000F0", "0012FB", "0015B9", "001632", "0017D5", "001DF6",
        "001E7D", "0021D1", "002339", "002454", "08373D", "0C715D",
        "1077B1", "14568E", "1C5A3E", "1C66AA", "2013E0", "244B03",
        "2C4401", "34145F", "34AA8B", "380A94", "38AA3C", "4C3C16",
        "5001BB", "5492BE", "5C0A5B", "6C2F2C", "7C0BC6", "8425DB",
        "88ADD2", "8C71F8", "90186F", "F0D2F1",
    ),
    "Espressif Inc.": (
        "240AC4", "30AEA4", "3C71BF", "5CCF7F", "600194", "68C63A",
        "7C9EBD", "80646F", "840D8E", "84CCA8", "8CAAB5", "90380C",
        "A4CF12", "AC67B2", "B4E62D", "BCDDC2", "C44F33", "CC50E3",
        "D8A01D", "D8F15B", "DC4F22", "ECFABC", "F4CFA2",
    ),
    "TP-Link Technologies": (
        "001D0F", "002127", "0023CD", "1027F5", "14CC20", "18A6F7",
        "1C61B4", "30B5C2", "3460F9", "3C846A", "50C7BF", "54C80F",
        "6032B1", "645601", "6466B3", "68FF7B", "6C5AB0", "74DA88",
        "788CB5", "8416F9", "909A4A", "98DAC4", "A42BB0", "AC84C6",
        "B04E26", "B09575", "C006C3", "C025E9", "C4E984", "CC32E5",
        "D807B6", "D80D17", "EC086B", "F4EC38", "F81A67",
    ),
    "Intel Corporate": (
        "001517", "001676", "0018DE", "0019D1", "001B21", "001B77",
        "001E67", "00216A", "00216B", "002314", "0024D6", "0024D7",
        "002710", "3413E8", "3CA9F4", "448500", "4851B7", "5CE0C5",
        "6805CA", "7C5CF8", "8086F2", "94659C", "9CB6D0", "A0369F",
        "A434D9", "B46BFC", "C85B76", "CC2F71", "D8FC93", "E4A471",
        "F48C50", "FCF8AE",
    ),
    "Raspberry Pi Foundation": (
        "ACDE48", "B827EB", "28CDC1", "2CCF67", "D83ADD", "DCA632",
        "E45F01",
    ),
    "Cisco Systems, Inc.": (
        "00000C", "001AA1", "001B0C", "001C0E", "001D45", "001E13",
        "001E14", "001E49", "001EBD", "002155", "0021A0", "00220C",
        "002255", "002290", "0022BD", "002304", "00235E", "0023AB",
        "0023EB", "002413", "002414", "002497", "0024C4", "0024F7",
        "002545", "002584", "0025B4", "00260A", "002651", "002699",
        "0026CA", "0026CB", "04DAD2", "1CDF0F", "2C3F38", "2C542D",
        "34A84E", "3C0E23", "4403A7", "4C4E35", "58BC27", "5C5015",
        "6400F1", "6899CD", "6C416A", "70DB98", "74A02F", "7C69F6",
        "84B261", "887556", "8C604F", "A03D6F", "A46C2A", "A80C0D",
        "AC7E8A", "B000B4", "B07D47", "B4A4E3", "BC16F5", "C067AF",
        "C4143C", "C80084", "CCEF48", "D0574C", "D0C789", "D4AD71",
        "DCA5F4", "E05FB9", "E4C722", "E8B748", "EC4476", "F02929",
        "F4ACC1", "F866F2",
    ),
    "Cisco-Linksys LLC": (
        "000C41", "001310", "0014BF", "001839", "001A70", "001C10",
        "001D7E", "001EE5", "00226B", "002369",
    ),
    "Netgear, Inc.": (
        "00095B", "000FB5", "00146C", "00184D", "001B2F", "001E2A",
        "001F33", "00223F", "0024B2", "0026F2", "0836C9", "100D7F",
        "204E7F", "28C68E", "2C3033", "30469A", "3C3786", "4494FC",
        "4C60DE", "6CB0CE", "841B5E", "9C3DCF", "A00460", "A040A0",
        "B03956", "B07FB9", "C03F0E", "C40415", "C43DC7", "E0469A",
        "E8FCAF",
    ),
    "Ubiquiti Inc.": (
        "00156D", "002722", "0418D6", "18E829", "24A43C", "44D9E7",
        "687251", "68D79A", "7483C2", "74ACB9", "788A20", "802AA8",
        "9C05D6", "AC8BA9", "B4FBE4", "D021F9", "DC9FDB", "E063DA",
        "F09FC2", "FCECDA",
    ),
    "Aruba Networks (HPE)": (
        "000B86", "001A1E", "00246C", "04BD88", "186472", "6CF37F",
        "84D47E", "94B40F", "9C1C12", "ACA31E", "B45D50", "BC9FE4",
        "D8C7C8", "F05C19",
    ),
    "Hewlett Packard Enterprise": (
        "001F29", "3CD92B", "9457A5", "9CB654", "B05ADA", "D0BF9C",
    ),
    "Cisco Meraki": (
        "00180A", "3456FE", "881544", "E0553D",
    ),
    "Ruckus Wireless (CommScope)": (
        "001392", "001D2E", "24C9A1", "2C5D93", "50A733", "589396",
        "6CAAB3", "74911A", "C08ADE",
    ),
    "Huawei Technologies": (
        "00E0FC", "0C37DC", "104780", "283CE4", "480031", "5C7D5E",
        "70723C", "781DBA", "84A8E4", "8C34FD", "90671C", "AC4E91",
        "C07009", "C8D15E", "D07AB5", "E0247F", "F4559C", "FC48EF",
    ),
    "Xiaomi Communications": (
        "009EC8", "04CF8C", "102AB3", "185936", "2034FB", "286C07",
        "34CE00", "3CBDD8", "508F4C", "640980", "64B473", "742344",
        "7811DC", "8CBEBE", "98FAE3", "A4DA22", "ACC1EE", "B0E235",
        "C40BCB", "D4970B", "E4AAEC", "F0B429", "F48B32", "FC64BA",
    ),
    "Sonos, Inc.": (
        "000E58", "347E5C", "48A6B8", "542A1B", "5CAAFD", "7828CA",
        "949F3E", "B8E937",
    ),
    "Roku, Inc.": (
        "000D4B", "080581", "20EFBD", "2C54CF", "88DEA9", "AC3A7A",
        "B0A737", "B83E59", "C83A6B", "CC6DA0", "D04D2C", "D83134",
        "DC3A5E",
    ),
    "Texas Instruments": (
        "00124B", "001831", "001AB6", "2CAB33", "34B1F7", "50F14A",
        "68C90B", "78A504", "A0E6F8", "B4994C", "C4BE84", "D03972",
        "D494A1", "E0E5CF",
    ),
    "Silicon Laboratories": (
        "000B57", "588E81", "60A423",
    ),
    "Broadcom": (
        "001018", "001BE9",
    ),
    "Qualcomm": (
        "00037F", "001374", "00A0C6",
    ),
    "Realtek Semiconductor": (
        "00E04C",
    ),
    "MediaTek": (
        "000CE7",
    ),
    "Microchip Technology": (
        "0004A3", "001EC0",
    ),
    "MikroTik": (
        "000C42", "18FD74", "488F5A", "64D154", "6C3B6B", "744D28",
        "789A18",
    ),
    "Juniper Networks": (
        "000585", "001BC0", "2C6BF5", "3C6104", "5C5EAB", "7819F7",
        "841888", "84B59C",
    ),
    "Fortinet, Inc.": (
        "00090F", "085B0E", "0C9F71", "704CA5", "906CAC",
    ),
    "Extreme Networks": (
        "000130", "000496", "5C0E8B",
    ),
    "AVM GmbH (FRITZ!)": (
        "00040E", "0896D7",
    ),
    "D-Link Corporation": (
        "00055D", "000D88", "000F3D", "001195", "001346", "0015E9",
        "00179A", "00195B", "001B11", "001CF0", "001E58", "002191",
        "0022B0", "002401", "00265A", "14D64D", "1C7EE5", "340804",
        "5CD998", "78542E", "84C9B2",
    ),
    "Zyxel Communications": (
        "001349", "0019CB", "0023F8", "00A0C5",
    ),
    "Belkin International": (
        "08863B", "94103E", "B4750E", "EC1A59",
    ),
    "Sony Corporation": (
        "0013A9", "001A80", "001DBA", "0024BE", "080046", "30F9ED",
        "544249", "78843C", "AC9B0A", "FC0FE6",
    ),
    "LG Electronics": (
        "001C62", "001E75", "002483", "88366C",
    ),
    "Microsoft Corporation": (
        "000D3A", "00125A", "0017FA", "001DD8", "002248", "0050F2",
        "281878", "3C8375", "485073", "5882A8", "6045BD", "7C1E52",
        "C049EF", "C83F26",
    ),
    "Nintendo Co., Ltd.": (
        "0009BF", "001656", "0017AB", "00191D", "001AE9", "001B7A",
        "001BEA", "001CBE", "001E35", "001F32",
    ),
    "Tesla, Inc.": (
        "4CFCAA", "98ED5C",
    ),
    "Wyze Labs": (
        "2CAA8E", "7C78B2",
    ),
    "Philips Lighting (Signify)": (
        "001788", "ECB5FA",
    ),
    "LIFX": (
        "D073D5",
    ),
    "Nest Labs": (
        "18B430",
    ),
    "Bose Corporation": (
        "0452C7", "2C41A1", "38184C", "4C875D", "9809CF",
    ),
    "Polycom, Inc.": (
        "0004F2",
    ),
    "Yealink Network Technology": (
        "001565", "805EC0",
    ),
    "Grandstream Networks": (
        "000B82",
    ),
    "Avaya Inc.": (
        "00040D", "001B4F",
    ),
    "Mitel Networks": (
        "08000F",
    ),
    "Brother Industries": (
        "008077",
    ),
    "Canon Inc.": (
        "000085", "001E8F",
    ),
    "Seiko Epson Corporation": (
        "000048",
    ),
    "ecobee Inc.": (
        "446132",
    ),
    "Pegatron Corporation": (
        "001BFC",
    ),
}

OUI_PREFIXES: dict[str, str] = {
    prefix: vendor
    for vendor, prefixes in _OUI_ASSIGNMENTS.items()
    for prefix in prefixes
}

# Bluetooth SIG Company Identifiers present in manufacturer-specific data.
# This identifies the advertiser's declared company code, not its exact model.
# Only identifiers whose numeric value could be confirmed are listed; an
# unrecognised company code is reported as unknown rather than guessed.
BLE_COMPANIES = {
    0x0000: "Ericsson Technology Licensing",
    0x0001: "Nokia Mobile Phones",
    0x0002: "Intel",
    0x0003: "IBM",
    0x0004: "Toshiba",
    0x0006: "Microsoft",
    0x0007: "Lucent Technologies",
    0x0008: "Motorola",
    0x0009: "Infineon Technologies",
    0x000A: "Qualcomm (formerly Cambridge Silicon Radio)",
    0x000B: "Silicon Wave",
    0x000C: "Digianswer A/S",
    0x000D: "Texas Instruments",
    0x000E: "Parthus Technologies",
    0x000F: "Broadcom",
    0x0010: "Mitsubishi Electric",
    0x0011: "Sun Microsystems",
    0x0013: "Atmel",
    0x004C: "Apple",
    0x0059: "Nordic Semiconductor",
    0x0075: "Samsung Electronics",
    0x0087: "Garmin International",
    0x00E0: "Google",
    0x0171: "Amazon.com Services",
    0x027D: "Tile",
    0x0499: "Ruuvi Innovations",
}

# Category labels are descriptive groupings for an operator, not a product
# classification. Anything unmatched stays "Unclassified".
VENDOR_CATEGORIES: dict[str, str] = {
    "Parallels, Inc.": "Software / virtualization",
    "Apple, Inc.": "Computing / mobile hardware",
    "Apple": "Computing / mobile hardware",
    "Google LLC": "Smart home / consumer hardware",
    "Google": "Smart home / consumer hardware",
    "Amazon Technologies, Inc.": "Smart home / cloud hardware",
    "Amazon.com Services": "Smart home / cloud hardware",
    "Samsung Electronics": "Consumer electronics / mobile",
    "Espressif Inc.": "IoT / embedded radio",
    "TP-Link Technologies": "Network infrastructure",
    "Intel Corporate": "Chipset / computing hardware",
    "Intel": "Chipset / computing hardware",
    "Raspberry Pi Foundation": "Single-board computer",
    "Cisco Systems, Inc.": "Network infrastructure",
    "Cisco-Linksys LLC": "Network infrastructure",
    "Netgear, Inc.": "Network infrastructure",
    "Ubiquiti Inc.": "Network infrastructure",
    "Aruba Networks (HPE)": "Network infrastructure",
    "Hewlett Packard Enterprise": "Network infrastructure / servers",
    "Cisco Meraki": "Network infrastructure / cloud managed",
    "Ruckus Wireless (CommScope)": "Network infrastructure",
    "Huawei Technologies": "Network infrastructure / mobile",
    "Xiaomi Communications": "Consumer electronics / mobile",
    "Sonos, Inc.": "Audio / media",
    "Roku, Inc.": "Streaming media",
    "Texas Instruments": "Chipset vendor",
    "Silicon Laboratories": "Chipset vendor",
    "Broadcom": "Chipset vendor",
    "Qualcomm": "Chipset vendor",
    "Qualcomm (formerly Cambridge Silicon Radio)": "Chipset vendor",
    "Realtek Semiconductor": "Chipset vendor",
    "MediaTek": "Chipset vendor",
    "Microchip Technology": "Chipset vendor",
    "Nordic Semiconductor": "Chipset vendor",
    "Infineon Technologies": "Chipset vendor",
    "Silicon Wave": "Chipset vendor",
    "Atmel": "Chipset vendor",
    "MikroTik": "Network infrastructure",
    "Juniper Networks": "Network infrastructure",
    "Fortinet, Inc.": "Security appliance",
    "Extreme Networks": "Network infrastructure",
    "AVM GmbH (FRITZ!)": "Network infrastructure / consumer",
    "D-Link Corporation": "Network infrastructure",
    "Zyxel Communications": "Network infrastructure",
    "Belkin International": "Network infrastructure / accessories",
    "Sony Corporation": "Consumer electronics",
    "LG Electronics": "Consumer electronics",
    "Microsoft Corporation": "Computing hardware / software",
    "Microsoft": "Computing hardware / software",
    "Nintendo Co., Ltd.": "Gaming",
    "Tesla, Inc.": "Automotive",
    "Wyze Labs": "Smart home / cameras",
    "Philips Lighting (Signify)": "Smart home / lighting",
    "LIFX": "Smart home / lighting",
    "Nest Labs": "Smart home",
    "ecobee Inc.": "Smart home / thermostats",
    "Bose Corporation": "Audio / media",
    "Polycom, Inc.": "Voice / conferencing hardware",
    "Yealink Network Technology": "Voice / conferencing hardware",
    "Grandstream Networks": "Voice / conferencing hardware",
    "Avaya Inc.": "Voice / conferencing hardware",
    "Mitel Networks": "Voice / conferencing hardware",
    "Brother Industries": "Imaging / printing",
    "Canon Inc.": "Imaging / printing",
    "Seiko Epson Corporation": "Imaging / printing",
    "Pegatron Corporation": "Contract manufacturer (ODM)",
    "Ericsson Technology Licensing": "Telecom equipment",
    "Nokia Mobile Phones": "Mobile device",
    "IBM": "Computing hardware / software",
    "Toshiba": "Consumer electronics",
    "Lucent Technologies": "Telecom equipment",
    "Motorola": "Telecom equipment",
    "Digianswer A/S": "Chipset vendor",
    "Parthus Technologies": "Chipset vendor",
    "Mitsubishi Electric": "Industrial / electronics",
    "Sun Microsystems": "Computing hardware / software",
    "Garmin International": "Wearables / navigation",
    "Tile": "Wearables / accessories",
    "Ruuvi Innovations": "IoT / embedded radio",
}

# Self-reported name hints. Many access points and accessories embed their brand in
# the SSID or advertised BLE name, which is useful context when the address prefix is
# not in the local table. This is a hint only: the name is chosen by the device owner,
# so it is never reported as the resolved vendor and never raises evidence quality.
_NAME_HINTS: tuple[tuple[str, str], ...] = (
    ("tp-link", "TP-Link Technologies"),
    ("tplink", "TP-Link Technologies"),
    ("netgear", "Netgear, Inc."),
    ("fritz!box", "AVM GmbH (FRITZ!)"),
    ("fritzbox", "AVM GmbH (FRITZ!)"),
    ("ubiquiti", "Ubiquiti Inc."),
    ("unifi", "Ubiquiti Inc."),
    ("mikrotik", "MikroTik"),
    ("ruckus", "Ruckus Wireless (CommScope)"),
    ("aruba", "Aruba Networks (HPE)"),
    ("meraki", "Cisco Meraki"),
    ("cisco", "Cisco Systems, Inc."),
    ("linksys", "Cisco-Linksys LLC"),
    ("dlink", "D-Link Corporation"),
    ("d-link", "D-Link Corporation"),
    ("zyxel", "Zyxel Communications"),
    ("tenda", "Tenda Technology"),
    ("belkin", "Belkin International"),
    ("eero", "Amazon Technologies, Inc."),
    ("nest", "Nest Labs"),
    ("ring-", "Ring (Amazon Technologies, Inc.)"),
    ("starlink", "Space Exploration Technologies"),
    ("xfinity", "Comcast (Xfinity)"),
    ("spectrum", "Charter Communications (Spectrum)"),
    ("vodafone", "Vodafone Group"),
    ("asus", "ASUSTeK Computer"),
    ("sonos", "Sonos, Inc."),
    ("roku", "Roku, Inc."),
    ("chromecast", "Google LLC"),
    ("googlehome", "Google LLC"),
    ("shelly", "Allterco Robotics (Shelly)"),
    ("sonoff", "ITEAD Intelligent Systems (Sonoff)"),
    ("smartlife", "Tuya Smart"),
    ("tuya", "Tuya Smart"),
    ("wyze", "Wyze Labs"),
    ("hue", "Philips Lighting (Signify)"),
    ("lifx", "LIFX"),
    ("ecobee", "ecobee Inc."),
    ("tesla", "Tesla, Inc."),
    ("raspberrypi", "Raspberry Pi Foundation"),
    ("printer", "Imaging / printing device (name hint only)"),
    ("hp-", "HP Inc."),
    ("brother", "Brother Industries"),
    ("epson", "Seiko Epson Corporation"),
    ("canon", "Canon Inc."),
)

# Fallback keyword groupings, used only if an exact category is missing.
_CATEGORY_HINTS: tuple[tuple[str, str], ...] = (
    ("chipset", "Chipset vendor"),
    ("semiconductor", "Chipset vendor"),
    ("laboratories", "Chipset vendor"),
    ("technologies", "Technology vendor"),
    ("networks", "Network infrastructure"),
    ("network", "Network infrastructure"),
    ("communications", "Network infrastructure"),
    ("systems", "Network infrastructure"),
    ("electronics", "Consumer electronics"),
    ("microsystems", "Computing hardware / software"),
    ("corporation", "Unclassified vendor"),
    ("inc.", "Unclassified vendor"),
    ("ltd.", "Unclassified vendor"),
    ("llc", "Unclassified vendor"),
)


def _prefix(address: str | None) -> str:
    if not address:
        return ""
    return "".join(character for character in address.upper() if character.isalnum())[:6]


def address_kind(address: str | None) -> str:
    if not address:
        return "unknown address type"
    octet = address.split(":", 1)[0].split("-", 1)[0]
    try:
        first = int(octet, 16)
    except ValueError:
        return "unknown address type"
    if first & 0x01:
        return "multicast address"
    if first & 0x02:
        return "private/randomized address"
    return "globally administered address"


def vendor_for(address: str | None) -> str:
    if not address or address_kind(address) != "globally administered address":
        return UNKNOWN_VENDOR
    return OUI_PREFIXES.get(_prefix(address), UNKNOWN_VENDOR)


def ble_manufacturer_for(manufacturer_data: dict[int, bytes] | None) -> str | None:
    if not manufacturer_data:
        return None
    known = sorted(
        {BLE_COMPANIES[company_id] for company_id in manufacturer_data if company_id in BLE_COMPANIES}
    )
    return known[0] if known else None


def vendor_category(vendor: str) -> str:
    if not vendor or vendor == UNKNOWN_VENDOR:
        return UNCLASSIFIED
    if vendor in VENDOR_CATEGORIES:
        return VENDOR_CATEGORIES[vendor]
    lowered = vendor.lower()
    for hint, category in _CATEGORY_HINTS:
        if hint in lowered:
            return category
    return UNCLASSIFIED


def vendor_hint_from_name(name: str | None) -> str | None:
    """Brand hint taken from a self-reported SSID or advertised name.

    This never identifies a device: the name is chosen by whoever configured the
    radio. It is reported separately from the resolved vendor so an operator can tell
    a reviewed address-prefix match apart from a name that merely looks familiar.
    """
    if not name or not isinstance(name, str):
        return None
    lowered = name.strip().lower()
    if not lowered:
        return None
    for token, vendor in _NAME_HINTS:
        if token in lowered:
            return vendor
    return None


def vendor_profile(
    address: str | None,
    manufacturer_data: dict[int, bytes] | None = None,
) -> dict[str, object]:
    """Describe the vendor evidence available for one observed radio.

    A globally administered address with a reviewed prefix is the strongest
    evidence available locally. A declared BLE company code is a weaker hint,
    and a randomized address cannot be attributed at all.
    """
    kind = address_kind(address)
    if kind == "globally administered address":
        prefix = _prefix(address)
        vendor = OUI_PREFIXES.get(prefix)
        if vendor:
            return {
                "vendor": vendor,
                "category": vendor_category(vendor),
                "ouiPrefix": prefix,
                "basis": BASIS_OUI,
                "evidenceQuality": QUALITY_OUI,
            }
    company = ble_manufacturer_for(manufacturer_data)
    if company:
        return {
            "vendor": company,
            "category": vendor_category(company),
            "ouiPrefix": None,
            "basis": BASIS_BLE,
            "evidenceQuality": QUALITY_BLE,
        }
    if kind in ("private/randomized address", "multicast address"):
        return {
            "vendor": UNKNOWN_VENDOR,
            "category": UNCLASSIFIED,
            "ouiPrefix": None,
            "basis": BASIS_RANDOMIZED,
            "evidenceQuality": QUALITY_RANDOMIZED,
        }
    return {
        "vendor": UNKNOWN_VENDOR,
        "category": UNCLASSIFIED,
        "ouiPrefix": None,
        "basis": BASIS_NONE,
        "evidenceQuality": QUALITY_NONE,
    }