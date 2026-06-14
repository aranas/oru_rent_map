#!/usr/bin/env python3
"""
patch_geojson_properties.py
---------------------------
Merges address + agent from licence_address_lookup.json into
licence_locations.geojson, and removes licence_start / licence_end.

Run after build_address_lookup.py. No geocoding — completes in seconds.

Output: data/licence_locations.geojson (updated in-place)
"""

import json, os, sys

ROOT   = os.path.join(os.path.dirname(__file__), "..")
DATA   = os.path.join(ROOT, "data")
GJ     = os.path.join(DATA, "licence_locations.geojson")
LOOKUP = os.path.join(DATA, "licence_address_lookup.json")

for path in [GJ, LOOKUP]:
    if not os.path.exists(path):
        sys.exit(f"ERROR: file not found: {path}")

with open(GJ) as f:
    gj = json.load(f)

with open(LOOKUP) as f:
    lookup = json.load(f)

matched = missing = 0
for feat in gj["features"]:
    p   = feat["properties"]
    rid = p.get("id", "")
    meta = lookup.get(rid, {})

    p["address"] = meta.get("address", p.get("address", ""))
    p["agent"]   = meta.get("agent", "")

    # Drop fields not needed at runtime
    p.pop("licence_start", None)
    p.pop("licence_end",   None)

    if meta:
        matched += 1
    else:
        missing += 1

print(f"  {matched} features enriched, {missing} with no lookup entry")

with open(GJ, "w") as f:
    json.dump(gj, f, separators=(",", ":"))

size_kb = os.path.getsize(GJ) / 1024
print(f"  Written -> {GJ} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    pass
