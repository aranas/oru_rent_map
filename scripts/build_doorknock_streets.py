#!/usr/bin/env python3
"""
build_doorknock_streets.py
---------------------------
Builds the data feeding the "Doorknock streets" map overlay.

Identifies the densest small pockets ("blocks") in East Oxford by licence
DENSITY (per 150 sqm) AND by density of listings from the top 20 rental
agencies (by city-wide licence count), and groups the shortlist into
geographically-adjacent bundles (so the panel lists walkable clusters, not
a scatter of individual grid cells).

Method:
  - "East Oxford" = postcode sector OX4 1 (Bartlemas Road, Divinity Road,
    Magdalen Road, St Clement's, the northern/city end of Cowley Road and
    Iffley Road, etc.) — verified empirically against this dataset's own
    addresses, and distinct from Temple Cowley/Cowley (OX4 2-3), Rose Hill/
    Littlemore (OX4 4) and Blackbird Leys (OX4 6-7), which are separate
    neighbourhoods that happen to share the OX4 postcode district.
  - The ranking unit is a BLOCK_SIZE_M square grid cell, not a whole named
    street. An earlier version ranked whole streets by renters-per-length,
    which has a real failure mode: a long street can have one genuinely
    dense stretch sitting right next to another shortlisted street, but if
    the rest of that street is sparse, averaging over its full length
    dilutes the stretch below the cutoff (e.g. a dense pocket of Divinity
    Road immediately next to Bartlemas Road was invisible this way, because
    Divinity Road runs ~500m and most of it isn't that dense). Fixed-size
    blocks catch exactly that: a dense pocket scores on its own, regardless
    of what the rest of its street looks like, or even which street it's
    on — the bundling step below then reconnects it with its dense
    neighbours from other streets.
  - "Renters" = sum of registered occupants per block (Occupants for HMO,
    Maximum permitted occupants for Selective licences).
  - "Top 20 rental agencies" = the 20 highest-volume canonical commercial
    letting agencies city-wide, using the same name normalisation as
    static/app.js (AGENT_NORM), excluding Oxford colleges and self-managed
    landlords.
  - Blocks are ranked by renters-per-150sqm and top-20-agency-listings-
    per-150sqm — a block's area is fixed (BLOCK_SIZE_M x BLOCK_SIZE_M), so
    no length/footprint estimation is needed. Blocks with under
    MIN_LISTINGS properties or under MIN_MARKERS distinct geocoded points
    are excluded (too small a sample to trust). Blocks are ranked by
    (renters-per-150sqm rank + top-20-agency-listings-per-150sqm rank) and
    the best TOP_N are kept. Each block is labelled with its most common
    street name(s), for display only.
  - The shortlist is then grouped into "bundles": blocks are grid cells, so
    adjacency is native — two shortlisted blocks bundle together if they
    share an edge or corner (Moore/8-connectivity), chained transitively
    via union-find. This is what actually reconnects a dense Divinity Road
    pocket with the neighbouring dense Bartlemas Road pocket into one
    walkable bundle, even though they're different named streets.

Inputs (must already exist):
  data/licence_locations.geojson
  data/HMO_Register_April_*_details.csv        (gitignored source register)
  data/Selective_Licence_Register*.csv         (gitignored source register)
  data/oxford_buildings.geojson                (OSM postcode -> street lookup)
  data/oxford_locality_anchors.json            (see build_locality_anchors.py)

Outputs (committed):
  data/doorknock_blocks.geojson  — one Polygon per shortlisted block: its
                                   exact grid-cell boundary (the
                                   doorknocking "unit" to walk), with a
                                   per-street breakdown (HMO count,
                                   privately-rented/Selective count, doors,
                                   renters) plus the block's own totals and
                                   density stats
  data/doorknock_bundles.json    — plain JSON: overall totals plus a
                                   breakdown by geographic bundle (each
                                   listing its member blocks, each with the
                                   same per-street HMO/Selective breakdown)

Run time: a few seconds, no network calls (reuses committed data files).
"""

