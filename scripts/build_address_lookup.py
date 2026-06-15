#!/usr/bin/env python3
"""
build_address_lookup.py
-----------------------
Produces data/licence_address_lookup.json — a mapping of licence ID → metadata dict.

Each HMO entry:
  { "address": "...", "agent": "...", "holder": "...", "holder_address": "..." }

Each Selective entry:
  { "address": "...", "agent": "...", "holder": "..." }

Agent resolution for HMO data
------------------------------
The contacts CSV has one or two rows per property (Case Number):
  - Party Type "Agent or Manager"  → agent name + agent address
  - Party Type "HMO Licence Holder" → holder name + holder address

Resolution rules (applied in order):
  1. If agent name == holder name → self-managed; agent field = holder name.
  2. If agent address == holder address AND names differ → the agent is working
     for a letting agency at that address.  We look up the agency name via the
     agency_address_table (built by scanning all entries where the agent name
     itself looks like a company).  If found → use the agency name.
     If not found → fall back to the raw agent name.
  3. Otherwise → use the agent name as-is.

agency_address_table
---------------------
Built by scanning every agent row:
  - If the agent name looks like a company (contains Ltd/LLP/&/letting/
    management/property/estate/group/homes/rentals … OR contains a
    "(CompanyName)" suffix where the inner part looks like a company)
    → record  agent_address → company_name.
  - The company name is extracted by stripping any trailing "(PersonName)"
    in parentheses.

Run time: a few seconds (no network calls).
Output is gitignored because it derives from the source registers.
"""

import csv, json, glob, os, re, sys
from collections import defaultdict

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")
OUT  = os.path.join(DATA, "licence_address_lookup.json")

HMO_DETAILS_GLOB   = os.path.join(DATA, "HMO_Register_April_*_details.csv")
HMO_CONTACTS_GLOB  = os.path.join(DATA, "HMO_Register_April_*_contacts_cells.csv")
SELECTIVE_CSV_GLOB = os.path.join(DATA, "Selective_Licence_Register*.csv")

# ── Name classification helpers ────────────────────────────────────────────

# Patterns that suggest a company name rather than a person
_COMPANY_KEYWORDS_RE = re.compile(
    r'\b(letting|lettings|management|property|properties|estate|estates|'
    r'residential|students|ltd|limited|llp|plc|uk|group|realty|homes|'
    r'rentals|agents?|housing|services|solutions)\b',
    re.IGNORECASE,
)
_HAS_AMPERSAND_RE = re.compile(r'\s&\s')
_PERSON_PREFIX_RE = re.compile(r'^(mr|mrs|ms|miss|dr|prof)\.?\s', re.IGNORECASE)
# Trailing (Inner) — used to detect "Company (Person)" patterns
_TRAILING_PAREN_RE = re.compile(r'\s*\(([^)]*)\)\s*$')


def _strip_trailing_person_paren(name: str) -> str:
    """
    Remove trailing (PersonName) from a company name.
    Keeps trailing parens that look like company qualifiers
    e.g. "Chancellors (Verity Smith)" → "Chancellors"
         "Martin & Co (Oxford)"        → "Martin & Co (Oxford)"
    """
    m = _TRAILING_PAREN_RE.search(name)
    if not m:
        return name
    inner = m.group(1)
    # Keep if inner looks like a company qualifier, strip otherwise
    if _COMPANY_KEYWORDS_RE.search(inner):
        return name
    return name[:m.start()].strip()


def looks_like_company(name: str) -> bool:
    """Return True if the name looks like a company rather than a person."""
    if _PERSON_PREFIX_RE.match(name):
        return False
    if _COMPANY_KEYWORDS_RE.search(name):
        return True
    if _HAS_AMPERSAND_RE.search(name):
        return True
    # "Company (Person)" pattern — company part has a keyword
    m = _TRAILING_PAREN_RE.search(name)
    if m:
        company_part = name[:m.start()].strip()
        if _COMPANY_KEYWORDS_RE.search(company_part) or _HAS_AMPERSAND_RE.search(company_part):
            return True
    return False


def extract_company_name(name: str) -> str:
    """Strip trailing (PersonName) to get the bare company name."""
    return _strip_trailing_person_paren(name).strip().rstrip(',').strip()


# ── File helpers ───────────────────────────────────────────────────────────

