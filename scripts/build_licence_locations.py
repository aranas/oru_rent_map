#!/usr/bin/env python3
"""
build_licence_locations.py
==========================
Generates data/licence_locations.geojson from the Oxford HMO and
Selective Licence registers.  This is the pre-baked dataset the map
loads on startup — no CSV upload required.

After running this script, run patch_geojson_properties.py to embed
address, agent, and holder metadata into the geojson features.

Each feature is a GeoJSON Point containing:
  type   – "hmo" or "selective"
  id     – original register reference (for back-identification)
  lsoa   – LSOA name the property falls in
  address / agent / holder — added by patch_geojson_properties.py

Address matching strategy (in order):
  1. Direct lookup in oxford_buildings.geojson by normalised match_key
     (housenumber + street) — uses OSM-tagged building centroid.
  2. Nominatim: sub-unit stripped address + abbreviation expansion + postcode
  3. Nominatim: house number + postcode only (bypasses street name)
  4. Nominatim: house number found anywhere in string + street + postcode
     (handles "Flat 1, Building Name, 42 Some Street, OX1 1AA")
  5. Nominatim: original unmodified address
  6. Google Maps Geocoding API — handles named developments and new builds
     not yet in OSM (only called if all Nominatim strategies fail)

Results are cached in data/geocode_cache.json (gitignored) — safe to
interrupt and re-run.

Usage
-----
  python scripts/build_licence_locations.py

Required inputs:
  data/HMO_Register_April_*_details.csv      (HMO addresses)
  data/Selective_Licence_Register*.csv       (Selective addresses)
  data/oxford_buildings.geojson
  data/neighbourhoods.geojson

Output:
  data/licence_locations.geojson

Requires: requests, shapely  (pip install -r requirements.txt)
"""

import csv
import glob
import json
import os
import re
import sys
import time
from datetime import datetime

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install requests")

try:
    from shapely.geometry import shape, Point
except ImportError:
    sys.exit("Missing dependency: pip install shapely")

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

HMO_CSV_GLOB      = os.path.join(DATA_DIR, "HMO_Register_April_*_details.csv")
SELECTIVE_CSV_GLOB = os.path.join(DATA_DIR, "Selective_Licence_Register*.csv")
BUILDINGS_GJ  = os.path.join(DATA_DIR, "oxford_buildings.geojson")
HOODS_GJ      = os.path.join(DATA_DIR, "neighbourhoods.geojson")
OUTPUT_GJ     = os.path.join(DATA_DIR, "licence_locations.geojson")
CACHE_PATH    = os.path.join(DATA_DIR, "geocode_cache.json")


def find_file(pattern, label):
    matches = sorted(glob.glob(pattern))
    if not matches:
        sys.exit(f"ERROR: no {label} file found matching {pattern}")
    if len(matches) > 1:
        print(f"  Warning: multiple {label} files found, using {matches[-1]}")
    return matches[-1]

# ── Geocoding ──────────────────────────────────────────────────────────────

NOMINATIM_URL   = "https://nominatim.openstreetmap.org/search"
NOMINATIM_DELAY = 1.1
USER_AGENT      = "oru-hmo-map-geocoder/1.0 (open-source research tool)"

GOOGLE_GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json"
GOOGLE_API_KEY       = os.environ.get("GOOGLE_GEOCODING_KEY", "")

# ── Address normalisation ──────────────────────────────────────────────────

UK_POSTCODE_RE = re.compile(r"[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}", re.IGNORECASE)

SUBUNIT_RE = re.compile(
    r"^(flat\s+\S+|room\s+\S+|unit\s+\S+|apt\.?\s+\S+|apartment\s+\S+|"
    r"studio\s+\S+|basement|ground\s+floor|first\s+floor|second\s+floor|"
    r"third\s+floor|top\s+floor|lower\s+ground|first\s+and\s+second\s+floor|"
    r"second\s+and\s+third\s+floor|floor\s+\d+|maisonette|annexe|annex|"
    r"the\s+flat|the\s+annexe)\s*,\s*",
    re.IGNORECASE,
)

# Finds the first house number anywhere in an address string
# e.g. "Flat 1, Oakthorpe Mansions, 205 Banbury Road, OX2 7HG" → ("205", "Banbury Road")
_HOUSENUMBER_IN_STRING_RE = re.compile(
    r"(?:^|,\s*)(\d+[A-Za-z]?)\s+([A-Za-z][^,]+)"
)

