# ORU Density Map

Interactive choropleth map of Oxford neighbourhood density for ORU door-knocking
planning. Visualises any per-neighbourhood numeric dataset (e.g. HMO counts,
amenity density, survey responses) on LSOA boundaries with optional point markers.

## Quick start

**Just want to view the map?**
Open the GitHub Pages URL in any browser — no installation or login required.

**Want to run it locally?**

```bash
cd oru_doorknocking_map
python3 -m http.server 8000
# Open http://localhost:8000
```

For detailed setup, data generation, and deployment instructions see
[INSTRUCTIONS.md](INSTRUCTIONS.md).

## What the map shows

Oxford is divided into **LSOA neighbourhoods** (Lower Layer Super Output Areas —
small census zones). Each LSOA is colour-coded from light to dark based on a
numeric value. The current dataset uses **OSM amenity counts** as a structural
placeholder; swapping in real data (e.g. HMO register counts) only requires
replacing the CSV and GeoJSON properties.

Individual **point locations** (currently amenities) are shown as blue circle
markers. Hovering a marker shows its name and type.

| Feature | Description |
|---------|-------------|
| Neighbourhood choropleth | LSOA polygons filled light to dark by value (quantile scale) |
| Point markers | Blue circles at each data point location |
| Hover info | Neighbourhood name, count, and label on polygon mouseover |
| Point tooltips | Name and type on marker hover |
| Colour legend | Auto-generated quantile breakpoints in bottom-right corner |
| Layer control | Toggle neighbourhood fill and point markers independently |
| Placeholder disclaimer | Banner at top; dismissible per session |

## Data

### CSV schema (aggregated, map-ready)

| Column | Description |
|--------|-------------|
| `neighbourhood` | LSOA name matching GeoJSON properties (e.g. "Oxford 005A") |
| `value` | Integer count |
| `value_label` | Human-readable label shown in legend and tooltip (e.g. "HMO count") |

### Preprocessing raw data

If you have a per-property CSV (e.g. HMO register with columns `id`, `address`,
`neighbourhood`), aggregate it first:

```bash
python3 scripts/preprocess_data.py data/hmo_register.csv \
  --output data/hmo_aggregated.csv \
  --label "HMO count"
```

### Regenerating placeholder data from OSM

```bash
python3 scripts/generate_placeholder.py
```

See [INSTRUCTIONS.md](INSTRUCTIONS.md) section 3 for full details.

## File structure

```
oru_doorknocking_map/
  index.html                    <- single HTML file (Leaflet + chroma via CDN)
  static/
    app.js                      <- all map logic (fetch, style, legend, layers, UI)
  data/
    neighbourhoods.geojson      <- Oxford LSOA boundary polygons (from ONS)
    amenities.geojson           <- individual point markers (from Overpass)
    placeholder_amenities.csv   <- per-neighbourhood counts (placeholder)
  scripts/
    generate_placeholder.py     <- regenerate all data from ONS + Overpass
    preprocess_data.py          <- aggregate raw per-property CSV to per-neighbourhood
  INSTRUCTIONS.md               <- detailed setup, testing, and deploy guide
  README.md                     <- this file
```

## Technology

| Concern | Choice |
|---------|--------|
| Map rendering | Leaflet.js (CDN, no build step) |
| Base tiles | OpenStreetMap (no API key) |
| Colour scale | chroma.js (CDN) |
| Neighbourhood boundaries | ONS Open Geography Portal (LSOA 2021) |
| Point data | Overpass API (OpenStreetMap) |
| Point-in-polygon | shapely (Python, data generation only) |
| Hosting | GitHub Pages (static, free) |
| Build pipeline | None — plain HTML/CSS/JS |

## Swapping in a different dataset

The map is dataset-agnostic. To use your own data:

1. Provide a **`neighbourhoods.geojson`** where each feature has an `amenity_count`
   property (or rename the property and update `app.js` accordingly).
2. Optionally provide a **point-layer GeoJSON** with `name` and `amenity` (or
   any label) properties for the markers.
3. Update `value_label` in the CSV or the `valueLabel` constant in `app.js` to
   describe what the numbers represent.

## Data licence

LSOA boundaries are from the [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/)
and are available under the Open Government Licence.

Amenity point data is derived from [OpenStreetMap](https://www.openstreetmap.org/copyright)
and is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
