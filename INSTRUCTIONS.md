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

**Using venv:**

```bash
cd oru_doorknocking_map
python3 -m venv venv
source venv/bin/activate     # On Windows: venv\Scripts\activate
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

## 2. GitHub repo initialisation

### Create the repo

```bash
cd oru_doorknocking_map
git init
git add .
git commit -m "Initial commit: MVP map scaffold + placeholder data"
```

### Create the remote (pick one)

**Option A — GitHub CLI:**

```bash
gh repo create oru_doorknocking_map --public --source=. --push
```

**Option B — Manual:**

1. Go to https://github.com/new and create a repo named `oru_doorknocking_map`.
2. Then:

```bash
git remote add origin git@github.com:<YOUR_ORG>/oru_doorknocking_map.git
git branch -M main
git push -u origin main
```

### Branch conventions

- `main` — production; what GitHub Pages serves.
- Feature branches: `feature/<short-name>` (e.g. `feature/csv-upload`).

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
| `data/neighbourhoods.geojson` | 20 Oxford ward polygons with `amenity_count` | ~41 KB |
| `data/amenities.geojson` | ~2,700 amenity point markers | ~467 KB |
| `data/placeholder_amenities.csv` | Per-neighbourhood amenity counts | ~1 KB |
| `data/amenities_raw.json` | Raw Overpass response (intermediate, gitignored) | ~1.1 MB |

### 3b. Preprocess real HMO data (when available)

When you have the real HMO register CSV (one row per property with columns
`id`, `address`, `neighbourhood`):

```bash
python3 scripts/preprocess_data.py data/hmo_register.csv \
  --output data/hmo_aggregated.csv \
  --label "HMO count"
```

Then update `CONFIG.neighbourhoodsPath` or the `amenity_count` property
approach in `static/app.js` to use the new data.

---

## 4. Manual testing of the map

### Start a local server

```bash
cd oru_doorknocking_map
python3 -m http.server 8000
```

### Open in your browser

Navigate to: **http://localhost:8000**

### Visual verification checklist

Open the browser developer console (Cmd+Option+J on Mac, F12 on Windows),
then check the following:

- [ ] **Map loads** and is centred on Oxford at a comfortable zoom level.
- [ ] **Ward polygons are shaded** from light to dark — not all the same colour.
- [ ] **Colour legend** appears in the bottom-right corner. Title reads
      "OSM amenity count (placeholder)" (or your custom `value_label`).
- [ ] **Hover** over a ward polygon: an info panel appears near the cursor
      showing the neighbourhood name, count, and label. Disappears on mouseout.
- [ ] **Amenity markers**: blue circles visible across Oxford. Hover shows
      amenity name and type in a tooltip.
- [ ] **Layer control** in the top-right: uncheck "Neighbourhood density" to
      hide ward fill; uncheck "Amenity markers" to hide points.
- [ ] **Disclaimer banner** at the top reads "Showing placeholder data...".
      Click the X to dismiss. Refresh — it should stay dismissed (same session).
- [ ] **Visited toggle**: check "Mask visited areas" in the top-right.
      The "Cowley" ward (example entry in `visited_streets.csv`) turns grey.

---

## 5. Staging to GitHub Pages

### Enable GitHub Pages

1. Go to your repo on GitHub: `https://github.com/<YOUR_ORG>/oru_doorknocking_map`
2. Navigate to **Settings** → **Pages**.
3. Under **Source**, select:
   - Branch: `main`
   - Folder: `/ (root)`
4. Click **Save**.

### Expected URL

After a minute or two, the site will be live at:

```
https://<YOUR_ORG>.github.io/oru_doorknocking_map/
```

### Verify the deployed site

Open the URL above and repeat the visual verification checklist from section 4.

### Deploying updates

Any push to `main` automatically triggers a Pages rebuild:

```bash
git add .
git commit -m "Update data"
git push origin main
```

The site typically updates within 1–2 minutes.

### Fallback tile URL for demos / workshops

If OSM tiles are slow during a live demo, edit one line in `static/app.js`:

```javascript
// Change this:
tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
// To this:
tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
```

Commit and push to update the live site.
