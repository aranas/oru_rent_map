#!/usr/bin/env python3
"""
build_doorknock_streets.py
---------------------------
Builds the data feeding the "Doorknock streets (Cowley)" map overlay.

Identifies the Cowley streets with the highest renter DENSITY AND the
highest density of listings from the top 20 rental agencies (by city-wide
licence count), then outputs per-property markers and a single suggested
meeting point for the whole shortlist.

Method:
  - "Cowley" = properties whose nearest named locality (from
    data/oxford_locality_anchors.json, built by build_locality_anchors.py
    from the OS OpenMap Local "Named Place" layer) is Cowley or Temple
    Cowley. Postcode district OX4 alone is too coarse — it also covers Rose
    Hill, Littlemore, Blackbird Leys, Iffley Fields and St Clement's, which
    have their own identity and are not what "Cowley" usually means. OX4 is
    still used as a cheap prefilter before the nearest-locality check.
  - "Renters" = sum of registered occupants per street (Occupants for HMO,
    Maximum permitted occupants for Selective licences).
  - "Top 20 rental agencies" = the 20 highest-volume canonical commercial
    letting agencies city-wide, using the same name normalisation as
    static/app.js (AGENT_NORM), excluding Oxford colleges and self-managed
    landlords.
  - Streets are ranked by renters-per-100m and top-20-agency-listings-per-100m,
    NOT raw totals — otherwise a long road (e.g. Cowley Road, ~1.5 miles)
    always outranks a short one purely by having more addresses on it, even
    if a canvasser covers far less ground per door on the short one.
    Street "length" is estimated by projecting each street's property points
    onto their principal axis (PCA) and taking the 5th-95th percentile
    range — this is robust to the handful of licences per street that are
    geocoded to the wrong place (common in this dataset; see
    data/geocode_failures.csv) and would otherwise blow up a naive
    max-pairwise-distance estimate. Streets with under MIN_LISTINGS
    properties or under MIN_MARKERS distinct geocoded points are excluded
    (too small a sample to estimate density from) and the span is floored
    at SPAN_FLOOR_M (very short/cul-de-sac streets or streets whose points
    all geocode to one building centroid still get treated as walkable in
    one stop, not as infinitely dense).
  - Streets are ranked by (renters-per-100m rank + top-20-agency-listings-
    per-100m rank) and the best TOP_N are kept.

Inputs (must already exist):
  data/licence_locations.geojson
  data/HMO_Register_April_*_details.csv        (gitignored source register)
  data/Selective_Licence_Register*.csv         (gitignored source register)
  data/oxford_buildings.geojson                (OSM postcode -> street lookup)
  data/amenities.geojson                       (OSM amenities, for the meeting point)
  data/oxford_locality_anchors.json            (see build_locality_anchors.py)

Outputs (committed):
  data/doorknock_streets.geojson        — one Point per rental property on a
                                          shortlisted street (doors to knock)
  data/doorknock_meeting_points.geojson — a single Point: one overall
                                          gathering spot for the whole
                                          shortlist (a named, publicly-
                                          accessible amenity where possible),
                                          with a per-street breakdown of
                                          door/marker/renter counts and the
                                          density stats used to select it

Run time: a few seconds, no network calls (reuses committed data files).
"""

import csv, glob, json, math, os, re
from collections import defaultdict, Counter

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")

LICENCE_LOCATIONS   = os.path.join(DATA, "licence_locations.geojson")
BUILDINGS_GEOJSON    = os.path.join(DATA, "oxford_buildings.geojson")
AMENITIES_GEOJSON    = os.path.join(DATA, "amenities.geojson")
LOCALITY_ANCHORS     = os.path.join(DATA, "oxford_locality_anchors.json")
HMO_DETAILS_GLOB     = os.path.join(DATA, "HMO_Register_April_*_details.csv")
SELECTIVE_CSV_GLOB   = os.path.join(DATA, "Selective_Licence_Register*.csv")

OUT_STREETS          = os.path.join(DATA, "doorknock_streets.geojson")
OUT_MEETING_POINTS   = os.path.join(DATA, "doorknock_meeting_points.geojson")

COWLEY_DISTRICT_PREFILTER = "OX4"   # cheap prefilter; see nearest-locality check below
COWLEY_LOCALITY_NAMES = {"Cowley", "Temple Cowley"}
TOP_N_AGENCIES  = 20
TOP_N_STREETS   = 7

