#!/usr/bin/env python3
"""
build_holder_normalised.py
--------------------------
Produces data/holder_normalised.csv — all licence holders (HMO + Selective)
indexed by property address, with normalised names and entity grouping.

Normalization steps applied
----------------------------
1.  Strip title prefixes  (Mr / Mrs / Ms / Miss / Dr / Prof / Rev / The)
2.  Strip trailing (PersonName) from company names
    e.g. "Merton College (Tim Lightfoot)" → "Merton College"
3.  Strip legal suffixes  (Ltd / Limited / LLP / PLC)
4.  Detect "C/O CompanyName" in holder_address → use company as entity
5.  Detect agency names embedded in holder_address
    e.g. "RMA Properties Ltd 101A Cowley Road" → entity = "RMA Properties"
6.  Identify known institutional entities (Oxford colleges, OUP, etc.)
7.  Assign entity_key:
      - Company / institution → normalised company name
      - Person → "<normalised_postcode>|<normalised_surname>"
        (groups family members and name-variant typos at the same address)
8.  Flag is_agency: holder is itself a letting agency (not a landlord)

Output columns
--------------
  property_address  — geocoded property (the actual HMO/selective address)
  licence_id        — original register reference
  licence_type      — "hmo" or "selective"
  lsoa              — LSOA name
  agent             — managing agent (resolved by build_address_lookup.py)
  holder_raw        — original holder name from register
  holder_normalised — cleaned name (titles + legal suffixes stripped)
  holder_entity     — grouped key for de-duplication analysis
  holder_address    — holder's address from register
  holder_postcode   — extracted postcode (or empty)
  is_agency         — 1 if holder appears to be a letting agency

Run after build_address_lookup.py.  No network calls — completes in seconds.
Output: data/holder_normalised.csv  (gitignored — contains holder names)
"""

import csv, json, os, re, sys
from collections import defaultdict

ROOT   = os.path.join(os.path.dirname(__file__), "..")
DATA   = os.path.join(ROOT, "data")
LOOKUP = os.path.join(DATA, "licence_address_lookup.json")
GJ     = os.path.join(DATA, "licence_locations.geojson")
OUT    = os.path.join(DATA, "holder_normalised.csv")

# ── Regex helpers ──────────────────────────────────────────────────────────

UK_POSTCODE_RE = re.compile(
    r'\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b', re.IGNORECASE
)
TITLE_RE = re.compile(
    r'^(mr\.?|mrs\.?|ms\.?|miss\.?|dr\.?|prof\.?|rev\.?|sir\.?'
    r'|the\s+rev\.?|rt\.?\s+hon\.?)\s+',
    re.IGNORECASE,
)
LEGAL_SUFFIX_RE = re.compile(
    r'\b(limited|ltd\.?|llp\.?|plc\.?|l\.l\.p\.?)\b\.?',
    re.IGNORECASE,
)
# Person name in trailing parens — strip when the outer name is a company
COMPANY_KEYWORDS_RE = re.compile(
    r'\b(letting|lettings|management|property|properties|estate|estates|'
    r'residential|students|ltd|limited|llp|plc|group|realty|homes|'
    r'rentals|agents?|housing|services|college|university|press|'
    r'investment|investments|trust|trustees|fund|foundation|'
    r'solutions|council|church|hall|school)\b',
    re.IGNORECASE,
)
PERSON_PAREN_RE  = re.compile(r'\s*\(([^)]+)\)\s*$')
CO_RE            = re.compile(r'^c/o\s*,?\s*', re.IGNORECASE)


# ── Name normalization ─────────────────────────────────────────────────────

def _looks_like_company(s: str) -> bool:
    return bool(COMPANY_KEYWORDS_RE.search(s)) or '&' in s


def _strip_person_paren(name: str) -> str:
    """Remove trailing (PersonName) from a company name string."""
    m = PERSON_PAREN_RE.search(name)
    if m:
        inner = m.group(1)
        # Keep if inner itself looks like a company qualifier
        if not _looks_like_company(inner):
            return name[:m.start()].strip()
    return name


def normalise_name(raw: str) -> str:
    """Clean a holder name: strip titles, person parens, legal suffixes."""
    s = raw.strip()
    # Strip leading title
    s = TITLE_RE.sub('', s).strip()
    # Strip trailing (PersonName) if outer is a company
    if _looks_like_company(s):
        s = _strip_person_paren(s)
    # Strip legal suffixes
    s = LEGAL_SUFFIX_RE.sub('', s)
    # Collapse whitespace and trailing punctuation
    s = re.sub(r'\s+', ' ', s).strip().rstrip(',.').strip()
    return s


def extract_postcode(address: str) -> str:
    m = UK_POSTCODE_RE.search(address)
    return m.group(1).upper().replace(' ', '') if m else ''


def extract_postcode_area(postcode: str) -> str:
    """OX4 1AB → OX4"""
    return re.sub(r'\d[A-Z]{2}$', '', postcode).strip()


