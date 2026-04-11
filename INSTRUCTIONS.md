# INSTRUCTIONS — ORU HMO Density Map

Step-by-step guide for setting up, generating data, testing, and deploying the map.

---

## 1. Environment setup

### Prerequisites

- **Python 3.10+** (check with `python3 --version`)
- **Git** and optionally the **GitHub CLI** (`gh`)

### Install Python dependencies

The data-generation scripts need `requests` (HTTP) and `shapely` (point-in-polygon).

**Using conda (recommended):**

```bash
conda create -n oru_map python=3.12 -y
conda activate oru_map
pip install requests shapely
```

### Local static server

Any of these work — pick one:

| Method | Command |
|--------|---------|
| Python built-in | `python3 -m http.server 8000` |
| VS Code extension | Install **Live Server**, right-click `index.html` → Open with Live Server |
| Node (npx) | `npx serve .` |

---

## 3. Data generation

The repo ships with real OSM-derived data. To regenerate (e.g. after OSM edits
or to refresh counts):

### 3a. Generate all data files (automated)

```bash
cd oru_doorknocking_map
conda activate oru_map       # or: source venv/bin/activate
python3 scripts/generate_placeholder.py
```

This script:
1. Fetches Oxford ward boundary polygons from the ONS Open Geography Portal.
2. Fetches all amenity nodes in the Oxford bounding box from Overpass API.
3. Uses shapely point-in-polygon to assign amenities to wards and count them.
4. Outputs three files (see below).

**Expected output files:**

| File | Description | Typical size |
|------|-------------|-------------|
| `data/neighbourhoods.geojson` | Oxford area polygons with `amenity_count` | ~41 KB |
| `data/amenities.geojson` | ~2,700 amenity point markers | ~467 KB |
| `data/placeholder_amenities.csv` | Per-neighbourhood amenity counts | ~1 KB |
| `data/amenities_raw.json` | Raw Overpass response (intermediate, gitignored) | ~1.1 MB |


## 4. Manual testing of the map

### Start a local server

```bash
cd oru_doorknocking_map
python3 -m http.server 8000
```

### Open in your browser

Navigate to: **http://localhost:8000**
