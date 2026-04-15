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
1. Fetches all Oxford buildings with address tags from Overpass API.
2. Converts to GeoJSON with a normalised `match_key` for address matching.
3. Uses shapely to map each building's postcode to its LSOA via point-in-polygon.
4. Outputs two files (see below).

**Expected output files:**

| File | Description | Typical size |
|------|-------------|-------------|
| `data/oxford_buildings.geojson` | ~23,000 building footprint polygons | ~10 MB |
| `data/postcode_lsoa.csv` | ~1,500 postcode-to-LSOA mappings | ~50 KB |
| `data/buildings_raw.json` | Raw Overpass response (intermediate, gitignored) | ~20 MB |


## 3. Manual testing of the map

### Start a local server

```bash
cd oru_doorknocking_map
python3 -m http.server 8000
```

### Open in your browser

Navigate to: **http://localhost:8000**

