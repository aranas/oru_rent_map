#!/usr/bin/env python3
"""
preprocess_data.py
==================
Aggregates a raw per-property CSV (e.g. HMO register) into the one-row-per-neighbourhood
format that the map expects.

Input CSV must have at least these columns:
  id              – unique identifier (e.g. licence reference)
  address         – full property address (retained for debugging)
  neighbourhood   – ward / neighbourhood name used as the join key to GeoJSON

Output CSV columns (written to stdout or --output file):
  neighbourhood   – neighbourhood name exactly as it appears in the input
  value           – count of rows per neighbourhood
  value_label     – human-readable label (set via --label flag)

Usage:
  python scripts/preprocess_data.py data/hmo_register.csv
  python scripts/preprocess_data.py data/hmo_register.csv --output data/hmo_aggregated.csv
  python scripts/preprocess_data.py data/hmo_register.csv --label "HMO count"
"""

import argparse
import csv
import sys
from collections import Counter


def normaliseName(name):
    """Lowercase, strip punctuation, collapse whitespace."""
    if not name:
        return ""
    import re
    s = name.lower()
    s = re.sub(r"[^a-z0-9\s]", "", s)
    return " ".join(s.split())


def main():
    parser = argparse.ArgumentParser(
        description="Aggregate a per-property CSV to one row per neighbourhood."
    )
    parser.add_argument("input", help="Path to the raw per-property CSV")
    parser.add_argument(
        "--output", "-o", default=None,
        help="Output CSV path (default: print to stdout)",
    )
    parser.add_argument(
        "--label", "-l", default="HMO count",
        help='Value label for the output (default: "HMO count")',
    )
    args = parser.parse_args()

    with open(args.input, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []

        if "neighbourhood" not in fieldnames:
            sys.exit(
                f"ERROR: Input CSV must have a 'neighbourhood' column.\n"
                f"Found columns: {fieldnames}"
            )

        counts = Counter()
        display_names = {}
        for row in reader:
            raw = row["neighbourhood"].strip()
            if not raw:
                continue
            key = normaliseName(raw)
            counts[key] += 1
            if key not in display_names:
                display_names[key] = raw

    out_file = open(args.output, "w", newline="") if args.output else sys.stdout
    writer = csv.writer(out_file)
    writer.writerow(["neighbourhood", "value", "value_label"])

    for key in sorted(counts):
        writer.writerow([display_names[key], counts[key], args.label])

    if args.output:
        out_file.close()
        print(f"Wrote {len(counts)} neighbourhoods to {args.output}", file=sys.stderr)
    else:
        print(f"# {len(counts)} neighbourhoods written to stdout", file=sys.stderr)


if __name__ == "__main__":
    main()
