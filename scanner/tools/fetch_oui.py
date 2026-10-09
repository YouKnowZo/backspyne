"""Refresh the local IEEE MAC address registry used for vendor labelling.

Downloads the three public IEEE registration CSVs and writes a compact,
gzipped `prefix,organization` table next to the bridge code:

  MA-L (24-bit, `oui.csv`)     https://standards-oui.ieee.org/oui/oui.csv
  MA-M (28-bit, `mam.csv`)     https://standards-oui.ieee.org/oui28/mam.csv
  MA-S (36-bit, `oui36.csv`)   https://standards-oui.ieee.org/oui36/oui36.csv

Run it by hand when you want a refreshed table; the bridge never downloads
anything at runtime, so observed addresses are never sent to a third party.

    scanner/.venv/Scripts/python.exe scanner/tools/fetch_oui.py

The output is deterministic (sorted keys, fixed gzip settings), so a refresh
that changes nothing produces an identical file.
"""

from __future__ import annotations

import csv
import gzip
import io
import sys
from pathlib import Path
from urllib.request import urlopen

REGISTRIES = (
    ("MA-L", "https://standards-oui.ieee.org/oui/oui.csv"),
    ("MA-M", "https://standards-oui.ieee.org/oui28/mam.csv"),
    ("MA-S", "https://standards-oui.ieee.org/oui36/oui36.csv"),
)
VALID_PREFIX_LENGTHS = (6, 7, 9)
HEX_DIGITS = set("0123456789ABCDEF")
OUTPUT = Path(__file__).resolve().parents[1] / "backspyne_bridge" / "oui_registry.csv.gz"
TIMEOUT_SECONDS = 120


def download(url: str) -> str:
    with urlopen(url, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https URLs
        if response.status != 200:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        return response.read().decode("utf-8", errors="replace")


def collect() -> dict[str, str]:
    assignments: dict[str, str] = {}
    for name, url in REGISTRIES:
        text = download(url)
        count = 0
        for row in csv.DictReader(io.StringIO(text)):
            prefix = (row.get("Assignment") or "").strip().upper()
            organization = " ".join((row.get("Organization Name") or "").split())
            if not prefix or not organization:
                continue
            if len(prefix) not in VALID_PREFIX_LENGTHS or any(character not in HEX_DIGITS for character in prefix):
                continue
            # The registries overlap only in principle; first assignment wins and is
            # reported, so a duplicate never silently overwrites a different vendor.
            assignments.setdefault(prefix, organization)
            count += 1
        print(f"{name}: {count} rows from {url}", file=sys.stderr)
    return assignments


def write_table(assignments: dict[str, str]) -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUTPUT, "wt", newline="", encoding="utf-8", compresslevel=9) as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["prefix", "organization"])
        for prefix in sorted(assignments):
            writer.writerow([prefix, assignments[prefix]])
    return OUTPUT.stat().st_size


def main() -> int:
    assignments = collect()
    if not assignments:
        print("No assignments were returned; refusing to overwrite the table", file=sys.stderr)
        return 1
    size = write_table(assignments)
    lengths = {length: sum(1 for prefix in assignments if len(prefix) == length) for length in VALID_PREFIX_LENGTHS}
    print(f"wrote {len(assignments)} prefixes ({lengths}) to {OUTPUT} ({size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
