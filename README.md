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
| 🔵 HMO markers | One blue dot per HMO licence |
| 🟢 Selective markers | One green dot per Selective licence |
| HMO / Private renters density | Lower Super Output Area (LSOA) choropleth shaded by licence count (toggle independently) |
| ⚫ Licence holder addresses | Black dots at the home addresses of Oxford-based landlords (OX1–OX4 only) |
| 🔴 Agent highlight | Dropdown to select a letting agency and overlay red halos on their managed properties |
| 🚪 Doorknock streets (Cowley) | Optional canvassing overlay: the Cowley streets with the highest renter density and top-20-rental-agency listing density (per 100m, not raw totals), with one overall meeting point and a door/marker count panel per street. Off by default. |

Hover any marker to see the property address, licence holder name, and managing agent.
Hover an LSOA to see its licence count.

**CSV upload** — the bottom-left panel accepts a custom CSV for overlaying additional data on top of the pre-loaded layers. Uploaded data never leaves your browser.

## Preprocessing pipeline

```
Oxford City Council registers (CSV, gitignored)
│
│  HMO_Register_April_*_details.csv          — one row per HMO licence (Case Number, address)
│  HMO_Register_April_*_contacts_cells.csv   — one or two rows per licence (agent + holder name/address)
│  Selective_Licence_Register*.csv           — one row per selective licence (address, agent, holder)
│
├─► build_address_lookup.py  ──────────────────────────────────────────────── ~2 s, no network
│     Joins details + contacts CSVs on Case Number.
│     Builds an agency-address table: scans every agent row; where the agent
│     name looks like a company (Ltd/LLP/&/letting/management/…), records
│     office_address → company_name.
│     Resolves agent per licence:
│       1. agent name == holder name  →  self-managed; use holder name
│       2. agent address == holder address (different names)  →  letting agency;
│          look up company name from agency-address table
│       3. otherwise  →  use agent name as-is
│     Output: data/licence_address_lookup.json  (gitignored)
│             { licence_id: { address, agent, holder, holder_address } }
│
├─► build_licence_locations.py  ───────────────────────────────── ~1–3 h first run, fast after
│     Reads property addresses from both registers.
│     For each address tries (in order):
│       1. OSM building centroid match (oxford_buildings.geojson)
│       2–5. Nominatim (4 query strategies, 1 req/s)
│       6. Google Maps Geocoding API (fallback, needs GOOGLE_GEOCODING_KEY)
│     Assigns each geocoded point to an LSOA polygon (shapely point-in-polygon).
│     Results cached in data/geocode_cache.json — safe to interrupt and resume.
│     Output: data/licence_locations.geojson  (committed, no personal data)
│             GeoJSON Points { type, id, lsoa, coordinates }
│
├─► patch_geojson_properties.py  ──────────────────────────────────────────── ~5 s, no network
│     Merges address + agent + holder from licence_address_lookup.json into
│     licence_locations.geojson in-place (joined on licence id).
│     Output: data/licence_locations.geojson  (updated in-place, commit after running)
│             GeoJSON Points { type, id, lsoa, address, agent, holder, coordinates }
│
├─► build_holder_locations.py  ────────────────────────────────── ~varies, uses geocode cache
│     Reads licence holder home addresses from both registers.
│     Filters to OX1–OX4 postcodes only (Oxford-based landlords).
│     Geocodes using the same 6-strategy cascade; reuses existing cache.
│     Groups by address: one point per unique address with property count.
│     Holder names are intentionally excluded from the output.
│     Output: data/holder_locations.geojson  (committed)
│             GeoJSON Points { holder_address, property_count, coordinates }
│
├─► build_locality_anchors.py  ───────────────────────────────────────────── <1 s, no network
│     One-off extraction from the OS OpenMap Local "Named Place" shapefile
│     (data/OS OpenMap Local*/, gitignored — ~500MB+ source, not committed):
│     converts each named locality (Cowley, Temple Cowley, Rose Hill,
│     Littlemore, Blackbird Leys, Iffley, …) from OSGB36 National Grid to
│     WGS84 lat/lon. Only needs re-running if the OS source data changes.
│     Output: data/oxford_locality_anchors.json  (committed)
│             [{ name, lat, lon }, …]
│
└─► build_doorknock_streets.py  ──────────────────────────────────────────── a few seconds
      Ranks Cowley streets (nearest named locality is Cowley or Temple
      Cowley — not the neighbouring areas that share its OX4 postcode) by
      renters-per-100m and top-20-rental-agency-listings-per-100m, keeps the
      top 7, and picks one overall meeting point (a nearby pub/cafe/car park
      where possible) for the shortlist.
      Output: data/doorknock_streets.geojson         (committed)
              data/doorknock_meeting_points.geojson   (committed)
```

The four committed geojson files (`licence_locations.geojson`,
`holder_locations.geojson`, `doorknock_streets.geojson`,
`doorknock_meeting_points.geojson`) plus `oxford_locality_anchors.json` are
all the map needs at runtime — no server, no database, no API calls.

## Generating the data files

The map loads pre-built data files committed to the repo. To regenerate them
after receiving new register data, run the scripts below in order.

### 1. Install dependencies

```bash
python3 -m venv oru-map
source oru-map/bin/activate
pip install -r requirements.txt
```

### 2. Place source registers in `data/`

- `data/HMO_Register_April_*_details.csv` — HMO property addresses (one row per licence)
- `data/HMO_Register_April_*_contacts_cells.csv` — HMO contacts (agent + holder rows per licence)
- `data/Selective_Licence_Register*.csv` — Selective Licence register (latin-1 encoded)

