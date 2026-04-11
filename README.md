# ORU HMO Density Map

A browser-based interactive map that helps Oxford Renters Union (ORU) organisers
decide which areas to prioritise for door-knocking by visualising amenity (and
eventually HMO) density per neighbourhood.

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

Oxford is divided into **20 ward neighbourhoods**. Each ward is colour-coded from
light to dark based on a numeric value. In the MVP this value is an **OSM amenity
count** (a structural placeholder). When real HMO register data is available, the
same map renders actual HMO counts per neighbourhood.

Individual **amenity locations** are shown as blue circle markers. Hovering a
marker shows the amenity name and type.

| Feature | Description |
|---------|-------------|
| Neighbourhood choropleth | Ward polygons filled light to dark by value (quantile scale) |
| Amenity markers | Blue circle markers at each OSM amenity location |
| Hover info | Neighbourhood name, count, and label shown on ward mouseover |
| Amenity tooltips | Name and type shown on marker hover |
| Colour legend | Auto-generated quantile breakpoints in bottom-right corner |
| Layer control | Toggle neighbourhood fill and amenity markers independently |
| Visited-area toggle | Grey out wards listed in `data/visited_streets.csv` |
| Placeholder disclaimer | Banner at top; dismissible per session |

## Data

### CSV schema (aggregated, map-ready)

| Column | Description |
|--------|-------------|
| `neighbourhood` | Ward name matching GeoJSON properties (e.g. "Cowley") |
| `value` | Integer count (amenities in placeholder; HMOs in real data) |
| `value_label` | Human-readable label shown in legend and tooltip |

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
    neighbourhoods.geojson      <- Oxford ward boundary polygons (from ONS, ~41 KB)
    amenities.geojson           <- individual amenity point markers (from Overpass, ~467 KB)
    placeholder_amenities.csv   <- per-neighbourhood amenity count (placeholder)
    visited_streets.csv         <- neighbourhoods to mask as visited (editable)
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
| Ward boundaries | ONS Open Geography Portal |
| Amenity data | Overpass API (OpenStreetMap) |
| Point-in-polygon | shapely (Python, data generation only) |
| Hosting | GitHub Pages (static, free) |
| Build pipeline | None — plain HTML/CSS/JS |

## Open decisions

These are documented but do not block the MVP:

- **Density metric**: raw count vs count per unit area for neighbourhood colouring.
- **Column fuzzy matching** on CSV upload (v1.1).

## Data licence

Ward boundaries are from the [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/)
and are available under the Open Government Licence.

Amenity data is derived from [OpenStreetMap](https://www.openstreetmap.org/copyright)
and is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
