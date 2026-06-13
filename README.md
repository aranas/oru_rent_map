# Oxford Licence Map

Interactive map of Oxford City Council's HMO and Selective Licence registers,
visualised as point markers and LSOA density choropleths.

## Quick start

[**View the map →**](https://aranas.github.io/oru_rent_map/)

To run locally:

```bash
python3 -m http.server 8000
# Open http://localhost:8000
```

## What the map shows

Pre-loaded from the Oxford City Council licence registers:

| Layer | Description |
|-------|-------------|
| 🔵 HMO markers | One blue dot per HMO licence, positioned at the geocoded property address |
| 🟢 Selective markers | One green dot per Selective licence |
| Combined / HMO / Selective density | LSOA choropleth shaded by licence count (toggle independently) |
| ⚫ Licence holder addresses | Black dots at the home addresses of Oxford-based landlords (OX1–OX4 only) |
| 🔴 Agent highlights | Toggle per-agent halos to see the geographic footprint of individual letting agents (Chancellors, Scott Fraser, NOPS, and more) |

Hover any marker to see the property address and managing agent. Hover an LSOA to see its licence count.

**CSV upload** — the bottom-left panel accepts a custom CSV for overlaying additional data on top of the pre-loaded layers. Uploaded data never leaves your browser.

## Generating the data files

The map loads three pre-built data files that are not committed to the repo
(they derive from source registers which contain personal data). Run these
scripts locally after cloning:

### 1. Install dependencies

```bash
python3 -m venv oru-map
source oru-map/bin/activate
pip install -r requirements.txt
```

### 2. Place source registers in `data/`

- `data/Oxford HMO Register - Parsed.xlsx` — Oxford City Council HMO register
- `data/Selective_Licence_Register_*.csv` — Oxford City Council Selective Licence register (latin-1 encoded)

### 3. Build address + agent lookup (~2 seconds)

```bash
python3 scripts/build_address_lookup.py
```

Produces `data/licence_address_lookup.json` — maps each licence ID to its
address, managing agent, and licence holder name. Used for marker tooltips.

### 4. Geocode licence locations (~1–3 hours first run, fast on re-runs)

```bash
export GOOGLE_GEOCODING_KEY="your-key-here"  # optional but recommended
python3 scripts/build_licence_locations.py
```

Produces `data/licence_locations.geojson` — one GeoJSON Point per licence
(HMO or Selective), containing only: type, licence ID, start/end dates, and
LSOA. No personal data.

**Geocoding strategy** — for each address the script tries in order:
1. Direct match against `oxford_buildings.geojson` (OSM building centroids)
2. Nominatim: expanded address + postcode
3. Nominatim: house number + postcode only
4. Nominatim: house number found anywhere in the string + street + postcode  
   *(handles "Flat 1, Oakthorpe Mansions, 205 Banbury Road, OX2 7HG")*
5. Nominatim: original address unchanged
6. **Google Maps Geocoding API** — only called if all Nominatim strategies fail;
   handles named developments and new builds that aren't in OSM

Results are cached in `data/geocode_cache.json`. Re-running the script is fast:
cached successes (~10k+) are returned instantly; only new or previously-failed
addresses hit the network.

`data/licence_locations.geojson` **is committed** to the repo (no personal data)
so the map works on GitHub Pages without running this script.

### 5. Geocode licence holder (landlord) addresses (optional)

```bash
export GOOGLE_GEOCODING_KEY="your-key-here"
python3 scripts/build_holder_locations.py
```

Produces `data/holder_locations.geojson` — one point per unique landlord
address, with the holder name(s) and property count.

**Oxford-only filter**: only addresses with an OX1–OX4 postcode are geocoded
(~2,976 of 7,544 unique holder addresses). Landlords based outside Oxford city
are excluded — the layer is intended to show where Oxford-based landlords live
relative to their properties, not to map the entire national landlord base.

The same 6-strategy geocoding cascade is used as for licence locations.

`data/holder_locations.geojson` is **gitignored** (contains holder names and
addresses). Each team member who wants the layer must run this script locally.

### Why Google Maps Geocoding?

Nominatim (OpenStreetMap) covers most Oxford street addresses well but fails on:
- **Named developments** with no street number (`Almero Student The Park, Horspath Driftway`)
- **Flat-only addresses** where the building isn't individually mapped in OSM
- **New builds** not yet added to OpenStreetMap

Google Maps handles these cases reliably. The API is free up to 40,000 requests/month
(well above the ~3,400 addresses that Nominatim can't resolve). A billing account
is required to activate the free tier but no charges are incurred within the quota.

Get a key at [console.cloud.google.com](https://console.cloud.google.com) →
Geocoding API → Credentials → Create API Key. Restrict the key to the
Geocoding API only.

## File structure

```
oru_rent_map/
  index.html                        — map shell (Leaflet + chroma + PapaParse via CDN)
  static/
    app.js                          — map logic, layer builders, upload UI wiring
    hmo-upload.js                   — CSV parsing + address matching (in-browser)
  data/
    licence_locations.geojson       — pre-geocoded HMO + Selective points (committed)
    neighbourhoods.geojson          — Oxford LSOA boundary polygons (ONS)
    oxford_buildings.geojson        — OSM building footprints with address tags
    licence_address_lookup.json     — id → {address, agent, holder} (gitignored)
    holder_locations.geojson        — landlord home addresses (gitignored)
    geocode_cache.json              — Nominatim + Google results cache (gitignored)
    geocode_failures.csv            — addresses that could not be geocoded (gitignored)
  scripts/
    build_licence_locations.py      — geocode HMO + Selective property addresses
    build_holder_locations.py       — geocode landlord home addresses (Oxford only)
    build_address_lookup.py         — build id → address/agent/holder lookup
    generate_building_data.py       — regenerate oxford_buildings.geojson from Overpass
    generate_placeholder.py         — regenerate LSOA boundaries from ONS + Overpass
  requirements.txt
  README.md
```

## Technology

| Concern | Choice |
|---------|--------|
| Map rendering | Leaflet.js (CDN) |
| Base tiles | OpenStreetMap |
| Colour scale | chroma.js (CDN) |
| CSV parsing | PapaParse (CDN) |
| Neighbourhood boundaries | ONS Open Geography Portal (LSOA 2021) |
| Building footprints | Overpass API (OpenStreetMap, build-time only) |
| Geocoding | Nominatim (primary) + Google Maps Geocoding API (fallback) |
| Point-in-polygon (LSOA assignment) | shapely (Python, data generation only) |
| Hosting | GitHub Pages (static) |

## Privacy

- Uploaded CSV data is parsed entirely in the browser — **no data leaves your machine**
- `licence_locations.geojson` contains no personal data (coordinates, type, dates, LSOA only)
- Source registers, address lookups, and holder locations are gitignored
- At runtime, the map makes no external API calls (all data is served as static files)

## Data licences

- LSOA boundaries: [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/) — Open Government Licence
- Building footprints and base tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) — ODbL
- Licence data: Oxford City Council (public register)