# Density-ranking guardrails (see module docstring)
MIN_LISTINGS  = 5      # a street needs at least this many licences to rank
MIN_MARKERS   = 3      # ...spread across at least this many distinct points
SPAN_FLOOR_M  = 50      # minimum assumed street length, in metres

# Landmark amenity types worth meeting at (publicly accessible, easy to find)
MEETING_AMENITY_TYPES = {
    'pub', 'cafe', 'restaurant', 'bar', 'fast_food',
    'community_centre', 'library', 'place_of_worship', 'parking',
}
MEETING_AMENITY_MAX_M = 500  # snap to a landmark only if within this radius


# ── Occupant counts (renter proxy) ──────────────────────────────────────────

def load_occupants():
    occupants = {}
    hmo_files = glob.glob(HMO_DETAILS_GLOB)
    for path in hmo_files:
        with open(path, encoding="latin-1") as f:
            for row in csv.DictReader(f):
                cid = row.get("Case Number", "").strip()
                try:
                    occupants[cid] = int(row["Occupants"])
                except (ValueError, KeyError):
                    pass

    sel_files = glob.glob(SELECTIVE_CSV_GLOB)
    for path in sel_files:
        with open(path, encoding="latin-1") as f:
            for row in csv.DictReader(f):
                cid = row.get("Licence reference number", "").strip()
                try:
                    occupants[cid] = int(row["Maximum permitted occupants"])
                except (ValueError, KeyError):
                    pass
    return occupants


# ── Agent name normalisation (ported from static/app.js AGENT_NORM) ────────

_COMPANY_PAREN_RE = re.compile(
    r"\b(letting|management|property|properties|estate|residential|students|ltd|limited|llp|uk)\b", re.I)
_LEGAL_RE = re.compile(r"\b(limited|ltd\.?|llp|plc|l\.l\.p\.?)\b\.?", re.I)
_TRAILING_PAREN_RE = re.compile(r"\s*\(([^)]*)\)\s*$")