def extract_surname(name: str) -> str:
    """Best-effort last word as surname, lower-cased."""
    parts = name.strip().split()
    return parts[-1].lower() if parts else ''


# ── Entity detection ───────────────────────────────────────────────────────

# Known institutional entities that appear under many name variants
KNOWN_ENTITIES = [
    # (match substring, canonical entity key)
    ("st. john's college",      "St John's College Oxford"),
    ("st johns college",        "St John's College Oxford"),
    ("st john's college",       "St John's College Oxford"),
    ("merton college",          "Merton College Oxford"),
    ("christ church",           "Christ Church Oxford"),
    ("dean and chapter",        "Christ Church Oxford"),
    ("dean & chapter",          "Christ Church Oxford"),
    ("worcester college",       "Worcester College Oxford"),
    ("exeter college",          "Exeter College Oxford"),
    ("hertford college",        "Hertford College Oxford"),
    ("pembroke college",        "Pembroke College Oxford"),
    ("oriel college",           "Oriel College Oxford"),
    ("keble college",           "Keble College Oxford"),
    ("wadham college",          "Wadham College Oxford"),
    ("lincoln college",         "Lincoln College Oxford"),
    ("balliol college",         "Balliol College Oxford"),
    ("magdalen college",        "Magdalen College Oxford"),
    ("new college",             "New College Oxford"),
    ("corpus christi college",  "Corpus Christi College Oxford"),
    ("somerville college",      "Somerville College Oxford"),
    ("st hilda's college",      "St Hilda's College Oxford"),
    ("st anne's college",       "St Anne's College Oxford"),
    ("st antony's college",     "St Antony's College Oxford"),
    ("st catherine's college",  "St Catherine's College Oxford"),
    ("st peter's college",      "St Peter's College Oxford"),
    ("st edmund hall",          "St Edmund Hall Oxford"),
    ("st edward's school",      "St Edward's School Oxford"),
    ("lady margaret hall",      "Lady Margaret Hall Oxford"),
    ("harris manchester",       "Harris Manchester College Oxford"),
    ("wycliffe hall",           "Wycliffe Hall Oxford"),
    ("nuffield college",        "Nuffield College Oxford"),
    ("oxford university press", "Oxford University Press"),
    ("lucy group",              "Lucy Group Ltd"),
    ("rma properties",          "RMA Properties"),
    ("oxford lettings",         "Oxford Lettings"),
    ("hutton parker",           "Hutton Parker Property Management"),
    ("college & county",        "College & County"),
    ("college and county",      "College & County"),
    ("finders keepers",         "Finders Keepers"),
    ("penny & sinclair",        "Penny & Sinclair"),
    ("penny and sinclair",      "Penny & Sinclair"),
    ("chancellors",             "Chancellors"),
    ("scott fraser",            "Scott Fraser"),
    ("scottfraser",             "Scott Fraser"),
    ("breckon & breckon",       "Breckon & Breckon"),
    ("breckon and breckon",     "Breckon & Breckon"),
    ("north oxford property",   "NOPS"),
    ("sterling lettings",       "Sterling Lettings & Management"),
    ("sterling letting",        "Sterling Lettings & Management"),
    ("chesterton yeates",       "Chesterton Yeates"),
    ("asset max",               "Asset Max"),
    ("homefinders oxford",      "Homefinders Oxford"),
    ("legal & general",         "Legal & General Investment Management"),
    ("legal and general",       "Legal & General Investment Management"),
    ("swailes",                 "Swailes Family Estates"),
    ("licentia",                "Licentia"),
    ("lark nest",               "Lark Nest Estates"),
    ("raja brothers",           "Raja / RMA Group"),
    ("mohammed razvan raja",    "Raja / RMA Group"),
    ("granat",                  "David Granat / OX Living"),
    ("ox living",               "David Granat / OX Living"),
    ("heritage properties oxford", "Oxford Heritage Property Management"),
    ("oxford heritage",         "Oxford Heritage Property Management"),
    ("lpm residential",         "LPM Residential"),
    ("portfolio properties",    "Portfolio Properties Oxford"),
    ("bright properties",       "Bright Properties Oxford"),
    ("city properties",         "City Properties Oxford"),
    ("top lettings",            "Top Lettings"),
    ("nmh residential",         "NMH Residential"),
    ("enfields lettings",       "Enfields Lettings"),
    ("west property",           "WEST Property"),
    ("west - the property",     "WEST Property"),
    ("almero students",         "Almero Students"),
    ("host student housing",    "Host Student Housing"),
    ("homes for students",      "Homes for Students"),
    ("letting & property agency", "Letting & Property Agency"),
]

