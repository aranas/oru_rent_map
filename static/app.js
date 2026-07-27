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
  doorknockBlocksPath:  'data/doorknock_blocks.geojson',
  doorknockBundlesPath: 'data/doorknock_bundles.json',
  studentHouseholdsPath: 'data/student_households.json',
  // Choropleth colour ranges per type
  choroplethHmo:       ['#dbeafe', '#1e40af'],  // blue
  choroplethSelective: ['#dcfce7', '#166534'],  // green
  choroplethStudent:   ['#ede9fe', '#5b21b6'],  // purple
  numQuantiles: 6,
  defaultFillOpacity:  0.55,
  defaultBorderColour: '#666',
  highlightBorderColour: '#222',
  // Marker colours
  hmoMarkerColour:       '#2563eb',  // blue
  selectiveMarkerColour: '#16a34a',  // green
  doorknockBoundaryColour: '#f97316',  // orange
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
// Leaflet's corner controls (zoom, Map layers, Doorknock streets) default to
// top:0, which sits directly under the fixed disclaimer bar — on mobile,
// where the disclaimer text wraps to 2-3 lines, that hid the dismiss button
// entirely underneath the opaque "Map layers" box. Push every top corner
// down by the disclaimer's actual (measured, not guessed) height instead.
window.positionControlsBelowDisclaimer = function () {
  var discEl = document.getElementById('disclaimer');
  var h = (discEl && discEl.style.display !== 'none') ? discEl.offsetHeight : 0;
  document.querySelectorAll('.leaflet-top').forEach(function (el) {
    el.style.top = h + 'px';
  });
};

window.dismissDisclaimer = function () {
  document.getElementById('disclaimer').style.display = 'none';
  try { sessionStorage.setItem('disclaimerDismissed', '1'); } catch (_) {}
  window.positionControlsBelowDisclaimer();
};

(function restoreDisclaimer() {
  try {
    if (sessionStorage.getItem('disclaimerDismissed') === '1') {
      var el = document.getElementById('disclaimer');
      if (el) el.style.display = 'none';
    }
  } catch (_) {}
})();

window.addEventListener('resize', function () {
  window.positionControlsBelowDisclaimer();
});


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


// ── Grid heatmap ──────────────────────────────────────────────────────────
// Divides the map into ~1 km² cells and counts all licences per cell.

function buildGridHeatmap(features) {
  // At Oxford's latitude (~51.75°), 500 m ≈ 0.0045° lat, ≈ 0.00728° lon
  var CELL_LAT = 0.0045;
  var CELL_LON = 0.00728;

  // Count points per cell
  var cells = {};
  features.forEach(function (f) {
    var coords = f.geometry && f.geometry.coordinates;
    if (!coords) return;
    var lon = coords[0], lat = coords[1];
    var row = Math.floor(lat / CELL_LAT);
    var col = Math.floor(lon / CELL_LON);
    var key = row + ',' + col;
    if (!cells[key]) cells[key] = { row: row, col: col, count: 0 };
    cells[key].count++;
  });

  var cellList = Object.values(cells);
  if (!cellList.length) return L.geoJSON();

  var maxCount = Math.max.apply(null, cellList.map(function (c) { return c.count; }));
  var colourScale = chroma.scale(['#ffffb2', '#fd8d3c', '#bd0026'])
                         .domain([0, maxCount]);

  var gridFeatures = cellList.map(function (c) {
    var minLon = c.col * CELL_LON,       maxLon = (c.col + 1) * CELL_LON;
    var minLat = c.row * CELL_LAT,       maxLat = (c.row + 1) * CELL_LAT;
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [minLon, minLat], [maxLon, minLat],
          [maxLon, maxLat], [minLon, maxLat],
          [minLon, minLat],
        ]],
      },
      properties: { count: c.count },
    };
  });

  return L.geoJSON({ type: 'FeatureCollection', features: gridFeatures }, {
    style: function (feature) {
      return {
        fillColor:   colourScale(feature.properties.count).hex(),
        fillOpacity: 0.75,
        color:       'none',
        weight:      0,
      };
    },
    onEachFeature: function (feature, layer) {
      layer.bindTooltip(feature.properties.count + ' licences in this grid cell',
                        { sticky: true });
    },
  });
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


// Doorknock block boundaries: an outline (not a filled area) around each
// grid-cell "unit" — the doorknocking overlay's canvassing unit — so the
// base HMO/Selective markers underneath stay visible and clickable.
function buildBlockBoundariesLayer(polygonGeojson, opts) {
  opts = opts || {};
  var colour = opts.colour || '#f97316';
  var tooltipFn = opts.tooltipFn || function () { return ''; };
  var onClickFn = opts.onClickFn;

  return L.geoJSON(polygonGeojson, {
    style: function () {
      return {
        fillColor:   colour,
        fillOpacity: 0.08,
        color:       colour,
        weight:      2,
        dashArray:   '4 3',
      };
    },
    onEachFeature: function (feature, layer) {
      var label = tooltipFn(feature.properties);
      if (label) layer.bindTooltip(label, { direction: 'top', sticky: true });
      if (onClickFn) layer.on('click', function () { onClickFn(feature.properties); });
    },
  });
}