import csv, glob, json, math, os, re
from collections import defaultdict, Counter

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")

LICENCE_LOCATIONS   = os.path.join(DATA, "licence_locations.geojson")
BUILDINGS_GEOJSON    = os.path.join(DATA, "oxford_buildings.geojson")
LOCALITY_ANCHORS     = os.path.join(DATA, "oxford_locality_anchors.json")
HMO_DETAILS_GLOB     = os.path.join(DATA, "HMO_Register_April_*_details.csv")
SELECTIVE_CSV_GLOB   = os.path.join(DATA, "Selective_Licence_Register*.csv")

OUT_BLOCKS   = os.path.join(DATA, "doorknock_blocks.geojson")
OUT_BUNDLES  = os.path.join(DATA, "doorknock_bundles.json")

EAST_OXFORD_SECTOR = "OX41"   # postcode sector (no space) — see docstring
TOP_N_AGENCIES = 20
TOP_N_BLOCKS   = 10            # keep the shortlist small enough that a
                                # canvassing team can scan it at a glance

# Density-ranking guardrails (see module docstring)
MIN_LISTINGS  = 4        # a block needs at least this many licences to rank
MIN_MARKERS   = 2        # ...spread across at least this many distinct points
BLOCK_SIZE_M  = 100.0     # grid cell edge length, in metres — roughly a real
                          # residential block face; small enough to isolate
                          # a dense pocket, large enough for a usable sample
AREA_UNIT_M2  = 150.0    # density is expressed per this many square metres


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


# ── Grid block assignment ───────────────────────────────────────────────────

def assign_block(lat, lon, lat0, block_size_m):
    """Snap a point to a (row, col) grid cell key. `lat0` fixes the
    metres-per-degree-longitude conversion for the whole grid (using each
    point's own latitude would make cells slightly non-square and,
    worse, inconsistent between points — this keeps every cell exactly
    block_size_m x block_size_m)."""
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat0))
    row = math.floor(lat * m_per_deg_lat / block_size_m)
    col = math.floor(lon * m_per_deg_lon / block_size_m)
    return row, col


def block_bounds(block, lat0, block_size_m):
    """The exact lat/lon rectangle for a (row, col) block key — the inverse
    of assign_block, so the boundary drawn on the map is precisely the grid
    cell used for ranking and bundling, not an approximation of it."""
    row, col = block
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat0))
    min_lat = row * block_size_m / m_per_deg_lat
    max_lat = (row + 1) * block_size_m / m_per_deg_lat
    min_lon = col * block_size_m / m_per_deg_lon
    max_lon = (col + 1) * block_size_m / m_per_deg_lon
    return min_lat, min_lon, max_lat, max_lon


def street_breakdown(pts):
    """Per-street breakdown within a block: how many HMO licences, how many
    privately-rented (Selective licence) properties, doors and renters —
    the level of detail a canvasser actually needs once they're standing on
    a specific street inside the block. Sorted by renters, busiest first."""
    by_street = defaultdict(list)
    for r in pts:
        by_street[r["street"]].append(r)
    rows = []
    for street, spts in by_street.items():
        rows.append({
            "street": street,
            "hmo_count": sum(1 for r in spts if r["type"] == "hmo"),
            "selective_count": sum(1 for r in spts if r["type"] == "selective"),
            "doors": len({r["address"] for r in spts}),
            "renters": sum(r["occupants"] or 0 for r in spts),
        })
    rows.sort(key=lambda x: -x["renters"])
    return rows


# ── Ranking ───────────────────────────────────────────────────────────────

