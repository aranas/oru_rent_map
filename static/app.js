// ── Configuration ──────────────────────────────────────────────────────────
var CONFIG = {
  centre: [51.752, -1.2577],
  zoom: 13,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  neighbourhoodsPath:     'data/neighbourhoods.geojson',
  licenceLocationsPath:   'data/licence_locations.geojson',
  holderLocationsPath:    'data/holder_locations.geojson',
  // Choropleth colour ranges per type
  choroplethHmo:       ['#dbeafe', '#1e40af'],  // blue
  choroplethSelective: ['#dcfce7', '#166534'],  // green
  choroplethCombined:  ['#f3e8ff', '#6b21a8'],  // purple
  // Custom breaks for combined choropleth — tighter bins at higher values
  // where the interesting variation lies (most LSOAs fall in the 50–285 range)
  choroplethBreaks: [0, 50, 80, 110, 140, 175, 220],
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

function buildChoropleth(wardGeojson, countProp, valueLabel, colourRange, customBreaks) {
  var allValues = wardGeojson.features.map(function (f) {
    return f.properties[countProp] || 0;
  });
  var maxVal = Math.max.apply(null, allValues);
  var classBounds, breaks;
  if (customBreaks) {
    classBounds = customBreaks.concat([maxVal]);
    breaks = customBreaks.slice(1);  // for legend (skip the leading 0)
  } else {
    var minVal = Math.min.apply(null, allValues);
    breaks = quantileBreaks(allValues, CONFIG.numQuantiles);
    classBounds = [minVal].concat(breaks, [maxVal]);
  }
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

  // Holder locations (one point per landlord address); optional
  var holderGeojson = null;
  try {
    var holderRes = await fetch(CONFIG.holderLocationsPath);
    if (holderRes.ok) holderGeojson = await holderRes.json();
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

  // ── Deduplicate features by coordinate ───────────────────────────────
  // Multiple licences geocoded to the same point become one merged marker.
  function mergeByCoord(features) {
    var groups = {};
    features.forEach(function (f) {
      var key = f.geometry.coordinates[0] + ',' + f.geometry.coordinates[1];
      if (!groups[key]) {
        groups[key] = { feature: f, addresses: [], agents: [] };
      }
      var p = f.properties;
      if (p.address) groups[key].addresses.push(p.address);
      if (p.agent && groups[key].agents.indexOf(p.agent) === -1) {
        groups[key].agents.push(p.agent);
      }
    });

    return Object.values(groups).map(function (g) {
      var merged = JSON.parse(JSON.stringify(g.feature));
      merged.properties.addresses = g.addresses;
      merged.properties.agents    = g.agents;
      merged.properties.count     = g.addresses.length;
      return merged;
    });
  }

  var hmoMerged = mergeByCoord(hmoFeatures);
  var selMerged = mergeByCoord(selFeatures);

  function licTooltip(p) {
    var lines = [];
    var addrs  = p.addresses || (p.address ? [p.address] : []);
    var agents = (p.agents || (p.agent ? [p.agent] : []))
      .map(canonicalAgent)
      .filter(function (a, i, arr) { return arr.indexOf(a) === i; }); // dedupe after normalisation
    if (p.count > 1) lines.push('<strong>' + p.count + ' licences at this location</strong>');
    addrs.forEach(function (a) { lines.push(p.count > 1 ? '• ' + a : '<strong>' + a + '</strong>'); });
    if (agents.length) lines.push('Agent: ' + agents.join(', '));
    return lines.join('<br>');
  }

  // ── Build pre-loaded layers ───────────────────────────────────────────
  var hmoMarkerLayer = buildPointMarkers(
    { type: 'FeatureCollection', features: hmoMerged },
    { fillColor: CONFIG.hmoMarkerColour, tooltipFn: licTooltip }
  );

  var selMarkerLayer = buildPointMarkers(
    { type: 'FeatureCollection', features: selMerged },
    { fillColor: CONFIG.selectiveMarkerColour, tooltipFn: licTooltip }
  );

  var hmoChoro  = buildChoropleth(wardGeojson, 'hmo_count',      'HMO count per area',        CONFIG.choroplethHmo);
  var selChoro  = buildChoropleth(wardGeojson, 'selective_count', 'Private renters per area',  CONFIG.choroplethSelective);
  var combChoro = buildChoropleth(wardGeojson, 'combined_count',  'All licences per area',     CONFIG.choroplethCombined, CONFIG.choroplethBreaks);

  // ── Agent name normalisation ──────────────────────────────────────────
  // Each entry: { label: 'Canonical Name', match: [substrings] }
  // Raw agent names are matched case-insensitively; first match wins.
  // Names not matched by any rule are shown as-is.
  var AGENT_NORM = [
    { label: 'Chancellors',              match: ['chancellors'] },
    { label: 'Finders Keepers',          match: ['finders keepers', 'finders-keepers'] },
    { label: 'Breckon & Breckon',        match: ['breckon'] },
    { label: 'Scott Fraser',             match: ['scott fraser', 'scottfraser', 'leaders limited'] },
    { label: 'NOPS',                     match: ['north oxford property services', 'nops'] },
    { label: 'College and County',       match: ['college and county', 'college & county'] },
    { label: 'LPM Residential',          match: ['lpm residential'] },
    { label: 'Penny & Sinclair',         match: ['penny & sinclair', 'penny and sinclair', 'penny & sinclair limited'] },
    { label: 'Carter Jonas',             match: ['carter jonas'] },
    { label: 'Savills',                  match: ['savills'] },
    { label: 'Martin & Co',             match: ['martin & co', 'martin and co', 'urwin (oxford)'] },
    { label: 'Oxford Lettings',          match: ['oxford lettings'] },
    { label: 'Thomas Merrifield',        match: ['thomas merrifield'] },
    { label: 'Portfolio Properties',     match: ['portfolio properties oxford'] },
    { label: 'RMA Properties',           match: ['rma properties'] },
    { label: 'Abbey Group',              match: ['abbey group'] },
    { label: 'Chesterton Yeates',        match: ['chesterton yeates'] },
    { label: 'Elwood & Co',             match: ['elwood & co', 'elwood and co'] },
    { label: 'Taylors',                  match: ['taylors'] },
    { label: 'John D Wood & Co',        match: ['john d wood'] },
    { label: 'Host Student Housing',     match: ['host student housing'] },
    { label: 'Lee & Lindars',           match: ['lee & lindars'] },
    { label: 'Hutton Parker',            match: ['hutton parker'] },
    { label: 'Enfields Lettings',        match: ['enfields lettings'] },
    { label: 'Homes for Students',       match: ['homes for students'] },
    { label: 'WEST Property',            match: ['west - the property', 'west - the property'] },
    { label: "Amelie's",                 match: ["amelies", "amelie's"] },
    { label: 'Hunters',                  match: ['hunters'] },
    { label: 'Nicholas Jones',           match: ['nicholas jones residential'] },
    { label: 'Bright Properties',        match: ['bright properties'] },
    { label: 'Top Lettings',             match: ['top lettings'] },
    { label: 'NMH Residential',          match: ['nmh residential'] },
    { label: 'Reaston-Brown Rentals',    match: ['reaston-brown'] },
    { label: 'City Properties',          match: ['city properties'] },
    { label: 'Andrews',                  match: ['andrews'] },
    { label: 'Sterling Lettings',        match: ['sterling lettings'] },
    { label: 'Almero Students',          match: ['almero students'] },
    { label: 'City Estates',             match: ['city estates'] },
    { label: 'Bloomsbury Property',      match: ['bloomsbury property'] },
    { label: 'Oxfordshire Lettings',     match: ['oxfordshire lettings'] },
    { label: 'Hamways',                  match: ['hamways'] },
    { label: 'James C Penny',            match: ['james c penny'] },
    { label: 'Stonecopper',              match: ['stonecopper'] },
    { label: 'The Rent Guru',            match: ['rent guru'] },
    { label: 'Oxford Heritage',          match: ['oxford heritage'] },
  ];

  function canonicalAgent(raw) {
    var lower = raw.toLowerCase();
    for (var i = 0; i < AGENT_NORM.length; i++) {
      var terms = AGENT_NORM[i].match;
      for (var j = 0; j < terms.length; j++) {
        if (lower.indexOf(terms[j]) !== -1) return AGENT_NORM[i].label;
      }
    }
    return raw;  // unmatched — show as-is
  }

  // ── Agent halo layer ─────────────────────────────────────────────────
  // Collect canonical agent names from both HMO and Selective features
  var allAgents = [];
  var _agentSeen = {};
  hmoMerged.concat(selMerged).forEach(function (f) {
    (f.properties.agents || []).forEach(function (a) {
      if (!a) return;
      var canon = canonicalAgent(a);
      if (!_agentSeen[canon]) { _agentSeen[canon] = true; allAgents.push(canon); }
    });
  });
  allAgents.sort(function (a, b) { return a.localeCompare(b); });

  function buildAgentHaloLayer(canonName) {
    var matched = hmoMerged.concat(selMerged).filter(function (f) {
      return (f.properties.agents || []).some(function (a) {
        return canonicalAgent(a) === canonName;
      });
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

  var activeHaloLayer = null;

  function setAgentHalo(agentName) {
    if (activeHaloLayer) { map.removeLayer(activeHaloLayer); activeHaloLayer = null; }
    if (!agentName) return;
    activeHaloLayer = buildAgentHaloLayer(agentName);
    activeHaloLayer.addTo(map);
    if (map.hasLayer(hmoMarkerLayer)) hmoMarkerLayer.bringToFront();
    if (map.hasLayer(selMarkerLayer)) selMarkerLayer.bringToFront();
  }

  // ── Agent dropdown control ────────────────────────────────────────────
  var agentControl = L.control({ position: 'topright' });
  agentControl.onAdd = function () {
    var div = L.DomUtil.create('div', 'agent-dropdown-control');
    div.innerHTML =
      '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">🔴 Agent highlight</label>' +
      '<select id="agent-select" style="width:100%;font-size:12px;padding:2px 4px;">' +
      '<option value="">— none —</option>' +
      allAgents.map(function (name) {
        return '<option value="' + name.replace(/"/g, '&quot;') + '">' + name + '</option>';
      }).join('') +
      '</select>';
    L.DomEvent.disableClickPropagation(div);
    div.querySelector('#agent-select').addEventListener('change', function () {
      setAgentHalo(this.value);
    });
    return div;
  };

  // ── Holder (landlord) marker layer ────────────────────────────────────
  var holderMarkerLayer = holderGeojson ? buildPointMarkers(holderGeojson, {
    radius:    5,
    fillColor: '#111827',   // near-black
    tooltipFn: function (p) {
      var lines = [];
      if (p.holder_address) lines.push('<strong>' + p.holder_address + '</strong>');
      if (p.property_count) lines.push('Properties: ' + p.property_count);
      return lines.join('<br>');
    },
  }) : null;

  // Default: markers on, combined density on
  // Halos go on first so they sit behind the main markers
  hmoMarkerLayer.addTo(map);
  selMarkerLayer.addTo(map);
  combChoro.wardLayer.addTo(map);

  // ── Layer control ─────────────────────────────────────────────────────
  var overlays = {};
  overlays['🔵 HMO rented properties']          = hmoMarkerLayer;
  overlays['🟢 Privately rented properties']     = selMarkerLayer;
  if (holderMarkerLayer) overlays['⚫ Landlords (licence holder)'] = holderMarkerLayer;
  overlays['HMO count per area']                 = hmoChoro.wardLayer;
  overlays['Private renters per area']           = selChoro.wardLayer;

  var layerControl = L.control.layers(null, overlays, { collapsed: false, position: 'topright' });
  layerControl.addTo(map);
  agentControl.addTo(map);

  // ── Legend (combined by default) ──────────────────────────────────────
  var activeLegend = buildLegend(combChoro.colourScale, combChoro.breaks, 'All licences per area');
  activeLegend.addTo(map);

  // Swap legend when density layers are toggled
  var legendMap = {
    combined:  { choro: combChoro, label: 'All licences per area' },
    hmo:       { choro: hmoChoro,  label: 'HMO count per area' },
    selective: { choro: selChoro,  label: 'Private renters per area' },
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

  // ── Disclaimer ────────────────────────────────────────────────────────
  var hmoTotal = hmoFeatures.length;
  var selTotal = selFeatures.length;
  var disc = document.getElementById('disclaimer');
  if (disc) {
    disc.innerHTML =
      '<strong>' + hmoTotal + ' HMO</strong> rented properties (blue) and ' +
      '<strong>' + selTotal + '</strong> privately rented properties (green). ' +
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
