# ORU Density Map

Interactive choropleth map of Oxford neighbourhood density for ORU door-knocking
planning. Visualises any per-neighbourhood numeric dataset (e.g. HMO counts,
amenity density, survey responses) on LSOA boundaries with optional point markers.

## Quick start

[**View the map here**](https://aranas.github.io/oru_rent_map/)

**Want to run it locally?**

```bash
cd oru_doorknocking_map
python3 -m http.server 8000
# Open http://localhost:8000
```

For detailed setup, data generation, and testing instructions see
[INSTRUCTIONS.md](INSTRUCTIONS.md).

## What the map shows

Oxford is divided into **LSOA neighbourhoods** (Lower Layer Super Output Areas —
small census zones). Each LSOA is colour-coded from light to dark based on a
numeric value. By default the map shows **OSM amenity counts** as a structural
placeholder.

**Upload an HMO CSV** (in-browser, no data leaves your machine) and the map
instantly updates to show HMO density per LSOA, with individual HMOs
highlighted as **building footprint polygons** matched to their exact address
in OpenStreetMap.

| Feature | Description |
|---------|-------------|
| Neighbourhood choropleth | LSOA polygons filled light to dark by value (quantile scale) |
| HMO building footprints | Blue outlines of matched HMO buildings (after CSV upload) |
| Fallback markers | Orange circles at postcode centroid for unmatched addresses |
| Amenity markers | Blue circles at each amenity location (placeholder mode) |
| Hover info | Neighbourhood name, count, and label on polygon mouseover |
| Building tooltips | Address, licence dates, register ID on HMO building hover |
| Colour legend | Auto-generated quantile breakpoints in bottom-right corner |
| Layer control | Toggle layers independently |
| CSV upload panel | Drag-and-drop or click; data stays in memory only, never cached |
| Placeholder disclaimer | Banner at top; updates when HMO data is loaded |

## Uploading HMO data (in-browser)

Use the **Upload HMO CSV** panel in the bottom-left corner. Your CSV should have
these columns (header names are detected by fuzzy match):

| Column | Description |
|--------|-------------|
| ID | HMO register reference |
| Address | Full address including postcode (e.g. `18 Abbey Road, OX2 0AE`) |
| Street | Street name |
| Licence start | HMO licence start date |
| Licence end | HMO licence end date |

The browser matches each address to an OSM building footprint and assigns it to
an LSOA via the postcode. **No data leaves your machine** — all reference data
is pre-generated and served as static files. CSV data is **never cached or
persisted**; it lives only in browser memory for the current session. Click
**Clear HMO data** or refresh the page to revert to the placeholder view.

### Preprocessing CSV for instant matching (recommended)

For large CSV files or when you need instant uploads, preprocess your CSV to
match addresses against the building database upfront:

```bash
python3 scripts/preprocess_hmo_csv.py input.csv output.csv
```

This script:
- Parses addresses using the same logic as the browser
- Matches against the building database (exact match first, then fuzzy)
- Adds matched building keys for instant exact lookups

The preprocessed CSV gets additional columns:
- `match_key`: The building's exact matchKey (from building data)
- `housenumber`: Parsed housenumber from input
- `street`: Parsed street from input  
- `postcode`: Normalized postcode
- `sub_unit`: Parsed sub-unit
- `match_confidence`: 'exact', 'fuzzy', or 'none'

Upload the preprocessed CSV just like a regular one — the app detects the
precomputed matches and uploads instantly. The expensive fuzzy matching happens
once during preprocessing, not in the browser.

## Data

### Regenerating placeholder data from OSM

```bash
python3 scripts/generate_placeholder.py
```

### Regenerating building footprint + postcode data

Must run after `generate_placeholder.py` (needs `data/neighbourhoods.geojson`):

```bash
python3 scripts/generate_building_data.py
```

This produces:
- `data/oxford_buildings.geojson` (~10 MB) — building footprints with address tags
- `data/postcode_lsoa.csv` (~50 KB) — postcode-to-LSOA mapping

See [INSTRUCTIONS.md](INSTRUCTIONS.md) for full details.

## File structure

```
oru_doorknocking_map/
  index.html                    <- HTML file (Leaflet + chroma + PapaParse via CDN)
  static/
    app.js                      <- map logic, layer builders, upload UI wiring
    hmo-upload.js               <- CSV parsing, address matching (in-memory only)
  data/
    neighbourhoods.geojson      <- Oxford LSOA boundary polygons (from ONS)
    amenities.geojson           <- individual point markers (from Overpass)
    placeholder_amenities.csv   <- per-neighbourhood counts (placeholder)
    oxford_buildings.geojson    <- building footprints with address tags (from Overpass)
    postcode_lsoa.csv           <- postcode -> LSOA + centroid mapping
  scripts/
    generate_placeholder.py     <- regenerate LSOA + amenity data from ONS + Overpass
    generate_building_data.py   <- regenerate building footprints + postcode mapping
  requirements.txt              <- Python dependencies for data-generation scripts
  INSTRUCTIONS.md               <- detailed setup and testing guide
  README.md                     <- this file
```

## Technology

| Concern | Choice |
|---------|--------|
| Map rendering | Leaflet.js (CDN, no build step) |
| Base tiles | OpenStreetMap (no API key) |
| Colour scale | chroma.js (CDN) |
| CSV parsing | PapaParse (CDN) |
| Neighbourhood boundaries | ONS Open Geography Portal (LSOA 2021) |
| Building footprints | Overpass API (OpenStreetMap, build-time only) |
| Point-in-polygon | shapely (Python, data generation only) |
| CSV data handling | In-memory only, never persisted |
| Hosting | GitHub Pages (static, free) |
| Build pipeline | None — plain HTML/CSS/JS |

## Privacy model

When a user uploads an HMO CSV in the browser:

- The CSV is parsed **entirely in the browser** (client-side JavaScript)
- Address matching uses `data/oxford_buildings.geojson` (static file, public OSM data)
- Postcode-to-LSOA lookup uses `data/postcode_lsoa.csv` (static file, public data)
- **Zero external API calls** are made at runtime
- CSV data is **never cached or persisted** — it lives in browser memory only and is discarded on page refresh
- No HMO data is ever sent to a server or stored in the Git repository

## Data licence

LSOA boundaries are from the [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/)
and are available under the Open Government Licence.

Amenity point data is derived from [OpenStreetMap](https://www.openstreetmap.org/copyright)
and is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