def preprocess_agent(raw):
    s = raw.strip()
    m = _TRAILING_PAREN_RE.search(s)
    if m:
        inner = m.group(1)
        s = s[:m.start()] + (" (" + inner + ")" if _COMPANY_PAREN_RE.search(inner) else "")
    s = _LEGAL_RE.sub("", s)
    s = re.sub(r"\band\b", "&", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip().rstrip(",").strip()
    return s


AGENT_NORM = [
    ("Balliol College", ["balliol college"]), ("Brasenose College", ["brasenose college"]),
    ("Christ Church", ["christ church"]), ("Corpus Christi College", ["corpus christi college"]),
    ("Exeter College", ["exeter college"]), ("Hertford College", ["hertford college"]),
    ("Jesus College", ["jesus college"]), ("Keble College", ["keble college"]),
    ("Lady Margaret Hall", ["lady margaret hall"]), ("Linacre College", ["linacre college"]),
    ("Lincoln College", ["lincoln college"]), ("Magdalen College", ["magdalen college"]),
    ("Mansfield College", ["mansfield college"]), ("Merton College", ["merton college"]),
    ("New College", ["new college"]), ("Nuffield College", ["nuffield college"]),
    ("Oriel College", ["oriel college"]), ("Pembroke College", ["pembroke college"]),
    ("Queen's College", ["queen's college"]), ("Reuben College", ["reuben college"]),
    ("Regent's Park College", ["regent's park college"]), ("Somerville College", ["somerville college"]),
    ("St Anne's College", ["st anne's college"]), ("St Antony's College", ["st antony's college"]),
    ("St Catherine's College", ["st catherine's college"]), ("St Cross College", ["st cross college"]),
    ("St Edmund Hall", ["st edmund hall"]), ("St Hilda's College", ["st hilda's college"]),
    ("St Hugh's College", ["st hugh's college"]), ("St John's College", ["st john's college"]),
    ("St Peter's College", ["st peter's college"]), ("Trinity College", ["trinity college"]),
    ("University College", ["university college"]), ("Wadham College", ["wadham college"]),
    ("Wolfson College", ["wolfson college"]), ("Worcester College", ["worcester college"]),
    ("Wycliffe Hall", ["wycliffe hall"]), ("Green Templeton College", ["green templeton"]),
    ("Harris Manchester College", ["harris manchester"]), ("Kellogg College", ["kellogg college"]),
    ("Oxford Brookes University", ["oxford brookes"]),
    # ── Commercial letting agencies ─────────────────────────────────────────
    ("Chancellors", ["chancellors"]), ("Finders Keepers", ["finders keepers"]),
    ("Breckon & Breckon", ["breckon & breckon"]),
    ("Scott Fraser", ["scott fraser", "scottfraser", "leaders"]),
    ("NOPS", ["north oxford property services", "nops"]),
    ("College & County", ["college & county"]), ("LPM Residential", ["lpm residential"]),
    ("Penny & Sinclair", ["penny & sinclair"]), ("Carter Jonas", ["carter jonas"]),
    ("Savills", ["savills"]), ("Martin & Co", ["martin & co", "urwin (oxford)"]),
    ("Oxford Lettings", ["oxford lettings"]), ("Thomas Merrifield", ["thomas merrifield"]),
    ("Portfolio Properties", ["portfolio properties oxford"]), ("RMA Properties", ["rma properties"]),
    ("Abbey Group", ["abbey group"]), ("Chesterton Yeates", ["chesterton yeates"]),
    ("Elwood & Co", ["elwood & co"]), ("Taylors", ["taylors"]),
    ("John D Wood & Co", ["john d wood"]), ("Host Student Housing", ["host student housing"]),
    ("Lee & Lindars", ["lee & lindars"]), ("Hutton Parker", ["hutton parker"]),
    ("Enfields Lettings", ["enfields lettings"]), ("Homes for Students", ["homes for students"]),
    ("WEST Property", ["west - the property"]), ("Amelie's", ["amelies", "amelie's"]),
    ("Hunters", ["hunters"]), ("Nicholas Jones", ["nicholas jones residential"]),
    ("Bright Properties", ["bright properties"]), ("Top Lettings", ["top lettings"]),
    ("NMH Residential", ["nmh residential"]), ("Reaston-Brown Rentals", ["reaston-brown"]),
    ("City Properties", ["city properties"]), ("Andrews", ["andrews"]),
    ("Sterling Lettings", ["sterling lettings"]), ("Almero Students", ["almero students"]),
    ("City Estates", ["city estates"]), ("Bloomsbury Property", ["bloomsbury property"]),
    ("Oxfordshire Lettings", ["oxfordshire lettings"]), ("Hamways", ["hamways"]),
    ("James C Penny", ["james c penny"]), ("Stonecopper", ["stonecopper"]),
    ("The Rent Guru", ["rent guru"]), ("Oxford Heritage", ["oxford heritage"]),
]

UNI_LABELS = {
    'Balliol College', 'Brasenose College', 'Christ Church', 'Corpus Christi College',
    'Exeter College', 'Hertford College', 'Jesus College', 'Keble College',
    'Lady Margaret Hall', 'Linacre College', 'Lincoln College', 'Magdalen College',
    'Mansfield College', 'Merton College', 'New College', 'Nuffield College',
    'Oriel College', 'Pembroke College', "Queen's College", 'Reuben College',
    "Regent's Park College", 'Somerville College', "St Anne's College",
    "St Antony's College", "St Catherine's College", 'St Cross College',
    'St Edmund Hall', "St Hilda's College", "St Hugh's College", "St John's College",
    "St Peter's College", 'Trinity College', 'University College', 'Wadham College',
    'Wolfson College', 'Worcester College', 'Wycliffe Hall', 'Green Templeton College',
    'Harris Manchester College', 'Kellogg College', 'Oxford Brookes University',
}
COMMERCIAL_AGENCY_LABELS = {label for label, _ in AGENT_NORM} - UNI_LABELS


def canonical_agent(raw):
    if not raw:
        return None
    pre = preprocess_agent(raw)
    lower = pre.lower()
    for label, terms in AGENT_NORM:
        for term in terms:
            if term in lower:
                return label
    return pre


# ── Address / street parsing ────────────────────────────────────────────────

POSTCODE_FULL_RE = re.compile(r"(OX\d{1,2})\s*(\d[A-Z]{2})\s*$", re.I)
NUMERIC_PART_RE = re.compile(
    r"^(flat|upper flat|lower flat|ground floor flat|first floor flat|second floor flat)?"
    r"\s*\d+[a-zA-Z]?(\s*-\s*\d+[a-zA-Z]?)?$", re.I)
LEADING_NUM_RE = re.compile(r"^\s*(flat\s+\d+[a-zA-Z]?,?\s*)?\d+[a-zA-Z]?(\s*-\s*\d+[a-zA-Z]?)?\s*", re.I)


def extract_postcode(address):
    m = POSTCODE_FULL_RE.search(address.strip())
    return (m.group(1) + m.group(2)).upper() if m else None


def extract_district(address):
    m = POSTCODE_FULL_RE.search(address.strip())
    return m.group(1).upper() if m else None


def extract_street_fallback(address):
    addr_no_pc = POSTCODE_FULL_RE.sub("", address.strip()).rstrip(", ").strip()
    parts = [p.strip() for p in addr_no_pc.split(",")]
    parts = [p for p in parts if p and p.lower() != "oxford"]
    parts = [p for p in parts if not NUMERIC_PART_RE.match(p)]
    if not parts:
        return None
    candidate = parts[-1]
    candidate = LEADING_NUM_RE.sub("", candidate).strip()
    return candidate or None


def norm_key(s):
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def load_locality_anchors():
    with open(LOCALITY_ANCHORS) as f:
        return json.load(f)


def nearest_locality(lat, lon, anchors):
    best = min(anchors, key=lambda a: (a["lat"] - lat) ** 2 + (a["lon"] - lon) ** 2)
    return best["name"]


def load_postcode_street_lookup():
    with open(BUILDINGS_GEOJSON) as f:
        bd = json.load(f)
    pc_street = defaultdict(Counter)
    for feat in bd["features"]:
        p = feat["properties"]
        pc = (p.get("addr_postcode") or "").strip().upper().replace(" ", "")
        st = (p.get("addr_street") or "").strip()
        if pc and st:
            pc_street[pc][st] += 1
    return {pc: c.most_common(1)[0][0] for pc, c in pc_street.items()}


# ── Build per-licence records ────────────────────────────────────────────────

def build_records():
    occupants = load_occupants()
    pc_to_street = load_postcode_street_lookup()

    with open(LICENCE_LOCATIONS) as f:
        geo = json.load(f)

    records = []
    for feat in geo["features"]:
        p = feat["properties"]
        addr = p.get("address", "")
        postcode = extract_postcode(addr)
        district = extract_district(addr)
        fallback_street = extract_street_fallback(addr)
        street = pc_to_street.get(postcode, fallback_street)
        agent_raw = p.get("agent", "")
        records.append({
            "id": p["id"],
            "type": p.get("type"),
            "address": addr,
            "postcode": postcode,
            "district": district,
            "street": street,
            "agent_raw": agent_raw,
            "agent_canon": canonical_agent(agent_raw) if agent_raw else None,
            "occupants": occupants.get(p["id"]),
            "lon": feat["geometry"]["coordinates"][0],
            "lat": feat["geometry"]["coordinates"][1],
        })

    # Collapse "Development Name + Real Street" duplicates using the
    # authoritative OSM postcode->street entries as ground truth, then merge
    # apostrophe/punctuation variants (e.g. "St Clements" vs "St Clement's")
    # under a single display label.
    confirmed_streets = set(pc_to_street.values())
    confirmed_by_norm = {}
    for cs in confirmed_streets:
        confirmed_by_norm.setdefault(norm_key(cs), cs)

    for r in records:
        st = r["street"]
        if not st:
            continue
        nk = norm_key(st)
        if nk in confirmed_by_norm:
            continue
        for cs_norm, cs in confirmed_by_norm.items():
            if nk.endswith(cs_norm) and nk != cs_norm and nk[-(len(cs_norm) + 1)] == " ":
                r["street"] = cs
                break

    group_counts = defaultdict(Counter)
    for r in records:
        if r["street"]:
            group_counts[norm_key(r["street"])][r["street"]] += 1
    canon_label = {k: c.most_common(1)[0][0] for k, c in group_counts.items()}
    for r in records:
        if r["street"]:
            r["street"] = canon_label[norm_key(r["street"])]

    return records


# ── Street length estimate ──────────────────────────────────────────────────

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def robust_span_m(points):
    """Estimate how far apart a street's property points are spread, in
    metres, robust to the odd mis-geocoded outlier: project every point onto
    the principal axis of the point cloud (PCA) and take the 5th-95th
    percentile range of that projection, rather than the raw max-pairwise
    distance (which a single bad geocode can blow up to several km)."""
    n = len(points)
    if n < 2:
        return 0.0
    lat0 = sum(p["lat"] for p in points) / n
    lon0 = sum(p["lon"] for p in points) / n
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat0))
    xs = [(p["lon"] - lon0) * m_per_deg_lon for p in points]
    ys = [(p["lat"] - lat0) * m_per_deg_lat for p in points]
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs) / n
    syy = sum((y - my) ** 2 for y in ys) / n
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / n
    theta = 0.5 * math.atan2(2 * sxy, sxx - syy)
    proj = sorted((xs[i] - mx) * math.cos(theta) + (ys[i] - my) * math.sin(theta) for i in range(n))
    lo = proj[max(0, int(0.05 * n))]
    hi = proj[min(n - 1, int(0.95 * n))]
    return hi - lo