# Known letting agency names — holders with these names are agencies not landlords
AGENCY_NAMES = {
    "Finders Keepers", "Hutton Parker Property Management",
    "College & County", "Penny & Sinclair", "Chancellors",
    "Scott Fraser", "Breckon & Breckon", "NOPS",
    "Sterling Lettings & Management", "Chesterton Yeates",
    "Oxford Lettings", "RMA Properties", "Asset Max", "Homefinders Oxford",
    "LPM Residential", "Portfolio Properties Oxford", "Bright Properties Oxford",
    "City Properties Oxford", "Top Lettings", "NMH Residential",
    "Enfields Lettings", "WEST Property", "Almero Students",
    "Host Student Housing", "Homes for Students", "Letting & Property Agency",
}


def known_entity(name_lower: str, addr_lower: str) -> str | None:
    """Return canonical entity key if name or address matches a known entity."""
    combined = name_lower + ' ' + addr_lower
    for substring, canonical in KNOWN_ENTITIES:
        if substring in combined:
            return canonical
    return None


def entity_key(holder_raw: str, holder_norm: str, holder_address: str) -> tuple[str, bool]:
    """
    Returns (entity_key, is_agency).
    entity_key is used for grouping/de-duplication.
    """
    name_lower = holder_raw.lower()
    addr_lower = holder_address.lower()

    # 1. Handle C/O — entity is the company/person after "c/o"
    if CO_RE.match(holder_address.strip()):
        after_co = CO_RE.sub('', holder_address.strip()).strip().rstrip(',').strip()
        # Use first meaningful word(s) as entity
        entity = normalise_name(after_co.split(',')[0].strip())
        return entity, False

    # 2. Known entities (colleges, large landlords, agencies)
    ke = known_entity(name_lower, addr_lower)
    if ke:
        is_ag = ke in AGENCY_NAMES
        return ke, is_ag

    # 3. Company name (has company keywords or &)
    if _looks_like_company(holder_norm):
        key = re.sub(r'\s+', ' ', holder_norm).strip()
        return key, False

    # 4. Person: group by postcode area + surname
    postcode = extract_postcode(holder_address)
    pc_area  = extract_postcode_area(postcode) if postcode else ''
    surname  = extract_surname(holder_norm)
    if pc_area and surname:
        return f"{pc_area}|{surname}", False
    elif surname:
        return f"person|{surname}", False
    return holder_norm or holder_raw, False


# ── Main ───────────────────────────────────────────────────────────────────

def licence_type(lid: str) -> str:
    return 'hmo' if 'HMO' in lid.upper() else 'selective'


def main():
    for path in [LOOKUP, GJ]:
        if not os.path.exists(path):
            sys.exit(f"ERROR: file not found: {path}")

    print("Loading data…")
    with open(LOOKUP) as f:
        lookup = json.load(f)
    with open(GJ) as f:
        gj = json.load(f)

    # Build id → lsoa from geojson
    id_to_lsoa = {feat['properties']['id']: feat['properties'].get('lsoa', '')
                  for feat in gj['features']}

    print(f"  {len(lookup)} lookup entries")

    rows = []
    entity_counts = {}

    for lid, meta in lookup.items():
        holder_raw  = meta.get('holder', '').strip()
        if not holder_raw:
            continue

        holder_addr = meta.get('holder_address', '').strip()
        holder_norm = normalise_name(holder_raw)
        ek, is_ag   = entity_key(holder_raw, holder_norm, holder_addr)
        postcode    = extract_postcode(holder_addr)
        entity_counts[ek] = entity_counts.get(ek, 0) + 1

        rows.append({
            'property_address': meta.get('address', ''),
            'licence_id':       lid,
            'licence_type':     licence_type(lid),
            'lsoa':             id_to_lsoa.get(lid, ''),
            'agent':            meta.get('agent', ''),
            'holder_raw':       holder_raw,
            'holder_normalised': holder_norm,
            'holder_entity':    ek,
            'holder_address':   holder_addr,
            'holder_postcode':  postcode,
            'is_agency':        1 if is_ag else 0,
        })

    # Attach entity property count to each row for analysis
    for row in rows:
        row['entity_property_count'] = entity_counts[row['holder_entity']]

    # Sort by entity count desc, then entity key, then address
    rows.sort(key=lambda r: (-r['entity_property_count'], r['holder_entity'], r['property_address']))

    fields = [
        'property_address', 'licence_id', 'licence_type', 'lsoa',
        'agent', 'holder_raw', 'holder_normalised', 'holder_entity',
        'holder_address', 'holder_postcode', 'is_agency', 'entity_property_count',
    ]

    with open(OUT, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    print(f"  Written {len(rows)} rows → {OUT}")

    # Summary
    print(f"\n── Summary ─────────────────────────────────────────────────────")
    print(f"  Total holder rows:       {len(rows)}")
    unique_entities = len(entity_counts)
    print(f"  Unique entity keys:      {unique_entities}")
    agencies = sum(1 for r in rows if r['is_agency'])
    print(f"  Rows flagged as agency:  {agencies}")

    print(f"\n  Top 30 entities by property count:")
    for ek, cnt in sorted(entity_counts.items(), key=lambda x: -x[1])[:30]:
        print(f"  {cnt:5d}  {ek}")


if __name__ == '__main__':
    main()