// ── Doorknocking checklist ("knocking mode") ────────────────────────────
// Opens a self-contained, standalone HTML page in a new tab: one row per
// address in the block, ordered by house number, with a checkbox per
// address so a canvasser can tick addresses off while walking without
// needing a network connection or losing their place if they background
// the tab. Built as a Blob + object URL (not window.open('') +
// document.write) specifically so the new tab gets a real document with
// its own working localStorage, rather than an opaque about:blank origin.

function escapeHtml(s) {
  var div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function startKnockingMode(blk) {
  var addresses = blk.addresses || [];
  var storageKey = 'doorknock-checklist-' + blk.block_id;

  var rowsHtml = addresses.map(function (a, i) {
    var badgeClass = a.type === 'hmo' ? 'hmo' : 'private';
    var badgeText  = a.type === 'hmo' ? 'HMO' : 'Private';
    var occupants  = (a.occupants === null || a.occupants === undefined) ? '—' : a.occupants;
    return (
      '<li class="row">' +
        '<label>' +
          '<input type="checkbox" data-key="' + i + '">' +
          '<span class="addr">' + escapeHtml(a.address) + '</span>' +
          '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
          '<span class="occupants" title="Licensed occupants">' + occupants + ' occ.</span>' +
          '<span class="agent">' + escapeHtml(a.agent || '—') + '</span>' +
        '</label>' +
      '</li>'
    );
  }).join('');

  var css = [
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'max-width:560px;margin:0 auto;padding:16px;color:#1e293b;}',
    'h1{font-size:18px;margin:0 0 2px;}',
    'h1 .locality{font-weight:400;color:#666;font-size:14px;}',
    '#progress{font-size:13px;color:#555;margin:8px 0 12px;position:sticky;top:0;',
    'background:#fff;padding:8px 0;border-bottom:1px solid #eee;}',
    'ul{list-style:none;padding:0;margin:0;}',
    '.row{border-bottom:1px solid #eee;}',
    '.row.done{opacity:.5;}',
    '.row.done .addr{text-decoration:line-through;}',
    'label{display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer;}',
    'input[type=checkbox]{width:22px;height:22px;flex-shrink:0;}',
    '.addr{flex:1;font-size:14px;}',
    '.badge{font-size:11px;padding:2px 6px;border-radius:4px;font-weight:600;flex-shrink:0;}',
    '.badge.hmo{background:#dbeafe;color:#1e40af;}',
    '.badge.private{background:#dcfce7;color:#166534;}',
    '.occupants{font-size:11px;color:#555;flex-shrink:0;white-space:nowrap;}',
    '.agent{font-size:12px;color:#666;min-width:100px;text-align:right;flex-shrink:0;}',
  ].join('');

  var script = [
    'var STORAGE_KEY=' + JSON.stringify(storageKey) + ';',
    'var saved={};',
    'try{saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}");}catch(e){}',
    'function save(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(saved));}catch(e){}}',
    'function updateProgress(){',
    '  var boxes=document.querySelectorAll("input[type=checkbox]");',
    '  var done=0;',
    '  boxes.forEach(function(b){if(b.checked)done++;});',
    '  document.getElementById("progress").textContent=done+" / "+boxes.length+" knocked";',
    '}',
    'document.querySelectorAll("input[type=checkbox]").forEach(function(cb){',
    '  var key=cb.getAttribute("data-key");',
    '  cb.checked=!!saved[key];',
    '  if(cb.checked)cb.closest(".row").classList.add("done");',
    '  cb.addEventListener("change",function(){',
    '    saved[key]=cb.checked;',
    '    save();',
    '    cb.closest(".row").classList.toggle("done",cb.checked);',
    '    updateProgress();',
    '  });',
    '});',
    'updateProgress();',
  ].join('\n');

  var html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Knocking: ' + escapeHtml(blk.label) + '</title>' +
    '<style>' + css + '</style></head><body>' +
    '<h1>' + escapeHtml(blk.label) + ' <span class="locality">(' + escapeHtml(blk.locality) + ')</span></h1>' +
    '<div id="progress"></div>' +
    '<ul>' + rowsHtml + '</ul>' +
    '<script>' + script + '<\/script>' +
    '</body></html>';

  var blob = new Blob([html], { type: 'text/html' });
  var url = URL.createObjectURL(blob);
  window.open(url, '_blank');
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

  // Doorknocking overlay (East Oxford blocks shortlist); optional
  var doorknockBlocksGeojson = null;
  var doorknockBundles = null;
  try {
    var dkBlocksRes = await fetch(CONFIG.doorknockBlocksPath);
    if (dkBlocksRes.ok) doorknockBlocksGeojson = await dkBlocksRes.json();
    var dkBundlesRes = await fetch(CONFIG.doorknockBundlesPath);
    if (dkBundlesRes.ok) doorknockBundles = await dkBundlesRes.json();
  } catch (e) { /* non-fatal */ }

  // Census 2021 student-only-household counts per LSOA; optional
  var studentHouseholds = null;
  try {
    var studentRes = await fetch(CONFIG.studentHouseholdsPath);
    if (studentRes.ok) studentHouseholds = await studentRes.json();
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
    if (studentHouseholds) {
      var code = f.properties.LSOA21CD || '';
      var row  = studentHouseholds[code];
      f.properties.student_households = row ? row.student_households : 0;
    }
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
        groups[key] = { feature: f, addresses: [], agents: [], holders: [] };
      }
      var p = f.properties;
      if (p.address) groups[key].addresses.push(p.address);
      if (p.agent  && groups[key].agents.indexOf(p.agent)   === -1) groups[key].agents.push(p.agent);
      if (p.holder && groups[key].holders.indexOf(p.holder) === -1) groups[key].holders.push(p.holder);
    });

    return Object.values(groups).map(function (g) {
      var merged = JSON.parse(JSON.stringify(g.feature));
      merged.properties.addresses = g.addresses;
      merged.properties.agents    = g.agents;
      merged.properties.holders   = g.holders;
      merged.properties.count     = g.addresses.length;
      return merged;
    });
  }

  var hmoMerged = mergeByCoord(hmoFeatures);
  var selMerged = mergeByCoord(selFeatures);

  // ── Separate exactly-overlapping cross-layer markers ──────────────────
  // mergeByCoord already collapses same-address duplicates *within* a
  // layer (HMO-with-HMO, Selective-with-Selective) into one dot — that's
  // correct, one address should be one dot. But a bad geocode can still
  // land an HMO point and a Selective point (or a landlord point) on the
  // exact same coordinate; since those are separate layers they never get
  // merged together, so without this they'd render as circles stacked
  // perfectly on top of each other with only the topmost one clickable.
  // Nudge every point in a same-coordinate cross-layer group a few metres
  // apart (evenly spaced around the shared point) so each stays visible
  // and independently hoverable — this only touches on-screen position,
  // not any of the underlying counts/stats.
  function offsetLatLon(lat, lon, distMetres, bearingDeg) {
    var R = 6371000;
    var brng = bearingDeg * Math.PI / 180;
    var lat1 = lat * Math.PI / 180;
    var lon1 = lon * Math.PI / 180;
    var lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distMetres / R) +
      Math.cos(lat1) * Math.sin(distMetres / R) * Math.cos(brng)
    );
    var lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(distMetres / R) * Math.cos(lat1),
      Math.cos(distMetres / R) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]; // GeoJSON order: [lon, lat]
  }

  function separateOverlappingMarkers(featureLists) {
    var groups = {};
    featureLists.forEach(function (features) {
      (features || []).forEach(function (f) {
        var key = f.geometry.coordinates[0] + ',' + f.geometry.coordinates[1];
        (groups[key] = groups[key] || []).push(f);
      });
    });

    var OFFSET_M = 6; // small enough to still read as "the same building"
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      if (group.length < 2) return;
      var lon0 = group[0].geometry.coordinates[0];
      var lat0 = group[0].geometry.coordinates[1];
      group.forEach(function (f, i) {
        var bearing = (360 / group.length) * i;
        f.geometry.coordinates = offsetLatLon(lat0, lon0, OFFSET_M, bearing);
      });
    });
  }

  separateOverlappingMarkers([hmoMerged, selMerged, holderGeojson ? holderGeojson.features : []]);

  // ── Agent name normalisation ─────────────────────────────────────────
  // Stage 1: pre-process every raw name to strip noise before matching.
  // Stage 2: AGENT_NORM maps remaining known aliases to canonical labels.

  // Words that indicate a parenthetical is part of the company name, not a person
  var _COMPANY_PAREN_RE = /\b(letting|management|property|properties|estate|residential|students|ltd|limited|llp|uk)\b/i;
  var _LEGAL_RE = /\b(limited|ltd\.?|llp|plc|l\.l\.p\.?)\b\.?/gi;

  function preprocess(raw) {
    var s = raw.trim();
    // Strip trailing (Person Name) — only if content looks like a person, not a company
    s = s.replace(/\s*\(([^)]*)\)\s*$/, function (_, inner) {
      return _COMPANY_PAREN_RE.test(inner) ? ' (' + inner + ')' : '';
    });
    // Strip legal suffixes
    s = s.replace(_LEGAL_RE, '');
    // Normalise & ↔ and, collapse whitespace
    s = s.replace(/\band\b/gi, '&');
    s = s.replace(/\s+/g, ' ').trim().replace(/,\s*$/, '').trim();
    return s;
  }

  // Stage 2: explicit aliases for names that survive pre-processing differently
  // (NOPS vs North Oxford Property Services, Chancellors vs The Chancellors Group, etc.)
  // Oxford colleges come FIRST so they are matched before 'college & county'.
  var AGENT_NORM = [
    // ── Oxford University colleges & institutions ──────────────────────────
    { label: 'Balliol College',            match: ['balliol college'] },
    { label: 'Brasenose College',          match: ['brasenose college'] },
    { label: 'Christ Church',              match: ['christ church'] },
    { label: 'Corpus Christi College',     match: ['corpus christi college'] },
    { label: 'Exeter College',             match: ['exeter college'] },
    { label: 'Hertford College',           match: ['hertford college'] },
    { label: 'Jesus College',              match: ['jesus college'] },
    { label: 'Keble College',              match: ['keble college'] },
    { label: 'Lady Margaret Hall',         match: ['lady margaret hall'] },
    { label: 'Linacre College',            match: ['linacre college'] },
    { label: 'Lincoln College',            match: ['lincoln college'] },
    { label: 'Magdalen College',           match: ['magdalen college'] },
    { label: 'Mansfield College',          match: ['mansfield college'] },
    { label: 'Merton College',             match: ['merton college'] },
    { label: 'New College',               match: ['new college'] },
    { label: 'Nuffield College',           match: ['nuffield college'] },
    { label: 'Oriel College',              match: ['oriel college'] },
    { label: 'Pembroke College',           match: ['pembroke college'] },
    { label: "Queen's College",            match: ["queen's college"] },
    { label: 'Reuben College',             match: ['reuben college'] },
    { label: 'Regent\'s Park College',     match: ["regent's park college"] },
    { label: 'Somerville College',         match: ['somerville college'] },
    { label: 'St Anne\'s College',         match: ["st anne's college"] },
    { label: 'St Antony\'s College',       match: ["st antony's college"] },
    { label: 'St Catherine\'s College',    match: ["st catherine's college"] },
    { label: 'St Cross College',           match: ['st cross college'] },
    { label: 'St Edmund Hall',             match: ['st edmund hall'] },
    { label: 'St Hilda\'s College',        match: ["st hilda's college"] },
    { label: 'St Hugh\'s College',         match: ["st hugh's college"] },
    { label: 'St John\'s College',         match: ["st john's college"] },
    { label: 'St Peter\'s College',        match: ["st peter's college"] },
    { label: 'Trinity College',            match: ['trinity college'] },
    { label: 'University College',         match: ['university college'] },
    { label: 'Wadham College',             match: ['wadham college'] },
    { label: 'Wolfson College',            match: ['wolfson college'] },
    { label: 'Worcester College',          match: ['worcester college'] },
    { label: 'Wycliffe Hall',              match: ['wycliffe hall'] },
    { label: 'Green Templeton College',    match: ['green templeton'] },
    { label: 'Harris Manchester College',  match: ['harris manchester'] },
    { label: 'Kellogg College',            match: ['kellogg college'] },
    { label: 'Oxford Brookes University',  match: ['oxford brookes'] },
    // ── Commercial letting agencies ────────────────────────────────────────
    { label: 'Chancellors',           match: ['chancellors'] },
    { label: 'Finders Keepers',       match: ['finders keepers'] },
    { label: 'Breckon & Breckon',     match: ['breckon & breckon'] },
    { label: 'Scott Fraser',          match: ['scott fraser', 'scottfraser', 'leaders'] },
    { label: 'NOPS',                  match: ['north oxford property services', 'nops'] },
    { label: 'College & County',      match: ['college & county'] },
    { label: 'LPM Residential',       match: ['lpm residential'] },
    { label: 'Penny & Sinclair',      match: ['penny & sinclair'] },
    { label: 'Carter Jonas',          match: ['carter jonas'] },
    { label: 'Savills',               match: ['savills'] },
    { label: 'Martin & Co',           match: ['martin & co', 'urwin (oxford)'] },
    { label: 'Oxford Lettings',       match: ['oxford lettings'] },
    { label: 'Thomas Merrifield',     match: ['thomas merrifield'] },
    { label: 'Portfolio Properties',  match: ['portfolio properties oxford'] },
    { label: 'RMA Properties',        match: ['rma properties'] },
    { label: 'Abbey Group',           match: ['abbey group'] },
    { label: 'Chesterton Yeates',     match: ['chesterton yeates'] },
    { label: 'Elwood & Co',          match: ['elwood & co'] },
    { label: 'Taylors',               match: ['taylors'] },
    { label: 'John D Wood & Co',     match: ['john d wood'] },
    { label: 'Host Student Housing',  match: ['host student housing'] },
    { label: 'Lee & Lindars',        match: ['lee & lindars'] },
    { label: 'Hutton Parker',         match: ['hutton parker'] },
    { label: 'Enfields Lettings',     match: ['enfields lettings'] },
    { label: 'Homes for Students',    match: ['homes for students'] },
    { label: 'WEST Property',         match: ['west - the property'] },
    { label: "Amelie's",              match: ["amelies", "amelie's"] },
    { label: 'Hunters',               match: ['hunters'] },
    { label: 'Nicholas Jones',        match: ['nicholas jones residential'] },
    { label: 'Bright Properties',     match: ['bright properties'] },
    { label: 'Top Lettings',          match: ['top lettings'] },
    { label: 'NMH Residential',       match: ['nmh residential'] },
    { label: 'Reaston-Brown Rentals', match: ['reaston-brown'] },
    { label: 'City Properties',       match: ['city properties'] },
    { label: 'Andrews',               match: ['andrews'] },
    { label: 'Sterling Lettings',     match: ['sterling lettings'] },
    { label: 'Almero Students',       match: ['almero students'] },
    { label: 'City Estates',          match: ['city estates'] },
    { label: 'Bloomsbury Property',   match: ['bloomsbury property'] },
    { label: 'Oxfordshire Lettings',  match: ['oxfordshire lettings'] },
    { label: 'Hamways',               match: ['hamways'] },
    { label: 'James C Penny',         match: ['james c penny'] },
    { label: 'Stonecopper',           match: ['stonecopper'] },
    { label: 'The Rent Guru',         match: ['rent guru'] },
    { label: 'Oxford Heritage',       match: ['oxford heritage'] },
  ];

  // Set of canonical labels that belong to Oxford University / colleges
  var UNI_LABELS = new Set([
    'Balliol College', 'Brasenose College', 'Christ Church', 'Corpus Christi College',
    'Exeter College', 'Hertford College', 'Jesus College', 'Keble College',
    'Lady Margaret Hall', 'Linacre College', 'Lincoln College', 'Magdalen College',
    'Mansfield College', 'Merton College', 'New College', 'Nuffield College',
    'Oriel College', 'Pembroke College', "Queen's College", 'Reuben College',
    "Regent's Park College", 'Somerville College', "St Anne's College",
    "St Antony's College", "St Catherine's College", 'St Cross College',
    'St Edmund Hall', "St Hilda's College", "St Hugh's College", "St John's College",
    "St Peter's College", 'Trinity College', 'University College', 'Wadham College',
    'Wolfson College', 'Worcester College', 'Wycliffe Hall', 'Green Templeton College',
    'Harris Manchester College', 'Kellogg College', 'Oxford Brookes University',
  ]);

  function canonicalAgent(raw) {
    var pre   = preprocess(raw);
    var lower = pre.toLowerCase();
    for (var i = 0; i < AGENT_NORM.length; i++) {
      var terms = AGENT_NORM[i].match;
      for (var j = 0; j < terms.length; j++) {
        if (lower.indexOf(terms[j]) !== -1) return AGENT_NORM[i].label;
      }
    }
    // Return the pre-processed name (cleaned but unmatched)
    return pre;
  }

  function licTooltip(p) {
    var lines = [];
    var addrs   = p.addresses || (p.address ? [p.address] : []);
    var agents  = (p.agents  || (p.agent  ? [p.agent]  : []))
      .map(canonicalAgent)
      .filter(function (a, i, arr) { return arr.indexOf(a) === i; }); // dedupe after normalisation
    var holders = (p.holders || (p.holder ? [p.holder] : []))
      .filter(function (h, i, arr) { return h && arr.indexOf(h) === i; }); // dedupe
    if (p.count > 1) lines.push('<strong>' + p.count + ' licences at this location</strong>');
    addrs.forEach(function (a) { lines.push(p.count > 1 ? '• ' + a : '<strong>' + a + '</strong>'); });
    if (holders.length) lines.push('Holder: ' + holders.join(', '));
    if (agents.length)  lines.push('Agent: '  + agents.join(', '));
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
  var studentChoro = studentHouseholds
    ? buildChoropleth(wardGeojson, 'student_households', 'Student-only households per area', CONFIG.choroplethStudent)
    : null;

  // ── Agent halo layer ─────────────────────────────────────────────────
  // Count properties per canonical agent; only show agents with >= 5
  var _agentCount = {};
  hmoMerged.concat(selMerged).forEach(function (f) {
    (f.properties.agents || []).forEach(function (a) {
      if (!a) return;
      var canon = canonicalAgent(a);
      _agentCount[canon] = (_agentCount[canon] || 0) + 1;
    });
  });
  var allAgentNames = Object.keys(_agentCount)
    .filter(function (name) { return _agentCount[name] >= 10 && !UNI_LABELS.has(name); })
    .sort(function (a, b) { return a.localeCompare(b); });

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

  // ── Doorknocking overlay (East Oxford blocks shortlist) ─────────────────
  // The densest small (~100m) pockets in East Oxford by renter density and
  // top-20-rental-agency listing density, per 150 sqm (see
  // scripts/build_doorknock_streets.py) — ranking small blocks rather than
  // whole streets catches a dense stretch of one street sitting right next
  // to a dense stretch of another, which a whole-street average would dilute
  // away. Lives as a section inside the consolidated "Map layers" menu
  // (built further down) rather than its own floating control, and each
  // bundle row shows a one-line summary by default — tap the bundle name to
  // expand its full block/street breakdown, tap elsewhere on the row to fly
  // the map to it.
  var doorknockLayerGroup = null;
  var doorknockAvailable  = false;
  var bundlesSorted       = [];
  var bundleCentre        = function () { return null; };
  var selectBlock         = function () {};

  // Populated once the consolidated menu's DOM exists (see
  // mapControlsControl.onAdd below); selectBlock() is only ever called
  // later, from a map-polygon click, so it's safe to reference these here
  // before they're assigned.
  var mapControlsBody      = null;
  var mapControlsToggleBtn = null;
  var doorknockCheckbox    = null;

  if (doorknockBlocksGeojson && doorknockBundles && doorknockBundles.bundles && doorknockBundles.bundles.length) {
    doorknockAvailable = true;

    function streetBreakdownLines(streets) {
      return (streets || []).map(function (s) {
        return s.street + ': ' + s.hmo_count + ' HMO, ' + s.selective_count + ' private (' +
          s.doors + ' doors, ' + s.renters + ' renters)';
      }).join('<br>');
    }

    var blockBoundariesLayer = buildBlockBoundariesLayer(doorknockBlocksGeojson, {
      colour: CONFIG.doorknockBoundaryColour,
      tooltipFn: function (p) {
        var lines = ['<strong>' + p.label + '</strong> (' + p.locality + ')'];
        lines.push(p.doors + ' doors &middot; ' + p.renters + ' renters &middot; ' +
          p.top20_agency_listings + ' top-20-agency listings');
        lines.push(streetBreakdownLines(p.streets));
        return lines.join('<br>');
      },
      // Clicking a block's boundary on the map selects the matching entry
      // in the menu: opens the menu and the doorknock layer if folded,
      // expands its bundle's details, scrolls to it, and briefly
      // highlights it — so a canvassing team can tap the square they're
      // standing at and immediately see its street/HMO/private breakdown.
      onClickFn: function (p) { selectBlock(p.block_id); },
    });

    doorknockLayerGroup = blockBoundariesLayer;
    bundlesSorted = doorknockBundles.bundles; // already sorted by renters, server-side

    // Each block already carries its own centroid (computed server-side
    // from its member properties) — a bundle's centre is just the mean of
    // its member blocks' centroids.
    bundleCentre = function (bundle) {
      var lat = 0, lon = 0, n = bundle.blocks.length;
      bundle.blocks.forEach(function (blk) { lat += blk.lat; lon += blk.lon; });
      return n ? { lat: lat / n, lon: lon / n } : null;
    };

    selectBlock = function (blockId) {
      if (!blockId) return;
      if (mapControlsBody && !mapControlsBody.classList.contains('open')) {
        mapControlsBody.classList.add('open');
        if (mapControlsToggleBtn) mapControlsToggleBtn.setAttribute('aria-expanded', 'true');
      }
      if (doorknockCheckbox && !doorknockCheckbox.checked) {
        doorknockCheckbox.checked = true;
        doorknockCheckbox.dispatchEvent(new Event('change'));
      }
      var el = document.getElementById('doorknock-block-' + blockId);
      if (!el) return;
      var details = el.closest('.doorknock-bundle-details');
      if (details) details.style.display = 'block';
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.add('doorknock-block-highlight');
      setTimeout(function () { el.classList.remove('doorknock-block-highlight'); }, 2000);
    };
  }

  // ── Grid heatmap (all licences) ───────────────────────────────────────
  var allLicenceFeatures = hmoFeatures.concat(selFeatures);
  var gridHeatmap = buildGridHeatmap(allLicenceFeatures);

  // Default: markers on
  hmoMarkerLayer.addTo(map);
  selMarkerLayer.addTo(map);

  // ── Density layer dropdown ─────────────────────────────────────────────
  var activeDensityLayer = null;
  var activeLegend       = null;

  // Grid legend uses a simple fixed colour scale (yellow→red)
  var gridColourScale = chroma.scale(['#ffffb2', '#fd8d3c', '#bd0026']);
  var gridMaxCount    = 0;
  gridHeatmap.eachLayer(function (l) {
    var c = l.feature && l.feature.properties && l.feature.properties.count || 0;
    if (c > gridMaxCount) gridMaxCount = c;
  });
  gridColourScale = gridColourScale.domain([0, gridMaxCount]);

  var densityOptions = {
    '':        { layer: null,               colourScale: null,             breaks: null, label: '' },
    'hmo':     { layer: hmoChoro.wardLayer, colourScale: hmoChoro.colourScale, breaks: hmoChoro.breaks, label: 'HMO count per area' },
    'sel':     { layer: selChoro.wardLayer, colourScale: selChoro.colourScale, breaks: selChoro.breaks, label: 'Private renters per area' },
    'grid':    { layer: gridHeatmap,        colourScale: gridColourScale,   breaks: null, label: 'Licence density (~500 m²)' },
  };
  if (studentChoro) {
    densityOptions['student'] = {
      layer: studentChoro.wardLayer,
      colourScale: studentChoro.colourScale,
      breaks: studentChoro.breaks,
      label: 'Student-only households per area (Census 2021)',
    };
  }

  function buildGridLegend(colourScale, maxVal, label) {
    var legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
      var div = L.DomUtil.create('div', 'info legend');
      var steps = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
      div.innerHTML = '<strong>' + label + '</strong><br>';
      steps.forEach(function (t, i) {
        var val = Math.round(t * maxVal);
        var nextVal = i < steps.length - 1 ? Math.round(steps[i + 1] * maxVal) : null;
        div.innerHTML +=
          '<i style="background:' + colourScale(t).hex() + ';width:14px;height:14px;display:inline-block;margin-right:5px;border-radius:2px;vertical-align:middle;opacity:1"></i>' +
          val + (nextVal !== null ? '–' + nextVal : '+') + '<br>';
      });
      return div;
    };
    return legend;
  }

  function setDensityLayer(key) {
    // Remove current density layer and legend
    if (activeDensityLayer) { map.removeLayer(activeDensityLayer); activeDensityLayer = null; }
    if (activeLegend)       { map.removeControl(activeLegend);     activeLegend = null; }

    var opt = densityOptions[key];
    if (!opt || !opt.layer) return;

    opt.layer.addTo(map);
    activeDensityLayer = opt.layer;

    // Bring markers to front so they sit above the density layer
    if (map.hasLayer(hmoMarkerLayer)) hmoMarkerLayer.bringToFront();
    if (map.hasLayer(selMarkerLayer)) selMarkerLayer.bringToFront();

    // Build appropriate legend
    if (key === 'grid') {
      activeLegend = buildGridLegend(gridColourScale, gridMaxCount, opt.label);
    } else {
      activeLegend = buildLegend(opt.colourScale, opt.breaks, opt.label);
    }
    activeLegend.addTo(map);
  }

  // ── Consolidated "Map layers" menu (top-right) ─────────────────────────
  // Bundles the HMO/Selective/Landlords toggles, the agent-highlight
  // select, and the density-layer select into one collapsed-by-default
  // menu instead of three separate floating boxes — that many boxes at
  // once left little room for the map on narrow/mobile screens.
  var mapControlsControl = L.control({ position: 'topright' });
  mapControlsControl.onAdd = function () {
    var div = L.DomUtil.create('div', 'legend map-controls');
    var html =
      '<button type="button" id="map-controls-toggle" class="map-controls-toggle" aria-expanded="false">&#9776; Map layers</button>' +
      '<div class="map-controls-body" id="map-controls-body">' +
        '<div class="map-controls-section">' +
          '<label><input type="checkbox" id="chk-hmo" checked> 🔵 HMO rented properties</label>' +
          '<label><input type="checkbox" id="chk-sel" checked> 🟢 Privately rented properties</label>' +
          (holderMarkerLayer ? '<label><input type="checkbox" id="chk-holder"> ⚫ Landlords (licence holder)</label>' : '') +
        '</div>' +
        '<div class="map-controls-section">' +
          '<label class="map-controls-label">🔴 Agent highlight</label>' +
          '<select id="agent-select">' +
          '<option value="">— none —</option>' +
          allAgentNames.map(function (name) {
            return '<option value="' + name.replace(/"/g, '&quot;') + '">' + name + '</option>';
          }).join('') +
          '</select>' +
        '</div>' +
        '<div class="map-controls-section">' +
          '<label class="map-controls-label">🗺 Density layer</label>' +
          '<select id="density-select">' +
          '<option value="">— none —</option>' +
          '<option value="hmo">HMO count per area</option>' +
          '<option value="sel">Private renters per area</option>' +
          '<option value="grid">Licence density grid (~500 m²)</option>' +
          (studentChoro ? '<option value="student">Student-only households (Census 2021)</option>' : '') +
          '</select>' +
        '</div>' +
        (doorknockAvailable ? '<div class="map-controls-section" id="doorknock-section"></div>' : '') +
      '</div>';
    div.innerHTML = html;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    var toggleBtn = div.querySelector('#map-controls-toggle');
    var body      = div.querySelector('#map-controls-body');
    mapControlsBody = body;
    mapControlsToggleBtn = toggleBtn;
    toggleBtn.addEventListener('click', function () {
      var open = body.classList.toggle('open');
      toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    div.querySelector('#chk-hmo').addEventListener('change', function (e) {
      if (e.target.checked) hmoMarkerLayer.addTo(map); else map.removeLayer(hmoMarkerLayer);
    });
    div.querySelector('#chk-sel').addEventListener('change', function (e) {
      if (e.target.checked) selMarkerLayer.addTo(map); else map.removeLayer(selMarkerLayer);
    });
    var holderChk = div.querySelector('#chk-holder');
    if (holderChk) {
      holderChk.addEventListener('change', function (e) {
        if (e.target.checked) holderMarkerLayer.addTo(map); else map.removeLayer(holderMarkerLayer);
      });
    }
    div.querySelector('#agent-select').addEventListener('change', function () {
      setAgentHalo(this.value);
    });
    div.querySelector('#density-select').addEventListener('change', function () {
      setDensityLayer(this.value);
    });

    // ── Doorknock section: nested inside this same collapsible menu ─────
    if (doorknockAvailable) {
      var dkSection = div.querySelector('#doorknock-section');
      dkSection.innerHTML =
        '<label><input type="checkbox" id="chk-doorknock"> 🚪 Doorknock streets</label>' +
        '<div class="doorknock-summary">' + doorknockBundles.total_doors + ' doors &middot; ' +
        doorknockBundles.total_markers + ' markers &middot; ' + doorknockBundles.total_renters + ' renters total</div>' +
        '<div class="doorknock-bundle-list" id="doorknock-bundle-list"></div>';

      doorknockCheckbox = dkSection.querySelector('#chk-doorknock');
      var bundleListEl = dkSection.querySelector('#doorknock-bundle-list');

      bundlesSorted.forEach(function (b, i) {
        var row = document.createElement('div');
        row.className = 'doorknock-row doorknock-bundle-row';
        row.setAttribute('data-idx', i);

        var nameEl = document.createElement('div');
        nameEl.className = 'doorknock-bundle-name';
        nameEl.textContent = b.label + ' (' + b.locality + ')';

        var summaryEl = document.createElement('div');
        summaryEl.className = 'doorknock-bundle-summary';
        summaryEl.textContent = b.doors + ' doors · ' + b.renters + ' renters · ' +
          b.top20_agency_listings + ' top-20-agency listings';

        var detailsEl = document.createElement('div');
        detailsEl.className = 'doorknock-bundle-details';
        detailsEl.style.display = 'none';
        b.blocks.forEach(function (blk) {
          var blockEl = document.createElement('div');
          blockEl.className = 'doorknock-block-entry';
          blockEl.id = 'doorknock-block-' + blk.block_id;
          var streetLines = (blk.streets || []).map(function (s) {
            return '<div class="doorknock-street-line">' +
              '&ndash; ' + s.street + ': ' + s.hmo_count + ' HMO, ' + s.selective_count +
              ' private (' + s.doors + ' doors, ' + s.renters + ' renters)</div>';
          }).join('');
          blockEl.innerHTML =
            '&bull; ' + blk.label + ' (' + blk.locality + '): ' + blk.doors + ' doors, ' +
            blk.renters + ' renters (' + blk.renters_per_150sqm + '/150sqm), ' +
            blk.top20_agency_listings + ' top-20-agency listings' + streetLines +
            '<button type="button" class="doorknock-start-btn">🚪 Start knocking mode</button>';
          blockEl.querySelector('.doorknock-start-btn').addEventListener('click', function (e) {
            e.stopPropagation();
            startKnockingMode(blk);
          });
          detailsEl.appendChild(blockEl);
        });

        row.appendChild(nameEl);
        row.appendChild(summaryEl);
        row.appendChild(detailsEl);
        bundleListEl.appendChild(row);

        // Tap the name -> expand/collapse this bundle's full breakdown.
        nameEl.addEventListener('click', function (e) {
          e.stopPropagation();
          detailsEl.style.display = (detailsEl.style.display === 'none') ? 'block' : 'none';
        });
        // Tap anywhere else on the row -> fly the map to this bundle.
        row.addEventListener('click', function (e) {
          if (e.target.closest('.doorknock-bundle-name') || e.target.closest('.doorknock-block-entry')) return;
          var c = bundleCentre(b);
          if (c) map.setView([c.lat, c.lon], 17);
        });
      });

      doorknockCheckbox.addEventListener('change', function () {
        if (doorknockCheckbox.checked) {
          doorknockLayerGroup.addTo(map);
        } else {
          map.removeLayer(doorknockLayerGroup);
        }
      });
    }

    return div;
  };
  mapControlsControl.addTo(map);

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
  window.positionControlsBelowDisclaimer();

})();