def find_file(pattern, label):
    matches = sorted(glob.glob(pattern))
    if not matches:
        print(f"ERROR: no {label} file found matching {pattern}", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        print(f"  Warning: multiple {label} files found, using {matches[-1]}")
    return matches[-1]


# ── HMO contacts parsing ───────────────────────────────────────────────────

def parse_hmo_contacts(contacts_path):
    """
    Returns:
      contacts  dict: case_number → {agent, agent_address, holder, holder_address}
      all_agent_rows  list of {name, address} for every agent row (used to build agency table)
    """
    print(f"  Parsing HMO contacts: {os.path.basename(contacts_path)}")
    contacts = {}
    all_agent_rows = []  # every agent row for agency table building

    with open(contacts_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            case    = row.get("Case Number", "").strip()
            party   = row.get("Party Type", "").strip().lower()
            name    = row.get("Name", "").strip()
            address = row.get("Address", "").strip()

            if not case:
                continue
            if case not in contacts:
                contacts[case] = {
                    "agent": "", "agent_address": "",
                    "holder": "", "holder_address": "",
                }
            if "agent" in party or "manager" in party:
                contacts[case]["agent"]         = name
                contacts[case]["agent_address"] = address
                if name and address:
                    all_agent_rows.append({"name": name, "address": address})
            elif "holder" in party:
                contacts[case]["holder"]         = name
                contacts[case]["holder_address"] = address

    print(f"  {len(contacts)} cases with contact info")
    return contacts, all_agent_rows


def build_agency_address_table(all_agent_rows):
    """
    Scan all agent rows to build address → agency_name for known letting agencies.

    Strategy:
      - Group all agent names seen at each address.
      - If ANY name at that address looks like a company → record the
        (stripped) company name for that address.
      - Where multiple company names appear at one address, prefer the most
        frequently seen one.
    """
    # address → list of (company_name) seen there
    addr_companies = defaultdict(list)

    for row in all_agent_rows:
        name = row["name"]
        addr = row["address"]
        if looks_like_company(name):
            addr_companies[addr].append(extract_company_name(name))

    # Pick the most common company name per address
    agency_table = {}
    for addr, companies in addr_companies.items():
        if companies:
            # Most frequent company name at this address
            best = max(set(companies), key=companies.count)
            agency_table[addr] = best

    print(f"  Agency address table: {len(agency_table)} known agency offices")
    return agency_table


def resolve_agent(agent_name, agent_address, holder_name, holder_address, agency_table):
    """
    Apply the three-rule resolution:
      1. Same name → self-managed → use holder name.
      2. Same address, different names → look up agency at that address.
      3. Otherwise → use agent name as-is.
    Returns the resolved agent string (may be empty).
    """
    if not agent_name:
        return ""

    # Rule 1: agent IS the holder (self-managed)
    if agent_name.lower() == holder_name.lower():
        return holder_name

    # Rule 2: same address → letting agency scenario
    if agent_address and holder_address and agent_address == holder_address:
        agency = agency_table.get(agent_address, "")
        if agency:
            return agency
        # Fallback: if neither name looks like a company, just return agent name
        return agent_name

    # Rule 3: different addresses → straight through
    return agent_name


def parse_hmo(details_path, contacts_path):
    """Returns lookup dict: case_number → {address, agent, holder, holder_address}."""
    print(f"  Parsing HMO details: {os.path.basename(details_path)}")
    contacts, all_agent_rows = parse_hmo_contacts(contacts_path)
    agency_table = build_agency_address_table(all_agent_rows)

    lookup = {}
    with open(details_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid  = row.get("Case Number", "").strip()
            addr = row.get("address", "").strip()
            if not rid or not addr:
                continue
            c = contacts.get(rid, {})
            agent = resolve_agent(
                c.get("agent", ""),
                c.get("agent_address", ""),
                c.get("holder", ""),
                c.get("holder_address", ""),
                agency_table,
            )
            lookup[rid] = {
                "address":        addr,
                "agent":          agent,
                "holder":         c.get("holder", ""),
                "holder_address": c.get("holder_address", ""),
            }

    # Summary stats
    with_agent  = sum(1 for v in lookup.values() if v["agent"])
    with_holder = sum(1 for v in lookup.values() if v["holder"])
    print(f"  {len(lookup)} HMO entries ({with_agent} with agent, {with_holder} with holder)")
    return lookup, agency_table


# ── Selective parsing ──────────────────────────────────────────────────────

def parse_selective(path):
    print(f"  Parsing Selective CSV: {os.path.basename(path)}")
    lookup = {}
    with open(path, newline="", encoding="latin-1") as f:
        reader = csv.DictReader(f)
        hl = {h.lower().strip(): h for h in (reader.fieldnames or [])}
        ref_col    = next((hl[h] for h in hl if "reference"           in h), None)
        addr_col   = next((hl[h] for h in hl if "property address"    in h), None)
        agent_col  = next((hl[h] for h in hl if "managing agent name" in h), None)
        holder_col = next((hl[h] for h in hl if "licence holder name" in h), None)
        holder_addr_col = next((hl[h] for h in hl if "holder address" in h), None)
        for row in reader:
            rid    = row.get(ref_col,    "").strip() if ref_col    else ""
            addr   = row.get(addr_col,   "").strip() if addr_col   else ""
            agent  = row.get(agent_col,  "").strip() if agent_col  else ""
            holder = row.get(holder_col, "").strip() if holder_col else ""
            holder_addr = row.get(holder_addr_col, "").strip() if holder_addr_col else ""
            if not rid or not addr:
                continue
            lookup[rid] = {
                "address":        addr,
                "agent":          agent,
                "holder":         holder,
                "holder_address": holder_addr,
            }
    print(f"  {len(lookup)} Selective entries")
    return lookup


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    details_path  = find_file(HMO_DETAILS_GLOB,  "HMO details CSV")
    contacts_path = find_file(HMO_CONTACTS_GLOB, "HMO contacts CSV")
    sel_path      = find_file(SELECTIVE_CSV_GLOB, "Selective CSV")

    print("[1/3] Parsing HMO data…")
    hmo_lookup, agency_table = parse_hmo(details_path, contacts_path)

    # Print agency table sample for inspection
    print(f"\n  Sample agency address mappings:")
    for addr, name in list(agency_table.items())[:10]:
        print(f"    {name!r:40s} ← {addr}")

    print("\n[2/3] Parsing Selective data…")
    sel_lookup = parse_selective(sel_path)

    print("\n[3/3] Writing output…")
    lookup = {}
    lookup.update(hmo_lookup)
    lookup.update(sel_lookup)

    with open(OUT, "w") as f:
        json.dump(lookup, f, separators=(",", ":"))
    print(f"Written {len(lookup)} entries → {OUT}")


if __name__ == "__main__":
    main()
