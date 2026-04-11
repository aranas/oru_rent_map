#!/usr/bin/env python3
"""
generate_placeholder.py
=======================
Generates committed data files for the ORU HMO density map MVP:

  data/neighbourhoods.geojson     – Oxford LSOA boundary polygons with amenity_count
  data/amenities.geojson          – individual amenity point markers
  data/placeholder_amenities.csv  – per-neighbourhood amenity count (placeholder)

Intermediate files (gitignored):
  data/lsoa_raw.json              – raw ONS LSOA boundary response
  data/amenities_raw.json         – raw Overpass amenity node response

Requires: Python 3, requests, shapely.

Usage:
  python scripts/generate_placeholder.py
"""

import csv
import json
import os
import sys
import time
from collections import Counter

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install requests")

try:
    from shapely.geometry import shape, Point
except ImportError:
    sys.exit("Missing dependency: pip install shapely")

# Overpass endpoints: try direct mirrors first, then the load balancer.
OVERPASS_ENDPOINTS = [
    "https://z.overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

# ONS Open Geography Portal — LSOA 2021 boundaries (BFE V10, full polygon extent)
ONS_LSOA_URL = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BFE_V10/"
    "FeatureServer/0/query"
)

# Oxford city LSOAs all have names starting with "Oxford " (e.g. "Oxford 015A")
OXFORD_LSOA_NAME_PREFIX = "Oxford "

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
MAX_RETRIES = 3
RETRY_DELAY_SECS = 30


# ── Overpass query helper ──────────────────────────────────────────────────

AMENITIES_QUERY = """
[out:json][timeout:120];
node["amenity"](51.71,-1.33,51.80,-1.17);
out body;
"""


def query_overpass(query, label):
    """Try each Overpass endpoint with retries. Returns parsed JSON."""
    for attempt in range(1, MAX_RETRIES + 1):
        for endpoint in OVERPASS_ENDPOINTS:
            short_name = endpoint.split("//")[1].split("/")[0]
            print(f"  [{attempt}/{MAX_RETRIES}] {short_name} — {label}...")
            try:
                resp = requests.get(
                    endpoint, params={"data": query}, timeout=120
                )
                if resp.status_code == 200:
                    data = resp.json()
                    print(f"  -> {len(data.get('elements', []))} elements.")
                    return data
                print(f"  -> HTTP {resp.status_code}, trying next endpoint.")
            except requests.RequestException as exc:
                print(f"  -> {exc}, trying next endpoint.")

        if attempt < MAX_RETRIES:
            print(f"  All endpoints failed. Retrying in {RETRY_DELAY_SECS}s...")
            time.sleep(RETRY_DELAY_SECS)

    sys.exit(f"ERROR: Could not fetch {label} after {MAX_RETRIES} rounds.")


# ── ONS LSOA boundary helper ──────────────────────────────────────────────

def fetch_oxford_lsoas():
    """Fetch Oxford LSOA polygons from the ONS Open Geography Portal."""
    params = {
        "geometry": "-1.33,51.71,-1.17,51.80",
        "geometryType": "esriGeometryEnvelope",
        "spatialRel": "esriSpatialRelIntersects",
        "inSR": "4326",
        "outFields": "LSOA21CD,LSOA21NM",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": 200,
    }
    print("  Querying ONS Open Geography Portal for LSOAs...")
    resp = requests.get(ONS_LSOA_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    # Filter to Oxford city LSOAs only (names like "Oxford 015A")
    features = [
        f for f in data.get("features", [])
        if f["properties"].get("LSOA21NM", "").startswith(OXFORD_LSOA_NAME_PREFIX)
    ]
    print(f"  -> {len(features)} Oxford city LSOAs.")
    return {"type": "FeatureCollection", "features": features}


# ── Main pipeline ──────────────────────────────────────────────────────────

def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    # Step 1: Fetch Oxford LSOA boundaries
    print("[1/4] Fetching Oxford LSOA boundaries from ONS...")
    lsoa_geojson = fetch_oxford_lsoas()
    raw_lsoa_path = os.path.join(DATA_DIR, "lsoa_raw.json")
    with open(raw_lsoa_path, "w") as f:
        json.dump(lsoa_geojson, f)
    print(f"  Wrote {len(lsoa_geojson['features'])} LSOAs -> {raw_lsoa_path}")

    # Build shapely geometries for point-in-polygon assignment
    lsoa_shapes = []
    for feat in lsoa_geojson["features"]:
        geom = shape(feat["geometry"])
        name = feat["properties"]["LSOA21NM"]
        lsoa_shapes.append((name, geom))

    time.sleep(2)

    # Step 2: Fetch amenity nodes from Overpass
    print("[2/4] Fetching amenity nodes from Overpass...")
    amenities_data = query_overpass(AMENITIES_QUERY, "amenities")
    amenities_path = os.path.join(DATA_DIR, "amenities_raw.json")
    with open(amenities_path, "w") as f:
        json.dump(amenities_data, f)
    print(f"  Wrote {len(amenities_data['elements'])} nodes -> {amenities_path}")

    # Step 3: Assign amenities to LSOAs, build point GeoJSON
    print("[3/4] Assigning amenities to LSOAs...")
    lsoa_counts = Counter()
    amenity_features = []

    for node in amenities_data.get("elements", []):
        pt = Point(node["lon"], node["lat"])
        for lsoa_name, lsoa_geom in lsoa_shapes:
            if lsoa_geom.contains(pt):
                lsoa_counts[lsoa_name] += 1
                tags = node.get("tags", {})
                amenity_features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [node["lon"], node["lat"]],
                    },
                    "properties": {
                        "name": tags.get("name", ""),
                        "amenity": tags.get("amenity", ""),
                        "lsoa": lsoa_name,
                    },
                })
                break

    print(f"  {len(amenity_features)} amenities assigned to Oxford LSOAs.")
    for lsoa, count in sorted(lsoa_counts.items(), key=lambda x: -x[1]):
        print(f"    {lsoa:35s} {count}")

    # Step 4: Write output files
    print("[4/4] Writing output files...")

    # 4a. Neighbourhoods GeoJSON (with amenity_count property)
    for feat in lsoa_geojson["features"]:
        name = feat["properties"]["LSOA21NM"]
        feat["properties"]["amenity_count"] = lsoa_counts.get(name, 0)

    hoods_path = os.path.join(DATA_DIR, "neighbourhoods.geojson")
    with open(hoods_path, "w") as f:
        json.dump(lsoa_geojson, f)
    size_kb = os.path.getsize(hoods_path) / 1024
    print(f"  {hoods_path} ({size_kb:.0f} KB)")

    # 4b. Amenities GeoJSON (point markers)
    amenities_out = {"type": "FeatureCollection", "features": amenity_features}
    amenities_out_path = os.path.join(DATA_DIR, "amenities.geojson")
    with open(amenities_out_path, "w") as f:
        json.dump(amenities_out, f)
    size_kb = os.path.getsize(amenities_out_path) / 1024
    print(f"  {amenities_out_path} ({size_kb:.0f} KB)")

    # 4c. Placeholder CSV (per-neighbourhood)
    csv_path = os.path.join(DATA_DIR, "placeholder_amenities.csv")
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["neighbourhood", "value", "value_label"])
        for feat in lsoa_geojson["features"]:
            name = feat["properties"]["LSOA21NM"]
            count = lsoa_counts.get(name, 0)
            writer.writerow([name, count, "OSM amenity count (placeholder)"])
    print(f"  {csv_path}")

    print("\nDone.")


if __name__ == "__main__":
    main()
