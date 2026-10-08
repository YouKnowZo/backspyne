from __future__ import annotations

# Reviewed local lookup only. Addresses are never sent to a third-party service.
OUI_PREFIXES = {
    "001C42": "Parallels, Inc.",
    "3C5A37": "Google LLC",
    "44D884": "Espressif Inc.",
    "ACDE48": "Raspberry Pi Foundation",
    "B827EB": "Raspberry Pi Foundation",
    "D8BB2C": "Apple, Inc.",
    "F0D2F1": "Samsung Electronics",
}

# Bluetooth SIG Company Identifiers present in manufacturer-specific data.
# This identifies the advertiser's declared company code, not its exact model.
BLE_COMPANIES = {
    0x0006: "Microsoft",
    0x000D: "Texas Instruments",
    0x004C: "Apple",
    0x0059: "Nordic Semiconductor",
    0x0075: "Samsung Electronics",
    0x00E0: "Google",
}


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
        return "Unknown vendor"
    prefix = "".join(character for character in address.upper() if character.isalnum())[:6]
    return OUI_PREFIXES.get(prefix, "Unknown vendor")


def ble_manufacturer_for(manufacturer_data: dict[int, bytes] | None) -> str | None:
    if not manufacturer_data:
        return None
    return next(
        (BLE_COMPANIES[company_id] for company_id in manufacturer_data if company_id in BLE_COMPANIES),
        None,
    )