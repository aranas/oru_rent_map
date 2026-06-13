#!/usr/bin/env python3
"""
build_address_lookup.py
-----------------------
Produces data/licence_address_lookup.json — a mapping of licence ID → metadata dict.

Each entry:
  { "address": "...", "agent": "...", "holder": "..." }

"agent" and "holder" are only populated for Selective licences (HMO register
does not include that information).

Run time: a few seconds (no network calls).
Output is gitignored because it derives from the source registers.
"""

import csv, json, glob, os, sys
import openpyxl

ROOT       = os.path.join(os.path.dirname(__file__), "..")
DATA       = os.path.join(ROOT, "data")
OUT        = os.path.join(DATA, "licence_address_lookup.json")

HMO_XLSX_GLOB      = os.path.join(DATA, "Oxford HMO Register*.xlsx")
SELECTIVE_CSV_GLOB = os.path.join(DATA, "Selective_Licence_Register*.csv")


def find_file(pattern, label):
    matches = sorted(glob.glob(pattern))
    if not matches:
        print(f"ERROR: no {label} file found matching {pattern}", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        print(f"  Warning: multiple {label} files found, using {matches[-1]}")
    return matches[-1]


def parse_hmo(path):
    print(f"  Parsing HMO xlsx: {os.path.basename(path)}")
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    headers = [str(h).lower().strip() if h else "" for h in rows[0]]

    def col(frag):
        for i, h in enumerate(headers):
            if frag in h:
                return i
        return -1

    id_col   = col("id")
    addr_col = col("address")
    st_col   = col("street")

    lookup = {}
    for row in rows[1:]:
        rid  = str(row[id_col]).strip()   if id_col   >= 0 and row[id_col]   else ""
        addr = str(row[addr_col]).strip() if addr_col >= 0 and row[addr_col] else ""
        st   = str(row[st_col]).strip()   if st_col   >= 0 and row[st_col]   else ""
        if not rid or not addr or addr == "None":
            continue
        full = f"{addr}, {st}, Oxford" if st and st.lower() not in addr.lower() else f"{addr}, Oxford"
        lookup[rid] = {"address": full, "agent": "", "holder": ""}
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
    hmo_path = find_file(HMO_XLSX_GLOB, "HMO xlsx")
    sel_path = find_file(SELECTIVE_CSV_GLOB, "Selective CSV")

    lookup = {}
    lookup.update(parse_hmo(hmo_path))
    lookup.update(parse_selective(sel_path))

    with open(OUT, "w") as f:
        json.dump(lookup, f, separators=(",", ":"))
    print(f"\nWritten {len(lookup)} entries -> {OUT}")


if __name__ == "__main__":
    main()