STREET_ABBREVIATIONS = {
    r"\bRd\b":     "Road",
    r"\bSt\b":     "Street",
    r"\bAve?\b":   "Avenue",
    r"\bDr\b":     "Drive",
    r"\bCl\b":     "Close",
    r"\bCres\b":   "Crescent",
    r"\bCresc\b":  "Crescent",
    r"\bPl\b":     "Place",
    r"\bLn\b":     "Lane",
    r"\bTce\b":    "Terrace",
    r"\bTerr\b":   "Terrace",
    r"\bGdns\b":   "Gardens",
    r"\bGdn\b":    "Garden",
    r"\bSq\b":     "Square",
    r"\bWk\b":     "Walk",
    r"\bCt\b":     "Court",
    r"\bBldgs\b":  "Buildings",
}


def normalise_key(s):
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", "", s)
    return " ".join(s.split())


def strip_sub_unit(address):
    m = SUBUNIT_RE.match(address)
    return address[len(m.group(0)):] if m else address


def extract_housenumber(address):
    m = re.match(r"^(\d+[A-Za-z]?)\b", address.strip())
    return m.group(1) if m else ""


def expand_abbreviations(address):
    for pattern, replacement in STREET_ABBREVIATIONS.items():
        address = re.sub(pattern, replacement, address, flags=re.IGNORECASE)
    return address


def extract_postcode(address):
    m = UK_POSTCODE_RE.search(address)
    return m.group(0).upper().strip() if m else ""


def build_match_key(address, street=""):
    """Compute the same match_key the browser uses."""
    core = strip_sub_unit(address)
    pc = extract_postcode(core) or extract_postcode(address)
    hn = extract_housenumber(core)
    st = street.strip()
    if not st:
        parts = core.replace(pc, "").split(",") if pc else core.split(",")
        st = re.sub(r"^\d+[A-Za-z]?\s*", "", parts[0].strip())
    return normalise_key(f"{hn} {st}")


def clean_for_nominatim(address):
    """
    Strip redundant tokens Nominatim doesn't need (city name already
    appended in query) and expand abbreviations.
    """
    # Remove "Oxford," or ", Oxford" from mid-address (Selective register style)
    cleaned = re.sub(r",?\s*\bOxford\b,?", "", address, flags=re.IGNORECASE)
    cleaned = expand_abbreviations(cleaned)
    # Collapse repeated commas / whitespace
    cleaned = re.sub(r",\s*,", ",", cleaned)
    return cleaned.strip().strip(",").strip()


def iso_date(raw):
    """Try to parse a date string into YYYY-MM-DD, return raw on failure."""
    if not raw:
        return ""
    if isinstance(raw, datetime):
        return raw.strftime("%Y-%m-%d")
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(str(raw).strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return str(raw).strip()


# ── Reference data ─────────────────────────────────────────────────────────

def load_building_index():
    print(f"  Loading {BUILDINGS_GJ}...")
    with open(BUILDINGS_GJ) as f:
        gj = json.load(f)
    index = {}  # match_key -> (centroid_lon, centroid_lat)
    for feat in gj["features"]:
        key = feat["properties"].get("match_key", "")
        if key:
            index[key] = (
                feat["properties"]["centroid_lon"],
                feat["properties"]["centroid_lat"],
            )
    print(f"  {len(index)} building match keys")
    return index


def load_lsoa_shapes():
    print(f"  Loading {HOODS_GJ}...")
    with open(HOODS_GJ) as f:
        gj = json.load(f)
    shapes = []
    for feat in gj["features"]:
        shapes.append((feat["properties"]["LSOA21NM"], shape(feat["geometry"])))
    print(f"  {len(shapes)} LSOA polygons")
    return shapes


def point_to_lsoa(lon, lat, lsoa_shapes):
    pt = Point(lon, lat)
    for name, geom in lsoa_shapes:
        if geom.contains(pt):
            return name
    return ""


# ── Geocoding ──────────────────────────────────────────────────────────────

def load_cache():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2)


def _nominatim_get(query, session):
    try:
        resp = session.get(
            NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": 1, "countrycodes": "gb"},
            timeout=10,
        )
        time.sleep(NOMINATIM_DELAY)
        if resp.status_code == 200:
            results = resp.json()
            if results:
                return (float(results[0]["lon"]), float(results[0]["lat"]))
    except Exception as exc:
        print(f"    Nominatim error for '{query}': {exc}")
    return None


def _google_get(query):
    """Call Google Maps Geocoding API. Returns (lon, lat) or None."""
    if not GOOGLE_API_KEY:
        return None
    try:
        resp = requests.get(
            GOOGLE_GEOCODING_URL,
            params={"address": query, "key": GOOGLE_API_KEY, "region": "gb"},
            timeout=10,
        )
        data = resp.json()
        if data.get("status") == "OK" and data.get("results"):
            loc = data["results"][0]["geometry"]["location"]
            return (loc["lng"], loc["lat"])
        if data.get("status") not in ("ZERO_RESULTS", "OK"):
            print(f"    Google error: {data.get('status')} for '{query}'")
    except Exception as exc:
        print(f"    Google request error for '{query}': {exc}")
    return None


