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

GOOGLE_GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json"
GOOGLE_API_KEY       = os.environ.get("GOOGLE_GEOCODING_KEY", "")

UK_POSTCODE_RE = re.compile(r'[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}', re.IGNORECASE)

SUBUNIT_RE = re.compile(
    r"^(flat\s+\S+|room\s+\S+|unit\s+\S+|apt\.?\s+\S+|apartment\s+\S+|"
    r"studio\s+\S+|basement|ground\s+floor|first\s+floor|second\s+floor|"
    r"third\s+floor|top\s+floor|lower\s+ground|first\s+and\s+second\s+floor|"
    r"second\s+and\s+third\s+floor|floor\s+\d+|maisonette|annexe|annex|"
    r"the\s+flat|the\s+annexe)\s*,\s*",
    re.IGNORECASE,
)

STREET_ABBREVIATIONS = {
    r"\bRd\b": "Road",   r"\bSt\b": "Street",  r"\bAve?\b": "Avenue",
    r"\bDr\b": "Drive",  r"\bCl\b": "Close",   r"\bCres\b":  "Crescent",
    r"\bPl\b": "Place",  r"\bLn\b": "Lane",    r"\bTce\b":   "Terrace",
    r"\bGdns\b": "Gardens", r"\bSq\b": "Square", r"\bCt\b":  "Court",
}

# Finds the first house number anywhere in an address string
_HOUSENUMBER_IN_STRING_RE = re.compile(r"(?:^|,\s*)(\d+[A-Za-z]?)\s+([A-Za-z][^,]+)")


def strip_sub_unit(address):
    m = SUBUNIT_RE.match(address)
    return address[len(m.group(0)):] if m else address


def expand_abbreviations(address):
    for pattern, replacement in STREET_ABBREVIATIONS.items():
        address = re.sub(pattern, replacement, address, flags=re.IGNORECASE)
    return address


def extract_postcode(address):
    m = UK_POSTCODE_RE.search(address)
    return m.group(0).upper().strip() if m else ""


def extract_housenumber(address):
    m = re.match(r"^(\d+[A-Za-z]?)\b", address.strip())
    return m.group(1) if m else ""


def extract_housenumber_anywhere(address):
    """Find the first house number buried anywhere in the string."""
    for m in _HOUSENUMBER_IN_STRING_RE.finditer(address):
        hn, street = m.group(1), m.group(2).strip()
        if UK_POSTCODE_RE.match(street) or len(street) < 4:
            continue
        return hn, street
    return "", ""


def clean_for_nominatim(address):
    cleaned = re.sub(r",?\s*\bOxford\b,?", "", address, flags=re.IGNORECASE)
    cleaned = expand_abbreviations(cleaned)
    cleaned = re.sub(r",\s*,", ",", cleaned)
    return cleaned.strip().strip(",").strip()


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


OX_POSTCODE_RE = re.compile(r'\bOX[1-4]\b', re.IGNORECASE)  # OX1–OX4 = Oxford city

def looks_like_oxford(address):
    """Only geocode addresses with an Oxford city postcode (OX1–OX4)."""
    return bool(OX_POSTCODE_RE.search(address))


def google_get(query):
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


def nominatim_query(q, session):
    try:
        time.sleep(NOMINATIM_DELAY)
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
        if resp.status_code == 200:
            results = resp.json()
            if results:
                return float(results[0]["lon"]), float(results[0]["lat"])
    except Exception as exc:
        print(f"    Nominatim error for '{q}': {exc}")
    return None


def geocode(address, session, cache):
    """Returns (lon, lat) or None. Skips non-UK addresses. Tries multiple strategies."""
    if not looks_like_oxford(address):
        return None

    # Return cached success immediately; None entries purged at startup
    if address in cache and cache[address] is not None:
        e = cache[address]
        # Handle both old list format [lon, lat] and new dict format {lon, lat}
        if isinstance(e, list):
            return (e[0], e[1])
        return (e["lon"], e["lat"])

    postcode = extract_postcode(address)
    core     = strip_sub_unit(address)
    expanded = clean_for_nominatim(core)
    hn       = extract_housenumber(expanded)

    result = None

    # Strategy 1: expanded (sub-unit stripped) address + postcode
    q1 = f"{expanded}, {postcode}, UK" if postcode else f"{expanded}, UK"
    result = nominatim_query(q1, session)

    # Strategy 2: house number at start of stripped address + postcode
    if not result and hn and postcode:
        result = nominatim_query(f"{hn} {postcode}, UK", session)

    # Strategy 3: house number found anywhere in string + street + postcode
    if not result and postcode:
        hn2, street2 = extract_housenumber_anywhere(address)
        if hn2 and street2 and hn2 != hn:
            result = nominatim_query(f"{hn2} {expand_abbreviations(street2)}, {postcode}, UK", session)

    # Strategy 4: original address unchanged
    if not result:
        q4 = f"{address}, UK"
        if q4 != q1:
            result = nominatim_query(q4, session)

    # Strategy 5: Google Maps Geocoding (only if Nominatim exhausted)
    if not result and GOOGLE_API_KEY:
        result = google_get(f"{address}, UK")

    if result:
        cache[address] = {"lon": result[0], "lat": result[1]}
    else:
        cache[address] = None

    save_cache(cache)
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

    # Purge cached failures so they get retried with improved strategies
    failures_purged = sum(1 for v in cache.values() if v is None)
    cache = {k: v for k, v in cache.items() if v is not None}
    if failures_purged:
        print(f"  Purged {failures_purged} cached failures — will retry with improved strategies")
        save_cache(cache)

    session = requests.Session()

    oxford_addrs    = [a for a in unique_addrs if looks_like_oxford(a)]
    non_oxford      = len(unique_addrs) - len(oxford_addrs)
    already_cached  = sum(1 for a in oxford_addrs if a in cache)
    to_fetch        = len(oxford_addrs) - already_cached
    print(f"  {len(oxford_addrs)} Oxford (OX1-OX4) addresses, {non_oxford} non-Oxford skipped")
    print(f"  {already_cached} already cached, {to_fetch} new Nominatim/Google requests needed")
    print(f"  Google API key: {'✓ loaded' if GOOGLE_API_KEY else '✗ NOT SET — set GOOGLE_GEOCODING_KEY env var for better results'}")

    coords = {}   # address -> (lon, lat) or None
    done = 0
    for addr in oxford_addrs:
        result = geocode(addr, session, cache)
        coords[addr] = result
        done += 1
        if done % 100 == 0:
            save_cache(cache)
            geocoded = sum(1 for v in coords.values() if v)
            failed   = sum(1 for v in coords.values() if v is None)
            print(f"  {done}/{len(oxford_addrs)} — geocoded: {geocoded}, failed: {failed}")

    save_cache(cache)
    geocoded_total = sum(1 for v in coords.values() if v)
    failed_total   = sum(1 for v in coords.values() if v is None)
    print(f"  Done: {geocoded_total} geocoded, {failed_total} failed/skipped")

    print("[4/4] Building GeoJSON and writing outputs…")
    features = []
    failures = []

    for addr, group in addr_groups.items():
        if not looks_like_oxford(addr):
            continue  # silently skip non-Oxford addresses
        c = coords.get(addr)
        if c is None:
            failures.append({
                "holder_address": addr,
                "holder_names":   "; ".join(sorted(group["names"])),
                "property_count": group["count"],
                "reason":         "geocode_failed",
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
