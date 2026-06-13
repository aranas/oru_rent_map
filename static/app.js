// ── Configuration ──────────────────────────────────────────────────────────
var CONFIG = {
  centre: [51.752, -1.2577],
  zoom: 13,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  neighbourhoodsPath:     'data/neighbourhoods.geojson',
  licenceLocationsPath:   'data/licence_locations.geojson',
  addressLookupPath:      'data/licence_address_lookup.json',
  numQuantiles: 4,
  // Choropleth colour ranges per type
  choroplethHmo:       ['#dbeafe', '#1e40af'],  // blue
  choroplethSelective: ['#dcfce7', '#166534'],  // green
  choroplethCombined:  ['#f3e8ff', '#6b21a8'],  // purple
defaultFillOpacity:  0.55,
  defaultBorderColour: '#666',
  highlightBorderColour: '#222',
  // Marker colours
  hmoMarkerColour:       '#2563eb',  // blue
  selectiveMarkerColour: '#16a34a',  // green
  // CSV upload (existing HMO footprint matching)
  hmoBuildingFill:   '#2563eb',
  hmoBuildingStroke: '#1d4ed8',
  hmoFallbackColour: '#ea580c',
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


// ── Reusable layer builders ───────────────────────────────────────────────

// opts.hoverHtmlFn(feature) → HTML string for info panel (overrides default count display)
function buildChoropleth(wardGeojson, countProp, valueLabel, colourRange, opts) {
  opts = opts || {};
  var allValues = wardGeojson.features.map(function (f) {
    return f.properties[countProp] || 0;
  });
  var breaks      = quantileBreaks(allValues, CONFIG.numQuantiles);
  var minVal      = Math.min.apply(null, allValues);
  var maxVal      = Math.max.apply(null, allValues);
  var classBounds = [minVal].concat(breaks, [maxVal]);
  var colourScale = chroma.scale(colourRange).classes(classBounds);

  function wardStyle(feature) {
    var count = feature.properties[countProp] || 0;
    return {
      fillColor:   colourScale(count).hex(),
      fillOpacity: CONFIG.defaultFillOpacity,
      color:       CONFIG.defaultBorderColour,
      weight:      1.5,
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
        if (opts.hoverHtmlFn) {
          var html = opts.hoverHtmlFn(feature);
          infoName.textContent = name;
          infoValue.innerHTML  = html;
          infoPanel.style.display = 'block';
          infoPanel.style.left = (e.originalEvent.clientX + 14) + 'px';
          infoPanel.style.top  = (e.originalEvent.clientY + 14) + 'px';
        } else {
          showInfo(e, name, count, valueLabel);
        }
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


function buildPointMarkers(pointGeojson, opts) {
  opts = opts || {};
  var radius    = opts.radius    || 5;
  var fillColor = opts.fillColor || CONFIG.hmoMarkerColour;
  var tooltipFn = opts.tooltipFn || function () { return ''; };

  return L.geoJSON(pointGeojson, {
    pointToLayer: function (feature, latlng) {
      return L.circleMarker(latlng, {
        radius:      radius,
        fillColor:   fillColor,
        fillOpacity: 0.8,
        color:       '#fff',
        weight:      1,
      });
    },
    onEachFeature: function (feature, layer) {
      var label = tooltipFn(feature.properties);
      if (label) layer.bindTooltip(label, { direction: 'top', offset: [0, -6] });
    },
  });
}


function buildBuildingFootprints(buildingGeojson) {
  return L.geoJSON(buildingGeojson, {
    style: function () {
      return {
        fillColor:   CONFIG.hmoBuildingFill,
        fillOpacity: 0.35,
        color:       CONFIG.hmoBuildingStroke,
        weight:      2,
      };
    },
    onEachFeature: function (feature, layer) {
      var p = feature.properties;
      var lines = [];
      if (p.address)       lines.push(p.address);
      if (p.sub_units)     lines.push('Units: ' + p.sub_units);
      if (p.entry_count)   lines.push('<em>' + p.entry_count + ' separate HMO entries at this address</em>');
      if (p.hmo_id)        lines.push('ID: ' + p.hmo_id);
      if (p.licence_start) lines.push('Start: ' + p.licence_start);
      if (p.licence_end)   lines.push('End: ' + p.licence_end);
      if (lines.length) {
        layer.bindTooltip(lines.join('<br>'), { direction: 'top', offset: [0, -6] });
      }
    },
  });
}


function buildLegend(colourScale, breaks, valueLabel) {
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

  // ── Load base data ────────────────────────────────────────────────────
  var wardRes    = await fetch(CONFIG.neighbourhoodsPath);
  var wardGeojson = await wardRes.json();

  var licRes     = await fetch(CONFIG.licenceLocationsPath);
  var licGeojson = await licRes.json();

  // Address lookup (id → address string); fails gracefully if file absent
  var addrLookup = {};
  try {
    var addrRes = await fetch(CONFIG.addressLookupPath);
    if (addrRes.ok) addrLookup = await addrRes.json();
  } catch (e) { /* non-fatal */ }

  // ── Aggregate LSOA counts ─────────────────────────────────────────────
  var hmoLsoa = {};
  var selLsoa = {};

  licGeojson.features.forEach(function (f) {
    var lsoa = f.properties.lsoa || '';
    if (!lsoa) return;
    if (f.properties.type === 'hmo') {
      hmoLsoa[lsoa] = (hmoLsoa[lsoa] || 0) + 1;
    } else {
      selLsoa[lsoa] = (selLsoa[lsoa] || 0) + 1;
    }
  });

  // Patch wardGeojson with counts
  wardGeojson.features.forEach(function (f) {
    var name = f.properties.LSOA21NM || '';
    f.properties.hmo_count       = hmoLsoa[name] || 0;
    f.properties.selective_count = selLsoa[name] || 0;
    f.properties.combined_count  = (hmoLsoa[name] || 0) + (selLsoa[name] || 0);
  });

  // ── Split licence features by type ───────────────────────────────────
  var hmoFeatures = licGeojson.features.filter(function (f) {
    return f.properties.type === 'hmo';
  });
  var selFeatures = licGeojson.features.filter(function (f) {
    return f.properties.type === 'selective';
  });

  function licTooltip(p) {
    var lines = [];
    var meta  = addrLookup[p.id] || {};
    var addr  = meta.address || '';
    var agent = meta.agent  || '';
    var holder = meta.holder || '';
    if (addr)            lines.push('<strong>' + addr + '</strong>');
    if (agent)           lines.push('Agent: ' + agent);
    if (holder)          lines.push('Holder: ' + holder);
    if (p.id)            lines.push('ID: ' + p.id);
    if (p.licence_start) lines.push('Start: ' + p.licence_start);
    if (p.licence_end)   lines.push('End: ' + p.licence_end);
    return lines.join('<br>');
  }

  // ── Build pre-loaded layers ───────────────────────────────────────────
  var hmoMarkerLayer = buildPointMarkers(
    { type: 'FeatureCollection', features: hmoFeatures },
    { fillColor: CONFIG.hmoMarkerColour, tooltipFn: licTooltip }
  );

  var selMarkerLayer = buildPointMarkers(
    { type: 'FeatureCollection', features: selFeatures },
    { fillColor: CONFIG.selectiveMarkerColour, tooltipFn: licTooltip }
  );

  var hmoChoro  = buildChoropleth(wardGeojson, 'hmo_count',       'HMO licences',     CONFIG.choroplethHmo);
  var selChoro  = buildChoropleth(wardGeojson, 'selective_count',  'Selective licences', CONFIG.choroplethSelective);
  var combChoro = buildChoropleth(wardGeojson, 'combined_count',   'Combined licences',  CONFIG.choroplethCombined);

  // ── Agent halo layers (selective only) ───────────────────────────────
  // Each highlights properties managed by a specific agent with a red halo.
  var AGENT_HIGHLIGHTS = [
    { label: 'Chancellors',  match: 'chancellors',  colour: '#ef4444' },
    { label: 'Scott Fraser', match: 'scott fraser', colour: '#f97316' },
    { label: 'NOPS',         match: 'nops',         colour: '#a855f7' },
  ];

  function buildAgentHaloLayer(matchStr) {
    var matched = selFeatures.filter(function (f) {
      var agent = ((addrLookup[f.properties.id] || {}).agent || '').toLowerCase();
      return agent.indexOf(matchStr) !== -1;
    });
    return L.geoJSON({ type: 'FeatureCollection', features: matched }, {
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius:      11,
          fillColor:   '#ef4444',
          fillOpacity: 0.30,
          color:       '#ef4444',
          weight:      2.5,
          opacity:     0.7,
          interactive: false,
        });
      },
    });
  }

  var agentHaloLayers = AGENT_HIGHLIGHTS.map(function (ag) {
    return { label: ag.label, layer: buildAgentHaloLayer(ag.match) };
  });

  // Default: markers on, combined density on
  // Halos go on first so they sit behind the main markers
  hmoMarkerLayer.addTo(map);
  selMarkerLayer.addTo(map);
  combChoro.wardLayer.addTo(map);

  // ── Layer control ─────────────────────────────────────────────────────
  var overlays = {};
  overlays['🔵 HMO licence markers']      = hmoMarkerLayer;
  overlays['🟢 Selective licence markers'] = selMarkerLayer;
  overlays['Combined density']             = combChoro.wardLayer;
  overlays['HMO density']                  = hmoChoro.wardLayer;
  overlays['Selective density']            = selChoro.wardLayer;
  agentHaloLayers.forEach(function (ag) {
    overlays['🔴 ' + ag.label] = ag.layer;
  });

  var layerControl = L.control.layers(null, overlays, { collapsed: false, position: 'topright' });
  layerControl.addTo(map);

  // ── Legend (combined by default) ──────────────────────────────────────
  var activeLegend = buildLegend(combChoro.colourScale, combChoro.breaks, 'Combined licences');
  activeLegend.addTo(map);

  // Swap legend when density layers are toggled
  var legendMap = {
    combined:  { choro: combChoro, label: 'Combined licences' },
    hmo:       { choro: hmoChoro,  label: 'HMO licences' },
    selective: { choro: selChoro,  label: 'Selective licences' },
  };

  function updateLegend() {
    var active = null;
    if (map.hasLayer(combChoro.wardLayer)) active = 'combined';
    if (map.hasLayer(hmoChoro.wardLayer))  active = 'hmo';
    if (map.hasLayer(selChoro.wardLayer))  active = 'selective';
    if (activeLegend) { map.removeControl(activeLegend); activeLegend = null; }
    if (active) {
      var l = legendMap[active];
      activeLegend = buildLegend(l.choro.colourScale, l.choro.breaks, l.label);
      activeLegend.addTo(map);
    }
  }

  map.on('overlayadd overlayremove', updateLegend);

  // Keep marker layers on top whenever a halo layer is toggled on
  map.on('overlayadd', function () {
    if (map.hasLayer(hmoMarkerLayer)) hmoMarkerLayer.bringToFront();
    if (map.hasLayer(selMarkerLayer)) selMarkerLayer.bringToFront();
  });

  // ── Disclaimer ────────────────────────────────────────────────────────
  var hmoTotal = hmoFeatures.length;
  var selTotal = selFeatures.length;
  var disc = document.getElementById('disclaimer');
  if (disc) {
    disc.innerHTML =
      'Showing Oxford licence data: <strong>' + hmoTotal + ' HMO</strong> licences (blue) ' +
      'and <strong>' + selTotal + ' selective</strong> licences (green). ' +
      'Data: Oxford City Council.' +
      ' <button onclick="dismissDisclaimer()" aria-label="Dismiss">&times;</button>';
    disc.style.display = '';
    try { sessionStorage.removeItem('disclaimerDismissed'); } catch (_) {}
  }

  // ── CSV upload (adds extra layers on top of pre-loaded data) ──────────

  // State for uploaded CSV layers
  var uploadedLayers = [];

  function clearUploadedLayers() {
    uploadedLayers.forEach(function (l) {
      if (map.hasLayer(l)) map.removeLayer(l);
      layerControl.removeLayer(l);
    });
    uploadedLayers = [];
  }

  function addUploadedData(hmoData) {
    clearUploadedLayers();

    var stats = hmoData.matchStats;

    if (hmoData.hmoBuildings && hmoData.hmoBuildings.features.length > 0) {
      var bl = buildBuildingFootprints(hmoData.hmoBuildings);
      bl.addTo(map);
      layerControl.addOverlay(bl, 'Uploaded: HMO buildings');
      uploadedLayers.push(bl);
    }

    if (hmoData.hmoFallbackPoints && hmoData.hmoFallbackPoints.features.length > 0) {
      var fl = buildPointMarkers(hmoData.hmoFallbackPoints, {
        fillColor: CONFIG.hmoFallbackColour,
        tooltipFn: function (p) {
          var lines = [];
          if (p.address)       lines.push(p.address);
          if (p.hmo_id)        lines.push('ID: ' + p.hmo_id);
          if (p.licence_start) lines.push('Start: ' + p.licence_start);
          if (p.licence_end)   lines.push('End: ' + p.licence_end);
          return lines.join('<br>');
        },
      });
      fl.addTo(map);
      layerControl.addOverlay(fl, 'Uploaded: unmatched (point)');
      uploadedLayers.push(fl);
    }

    // Update disclaimer
    if (disc) {
      disc.innerHTML =
        'Showing Oxford licence data: <strong>' + hmoTotal + ' HMO</strong> + ' +
        '<strong>' + selTotal + ' selective</strong> licences (pre-loaded). ' +
        'Uploaded CSV: ' + stats.total + ' properties, ' + stats.matched + ' matched to buildings.' +
        ' <button onclick="dismissDisclaimer()" aria-label="Dismiss">&times;</button>';
      disc.style.display = '';
      try { sessionStorage.removeItem('disclaimerDismissed'); } catch (_) {}
    }

    var btn = document.getElementById('btn-clear-hmo');
    if (btn) btn.style.display = 'inline-block';
  }

  // ── Upload UI wiring ──────────────────────────────────────────────────

  var statusEl  = document.getElementById('upload-status');
  var dropZone  = document.getElementById('upload-drop-zone');
  var fileInput = document.getElementById('hmo-file-input');
  var clearBtn  = document.getElementById('btn-clear-hmo');

  function setUploadStatus(msg, className) {
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.className   = className || '';
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
      addUploadedData(result);
      setUploadStatus('CSV loaded', 'success');
    }).catch(function (err) {
      setUploadStatus('Error: ' + err.message, 'error');
      console.error('HMO upload error:', err);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      clearUploadedLayers();
      clearBtn.style.display = 'none';
      setUploadStatus('', '');
      if (disc) {
        disc.innerHTML =
          'Showing Oxford licence data: <strong>' + hmoTotal + ' HMO</strong> licences (blue) ' +
          'and <strong>' + selTotal + ' selective</strong> licences (green). ' +
          'Data: Oxford City Council.' +
          ' <button onclick="dismissDisclaimer()" aria-label="Dismiss">&times;</button>';
        disc.style.display = '';
        try { sessionStorage.removeItem('disclaimerDismissed'); } catch (_) {}
      }
    });
  }
})();