These files are gitignored (they contain personal data).

### 3. Build address + agent + holder lookup (~2 seconds)

```bash
python3 scripts/build_address_lookup.py
```

Produces `data/licence_address_lookup.json` — maps each licence ID to its
property address, managing agent, and licence holder name/address.

**Agent resolution** — for each HMO licence the contacts CSV has up to two rows
(agent and holder). The script applies these rules in order:

1. If agent name == holder name → self-managed property; use holder name as agent.
2. If agent address == holder address but names differ → a letting agency employee
   is at the same office as the holder. The script looks up which agency is known
   at that address (from an *agency address table* built by scanning all entries
   where the agent name looks like a company). If found → use the agency name.
3. Otherwise → use the agent name as-is.

### 4. Geocode licence locations (~1–3 hours first run, fast on re-runs)

```bash
export GOOGLE_GEOCODING_KEY="your-key-here"  # optional but recommended
python3 scripts/build_licence_locations.py
```

Produces `data/licence_locations.geojson` — one GeoJSON Point per licence
(HMO or Selective), with coordinates and LSOA. Address/agent/holder metadata
is added by the next step.

**Geocoding strategy** — for each address the script tries in order:
1. Direct match against `oxford_buildings.geojson` (OSM building centroids)
2. Nominatim: expanded address + postcode
3. Nominatim: house number + postcode only
4. Nominatim: house number found anywhere in the string + street + postcode
5. Nominatim: original address unchanged
6. **Google Maps Geocoding API** — only called if all Nominatim strategies fail

Results are cached in `data/geocode_cache.json`. Re-running the script is fast:
cached successes are returned instantly; only new addresses hit the network.

### 5. Patch metadata into the geojson (~5 seconds)

```bash
python3 scripts/patch_geojson_properties.py
```

Merges address, agent, and holder from `licence_address_lookup.json` into
`licence_locations.geojson` in-place. No geocoding — completes in seconds.

Commit the updated `data/licence_locations.geojson` to the repo so GitHub Pages
serves the new data.

### 6. Geocode licence holder (landlord) addresses (optional)

```bash
export GOOGLE_GEOCODING_KEY="your-key-here"
python3 scripts/build_holder_locations.py
```

Produces `data/holder_locations.geojson` — one point per unique landlord
home address, with property count. Sources both HMO and Selective registers.

**Oxford-only filter**: only addresses with an OX1–OX4 postcode are geocoded.
Landlords based outside Oxford city are excluded.

`data/holder_locations.geojson` is committed to the repo (holder names are
excluded from tooltips; addresses are public register data).

### Why Google Maps Geocoding?

Nominatim (OpenStreetMap) covers most Oxford street addresses well but fails on:
- **Named developments** (`Almero Student The Park, Horspath Driftway`)
- **Flat-only addresses** where the building isn't individually mapped in OSM
- **New builds** not yet added to OpenStreetMap

Google Maps handles these cases reliably. The API is free up to 40,000 requests/month.
Get a key at [console.cloud.google.com](https://console.cloud.google.com) →
Geocoding API → Credentials → Create API Key.

## File structure

```
oru_rent_map/
  index.html                        — map shell (Leaflet + chroma + PapaParse via CDN)
  static/
    app.js                          — map logic, layer builders, upload UI wiring
    hmo-upload.js                   — CSV parsing + address matching (in-browser)
  data/
    licence_locations.geojson       — pre-geocoded HMO + Selective points (committed)
    holder_locations.geojson        — landlord home addresses (committed, names excluded)
    neighbourhoods.geojson          — Oxford LSOA boundary polygons (ONS)
    oxford_buildings.geojson        — OSM building footprints with address tags
    licence_address_lookup.json     — id → {address, agent, holder, holder_address} (gitignored)
    geocode_cache.json              — Nominatim + Google results cache (gitignored)
    geocode_failures.csv            — addresses that could not be geocoded (gitignored)
    oxford_locality_anchors.json    — named-locality lat/lon lookup (committed)
    doorknock_streets.geojson       — doorknock overlay: per-property markers (committed)
    doorknock_meeting_points.geojson— doorknock overlay: single meeting point (committed)
  scripts/
    build_address_lookup.py         — build id → address/agent/holder lookup (run first)
    build_licence_locations.py      — geocode HMO + Selective property addresses
    patch_geojson_properties.py     — merge lookup metadata into licence_locations.geojson
    build_holder_locations.py       — geocode landlord home addresses (Oxford only)
    generate_building_data.py       — regenerate oxford_buildings.geojson from Overpass
    generate_placeholder.py         — regenerate LSOA boundaries from ONS + Overpass
    build_locality_anchors.py       — extract named-locality lat/lon from OS OpenMap Local
    build_doorknock_streets.py      — build the Cowley doorknocking overlay data
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
- `licence_locations.geojson` contains no personal data (coordinates, type, LSOA, address, agent name only)
- `holder_locations.geojson` contains holder addresses (public register) but not holder names
- Source registers and address lookups are gitignored
- At runtime, the map makes no external API calls (all data is served as static files)

## Data licences

- LSOA boundaries: [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/) — Open Government Licence
- Building footprints and base tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) — ODbL
- Licence data: Oxford City Council (public register)
- Named-locality anchors (Cowley, Temple Cowley, etc.): [OS OpenMap Local](https://www.ordnancesurvey.co.uk/products/os-open-map-local), Ordnance Survey — Open Government Licence
