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
  doorknockStreetsPath:       'data/doorknock_streets.geojson',
  doorknockMeetingPointsPath: 'data/doorknock_meeting_points.geojson',
  // Choropleth colour ranges per type
  choroplethHmo:       ['#dbeafe', '#1e40af'],  // blue
  choroplethSelective: ['#dcfce7', '#166534'],  // green
  numQuantiles: 6,
  defaultFillOpacity:  0.55,
  defaultBorderColour: '#666',
  highlightBorderColour: '#222',
  // Marker colours
  hmoMarkerColour:       '#2563eb',  // blue
  selectiveMarkerColour: '#16a34a',  // green
  doorknockMarkerColour: '#f97316',  // orange
  meetingPointColour:    '#7c3aed',  // violet
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


// Doorknocking meeting-point markers: a distinct flag icon (not a plain dot)
// so canvassers can tell a gathering point apart from a rental-property door.
function buildMeetingPointsLayer(pointGeojson, opts) {
  opts = opts || {};
  var tooltipFn = opts.tooltipFn || function () { return ''; };

  var flagIcon = L.divIcon({
    className: 'doorknock-meeting-icon',
    html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));">🚩</div>',
    iconSize:   [22, 22],
    iconAnchor: [4, 20],
  });

  return L.geoJSON(pointGeojson, {
    pointToLayer: function (feature, latlng) {
      return L.marker(latlng, { icon: flagIcon });
    },
    onEachFeature: function (feature, layer) {
      var label = tooltipFn(feature.properties);
      if (label) layer.bindTooltip(label, { direction: 'top', offset: [0, -18] });
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

  // Doorknocking overlay (Cowley streets shortlist); optional
  var doorknockStreetsGeojson = null;
  var doorknockMeetingGeojson = null;
  try {
    var dkStreetsRes = await fetch(CONFIG.doorknockStreetsPath);
    if (dkStreetsRes.ok) doorknockStreetsGeojson = await dkStreetsRes.json();
    var dkMeetingRes = await fetch(CONFIG.doorknockMeetingPointsPath);
    if (dkMeetingRes.ok) doorknockMeetingGeojson = await dkMeetingRes.json();
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

  // ── Agent dropdown control ────────────────────────────────────────────
  var agentControl = L.control({ position: 'topright' });
  agentControl.onAdd = function () {
    var div = L.DomUtil.create('div', 'agent-dropdown-control');
    div.innerHTML =
      '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">🔴 Agent highlight</label>' +
      '<select id="agent-select" style="width:100%;font-size:12px;padding:2px 4px;">' +
      '<option value="">— none —</option>' +
      allAgentNames.map(function (name) {
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

  // ── Doorknocking overlay (Cowley streets shortlist) ───────────────────
  // Cowley streets with the highest renter density and top-20-rental-agency
  // listing density, per 100m (see scripts/build_doorknock_streets.py). Off
  // by default; toggled on from the layer control like any other overlay.
  var doorknockLayerGroup  = null;
  var doorknockOverlayName = '🚪 Doorknock streets (Cowley)';
  var doorknockPanelControl = null;

  if (doorknockStreetsGeojson && doorknockMeetingGeojson && doorknockMeetingGeojson.features.length) {
    var doorMarkersLayer = buildPointMarkers(doorknockStreetsGeojson, {
      radius:    5,
      fillColor: CONFIG.doorknockMarkerColour,
      tooltipFn: function (p) {
        var lines = [];
        lines.push('<strong>' + p.street + '</strong>');
        (p.addresses || []).forEach(function (a) { lines.push(a); });
        if (p.door_count > 1) lines.push(p.door_count + ' doors at this pin');
        if (p.agents && p.agents.length) lines.push('Agent: ' + p.agents.join(', '));
        if (p.top20_agency) lines.push('<em>Managed by a top-20 agency</em>');
        return lines.join('<br>');
      },
    });

    // A single overall meeting point for the whole shortlist (not one per
    // street) — canvassers start together and split into teams from here.
    var meetingFeature = doorknockMeetingGeojson.features[0];
    var meetingProps    = meetingFeature.properties;

    var meetingPointsLayer = buildMeetingPointsLayer(doorknockMeetingGeojson, {
      tooltipFn: function (p) {
        return [
          '<strong>Doorknock meeting point</strong>',
          'Meet at: ' + p.meeting_label,
          p.total_doors + ' doors (' + p.total_markers + ' map markers) across ' + p.streets.length + ' streets',
          p.total_renters + ' renters total',
        ].join('<br>');
      },
    });

    doorknockLayerGroup = L.layerGroup([doorMarkersLayer, meetingPointsLayer]);

    // Side panel: the meeting point, then one row per shortlisted street
    // (sorted by renter density, not raw totals, so a long road doesn't
    // just win for having more addresses). Clicking a row flies to that
    // street's own doors (computed from the marker layer, since there's no
    // longer a per-street meeting point).
    var streetsSorted = meetingProps.streets.slice().sort(function (a, b) {
      return b.renters_per_100m - a.renters_per_100m;
    });

    var streetCentres = {};
    doorknockStreetsGeojson.features.forEach(function (f) {
      var street = f.properties.street;
      if (!streetCentres[street]) streetCentres[street] = { lat: 0, lon: 0, n: 0 };
      var c = streetCentres[street];
      c.lat += f.geometry.coordinates[1];
      c.lon += f.geometry.coordinates[0];
      c.n += 1;
    });

    doorknockPanelControl = L.control({ position: 'bottomleft' });
    doorknockPanelControl.onAdd = function () {
      var div = L.DomUtil.create('div', 'legend doorknock-panel');
      var html = '<div class="legend-title">🚪 Doorknock streets</div>';
      html += '<div class="doorknock-row doorknock-meeting-row" style="cursor:pointer;padding:3px 0;">' +
        '<strong>Meeting point</strong><br>' +
        '<span style="color:#555;">' + meetingProps.meeting_label + '</span><br>' +
        '<span style="color:#888;font-size:11px;">' + meetingProps.total_doors + ' doors &middot; ' +
        meetingProps.total_markers + ' markers &middot; ' + meetingProps.total_renters + ' renters total</span>' +
        '</div>';
      html += '<div style="font-size:11px;color:#666;margin:6px 0;">Ranked by renter density (per 100m). Click a street to jump to it.</div>';
      streetsSorted.forEach(function (s, i) {
        html += '<div class="doorknock-row" data-idx="' + i + '" ' +
          'style="cursor:pointer;padding:3px 0;border-top:1px solid #eee;">' +
          '<strong>' + s.street + '</strong><br>' +
          '<span style="color:#555;">' + s.doors + ' doors &middot; ' + s.markers + ' markers &middot; ' +
          s.renters + ' renters (' + s.renters_per_100m + '/100m) &middot; ' +
          s.top20_agency_listings + ' top-20-agency listings</span>' +
          '</div>';
      });
      div.innerHTML = html;
      L.DomEvent.disableClickPropagation(div);
      div.querySelector('.doorknock-meeting-row').addEventListener('click', function () {
        map.setView([meetingFeature.geometry.coordinates[1], meetingFeature.geometry.coordinates[0]], 16);
      });
      div.querySelectorAll('.doorknock-row:not(.doorknock-meeting-row)').forEach(function (row) {
        row.addEventListener('click', function () {
          var s = streetsSorted[parseInt(row.getAttribute('data-idx'), 10)];
          var c = streetCentres[s.street];
          if (c) map.setView([c.lat / c.n, c.lon / c.n], 17);
        });
      });
      return div;
    };

    map.on('overlayadd', function (e) {
      if (e.name === doorknockOverlayName && doorknockPanelControl) {
        doorknockPanelControl.addTo(map);
      }
    });
    map.on('overlayremove', function (e) {
      if (e.name === doorknockOverlayName && doorknockPanelControl) {
        map.removeControl(doorknockPanelControl);
      }
    });
  }

  // ── Grid heatmap (all licences) ───────────────────────────────────────
  var allLicenceFeatures = hmoFeatures.concat(selFeatures);
  var gridHeatmap = buildGridHeatmap(allLicenceFeatures);

  // Default: markers on
  hmoMarkerLayer.addTo(map);
  selMarkerLayer.addTo(map);

  // ── Layer control (markers only) ──────────────────────────────────────
  var overlays = {};
  overlays['🔵 HMO rented properties']      = hmoMarkerLayer;
  overlays['🟢 Privately rented properties'] = selMarkerLayer;
  if (holderMarkerLayer) overlays['⚫ Landlords (licence holder)'] = holderMarkerLayer;
  if (doorknockLayerGroup) overlays[doorknockOverlayName] = doorknockLayerGroup;

  var layerControl = L.control.layers(null, overlays, { collapsed: false, position: 'topright' });
  layerControl.addTo(map);
  agentControl.addTo(map);

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

  var densityControl = L.control({ position: 'topright' });
  densityControl.onAdd = function () {
    var div = L.DomUtil.create('div', 'agent-dropdown-control');
    div.innerHTML =
      '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">🗺 Density layer</label>' +
      '<select id="density-select" style="width:100%;font-size:12px;padding:2px 4px;">' +
      '<option value="">— none —</option>' +
      '<option value="hmo">HMO count per area</option>' +
      '<option value="sel">Private renters per area</option>' +
      '<option value="grid">Licence density grid (~500 m²)</option>' +
      '</select>';
    L.DomEvent.disableClickPropagation(div);
    div.querySelector('#density-select').addEventListener('change', function () {
      setDensityLayer(this.value);
    });
    return div;
  };
  densityControl.addTo(map);

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