def rank_blocks(records, anchors):
    agency_counts = defaultdict(int)
    for r in records:
        if r["agent_canon"] in COMMERCIAL_AGENCY_LABELS:
            agency_counts[r["agent_canon"]] += 1
    top_agencies = sorted(agency_counts.items(), key=lambda x: -x[1])[:TOP_N_AGENCIES]
    top_agency_names = {name for name, _ in top_agencies}

    candidates = [
        r for r in records
        if r["street"] and r["postcode"] and r["postcode"].startswith(EAST_OXFORD_SECTOR)
    ]
    lat0 = sum(r["lat"] for r in candidates) / len(candidates)

    by_block = defaultdict(list)
    for r in candidates:
        by_block[assign_block(r["lat"], r["lon"], lat0, BLOCK_SIZE_M)].append(r)

    area_units = (BLOCK_SIZE_M * BLOCK_SIZE_M) / AREA_UNIT_M2
    block_stats = {}
    for block, pts in by_block.items():
        markers = len({(r["lon"], r["lat"]) for r in pts})
        if len(pts) < MIN_LISTINGS or markers < MIN_MARKERS:
            continue  # too small a sample to estimate density from
        renters = sum(r["occupants"] or 0 for r in pts)
        top20_listings = sum(1 for r in pts if r["agent_canon"] in top_agency_names)
        streets = Counter(r["street"] for r in pts).most_common(2)
        lat_c = sum(r["lat"] for r in pts) / len(pts)
        lon_c = sum(r["lon"] for r in pts) / len(pts)
        block_stats[block] = {
            "renters": renters,
            "listings": len(pts),
            "markers": markers,
            "top20_listings": top20_listings,
            "renters_per_150sqm": renters / area_units,
            "top20_per_150sqm": top20_listings / area_units,
            "streets": [name for name, _ in streets],
            "label": " / ".join(name for name, _ in streets),
            "lat": lat_c,
            "lon": lon_c,
            "locality": nearest_locality(lat_c, lon_c, anchors),
        }

    by_renters = sorted(block_stats.items(), key=lambda x: -x[1]["renters_per_150sqm"])
    by_top20 = sorted(block_stats.items(), key=lambda x: -x[1]["top20_per_150sqm"])
    rank_r = {block: i for i, (block, _) in enumerate(by_renters)}
    rank_t = {block: i for i, (block, _) in enumerate(by_top20)}

    combined = sorted(block_stats.items(), key=lambda x: rank_r[x[0]] + rank_t[x[0]])
    shortlist = [block for block, _ in combined[:TOP_N_BLOCKS]]

    return shortlist, block_stats, top_agency_names, candidates, by_block


# ── Bundling (group the shortlist into geographically-adjacent clusters) ───

def bundle_blocks(shortlist):
    """Chain shortlisted blocks into bundles via union-find, using native
    grid adjacency rather than a distance threshold. This is what reconnects
    a dense pocket of one street with a dense pocket of a neighbouring
    street into a single walkable bundle.

    Deliberately edge-only (4-connectivity: north/south/east/west), not
    Moore/8-connectivity (which also counts diagonal touches): East Oxford
    is dense enough that with 8-connectivity, most of the shortlist ends up
    diagonally chained into one mega-bundle, which stops the list being
    useful for splitting into separate walkable teams. Edge-only still
    reconnects genuinely adjacent streets (that's an edge touch, not a
    corner touch) while keeping bundles to a handful of blocks each."""
    shortlist_set = set(shortlist)
    parent = {b: b for b in shortlist}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for (row, col) in shortlist:
        for drow, dcol in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            neighbour = (row + drow, col + dcol)
            if neighbour in shortlist_set:
                union((row, col), neighbour)

    groups = defaultdict(list)
    for b in shortlist:
        groups[find(b)].append(b)
    return list(groups.values())


def bundle_label(members_sorted, block_stats):
    """A readable label for a bundle: the distinct primary street names of
    its member blocks (highest-renter block first), e.g. "Divinity Road &
    Bartlemas Road" — this is exactly what surfaces a dense pocket of one
    street bundled with a dense pocket of its neighbour."""
    seen = []
    for b in members_sorted:
        primary = block_stats[b]["streets"][0]
        if primary not in seen:
            seen.append(primary)
    if len(seen) == 1:
        return seen[0]
    if len(seen) == 2:
        return seen[0] + " & " + seen[1]
    return seen[0] + ", " + seen[1] + f" + {len(seen) - 2} more"


