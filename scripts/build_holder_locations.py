#!/usr/bin/env python3
"""
build_holder_locations.py
--------------------------
Geocodes licence holder (landlord) addresses from the Selective Licence
register and outputs:

  data/holder_locations.geojson   — one Point per unique holder address,
                                    with holder name(s) and property count
  data/holder_geocode_failures.csv — addresses that could not be geocoded

Shares the geocode cache with build_licence_locations.py so already-cached
results are reused instantly.

Run time: depends on how many new addresses need geocoding (~1 req/s).
"""

import csv, glob, json, os, re, sys, time
import requests

ROOT  = os.path.join(os.path.dirname(__file__), "..")
DATA  = os.path.join(ROOT, "data")

SELECTIVE_CSV_GLOB = os.path.join(DATA, "Selective_Licence_Register*.csv")
CACHE_FILE         = os.path.join(DATA, "geocode_cache.json")
OUT_GEOJSON        = os.path.join(DATA, "holder_locations.geojson")
OUT_FAILURES       = os.path.join(DATA, "holder_geocode_failures.csv")

NOMINATIM_URL  = "https://nominatim.openstreetmap.org/search"
NOMINATIM_DELAY = 1.1   # seconds between requests (Nominatim ToS)
USER_AGENT     = "oru-hmo-map-geocoder/1.0 (open-source research tool)"

UK_POSTCODE_RE = re.compile(r'[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}', re.IGNORECASE)

# ── Helpers ────────────────────────────────────────────────────────────────

def find_file(pattern, label):
    matches = sorted(glob.glob(pattern))
    if not matches:
        print(f"ERROR: no {label} file found matching {pattern}", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        print(f"  Warning: multiple {label} files found, using {matches[-1]}")
    return matches[-1]


def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f)


def looks_like_uk(address):
    """Rough heuristic: has a UK postcode, or ends with common UK place/country."""
    if UK_POSTCODE_RE.search(address):
        return True
    low = address.lower()
    for term in [", uk", ", england", ", wales", ", scotland", ", united kingdom"]:
        if low.endswith(term):
            return True
    return False


def nominatim_query(q, session):
    resp = session.get(
        NOMINATIM_URL,
        params={"q": q, "format": "json", "limit": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    if resp.status_code == 429:
        print("  Rate-limited (429), waiting 60s…")
        time.sleep(60)
        return nominatim_query(q, session)
    resp.raise_for_status()
    results = resp.json()
    if results:
        return float(results[0]["lon"]), float(results[0]["lat"])
    return None


def geocode(address, session, cache):
    """Returns (lon, lat) or None. Skips non-UK addresses."""
    if not looks_like_uk(address):
        return None   # Don't bother geocoding foreign addresses

    key = address
    if key in cache:
        return cache[key]   # None means previously failed

    time.sleep(NOMINATIM_DELAY)
    try:
        result = nominatim_query(address, session)
    except Exception as e:
        print(f"  Request error for [{address}]: {e}")
        result = None

    cache[key] = result
    return result


# ── Parse register ─────────────────────────────────────────────────────────

def parse_selective(path):
    """Returns list of dicts: {holder_name, holder_address}."""
    records = []
    with open(path, newline="", encoding="latin-1") as f:
        reader = csv.DictReader(f)
        hl = {h.lower().strip(): h for h in (reader.fieldnames or [])}
        name_col = next((hl[h] for h in hl if "holder name" in h), None)
        addr_col = next((hl[h] for h in hl if "holder address" in h), None)
        if not addr_col:
            print("ERROR: 'Licence holder address' column not found", file=sys.stderr)
            sys.exit(1)
        for row in reader:
            name = row.get(name_col, "").strip() if name_col else ""
            addr = row.get(addr_col, "").strip() if addr_col else ""
            if addr:
                records.append({"holder_name": name, "holder_address": addr})
    return records


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    sel_path = find_file(SELECTIVE_CSV_GLOB, "Selective CSV")

    print("[1/4] Parsing Selective register…")
    records = parse_selective(sel_path)
    print(f"  {len(records)} rows with holder addresses")

    print("[2/4] Grouping by holder address…")
    # address -> {names: set, count: int}
    addr_groups = {}
    for rec in records:
        addr = rec["holder_address"]
        if addr not in addr_groups:
            addr_groups[addr] = {"names": set(), "count": 0}
        addr_groups[addr]["names"].add(rec["holder_name"])
        addr_groups[addr]["count"] += 1

    unique_addrs = list(addr_groups.keys())
    print(f"  {len(unique_addrs)} unique holder addresses")

    print("[3/4] Geocoding (UK addresses only)…")
    cache = load_cache()
    session = requests.Session()

    # Count how many need network requests
    to_fetch = [a for a in unique_addrs if a not in cache and looks_like_uk(a)]
    skipped_foreign = sum(1 for a in unique_addrs if not looks_like_uk(a))
    print(f"  {len(to_fetch)} new UK addresses to geocode, {skipped_foreign} non-UK skipped")

    coords = {}   # address -> (lon, lat) or None
    done = 0
    for addr in unique_addrs:
        result = geocode(addr, session, cache)
        coords[addr] = result
        done += 1
        if done % 100 == 0:
            save_cache(cache)
            geocoded = sum(1 for v in coords.values() if v)
            failed   = sum(1 for v in coords.values() if v is None)
            print(f"  {done}/{len(unique_addrs)} — geocoded: {geocoded}, failed/skipped: {failed}")

    save_cache(cache)
    geocoded_total = sum(1 for v in coords.values() if v)
    failed_total   = sum(1 for v in coords.values() if v is None)
    print(f"  Done: {geocoded_total} geocoded, {failed_total} failed/skipped")

    print("[4/4] Building GeoJSON and writing outputs…")
    features = []
    failures = []

    for addr, group in addr_groups.items():
        c = coords.get(addr)
        if c is None:
            failures.append({
                "holder_address": addr,
                "holder_names":   "; ".join(sorted(group["names"])),
                "property_count": group["count"],
                "reason":         "non-UK" if not looks_like_uk(addr) else "geocode_failed",
            })
            continue
        lon, lat = round(c[0], 6), round(c[1], 6)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "holder_names":   "; ".join(sorted(group["names"])),
                "holder_address": addr,
                "property_count": group["count"],
            },
        })

    with open(OUT_GEOJSON, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    print(f"  Written {len(features)} features -> {OUT_GEOJSON}")

    with open(OUT_FAILURES, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["holder_address", "holder_names", "property_count", "reason"])
        writer.writeheader()
        writer.writerows(failures)
    print(f"  Written {len(failures)} failures -> {OUT_FAILURES}")


if __name__ == "__main__":
    main()