def extract_housenumber_anywhere(address):
    """
    Find the first house number anywhere in the string, not just at the start.
    Returns (housenumber, street_fragment) or ("", "").
    Handles addresses like "Flat 1, Oakthorpe Mansions, 205 Banbury Road, OX2 7HG"
    where the real house number is buried after a building name.
    """
    for m in _HOUSENUMBER_IN_STRING_RE.finditer(address):
        hn     = m.group(1)
        street = m.group(2).strip()
        # Skip if the "street" fragment is a postcode or very short
        if UK_POSTCODE_RE.match(street) or len(street) < 4:
            continue
        return hn, street
    return "", ""


def geocode(raw_address, session, cache):
    """
    Return (lon, lat) or None.  Tries multiple strategies, caches result.
    Cached successes are returned immediately; cached failures are skipped
    (None entries are purged at startup so re-runs retry with new strategies).
    """
    cache_key = raw_address

    # Return cached success immediately
    if cache_key in cache and cache[cache_key] is not None:
        e = cache[cache_key]
        return (e["lon"], e["lat"])

    postcode  = extract_postcode(raw_address)
    core      = strip_sub_unit(raw_address)
    expanded  = clean_for_nominatim(core)
    hn        = extract_housenumber(expanded)

    result = None

    # Strategy 1: expanded address (sub-unit stripped) + postcode
    q1 = f"{expanded}, {postcode}, Oxford, UK" if postcode else f"{expanded}, Oxford, UK"
    result = _nominatim_get(q1, session)

    # Strategy 2: housenumber found at start of stripped address + postcode
    if not result and hn and postcode:
        result = _nominatim_get(f"{hn} {postcode}, UK", session)

    # Strategy 3: house number found anywhere in string + street + postcode
    # Catches "Flat 1, Building Name, 42 Some Street, OX1 1AA"
    if not result and postcode:
        hn2, street2 = extract_housenumber_anywhere(raw_address)
        if hn2 and street2 and hn2 != hn:
            street2 = expand_abbreviations(street2)
            result = _nominatim_get(f"{hn2} {street2}, {postcode}, UK", session)

    # Strategy 4: original address unchanged
    if not result:
        q4 = f"{raw_address}, Oxford, UK" if postcode not in raw_address else f"{raw_address}, UK"
        if q4 != q1:
            result = _nominatim_get(q4, session)

    # Strategy 5: Google Maps Geocoding (only if Nominatim exhausted)
    if not result and GOOGLE_API_KEY:
        result = _google_get(f"{raw_address}, UK")

    if result:
        cache[cache_key] = {"lon": result[0], "lat": result[1]}
    else:
        cache[cache_key] = None

    save_cache(cache)
    return result


# ── Register parsers ───────────────────────────────────────────────────────

def parse_hmo_csv():
    """Returns list of dicts with keys: id, address, street, start, end."""
    path = find_file(HMO_CSV_GLOB, "HMO details CSV")
    print(f"  Parsing {os.path.basename(path)}...")
    records = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid  = row.get("Case Number", "").strip()
            addr = row.get("address", "").strip()
            if not rid or not addr:
                continue
            records.append({
                "id":      rid,
                "address": addr,
                "street":  "",
                "start":   "",
                "end":     "",
            })
    print(f"  {len(records)} HMO records")
    return records