# ── Ranking ───────────────────────────────────────────────────────────────

def rank_streets(records, anchors):
    agency_counts = defaultdict(int)
    for r in records:
        if r["agent_canon"] in COMMERCIAL_AGENCY_LABELS:
            agency_counts[r["agent_canon"]] += 1
    top_agencies = sorted(agency_counts.items(), key=lambda x: -x[1])[:TOP_N_AGENCIES]
    top_agency_names = {name for name, _ in top_agencies}

    # OX4 first (cheap prefilter), then the real Cowley-vs-neighbours check:
    # nearest named locality must be Cowley or Temple Cowley, not Rose Hill /
    # Littlemore / Blackbird Leys / Iffley / St Clement's (all also OX4).
    prefiltered = [r for r in records if r["district"] == COWLEY_DISTRICT_PREFILTER and r["street"]]
    cowley = [r for r in prefiltered if nearest_locality(r["lat"], r["lon"], anchors) in COWLEY_LOCALITY_NAMES]

    by_street = defaultdict(list)
    for r in cowley:
        by_street[r["street"]].append(r)

    street_stats = {}
    for street, pts in by_street.items():
        markers = len({(r["lon"], r["lat"]) for r in pts})
        if len(pts) < MIN_LISTINGS or markers < MIN_MARKERS:
            continue  # too small a sample to estimate walking density from
        renters = sum(r["occupants"] or 0 for r in pts)
        top20_listings = sum(1 for r in pts if r["agent_canon"] in top_agency_names)
        span_m = max(robust_span_m(pts), SPAN_FLOOR_M)
        span_units = span_m / 100.0
        street_stats[street] = {
            "renters": renters,
            "listings": len(pts),
            "top20_listings": top20_listings,
            "span_m": round(span_m),
            "renters_per_100m": renters / span_units,
            "top20_per_100m": top20_listings / span_units,
        }

    by_renters = sorted(street_stats.items(), key=lambda x: -x[1]["renters_per_100m"])
    by_top20 = sorted(street_stats.items(), key=lambda x: -x[1]["top20_per_100m"])
    rank_r = {name: i for i, (name, _) in enumerate(by_renters)}
    rank_t = {name: i for i, (name, _) in enumerate(by_top20)}

    combined = sorted(street_stats.items(), key=lambda x: rank_r[x[0]] + rank_t[x[0]])
    shortlist = [name for name, _ in combined[:TOP_N_STREETS]]

    return shortlist, street_stats, top_agency_names, cowley


