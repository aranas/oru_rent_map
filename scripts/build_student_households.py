#!/usr/bin/env python3
"""
build_student_households.py
----------------------------
Pulls Census 2021 household-composition data (LSOA level) from the ONS
Cantabular census-observations API and extracts the count of households
where every member is a full-time student, for each Oxford LSOA already
present in data/neighbourhoods.geojson.

Why the Cantabular API instead of the standard TS003 bulk table: the
published TS003 table only offers a *merged* category ("Other household
types: Other, including all full-time students and all aged 66 years and
over"), which conflates students with elderly-only households. The
detailed 37-category classification (hh_family_composition_37a, category
id "34" = "Other household types: All in full-time education") is only
exposed through the flexible census-observations API, not the bulk
downloads.

API docs: https://developer.ons.gov.uk/censusobservations/
No API key required.

Output (committed):
  data/student_households.json — {LSOA21CD: {student_households, total_households}}

Run time: a couple of seconds, one network call.
"""

import json
import os
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")

NEIGHBOURHOODS = os.path.join(DATA, "neighbourhoods.geojson")
OUT_PATH = os.path.join(DATA, "student_households.json")

API_BASE = "https://api.beta.ons.gov.uk/v1/population-types/HH/census-observations"
DIMENSION = "hh_family_composition_37a"
STUDENT_CATEGORY_ID = "34"  # "Other household types: All in full-time education"
NOT_APPLICABLE_CATEGORY_ID = "-8"  # "Does not apply" — excluded from household totals


def load_oxford_lsoa_codes():
    with open(NEIGHBOURHOODS) as f:
        geo = json.load(f)
    return sorted({feat["properties"]["LSOA21CD"] for feat in geo["features"]})


def fetch_observations(lsoa_codes):
    area_param = "lsoa," + ",".join(lsoa_codes)
    url = f"{API_BASE}?area-type={area_param}&dimensions={DIMENSION}"
    # Cloudflare in front of the API rejects requests with no User-Agent.
    req = urllib.request.Request(url, headers={"User-Agent": "oru-rent-map/1.0"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def main():
    codes = load_oxford_lsoa_codes()
    payload = fetch_observations(codes)

    if payload.get("blocked_areas"):
        print(f"Warning: {payload['blocked_areas']} area(s) blocked (disclosure control)")
    if payload["areas_returned"] != len(codes):
        print(f"Warning: expected {len(codes)} areas, API returned {payload['areas_returned']}")

    result = {}
    for obs in payload["observations"]:
        dims = {d["dimension_id"]: d for d in obs["dimensions"]}
        lsoa_code = dims["lsoa"]["option_id"]
        category_id = dims[DIMENSION]["option_id"]
        count = obs["observation"]

        row = result.setdefault(lsoa_code, {
            "lsoa_name": dims["lsoa"]["option"],
            "student_households": 0,
            "total_households": 0,
        })
        if category_id == STUDENT_CATEGORY_ID:
            row["student_households"] = count
        if category_id != NOT_APPLICABLE_CATEGORY_ID:
            row["total_households"] += count

    missing = set(codes) - set(result.keys())
    if missing:
        print(f"Warning: no data returned for {len(missing)} LSOA(s): {sorted(missing)}")

    with open(OUT_PATH, "w") as f:
        json.dump(result, f, indent=1, sort_keys=True)

    total_student_hh = sum(r["student_households"] for r in result.values())
    print(f"Wrote {len(result)} LSOAs -> {OUT_PATH}")
    print(f"Total student-only households across Oxford: {total_student_hh}")


if __name__ == "__main__":
    main()