def parse_selective_csv():
    """Returns list of dicts with keys: id, address, street, start, end."""
    path = find_file(SELECTIVE_CSV_GLOB, "Selective CSV")
    print(f"  Parsing {os.path.basename(path)}...")
    records = []
    with open(path, newline="", encoding="latin-1") as f:
        reader = csv.DictReader(f)
        headers_lower = {h.lower().strip(): h for h in reader.fieldnames or []}

        ref_col   = next((headers_lower[h] for h in headers_lower if "reference" in h), None)
        addr_col  = next((headers_lower[h] for h in headers_lower if "property address" in h), None)
        start_col = next((headers_lower[h] for h in headers_lower if "start" in h), None)
        end_col   = next((headers_lower[h] for h in headers_lower if "end" in h), None)

        for row in reader:
            addr = row.get(addr_col, "").strip() if addr_col else ""
            if not addr:
                continue
            records.append({
                "id":      row.get(ref_col, "").strip()   if ref_col   else "",
                "address": addr,
                "street":  "",   # Selective CSV has no separate street column
                "start":   iso_date(row.get(start_col, "")) if start_col else "",
                "end":     iso_date(row.get(end_col, ""))   if end_col   else "",
            })
    print(f"  {len(records)} selective licence records")
    return records


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    for path in [BUILDINGS_GJ, HOODS_GJ]:
        if not os.path.exists(path):
            sys.exit(f"ERROR: required file not found: {path}")

    # ── Load reference data ────────────────────────────────────────────────
    print("[1/5] Loading reference data...")
    building_index = load_building_index()
    lsoa_shapes    = load_lsoa_shapes()

    # ── Parse registers ───────────────────────────────────────────────────
    print("[2/5] Parsing licence registers...")
    hmo_records        = parse_hmo_csv()
    selective_records  = parse_selective_csv()

    all_records = (
        [("hmo", r) for r in hmo_records] +
        [("selective", r) for r in selective_records]
    )
    print(f"  {len(all_records)} total records")

    # ── Match / geocode ───────────────────────────────────────────────────
    print("[3/5] Matching addresses...")
    cache   = load_cache()

    # Purge cached failures so they are retried on this run.
    # Cached successes (non-None) are kept — they won't be re-requested.
    failures_purged = sum(1 for v in cache.values() if v is None)
    cache = {k: v for k, v in cache.items() if v is not None}
    if failures_purged:
        print(f"  Purged {failures_purged} cached failures — will retry")
        save_cache(cache)

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    # Deduplicate addresses to avoid redundant geocoding
    address_to_coords = {}  # raw_address -> (lon, lat) or None
    for _, rec in all_records:
        key = build_match_key(rec["address"], rec["street"])
        if key and key in building_index:
            address_to_coords[rec["address"]] = building_index[key]  # OSM centroid
        else:
            address_to_coords[rec["address"]] = None  # needs geocoding

    to_geocode = [addr for addr, coords in address_to_coords.items() if coords is None]
    already_cached = sum(1 for a in to_geocode if a in cache and cache[a] is not None)
    needs_fresh    = sum(1 for a in to_geocode if a not in cache or cache[a] is None)

    print(f"  {len(all_records) - len(to_geocode)} matched via OSM address tags")
    print(f"  {len(to_geocode)} need geocoding "
          f"({already_cached} cached, ~{needs_fresh} new Nominatim requests)")
    if needs_fresh:
        print(f"  Estimated time for new requests: ~{needs_fresh} seconds")
        print(f"  Cache: {CACHE_PATH} (safe to interrupt & resume)")

    geocoded = failed = 0
    failed_addresses = []  # collect for diagnostics
    for i, addr in enumerate(to_geocode):
        result = geocode(addr, session, cache)
        address_to_coords[addr] = result
        if result:
            geocoded += 1
        else:
            failed += 1
            failed_addresses.append(addr)
        if (i + 1) % 50 == 0 or (i + 1) == len(to_geocode):
            print(f"  {i + 1}/{len(to_geocode)} — geocoded: {geocoded}, failed: {failed}")

    # ── Write geocoding failures for analysis ─────────────────────────────
    if failed_addresses:
        failures_path = os.path.join(DATA_DIR, "geocode_failures.csv")
        # Build a lookup: address -> (type, id) from all_records
        addr_meta = {}
        for licence_type, rec in all_records:
            if rec["address"] not in addr_meta:
                addr_meta[rec["address"]] = (licence_type, rec["id"])
        with open(failures_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["type", "id", "address"])
            for addr in failed_addresses:
                meta = addr_meta.get(addr, ("", ""))
                writer.writerow([meta[0], meta[1], addr])
        print(f"  Failures written -> {failures_path} ({len(failed_addresses)} rows)")

    # ── Assign LSOAs + build features ─────────────────────────────────────
    print("[4/5] Assigning LSOAs and building GeoJSON features...")
    features = []
    skipped  = 0

    for licence_type, rec in all_records:
        coords = address_to_coords.get(rec["address"])
        if not coords:
            skipped += 1
            continue
        lon, lat = round(coords[0], 6), round(coords[1], 6)
        lsoa = point_to_lsoa(lon, lat, lsoa_shapes)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "type":          licence_type,
                "id":            rec["id"],
                "address":       rec["address"],
                "licence_start": rec["start"],
                "licence_end":   rec["end"],
                "lsoa":          lsoa,
            },
        })

    hmo_count        = sum(1 for f in features if f["properties"]["type"] == "hmo")
    selective_count  = sum(1 for f in features if f["properties"]["type"] == "selective")
    lsoa_assigned    = sum(1 for f in features if f["properties"]["lsoa"])
    print(f"  {hmo_count} HMO + {selective_count} selective = {len(features)} features")
    print(f"  {lsoa_assigned} assigned to an LSOA, {skipped} skipped (no location found)")

    # ── Write output ──────────────────────────────────────────────────────
    print("[5/5] Writing output...")
    with open(OUTPUT_GJ, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    size_kb = os.path.getsize(OUTPUT_GJ) / 1024
    print(f"  Written -> {OUTPUT_GJ} ({size_kb:.0f} KB)")
    print("\nDone. Commit data/licence_locations.geojson to the repo.")


if __name__ == "__main__":
    main()