def main():
    records = build_records()
    anchors = load_locality_anchors()
    shortlist, block_stats, top_agency_names, candidates, by_block = rank_blocks(records, anchors)

    print(f"Shortlisted blocks (top {TOP_N_BLOCKS} in East Oxford, {BLOCK_SIZE_M:.0f}m cells, "
          f"best combined renters/150sqm + top-20-agency/150sqm rank):")
    for block in shortlist:
        s = block_stats[block]
        print(f"  {s['label']} ({s['locality']}): {s['renters']} renters "
              f"({s['renters_per_150sqm']:.0f}/150sqm), {s['listings']} listings, "
              f"{s['top20_listings']} top-20-agency listings ({s['top20_per_150sqm']:.1f}/150sqm)")

    lat0 = sum(r["lat"] for r in candidates) / len(candidates)

    def block_summary(block):
        pts = by_block[block]
        s = block_stats[block]
        return {
            "block_id": f"{block[0]}_{block[1]}",
            "label": s["label"],
            "locality": s["locality"],
            "doors": len({r["address"] for r in pts}),
            "markers": s["markers"],
            "renters": s["renters"],
            "renters_per_150sqm": round(s["renters_per_150sqm"], 1),
            "top20_agency_listings": s["top20_listings"],
            "top20_per_150sqm": round(s["top20_per_150sqm"], 2),
            "lat": s["lat"],
            "lon": s["lon"],
            "streets": street_breakdown(pts),
        }

    # ── data/doorknock_blocks.geojson — one Polygon per shortlisted block:
    #    its exact grid-cell boundary (the doorknocking "unit"), with a
    #    per-street HMO/Selective breakdown.
    block_features = []
    for block in shortlist:
        min_lat, min_lon, max_lat, max_lon = block_bounds(block, lat0, BLOCK_SIZE_M)
        summary = block_summary(block)
        block_features.append({
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [min_lon, min_lat], [max_lon, min_lat],
                    [max_lon, max_lat], [min_lon, max_lat],
                    [min_lon, min_lat],
                ]],
            },
            "properties": summary,
        })

    with open(OUT_BLOCKS, "w") as f:
        json.dump({"type": "FeatureCollection", "features": block_features}, f, indent=1)
    print(f"\nWrote {len(block_features)} block boundaries -> {OUT_BLOCKS}")

    # ── data/doorknock_bundles.json — overall totals plus a breakdown by
    #    geographic bundle (each listing its member blocks, each with its
    #    own per-street breakdown).
    bundle_groups = bundle_blocks(shortlist)
    bundle_list = []
    for members in bundle_groups:
        members_sorted = sorted(members, key=lambda b: -block_stats[b]["renters_per_150sqm"])
        member_summaries = [block_summary(b) for b in members_sorted]
        bundle_list.append({
            "label": bundle_label(members_sorted, block_stats),
            "locality": block_stats[members_sorted[0]]["locality"],
            "doors": sum(m["doors"] for m in member_summaries),
            "markers": sum(m["markers"] for m in member_summaries),
            "renters": sum(m["renters"] for m in member_summaries),
            "top20_agency_listings": sum(m["top20_agency_listings"] for m in member_summaries),
            "blocks": member_summaries,
        })
    bundle_list.sort(key=lambda b: -b["renters"])

    print(f"\n{len(bundle_list)} bundle(s) (adjacent {BLOCK_SIZE_M:.0f}m blocks grouped together):")
    for b in bundle_list:
        print(f"  {b['label']}: {len(b['blocks'])} block(s), {b['doors']} doors, {b['renters']} renters")

    summary = {
        "total_doors": sum(b["doors"] for b in bundle_list),
        "total_markers": sum(b["markers"] for b in bundle_list),
        "total_renters": sum(b["renters"] for b in bundle_list),
        "bundles": bundle_list,
    }

    with open(OUT_BUNDLES, "w") as f:
        json.dump(summary, f, indent=1)
    print(f"\nWrote bundle summary -> {OUT_BUNDLES}")


if __name__ == "__main__":
    main()
