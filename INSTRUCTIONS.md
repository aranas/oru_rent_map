# INSTRUCTIONS — ORU HMO Density Map

Step-by-step guide for setting up, generating data, and testing the map.

---

## 1. Environment setup

### Prerequisites

- **Python 3.10+** (check with `python3 --version`)
- **Git** and optionally the **GitHub CLI** (`gh`)

### Install Python dependencies

The data-generation scripts need `requests` (HTTP) and `shapely` (point-in-polygon).
Dependencies are listed in `requirements.txt`.

**Using conda (recommended):**

```bash
conda create -n oru_map python=3.12 -y
conda activate oru_map
pip install -r requirements.txt
```

### Local static server

Any of these work — pick one:

| Method | Command |
|--------|---------|
| Python built-in | `python3 -m http.server 8000` |
| VS Code extension | Install **Live Server**, right-click `index.html` → Open with Live Server |
| Node (npx) | `npx serve .` |

---

## 2. Data generation

The repo ships with real OSM-derived data. To regenerate (e.g. after OSM edits
or to refresh counts):

### 2a. Generate placeholder data (LSOA boundaries + amenities)

```bash
cd oru_doorknocking_map
conda activate oru_map       # or: source venv/bin/activate
python3 scripts/generate_placeholder.py
```

This script:
1. Fetches Oxford LSOA boundary polygons from the ONS Open Geography Portal.
2. Fetches all amenity nodes in the Oxford bounding box from Overpass API.
3. Uses shapely point-in-polygon to assign amenities to LSOAs and count them.
4. Outputs three files (see below).

**Expected output files:**

| File | Description | Typical size |
|------|-------------|-------------|
| `data/neighbourhoods.geojson` | Oxford LSOA polygons with `amenity_count` | ~41 KB |
| `data/amenities.geojson` | ~2,700 amenity point markers | ~467 KB |
| `data/placeholder_amenities.csv` | Per-neighbourhood amenity counts | ~1 KB |
| `data/amenities_raw.json` | Raw Overpass response (intermediate, gitignored) | ~1.1 MB |

### 2b. Generate building footprint + postcode data

**Must run after step 2a** (needs `data/neighbourhoods.geojson`):

```bash
python3 scripts/generate_building_data.py
```

This script:
1. Fetches building ways from Overpass (full address on way, housenumber-only, street-only, and `building:part`) plus address **nodes** in the same bounding box.
2. Converts ways to GeoJSON, deduplicates by OSM id, then assigns node addresses to polygons with a Shapely **point-in-polygon** join (smallest-area polygon wins when several contain the node). Ways that already have both `addr:housenumber` and `addr:street` keep those tags; incomplete ways are filled from nodes where possible.
3. Builds `match_key` and `match_keys`: housenumber **ranges** (e.g. `1-19`) expand to multiple normalised keys (odds/evens when both ends share parity, otherwise every integer), capped per feature so the browser index can match unit-level HMO addresses to one terrace polygon.
4. Uses shapely to map each building postcode centroid to an LSOA for `postcode_lsoa.csv`.
5. Outputs two main files (see below). Raw Overpass dumps are gitignored (`buildings_raw.json`, `addr_nodes_raw.json`).

**Expected output files:**

| File | Description | Typical size |
|------|-------------|-------------|
| `data/oxford_buildings.geojson` | Building footprint polygons + `match_key` / `match_keys` | larger than before (more ways + expanded keys) |
| `data/postcode_lsoa.csv` | Postcode-to-LSOA mappings | varies |
| `data/buildings_raw.json` | Raw Overpass response for ways (intermediate, gitignored) | large |
| `data/addr_nodes_raw.json` | Raw Overpass response for address nodes (gitignored) | moderate |


## 3. Manual testing of the map

### Start a local server

```bash
cd oru_doorknocking_map
python3 -m http.server 8000
```

### Open in your browser

Navigate to: **http://localhost:8000**

