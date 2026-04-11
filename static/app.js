// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  centre: [51.752, -1.2577],        // Oxford
  zoom: 13,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  // Fallback for demos / workshops where OSM may rate-limit:
  // tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  tileAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  neighbourhoodsPath: 'data/neighbourhoods.geojson',
  amenitiesPath:      'data/amenities.geojson',
  numQuantiles: 4,
  colourRange: ['#fee5d9', '#a50f15'],   // light → dark sequential fill
  defaultFillOpacity: 0.55,
  defaultBorderColour: '#666',
  highlightBorderColour: '#222',
  amenityMarkerRadius: 4,
  amenityMarkerColour: '#2563eb',
};


// ── Quantile breakpoints ──────────────────────────────────────────────────
function quantileBreaks(values, n) {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks = [];
  for (let i = 1; i < n; i++) {
    const idx = Math.floor((i / n) * sorted.length);
    breaks.push(sorted[idx]);
  }
  return breaks;
}


// ── Disclaimer dismiss ────────────────────────────────────────────────────
window.dismissDisclaimer = function () {
  document.getElementById('disclaimer').style.display = 'none';
  try { sessionStorage.setItem('disclaimerDismissed', '1'); } catch (_) {}
};

(function restoreDisclaimer() {
  try {
    if (sessionStorage.getItem('disclaimerDismissed') === '1') {
      const el = document.getElementById('disclaimer');
      if (el) el.style.display = 'none';
    }
  } catch (_) {}
})();


// ── Build the legend control ──────────────────────────────────────────────
function buildLegend(map, colourScale, breaks, valueLabel) {
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    const div = L.DomUtil.create('div', 'legend');

    let html = `<div class="legend-title">${valueLabel}</div>`;
    const ranges = [];
    ranges.push({ lo: 0, hi: breaks[0], colour: colourScale(0).hex() });
    for (let i = 0; i < breaks.length - 1; i++) {
      const mid = (breaks[i] + breaks[i + 1]) / 2;
      ranges.push({ lo: breaks[i], hi: breaks[i + 1], colour: colourScale(mid).hex() });
    }
    const maxVal = breaks[breaks.length - 1] + 1;
    ranges.push({ lo: breaks[breaks.length - 1], hi: maxVal, colour: colourScale(maxVal).hex() });

    ranges.forEach(r => {
      html += `<div class="legend-row">
        <span class="legend-swatch" style="background:${r.colour}"></span>
        ${r.lo}&ndash;${r.hi === maxVal ? '+' : r.hi}
      </div>`;
    });

    div.innerHTML = html;
    return div;
  };
  legend.addTo(map);
}


// ── Hover info panel helpers ──────────────────────────────────────────────
const infoPanel  = document.getElementById('info-panel');
const infoName   = document.getElementById('info-name');
const infoValue  = document.getElementById('info-value');

function showInfo(e, name, value, valueLabel) {
  infoName.textContent  = name;
  infoValue.textContent = `${valueLabel}: ${value}`;
  infoPanel.style.display = 'block';
  infoPanel.style.left = (e.originalEvent.clientX + 14) + 'px';
  infoPanel.style.top  = (e.originalEvent.clientY + 14) + 'px';
}

function hideInfo() {
  infoPanel.style.display = 'none';
}


// ── Main initialisation ───────────────────────────────────────────────────
(async function init() {
  // 1. Create map
  const map = L.map('map').setView(CONFIG.centre, CONFIG.zoom);
  L.tileLayer(CONFIG.tileUrl, { attribution: CONFIG.tileAttribution, maxZoom: 19 }).addTo(map);

  // 2. Fetch data in parallel
  const [wardRes, amenityRes] = await Promise.all([
    fetch(CONFIG.neighbourhoodsPath),
    fetch(CONFIG.amenitiesPath),
  ]);

  const wardGeojson    = await wardRes.json();
  const amenityGeojson = await amenityRes.json();

  // 3. Extract amenity counts and build a quantile-based colour scale
  //    Using .classes() ensures even colour distribution despite skewed data.
  const valueLabel = 'OSM amenity count (placeholder)';
  const allValues = wardGeojson.features.map(f => f.properties.amenity_count || 0);
  const breaks    = quantileBreaks(allValues, CONFIG.numQuantiles);
  const minVal    = Math.min(...allValues);
  const maxVal    = Math.max(...allValues);
  const classBounds = [minVal, ...breaks, maxVal];
  const colourScale = chroma.scale(CONFIG.colourRange).classes(classBounds);

  // 4. Style function for neighbourhood polygons
  function wardStyle(feature) {
    const count = feature.properties.amenity_count || 0;
    return {
      fillColor: colourScale(count).hex(),
      fillOpacity: CONFIG.defaultFillOpacity,
      color: CONFIG.defaultBorderColour,
      weight: 1.5,
    };
  }

  // 5. Render neighbourhood polygon layer
  const wardLayer = L.geoJSON(wardGeojson, {
    style: wardStyle,
    onEachFeature: function (feature, layer) {
      const name  = feature.properties.LSOA21NM || '(unnamed)';
      const count = feature.properties.amenity_count || 0;

      layer.on('mouseover', function (e) {
        this.setStyle({ weight: 3, color: CONFIG.highlightBorderColour });
        this.bringToFront();
        showInfo(e, name, count, valueLabel);
      });
      layer.on('mousemove', function (e) {
        infoPanel.style.left = (e.originalEvent.clientX + 14) + 'px';
        infoPanel.style.top  = (e.originalEvent.clientY + 14) + 'px';
      });
      layer.on('mouseout', function () {
        wardLayer.resetStyle(this);
        hideInfo();
      });
    },
  }).addTo(map);

  // 6. Render amenity point markers
  const amenityLayer = L.geoJSON(amenityGeojson, {
    pointToLayer: function (feature, latlng) {
      return L.circleMarker(latlng, {
        radius: CONFIG.amenityMarkerRadius,
        fillColor: CONFIG.amenityMarkerColour,
        fillOpacity: 0.7,
        color: '#fff',
        weight: 1,
      });
    },
    onEachFeature: function (feature, layer) {
      const p = feature.properties;
      const label = p.name ? `${p.name} (${p.amenity})` : p.amenity;
      layer.bindTooltip(label, { direction: 'top', offset: [0, -6] });
    },
  }).addTo(map);

  // 7. Legend
  buildLegend(map, colourScale, breaks, valueLabel);

  // 8. Layer control to toggle neighbourhood density and amenity markers independently
  L.control.layers(null, {
    'Neighbourhood density': wardLayer,
    'Amenity markers': amenityLayer,
  }, { collapsed: false, position: 'topright' }).addTo(map);
})();
