#!/usr/bin/env python3
"""
build_address_lookup.py
-----------------------
Produces data/licence_address_lookup.json — a mapping of licence ID → metadata dict.

Each entry:
  { "address": "...", "agent": "...", "holder": "..." }

Run time: a few seconds (no network calls).
Output is gitignored because it derives from the source registers.
"""

import csv, json, glob, os, sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")
OUT  = os.path.join(DATA, "licence_address_lookup.json")

HMO_DETAILS_GLOB  = os.path.join(DATA, "HMO_Register_April_*_details.csv")
HMO_CONTACTS_GLOB = os.path.join(DATA, "HMO_Register_April_*_contacts_cells.csv")
SELECTIVE_CSV_GLOB = os.path.join(DATA, "Selective_Licence_Register*.csv")


def find_file(pattern, label):
    matches = sorted(glob.glob(pattern))
    if not matches:
        print(f"ERROR: no {label} file found matching {pattern}", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        print(f"  Warning: multiple {label} files found, using {matches[-1]}")
    return matches[-1]


def parse_hmo_contacts(contacts_path):
    """Returns dict: case_number -> {agent, holder}."""
    print(f"  Parsing HMO contacts: {os.path.basename(contacts_path)}")
    contacts = {}
    with open(contacts_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            case = row.get("Case Number", "").strip()
            if not case:
                continue
            party = row.get("Party Type", "").strip().lower()
            name  = row.get("Name", "").strip()
            if case not in contacts:
                contacts[case] = {"agent": "", "holder": ""}
            if "agent" in party:
                contacts[case]["agent"] = name
            elif "holder" in party:
                contacts[case]["holder"] = name
    print(f"  {len(contacts)} cases with contact info")
    return contacts


def parse_hmo(details_path, contacts_path):
    """Returns lookup dict: case_number -> {address, agent, holder}."""
    print(f"  Parsing HMO details: {os.path.basename(details_path)}")
    contacts = parse_hmo_contacts(contacts_path)
    lookup = {}
    with open(details_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid  = row.get("Case Number", "").strip()
            addr = row.get("address", "").strip()
            if not rid or not addr:
                continue
            c = contacts.get(rid, {})
            lookup[rid] = {
                "address": addr,
                "agent":   c.get("agent", ""),
                "holder":  c.get("holder", ""),
            }
    print(f"  {len(lookup)} HMO entries")
    return lookup


def parse_selective(path):
    print(f"  Parsing Selective CSV: {os.path.basename(path)}")
    lookup = {}
    with open(path, newline="", encoding="latin-1") as f:
        reader = csv.DictReader(f)
        hl = {h.lower().strip(): h for h in (reader.fieldnames or [])}
        ref_col    = next((hl[h] for h in hl if "reference" in h), None)
        addr_col   = next((hl[h] for h in hl if "property address" in h), None)
        agent_col  = next((hl[h] for h in hl if "managing agent name" in h), None)
        holder_col = next((hl[h] for h in hl if "licence holder name" in h), None)
        for row in reader:
            rid    = row.get(ref_col,    "").strip() if ref_col    else ""
            addr   = row.get(addr_col,   "").strip() if addr_col   else ""
            agent  = row.get(agent_col,  "").strip() if agent_col  else ""
            holder = row.get(holder_col, "").strip() if holder_col else ""
            if not rid or not addr:
                continue
            lookup[rid] = {"address": addr, "agent": agent, "holder": holder}
    print(f"  {len(lookup)} Selective entries")
    return lookup


def main():
    details_path  = find_file(HMO_DETAILS_GLOB,  "HMO details CSV")
    contacts_path = find_file(HMO_CONTACTS_GLOB, "HMO contacts CSV")
    sel_path      = find_file(SELECTIVE_CSV_GLOB, "Selective CSV")

    lookup = {}
    lookup.update(parse_hmo(details_path, contacts_path))
    lookup.update(parse_selective(sel_path))

    with open(OUT, "w") as f:
        json.dump(lookup, f, separators=(",", ":"))
    print(f"\nWritten {len(lookup)} entries -> {OUT}")


if __name__ == "__main__":
    main()