# ── Meeting point (one, for the whole shortlist) ────────────────────────────
# A single gathering spot, not one per street: real canvasses start together
# (safety briefing, pairing up, splitting into teams) and then fan out, they
# don't need a separate rendezvous per street.

def load_meeting_amenities():
    with open(AMENITIES_GEOJSON) as f:
        am = json.load(f)
    out = []
    for feat in am["features"]:
        p = feat["properties"]
        if p.get("amenity") in MEETING_AMENITY_TYPES and p.get("name"):
            lon, lat = feat["geometry"]["coordinates"]
            out.append({"name": p["name"], "amenity": p["amenity"], "lon": lon, "lat": lat})
    return out


def pick_meeting_point(points, amenities):
    """Prefer a real, publicly-accessible landmark (pub/cafe/library/etc.)
    near the centroid of every shortlisted street's points — weighted by how
    many properties each street contributes, so the point stays central to
    where the doors actually are rather than the simple average of 7 street
    midpoints. "Meet outside 40 Some Road" is a much worse instruction than
    "meet at The Rusty Bicycle", so this falls back to the actual property
    point closest to the centroid (a medoid) only when no landmark is close
    enough. A car park is preferred among equally-close landmarks since most
    canvassers will be driving in from outside the immediate area."""
    lat_c = sum(p["lat"] for p in points) / len(points)
    lon_c = sum(p["lon"] for p in points) / len(points)

    nearby = sorted(
        amenities,
        key=lambda a: (
            0 if a["amenity"] == "parking" else 1,
            haversine_m(lat_c, lon_c, a["lat"], a["lon"]),
        ),
    )
    within_range = [a for a in nearby if haversine_m(lat_c, lon_c, a["lat"], a["lon"]) <= MEETING_AMENITY_MAX_M]
    if within_range:
        best = within_range[0]
        return {
            "lat": best["lat"], "lon": best["lon"],
            "label": best["name"] + " (" + best["amenity"].replace("_", " ") + ")",
        }

    medoid = min(points, key=lambda p: (p["lat"] - lat_c) ** 2 + (p["lon"] - lon_c) ** 2)
    return {"lat": medoid["lat"], "lon": medoid["lon"], "label": "near " + medoid["address"]}


