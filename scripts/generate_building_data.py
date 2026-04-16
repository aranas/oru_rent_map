#!/usr/bin/env python3
"""
generate_building_data.py
=========================
Generates two static reference files used by the in-browser HMO CSV upload:

  data/oxford_buildings.geojson  – building footprint polygons with address tags
  data/postcode_lsoa.csv         – postcode -> LSOA + centroid mapping
  data/addr_nodes.csv            – precise lat/lon for address nodes (fallback)

Prerequisite: data/neighbourhoods.geojson must already exist
              (run generate_placeholder.py first).

Intermediate files (gitignored):
  data/buildings_raw.json        – raw Overpass response (ways)
  data/addr_nodes_raw.json       – raw Overpass response (address nodes)

Requires: Python 3, requests, shapely 2.x.

Usage:
  python scripts/generate_building_data.py
"""

from __future__ import annotations

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
    from shapely.geometry import Point, Polygon, shape
    from shapely.strtree import STRtree
except ImportError:
    sys.exit("Missing dependency: pip install shapely>=2")

OVERPASS_ENDPOINTS = [
    "https://z.overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
MAX_RETRIES = 3
RETRY_DELAY_SECS = 30

BBOX = "51.71,-1.33,51.80,-1.17"

BUILDINGS_QUERY = f"""
[out:json][timeout:300];
(
  way["building"]["addr:housenumber"]["addr:street"]({BBOX});
  way["building"]["addr:housenumber"]({BBOX});
  way["building"]["addr:street"]({BBOX});
  way["building:part"]({BBOX});
);
out body geom;
"""

ADDR_NODES_QUERY = f"""
[out:json][timeout:300];
node["addr:housenumber"]["addr:street"]({BBOX});
out body;
"""

# Do not emit more than this many match_keys per feature (range expansion cap).
MAX_EXPANDED_KEYS = 50
# If numeric span of a range exceeds this, keep raw token only (no expansion).
MAX_RANGE_SPAN = 400


def normalise_name(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", "", s)
    return " ".join(s.split())


def query_overpass(query: str, label: str) -> dict:
    """Try each Overpass endpoint with retries. Returns parsed JSON."""
    for attempt in range(1, MAX_RETRIES + 1):
        for endpoint in OVERPASS_ENDPOINTS:
            short_name = endpoint.split("//")[1].split("/")[0]
            print(f"  [{attempt}/{MAX_RETRIES}] {short_name} — {label}...")
            try:
                resp = requests.get(
                    endpoint, params={"data": query}, timeout=300
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


def truncate_coord(val: float, decimals: int = 6) -> float:
    return round(val, decimals)


def overpass_way_to_geojson_feature(way: dict) -> dict | None:
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

    poly = Polygon([(c[0], c[1]) for c in coords])
    centroid = poly.centroid

    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [coords]},
        "properties": {
            "osm_way_id": way.get("id"),
            "addr_housenumber": housenumber,
            "addr_street": street,
            "addr_postcode": postcode,
            "addr_source": "way",
            "centroid_lat": truncate_coord(centroid.y),
            "centroid_lon": truncate_coord(centroid.x),
        },
    }


def dedupe_ways(elements: list) -> list:
    """Keep one element per way id (union query may repeat ids)."""
    by_id: dict[int, dict] = {}
    for el in elements:
        if el.get("type") != "way":
            continue
        wid = el.get("id")
        if wid is not None:
            by_id[wid] = el
    return list(by_id.values())


def merge_node_into_feature(feat: dict, node_tags: dict) -> None:
    """Apply addr node tags when the way does not already have a full address."""
    p = feat["properties"]
    nh = (node_tags.get("addr:housenumber") or "").strip()
    ns = (node_tags.get("addr:street") or "").strip()
    npc = (node_tags.get("addr:postcode") or "").strip()

    wh = (p.get("addr_housenumber") or "").strip()
    ws = (p.get("addr_street") or "").strip()
    wpc = (p.get("addr_postcode") or "").strip()

    if wh and ws:
        if not wpc and npc:
            p["addr_postcode"] = npc
        return

    if nh and ns:
        p["addr_housenumber"] = nh
        p["addr_street"] = ns
        if npc:
            p["addr_postcode"] = npc or wpc
        p["addr_source"] = "node" if not (wh or ws) else "mixed"
        return

    if nh and not wh:
        p["addr_housenumber"] = nh
        p["addr_source"] = "mixed"
    if ns and not ws:
        p["addr_street"] = ns
        p["addr_source"] = "mixed"
    if not p.get("addr_postcode") and npc:
        p["addr_postcode"] = npc


def join_address_nodes_to_features(features: list, node_elements: list) -> None:
    """Assign addr:node tags to building polygons via point-in-polygon."""
    polys: list[Polygon] = []
    feat_index_for_poly: list[int] = []
    for i, feat in enumerate(features):
        g = feat.get("geometry") or {}
        if g.get("type") != "Polygon":
            continue
        polys.append(shape(g))
        feat_index_for_poly.append(i)

    if not polys:
        return

    tree = STRtree(polys)
    nodes = [el for el in node_elements if el.get("type") == "node"]
    print(f"  Joining {len(nodes)} address nodes to {len(polys)} polygons...")

    skipped = 0
    for el in nodes:
        lon, lat = el.get("lon"), el.get("lat")
        if lon is None or lat is None:
            skipped += 1
            continue
        pt = Point(lon, lat)
        idxs = tree.query(pt, predicate="intersects")
        if hasattr(idxs, "tolist"):
            idxs = idxs.tolist()
        elif not isinstance(idxs, list):
            idxs = list(idxs) if idxs is not None else []

        containing = [
            int(i) for i in idxs if polys[int(i)].covers(pt)
        ]
        if not containing:
            skipped += 1
            continue

        if len(containing) == 1:
            poly_i = containing[0]
        else:
            poly_i = min(containing, key=lambda i: polys[i].area)

        tags = el.get("tags") or {}
        merge_node_into_feature(features[feat_index_for_poly[poly_i]], tags)

    if skipped:
        print(f"  ({skipped} nodes skipped — no containing polygon or no coords)")


def expand_housenumber_token(raw: str, fallback_stats: list[int] | None = None) -> list[str]:
    """
    Turn housenumber tokens into a list for match_key expansion.
    Ranges like 1-19 expand to odds or evens if same parity, else all integers.
    """
    if not raw or not raw.strip():
        return []
    s = raw.strip().replace("–", "-").replace("—", "-")
    s_compact = re.sub(r"\s+", "", s)

    m = re.match(r"^(\d+)\s*-\s*(\d+)$", s_compact)
    if not m:
        return [s]

    lo, hi = int(m.group(1)), int(m.group(2))
    if lo > hi:
        lo, hi = hi, lo
    span = hi - lo + 1
    if span > MAX_RANGE_SPAN or span > MAX_EXPANDED_KEYS:
        if fallback_stats is not None:
            fallback_stats[0] += 1
        return [s]

    if lo % 2 == hi % 2:
        nums = list(range(lo, hi + 1, 2))
    else:
        nums = list(range(lo, hi + 1))

    if len(nums) > MAX_EXPANDED_KEYS:
        if fallback_stats is not None:
            fallback_stats[0] += 1
        return [s]
    return [str(n) for n in nums]


def expand_housenumber_field(hn: str, fallback_stats: list[int] | None = None) -> list[str]:
    """Split on comma/semicolon, expand each token, dedupe preserving order."""
    if not hn or not hn.strip():
        return []
    parts = re.split(r"[,;]", hn)
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        part = part.strip()
        if not part:
            continue
        for token in expand_housenumber_token(part, fallback_stats):
            if token not in seen:
                seen.add(token)
                out.append(token)
    return out


def finalize_match_keys(feat: dict, fallback_stats: list[int] | None = None) -> None:
    """Set match_key and match_keys from addr_housenumber + addr_street."""
    p = feat["properties"]
    hn = p.get("addr_housenumber") or ""
    st = (p.get("addr_street") or "").strip()
    if not st:
        p["match_key"] = ""
        p["match_keys"] = []
        return

    expanded = expand_housenumber_field(hn, fallback_stats)
    if not expanded:
        p["match_key"] = ""
        p["match_keys"] = []
        return

    keys_ordered: list[str] = []
    seen_k: set[str] = set()
    for num in expanded:
        k = normalise_name(f"{num} {st}")
        if k and k not in seen_k:
            seen_k.add(k)
            keys_ordered.append(k)

    if not keys_ordered:
        p["match_key"] = ""
        p["match_keys"] = []
        return

    p["match_keys"] = keys_ordered
    p["match_key"] = keys_ordered[0]


def count_match_key_collisions(features: list) -> int:
    """How many times a match_key would shadow an earlier feature (first wins)."""
    seen: dict[str, int] = {}
    collisions = 0
    for feat in features:
        p = feat["properties"]
        keys = p.get("match_keys") or []
        if not keys and p.get("match_key"):
            keys = [p["match_key"]]
        for k in keys:
            if not k:
                continue
            if k in seen:
                collisions += 1
            else:
                seen[k] = 1
    return collisions


def main() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)

    hoods_path = os.path.join(DATA_DIR, "neighbourhoods.geojson")
    if not os.path.exists(hoods_path):
        sys.exit(
            f"ERROR: {hoods_path} not found.\n"
            "Run generate_placeholder.py first to create LSOA boundaries."
        )

    print("[1/5] Fetching building ways from Overpass...")
    raw_ways = query_overpass(BUILDINGS_QUERY, "building ways")
    raw_path = os.path.join(DATA_DIR, "buildings_raw.json")
    with open(raw_path, "w") as f:
        json.dump(raw_ways, f)
    print(f"  Wrote raw response -> {raw_path}")

    print("[2/5] Fetching address nodes from Overpass...")
    raw_nodes = query_overpass(ADDR_NODES_QUERY, "address nodes")
    nodes_path = os.path.join(DATA_DIR, "addr_nodes_raw.json")
    with open(nodes_path, "w") as f:
        json.dump(raw_nodes, f)
    print(f"  Wrote raw response -> {nodes_path}")

    print("[3/5] Converting to GeoJSON, joining nodes, expanding ranges...")
    way_elements = dedupe_ways(raw_ways.get("elements", []))
    features: list[dict] = []
    for el in way_elements:
        feat = overpass_way_to_geojson_feature(el)
        if feat:
            features.append(feat)

    join_address_nodes_to_features(features, raw_nodes.get("elements", []))

    range_fallback_count = [0]
    for feat in features:
        finalize_match_keys(feat, range_fallback_count)

    if range_fallback_count[0]:
        print(
            f"  Range expansion fallbacks (span/cap): {range_fallback_count[0]} tokens"
        )

    collisions = count_match_key_collisions(features)
    if collisions:
        print(f"  Duplicate match_key occurrences (first feature wins in browser): {collisions}")

    buildings_geojson = {"type": "FeatureCollection", "features": features}
    buildings_path = os.path.join(DATA_DIR, "oxford_buildings.geojson")
    with open(buildings_path, "w") as f:
        json.dump(buildings_geojson, f)
    size_kb = os.path.getsize(buildings_path) / 1024
    print(
        f"  Individual building footprints encoded in oxford_buildings.geojson: {len(features)}"
    )
    print(f"  Wrote {buildings_path} ({size_kb:.0f} KB)")

    # Write address nodes CSV for precise browser fallback
    print("[4/5] Writing address nodes CSV...")
    addr_csv_path = os.path.join(DATA_DIR, "addr_nodes.csv")
    node_elements = [
        el for el in raw_nodes.get("elements", [])
        if el.get("type") == "node" and el.get("lat") is not None and el.get("lon") is not None
    ]
    addr_rows_written = 0
    seen_node_keys: set[str] = set()
    with open(addr_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["match_key", "lat", "lon", "addr_housenumber", "addr_street", "addr_postcode"])
        for el in node_elements:
            tags = el.get("tags") or {}
            hn = (tags.get("addr:housenumber") or "").strip()
            street = (tags.get("addr:street") or "").strip()
            pc = (tags.get("addr:postcode") or "").strip()
            if not hn or not street:
                continue
            lat = truncate_coord(el["lat"])
            lon = truncate_coord(el["lon"])
            expanded = expand_housenumber_field(hn)
            for num in expanded:
                key = normalise_name(f"{num} {street}")
                if not key or key in seen_node_keys:
                    continue
                seen_node_keys.add(key)
                writer.writerow([key, lat, lon, hn, street, pc])
                addr_rows_written += 1
    size_kb = os.path.getsize(addr_csv_path) / 1024
    print(f"  {addr_rows_written} address node entries -> {addr_csv_path} ({size_kb:.0f} KB)")

    print("[5/5] Generating postcode-to-LSOA mapping...")

    with open(hoods_path) as f:
        hoods_geojson = json.load(f)

    lsoa_shapes = []
    for feat in hoods_geojson["features"]:
        geom = shape(feat["geometry"])
        name = feat["properties"]["LSOA21NM"]
        lsoa_shapes.append((name, geom))

    postcode_info: dict[str, dict] = {}
    for feat in features:
        pc = feat["properties"].get("addr_postcode") or ""
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
