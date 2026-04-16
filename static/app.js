// ── Configuration ──────────────────────────────────────────────────────────
var CONFIG = {
  centre: [51.752, -1.2577],
  zoom: 13,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  neighbourhoodsPath: 'data/neighbourhoods.geojson',
  amenitiesPath:      'data/amenities.geojson',
  buildingsPath:      'data/oxford_buildings.geojson',
  numQuantiles: 4,
  colourRange: ['#fee5d9', '#a50f15'],
  defaultFillOpacity: 0.55,
  defaultBorderColour: '#666',
  highlightBorderColour: '#222',
  amenityMarkerRadius: 4,
  amenityMarkerColour: '#2563eb',
  hmoBuildingFill:   '#2563eb',
  hmoBuildingStroke: '#1d4ed8',
  hmoFallbackColour: '#ea580c',
  allBuildingsFill:   '#22c55e',
  allBuildingsStroke: '#15803d',
};


// ── Quantile breakpoints ──────────────────────────────────────────────────
function quantileBreaks(values, n) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var breaks = [];
  for (var i = 1; i < n; i++) {
    var idx = Math.floor((i / n) * sorted.length);
    breaks.push(sorted[idx]);
  }
  return breaks;
}


// ── Welcome overlay dismiss ───────────────────────────────────────────────
(function () {
  var overlay = document.getElementById('welcome-overlay');
  if (!overlay) return;

  try {
    if (sessionStorage.getItem('welcomeDismissed') === '1') {
      overlay.remove();
      return;
    }
  } catch (_) {}

  function close() {
    overlay.remove();
    try { sessionStorage.setItem('welcomeDismissed', '1'); } catch (_) {}
  }

  document.getElementById('welcome-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
})();


// ── Disclaimer dismiss ────────────────────────────────────────────────────
window.dismissDisclaimer = function () {
  document.getElementById('disclaimer').style.display = 'none';
  try { sessionStorage.setItem('disclaimerDismissed', '1'); } catch (_) {}
};

(function restoreDisclaimer() {
  try {
    if (sessionStorage.getItem('disclaimerDismissed') === '1') {
      var el = document.getElementById('disclaimer');
      if (el) el.style.display = 'none';
    }
  } catch (_) {}
})();


// ── Hover info panel helpers ──────────────────────────────────────────────
var infoPanel  = document.getElementById('info-panel');
var infoName   = document.getElementById('info-name');
var infoValue  = document.getElementById('info-value');

function showInfo(e, name, value, valueLabel) {
  infoName.textContent  = name;
  infoValue.textContent = valueLabel + ': ' + value;
  infoPanel.style.display = 'block';
  infoPanel.style.left = (e.originalEvent.clientX + 14) + 'px';
  infoPanel.style.top  = (e.originalEvent.clientY + 14) + 'px';
}

function hideInfo() {
  infoPanel.style.display = 'none';
}


// ── Reusable layer builders ──────────────────────────────────────────────

function buildChoropleth(map, wardGeojson, countProp, valueLabel) {
  var allValues = wardGeojson.features.map(function (f) {
    return f.properties[countProp] || 0;
  });
  var breaks     = quantileBreaks(allValues, CONFIG.numQuantiles);
  var minVal     = Math.min.apply(null, allValues);
  var maxVal     = Math.max.apply(null, allValues);
  var classBounds = [minVal].concat(breaks, [maxVal]);
  var colourScale = chroma.scale(CONFIG.colourRange).classes(classBounds);

  function wardStyle(feature) {
    var count = feature.properties[countProp] || 0;
    return {
      fillColor: colourScale(count).hex(),
      fillOpacity: CONFIG.defaultFillOpacity,
      color: CONFIG.defaultBorderColour,
      weight: 1.5,
    };
  }

  var wardLayer = L.geoJSON(wardGeojson, {
    style: wardStyle,
    onEachFeature: function (feature, layer) {
      var name  = feature.properties.LSOA21NM || '(unnamed)';
      var count = feature.properties[countProp] || 0;

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
  });

  return { wardLayer: wardLayer, colourScale: colourScale, breaks: breaks };
}


function buildPointMarkers(map, pointGeojson, opts) {
  opts = opts || {};
  var radius    = opts.radius    || CONFIG.amenityMarkerRadius;
  var fillColor = opts.fillColor || CONFIG.amenityMarkerColour;
  var tooltipFn = opts.tooltipFn || function (p) {
    return p.name ? p.name + ' (' + p.amenity + ')' : p.amenity;
  };

  return L.geoJSON(pointGeojson, {
    pointToLayer: function (feature, latlng) {
      return L.circleMarker(latlng, {
        radius: radius,
        fillColor: fillColor,
        fillOpacity: 0.7,
        color: '#fff',
        weight: 1,
      });
    },
    onEachFeature: function (feature, layer) {
      var label = tooltipFn(feature.properties);
      if (label) layer.bindTooltip(label, { direction: 'top', offset: [0, -6] });
    },
  });
}


function buildAllReferenceBuildings(buildingGeojson) {
  return L.geoJSON(buildingGeojson, {
    style: function () {
      return {
        fillColor: CONFIG.allBuildingsFill,
        fillOpacity: 0.28,
        color: CONFIG.allBuildingsStroke,
        weight: 1.5,
      };
    },
    onEachFeature: function (feature, layer) {
      var p = feature.properties;
      var line = '';
      if (p.addr_housenumber || p.addr_street) {
        line = [p.addr_housenumber, p.addr_street].filter(Boolean).join(' ');
      }
      if (p.addr_postcode) {
        line = line ? line + ', ' + p.addr_postcode : p.addr_postcode;
      }
      if (!line && p.match_key) line = p.match_key;
      if (line) layer.bindTooltip(line, { direction: 'top', offset: [0, -6] });
    },
  });
}


function buildBuildingFootprints(map, buildingGeojson) {
  return L.geoJSON(buildingGeojson, {
    style: function () {
      return {
        fillColor: CONFIG.hmoBuildingFill,
        fillOpacity: 0.35,
        color: CONFIG.hmoBuildingStroke,
        weight: 2,
      };
    },
    onEachFeature: function (feature, layer) {
      var p = feature.properties;
      var lines = [];
      if (p.address)        lines.push(p.address);
      if (p.sub_units)      lines.push('Units: ' + p.sub_units);
      if (p.entry_count)    lines.push('<em>' + p.entry_count + ' separate HMO entries at this address</em>');
      if (p.hmo_id)         lines.push('ID: ' + p.hmo_id);
      if (p.licence_start)  lines.push('Start: ' + p.licence_start);
      if (p.licence_end)    lines.push('End: ' + p.licence_end);
      if (lines.length) {
        layer.bindTooltip(lines.join('<br>'), { direction: 'top', offset: [0, -6] });
      }
    },
  });
}


function buildLegend(map, colourScale, breaks, valueLabel) {
  var legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    var div = L.DomUtil.create('div', 'legend');
    var html = '<div class="legend-title">' + valueLabel + '</div>';
    var ranges = [];

    ranges.push({ lo: 0, hi: breaks[0], colour: colourScale(0).hex() });
    for (var i = 0; i < breaks.length - 1; i++) {
      var mid = (breaks[i] + breaks[i + 1]) / 2;
      ranges.push({ lo: breaks[i], hi: breaks[i + 1], colour: colourScale(mid).hex() });
    }
    var maxVal = breaks[breaks.length - 1] + 1;
    ranges.push({ lo: breaks[breaks.length - 1], hi: maxVal, colour: colourScale(maxVal).hex() });

    ranges.forEach(function (r) {
      html += '<div class="legend-row">' +
        '<span class="legend-swatch" style="background:' + r.colour + '"></span>' +
        r.lo + '&ndash;' + (r.hi === maxVal ? '+' : r.hi) +
        '</div>';
    });

    div.innerHTML = html;
    return div;
  };
  return legend;
}


// ── Main initialisation ───────────────────────────────────────────────────
(async function init() {
  var map = L.map('map').setView(CONFIG.centre, CONFIG.zoom);
  L.tileLayer(CONFIG.tileUrl, { attribution: CONFIG.tileAttribution, maxZoom: 19 }).addTo(map);

  // State references for layer swapping
  var currentWardLayer   = null;
  var currentMarkerLayer = null;
  var currentBuildingLayer  = null;
  var currentFallbackLayer  = null;
  var currentLegend      = null;
  var currentLayerControl = null;
  var wardGeojson        = null;
  var allBuildingsLayer  = null;

  // Fetch base neighbourhood data (always needed for choropleth)
  var wardRes = await fetch(CONFIG.neighbourhoodsPath);
  wardGeojson = await wardRes.json();

  // ── Apply data and render layers ───────────────────────────────────────

  function applyData(countProp, valueLabel, pointGeojson, hmoBuildings, hmoFallback, matchStats) {
    // Remove existing layers
    if (currentWardLayer)     { map.removeLayer(currentWardLayer); }
    if (currentMarkerLayer)   { map.removeLayer(currentMarkerLayer); }
    if (currentBuildingLayer) { map.removeLayer(currentBuildingLayer); }
    if (currentFallbackLayer) { map.removeLayer(currentFallbackLayer); }
    if (currentLegend)        { map.removeControl(currentLegend); }
    if (currentLayerControl)  { map.removeControl(currentLayerControl); }

    // Build choropleth
    var choro = buildChoropleth(map, wardGeojson, countProp, valueLabel);
    currentWardLayer = choro.wardLayer;
    currentWardLayer.addTo(map);

    // Build legend
    currentLegend = buildLegend(map, choro.colourScale, choro.breaks, valueLabel);
    currentLegend.addTo(map);

    var overlays = {};
    overlays['Neighbourhood density'] = currentWardLayer;

    if (hmoBuildings && hmoBuildings.features.length > 0) {
      currentBuildingLayer = buildBuildingFootprints(map, hmoBuildings);
      currentBuildingLayer.addTo(map);
      overlays['HMO buildings'] = currentBuildingLayer;
    }

    if (hmoFallback && hmoFallback.features.length > 0) {
      currentFallbackLayer = buildPointMarkers(map, hmoFallback, {
        radius: 5,
        fillColor: CONFIG.hmoFallbackColour,
        tooltipFn: function (p) {
          var lines = [];
          if (p.address)        lines.push(p.address);
          if (p.sub_units)      lines.push('Units: ' + p.sub_units);
          if (p.entry_count)    lines.push(p.entry_count + ' separate HMO entries at this address');
          if (p.hmo_id)         lines.push('ID: ' + p.hmo_id);
          if (p.licence_start)  lines.push('Start: ' + p.licence_start);
          if (p.licence_end)    lines.push('End: ' + p.licence_end);
          return lines.join('\n');
        },
      });
      currentFallbackLayer.addTo(map);
      overlays['Unmatched (postcode centroid)'] = currentFallbackLayer;
    }

    if (pointGeojson) {
      currentMarkerLayer = buildPointMarkers(map, pointGeojson);
      currentMarkerLayer.addTo(map);
      overlays['Amenity markers'] = currentMarkerLayer;
    }

    if (allBuildingsLayer) {
      overlays['All building footprints'] = allBuildingsLayer;
    }

    currentLayerControl = L.control.layers(null, overlays, { collapsed: false, position: 'topright' });
    currentLayerControl.addTo(map);
  }

  // ── Replace data with HMO results ─────────────────────────────────────

  function replaceWithHmoData(hmoData) {
    // Patch wardGeojson with HMO counts
    wardGeojson.features.forEach(function (f) {
      var name = f.properties.LSOA21NM || '';
      f.properties.amenity_count = hmoData.lsoaCounts[name] || 0;
    });

    var stats = hmoData.matchStats;
    var label = 'HMO count';

    applyData('amenity_count', label, null, hmoData.hmoBuildings, hmoData.hmoFallbackPoints, stats);

    // Update disclaimer
    var disc = document.getElementById('disclaimer');
    if (disc) {
      var txt = 'Showing HMO licence data (' + stats.total + ' properties, ' +
        stats.matched + ' matched to buildings';
      if (stats.multiHousehold > 0) {
        txt += ', ' + stats.multiHousehold + ' with multiple HMO entries at one address';
      }
      txt += ')';
      disc.innerHTML = txt +
        ' <button onclick="dismissDisclaimer()" aria-label="Dismiss">&times;</button>';
      disc.style.display = '';
      try { sessionStorage.removeItem('disclaimerDismissed'); } catch (_) {}
    }

    // Show clear button
    var btn = document.getElementById('btn-clear-hmo');
    if (btn) btn.style.display = 'inline-block';
  }

  // ── Revert to placeholder amenity data ─────────────────────────────────

  async function revertToPlaceholder() {
    var amenityRes = await fetch(CONFIG.amenitiesPath);
    var amenityGeojson = await amenityRes.json();

    // Restore original amenity counts from the GeoJSON
    var freshWardRes = await fetch(CONFIG.neighbourhoodsPath);
    var freshWardGeojson = await freshWardRes.json();
    wardGeojson.features.forEach(function (f, i) {
      f.properties.amenity_count = freshWardGeojson.features[i].properties.amenity_count;
    });

    applyData('amenity_count', 'OSM amenity count (placeholder)', amenityGeojson, null, null, null);

    var disc = document.getElementById('disclaimer');
    if (disc) {
      disc.innerHTML =
        'Showing placeholder data (OSM amenity counts per neighbourhood). Upload your HMO CSV to see real data.' +
        ' <button onclick="dismissDisclaimer()" aria-label="Dismiss">&times;</button>';
      disc.style.display = '';
      try { sessionStorage.removeItem('disclaimerDismissed'); } catch (_) {}
    }

    var btn = document.getElementById('btn-clear-hmo');
    if (btn) btn.style.display = 'none';

    setUploadStatus('', '');
  }

  // ── Upload UI wiring ───────────────────────────────────────────────────

  var statusEl  = document.getElementById('upload-status');
  var dropZone  = document.getElementById('upload-drop-zone');
  var fileInput = document.getElementById('hmo-file-input');
  var clearBtn  = document.getElementById('btn-clear-hmo');

  function setUploadStatus(msg, className) {
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.className = className || '';
    }
  }

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', function () { fileInput.click(); });

    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
    });
  }

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setUploadStatus('Please select a .csv file.', 'error');
      return;
    }
    setUploadStatus('Processing...', '');

    window.HmoUpload.processHmoCsv(file, function (msg) {
      setUploadStatus(msg, '');
    }).then(function (result) {
      replaceWithHmoData(result);
      setUploadStatus('CSV loaded', 'success');
    }).catch(function (err) {
      setUploadStatus('Error: ' + err.message, 'error');
      console.error('HMO upload error:', err);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      revertToPlaceholder();
    });
  }

  // ── Initial load: always start with placeholder data ───────────────────

  try {
    var buildingsRes = await fetch(CONFIG.buildingsPath);
    if (buildingsRes.ok) {
      var buildingsGeojson = await buildingsRes.json();
      allBuildingsLayer = buildAllReferenceBuildings(buildingsGeojson);
    }
  } catch (err) {
    console.warn('Could not load reference building footprints:', err);
  }

  var amenityRes = await fetch(CONFIG.amenitiesPath);
  var amenityGeojson = await amenityRes.json();
  applyData('amenity_count', 'OSM amenity count (placeholder)', amenityGeojson, null, null, null);
})();