def main():
    records = build_records()
    anchors = load_locality_anchors()
    shortlist, street_stats, top_agency_names, cowley = rank_streets(records, anchors)
    amenities = load_meeting_amenities()

    print("Shortlisted streets (best combined renters/100m + top-20-agency/100m rank):")
    for name in shortlist:
        s = street_stats[name]
        print(f"  {name}: {s['renters']} renters over ~{s['span_m']}m "
              f"({s['renters_per_100m']:.0f}/100m), {s['listings']} listings, "
              f"{s['top20_listings']} top-20-agency listings ({s['top20_per_100m']:.1f}/100m)")

    shortlist_set = set(shortlist)
    street_records = [r for r in cowley if r["street"] in shortlist_set]

    # ── data/doorknock_streets.geojson — one marker per rental property,
    #    deduplicated by exact coordinate the same way static/app.js does
    #    for the main HMO/Selective layers ("markers" = distinct pins).
    coord_groups = defaultdict(list)
    for r in street_records:
        coord_groups[(r["lon"], r["lat"])].append(r)

    door_features = []
    for (lon, lat), group in coord_groups.items():
        addresses = sorted({r["address"] for r in group})
        agents = sorted({r["agent_canon"] for r in group if r["agent_canon"]})
        street = group[0]["street"]
        door_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "street": street,
                "addresses": addresses,
                "agents": agents,
                "top20_agency": any(a in top_agency_names for a in agents),
                "door_count": len(addresses),
            },
        })

    with open(OUT_STREETS, "w") as f:
        json.dump({"type": "FeatureCollection", "features": door_features}, f, indent=1)
    print(f"\nWrote {len(door_features)} markers -> {OUT_STREETS}")

    # ── data/doorknock_meeting_points.geojson — ONE overall meeting point for
    #    the whole shortlist, plus a per-street door/marker/renter breakdown.
    street_breakdown = []
    for street in shortlist:
        pts = [r for r in street_records if r["street"] == street]
        doors = len({r["address"] for r in pts})
        markers = len({(r["lon"], r["lat"]) for r in pts})
        s = street_stats[street]
        street_breakdown.append({
            "street": street,
            "doors": doors,
            "markers": markers,
            "renters": s["renters"],
            "renters_per_100m": round(s["renters_per_100m"], 1),
            "top20_agency_listings": s["top20_listings"],
            "top20_per_100m": round(s["top20_per_100m"], 2),
            "span_m": s["span_m"],
        })

    meeting = pick_meeting_point(street_records, amenities)
    meeting_feature = {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [meeting["lon"], meeting["lat"]]},
        "properties": {
            "meeting_label": meeting["label"],
            "total_doors": sum(s["doors"] for s in street_breakdown),
            "total_markers": sum(s["markers"] for s in street_breakdown),
            "total_renters": sum(s["renters"] for s in street_breakdown),
            "streets": street_breakdown,
        },
    }

    with open(OUT_MEETING_POINTS, "w") as f:
        json.dump({"type": "FeatureCollection", "features": [meeting_feature]}, f, indent=1)
    print(f"\nMeeting point: {meeting['label']} -> {OUT_MEETING_POINTS}")


if __name__ == "__main__":
    main()
