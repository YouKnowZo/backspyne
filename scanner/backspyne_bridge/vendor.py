from __future__ import annotations

# A deliberately small local OUI seed. The bridge never sends a raw address
# to a third-party lookup service; deployments can extend this map from a
# reviewed local OUI file.
OUI_PREFIXES = {
    "001C42": "Parallels, Inc.",
    "3C5A37": "Google LLC",
    "44D884": "Espressif Inc.",
    "ACDE48": "Raspberry Pi Foundation",
    "B827EB": "Raspberry Pi Foundation",
    "D8BB2C": "Apple, Inc.",
    "F0D2F1": "Samsung Electronics",
}


def vendor_for(address: str | None) -> str:
    if not address:
        return "Unknown vendor"
    prefix = "".join(character for character in address.upper() if character.isalnum())[:6]
    return OUI_PREFIXES.get(prefix, "Unknown vendor")