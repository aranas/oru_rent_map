#!/usr/bin/env python3
"""
generate_building_data.py
=========================
Generates two static reference files used by the in-browser HMO CSV upload:

  data/oxford_buildings.geojson  – building footprint polygons with address tags
  data/postcode_lsoa.csv         – postcode -> LSOA + centroid mapping

Prerequisite: data/neighbourhoods.geojson must already exist
              (run generate_placeholder.py first).

Intermediate files (gitignored):
  data/buildings_raw.json        – raw Overpass response

Requires: Python 3, requests, shapely.

Usage:
  python scripts/generate_building_data.py
"""

import csv
import json
import os
import re
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install requests")

try:
    from shapely.geometry import shape, Point, Polygon
except ImportError:
    sys.exit("Missing dependency: pip install shapely")

OVERPASS_ENDPOINTS = [
    "https://z.overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
MAX_RETRIES = 3
RETRY_DELAY_SECS = 30

BUILDINGS_QUERY = """
[out:json][timeout:180];
way["building"]["addr:housenumber"]["addr:street"](51.71,-1.33,51.80,-1.17);
out body geom;
"""


def normalise_name(s):
    """Lowercase, strip punctuation, collapse whitespace."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", "", s)
    return " ".join(s.split())


def query_overpass(query, label):
    """Try each Overpass endpoint with retries. Returns parsed JSON."""
    for attempt in range(1, MAX_RETRIES + 1):
        for endpoint in OVERPASS_ENDPOINTS:
            short_name = endpoint.split("//")[1].split("/")[0]
            print(f"  [{attempt}/{MAX_RETRIES}] {short_name} — {label}...")
            try:
                resp = requests.get(
                    endpoint, params={"data": query}, timeout=180
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


def truncate_coord(val, decimals=6):
    return round(val, decimals)


def overpass_way_to_geojson_feature(way):
    """Convert an Overpass way (with inline geometry) to a GeoJSON Feature."""
    geom_nodes = way.get("geometry", [])
    if len(geom_nodes) < 3:
        return None

    coords = [
        [truncate_coord(n["lon"]), truncate_coord(n["lat"])]
        for n in geom_nodes
    ]
    if coords[0] != coords[-1]:
        coords.append(coords[0])

    tags = way.get("tags", {})
    housenumber = tags.get("addr:housenumber", "")
    street = tags.get("addr:street", "")
    postcode = tags.get("addr:postcode", "")
    match_key = normalise_name(f"{housenumber} {street}")

    poly = Polygon([(c[0], c[1]) for c in coords])
    centroid = poly.centroid

    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [coords]},
        "properties": {
            "addr_housenumber": housenumber,
            "addr_street": street,
            "addr_postcode": postcode,
            "match_key": match_key,
            "centroid_lat": truncate_coord(centroid.y),
            "centroid_lon": truncate_coord(centroid.x),
        },
    }


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    hoods_path = os.path.join(DATA_DIR, "neighbourhoods.geojson")
    if not os.path.exists(hoods_path):
        sys.exit(
            f"ERROR: {hoods_path} not found.\n"
            "Run generate_placeholder.py first to create LSOA boundaries."
        )

    # Step 1: Fetch buildings from Overpass
    print("[1/3] Fetching addressed buildings from Overpass...")
    raw_data = query_overpass(BUILDINGS_QUERY, "addressed buildings")
    raw_path = os.path.join(DATA_DIR, "buildings_raw.json")
    with open(raw_path, "w") as f:
        json.dump(raw_data, f)
    print(f"  Wrote raw response -> {raw_path}")

    # Step 2: Convert to GeoJSON
    print("[2/3] Converting to GeoJSON...")
    features = []
    for el in raw_data.get("elements", []):
        if el.get("type") != "way":
            continue
        feat = overpass_way_to_geojson_feature(el)
        if feat:
            features.append(feat)

    buildings_geojson = {"type": "FeatureCollection", "features": features}
    buildings_path = os.path.join(DATA_DIR, "oxford_buildings.geojson")
    with open(buildings_path, "w") as f:
        json.dump(buildings_geojson, f)
    size_kb = os.path.getsize(buildings_path) / 1024
    print(f"  {len(features)} building footprints -> {buildings_path} ({size_kb:.0f} KB)")

    # Step 3: Generate postcode-to-LSOA mapping
    print("[3/3] Generating postcode-to-LSOA mapping...")

    with open(hoods_path) as f:
        hoods_geojson = json.load(f)

    lsoa_shapes = []
    for feat in hoods_geojson["features"]:
        geom = shape(feat["geometry"])
        name = feat["properties"]["LSOA21NM"]
        lsoa_shapes.append((name, geom))

    postcode_info = {}
    for feat in features:
        pc = feat["properties"]["addr_postcode"]
        if not pc or pc in postcode_info:
            continue
        clat = feat["properties"]["centroid_lat"]
        clon = feat["properties"]["centroid_lon"]
        pt = Point(clon, clat)

        lsoa_name = ""
        for name, geom in lsoa_shapes:
            if geom.contains(pt):
                lsoa_name = name
                break

        postcode_info[pc] = {
            "lsoa": lsoa_name,
            "centroid_lat": clat,
            "centroid_lon": clon,
        }

    csv_path = os.path.join(DATA_DIR, "postcode_lsoa.csv")
    matched = 0
    orphaned = 0
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["postcode", "lsoa", "centroid_lat", "centroid_lon"])
        for pc in sorted(postcode_info):
            info = postcode_info[pc]
            writer.writerow([pc, info["lsoa"], info["centroid_lat"], info["centroid_lon"]])
            if info["lsoa"]:
                matched += 1
            else:
                orphaned += 1

    print(f"  {len(postcode_info)} postcodes -> {csv_path}")
    print(f"    {matched} matched to an LSOA, {orphaned} outside Oxford LSOAs")
    print("\nDone.")


if __name__ == "__main__":
    main()
