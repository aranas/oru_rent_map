// ── HMO CSV Upload Module ────────────────────────────────────────────────
// Handles CSV parsing, address matching to building footprints, and LSOA
// assignment.  Zero external API calls at runtime — everything comes from
// pre-generated static files.  CSV data is NEVER cached or persisted;
// reference data (building index, postcode map) is held in memory only
// for the duration of the page session.
//
// Exports (on window.HmoUpload):
//   processHmoCsv(file, onProgress)  → Promise<ProcessedHmoData>

(function () {
  'use strict';

  var UK_POSTCODE_RE = /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i;

  // ── Normalisation (must match generate_building_data.py) ───────────────

  function normaliseMatchKey(s) {
    if (!s) return '';
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function normalisePostcode(pc) {
    return pc.toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // ── Column detection ───────────────────────────────────────────────────

  function detectColumns(headers) {
    var lower = headers.map(function (h) { return h.toLowerCase().trim(); });
    var mapping = { id: -1, address: -1, street: -1, licenceStart: -1, licenceEnd: -1 };

    for (var i = 0; i < lower.length; i++) {
      var h = lower[i];
      if (mapping.id === -1 && (h === 'id' || h.indexOf('register') !== -1 || h.indexOf('ref') !== -1 || h.indexOf('licence id') !== -1)) {
        mapping.id = i;
      } else if (mapping.address === -1 && h.indexOf('address') !== -1) {
        mapping.address = i;
      } else if (mapping.street === -1 && h.indexOf('street') !== -1) {
        mapping.street = i;
      } else if (mapping.licenceStart === -1 && h.indexOf('start') !== -1) {
        mapping.licenceStart = i;
      } else if (mapping.licenceEnd === -1 && h.indexOf('end') !== -1) {
        mapping.licenceEnd = i;
      }
    }
    return mapping;
  }

  // ── Extract housenumber from address string ────────────────────────────

  function extractHousenumber(address) {
    var m = address.match(/^(\d+[A-Za-z]?)\b/);
    return m ? m[1] : '';
  }

  // ── Strip sub-unit prefix from address ─────────────────────────────────
  // Addresses like "Flat B, 65 Ashhurst Way, OX4 4RF" or
  // "Room 3, 12 James Street, OX4 1EU" have a sub-unit before the
  // housenumber.  Returns { subUnit, coreAddress }.

  var SUBUNIT_RE = /^(flat\s+\S+|room\s+\S+|unit\s+\S+|apt\.?\s+\S+|apartment\s+\S+|studio\s+\S+|basement|ground\s+floor|first\s+floor|second\s+floor)\s*,\s*/i;

  function stripSubUnit(address) {
    var m = address.match(SUBUNIT_RE);
    if (m) {
      return { subUnit: m[1].trim(), coreAddress: address.substring(m[0].length) };
    }
    return { subUnit: '', coreAddress: address };
  }

  // ── Reference data loading (lazy, cached in module scope) ──────────────

  var _buildingIndex = null;   // Map<matchKey, GeoJSON feature>
  var _postcodeIndex = null;   // Map<normalisedPostcode, {lsoa, lat, lon}>

  function loadReferenceData(onProgress) {
    if (_buildingIndex && _postcodeIndex) {
      return Promise.resolve();
    }

    onProgress('Loading reference data...');

    return Promise.all([
      fetch('data/oxford_buildings.geojson').then(function (r) { return r.json(); }),
      fetch('data/postcode_lsoa.csv').then(function (r) { return r.text(); }),
    ]).then(function (results) {
      var buildingsGeojson = results[0];
      var postcodeCsvText  = results[1];

      _buildingIndex = new Map();
      buildingsGeojson.features.forEach(function (f) {
        var p = f.properties;
        var keys = p.match_keys;
        if (keys && keys.length) {
          keys.forEach(function (key) {
            if (key && !_buildingIndex.has(key)) {
              _buildingIndex.set(key, f);
            }
          });
        } else {
          var key = p.match_key;
          if (key && !_buildingIndex.has(key)) {
            _buildingIndex.set(key, f);
          }
        }
      });
      onProgress('Building index: ' + _buildingIndex.size + ' entries');

      _postcodeIndex = new Map();
      var parsed = Papa.parse(postcodeCsvText, { header: true, skipEmptyLines: true });
      parsed.data.forEach(function (row) {
        var pc = normalisePostcode(row.postcode || '');
        if (pc) {
          _postcodeIndex.set(pc, {
            lsoa: row.lsoa || '',
            lat: parseFloat(row.centroid_lat) || 0,
            lon: parseFloat(row.centroid_lon) || 0,
          });
        }
      });
    });
  }

  // ── Main processing pipeline ───────────────────────────────────────────

  function processHmoCsv(file, onProgress) {
    onProgress = onProgress || function () {};

    return new Promise(function (resolve, reject) {
      onProgress('Parsing CSV...');

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: function (results) {
          if (!results.data || results.data.length === 0) {
            return reject(new Error('CSV is empty or could not be parsed.'));
          }

          var headers = results.meta.fields || [];
          var colMap = detectColumns(headers);

          if (colMap.address === -1) {
            return reject(new Error(
              'No "address" column found. Headers: ' + headers.join(', ')
            ));
          }

          var rows = results.data;
          onProgress('Loading reference data...');

          loadReferenceData(onProgress).then(function () {
            onProgress('Matching addresses to buildings...');
            return matchRows(rows, headers, colMap, onProgress);
          }).then(resolve).catch(reject);
        },
        error: function (err) { reject(err); },
      });
    });
  }

  function matchRows(rows, headers, colMap, onProgress) {
    var lsoaCounts = {};
    var stats = { total: 0, matched: 0, fallback: 0, noPostcode: 0, noLsoa: 0, multiHousehold: 0 };

    // Pass 1: parse each row, strip sub-units, collect per-building entries
    var buildingBucket = new Map();  // matchKey -> { geometry, entries[] }
    var fallbackBucket = new Map();  // matchKey|postcode -> { geometry, entries[] }

    rows.forEach(function (row) {
      var vals = headers.map(function (h) { return row[h] || ''; });
      var rawAddress = colMap.address !== -1 ? vals[colMap.address] : '';

      if (!rawAddress.trim()) return;
      stats.total++;

      var street       = colMap.street !== -1        ? vals[colMap.street]       : '';
      var id           = colMap.id !== -1            ? vals[colMap.id]           : '';
      var licenceStart = colMap.licenceStart !== -1  ? vals[colMap.licenceStart] : '';
      var licenceEnd   = colMap.licenceEnd !== -1    ? vals[colMap.licenceEnd]   : '';

      var parsed = stripSubUnit(rawAddress);
      var address = parsed.coreAddress;
      var subUnit = parsed.subUnit;

      var pcMatch = address.match(UK_POSTCODE_RE);
      if (!pcMatch) {
        pcMatch = rawAddress.match(UK_POSTCODE_RE);
      }
      if (!pcMatch) {
        stats.noPostcode++;
        return;
      }
      var postcode = normalisePostcode(pcMatch[0]);

      var pcInfo = _postcodeIndex.get(postcode);
      var lsoa = pcInfo ? pcInfo.lsoa : '';
      if (lsoa) {
        lsoaCounts[lsoa] = (lsoaCounts[lsoa] || 0) + 1;
      } else {
        stats.noLsoa++;
      }

      var housenumber = extractHousenumber(address);
      var streetForMatch = street || '';
      if (!streetForMatch) {
        var parts = address.replace(pcMatch[0], '').split(',');
        if (parts.length > 0) {
          var firstPart = parts[0].trim();
          streetForMatch = firstPart.replace(/^\d+[A-Za-z]?\s*/, '');
        }
      }

      var entry = {
        hmo_id: id,
        raw_address: rawAddress,
        sub_unit: subUnit,
        licence_start: licenceStart,
        licence_end: licenceEnd,
      };

      var matchKey = normaliseMatchKey(housenumber + ' ' + streetForMatch);
      var buildingFeat = matchKey ? _buildingIndex.get(matchKey) : null;

      if (buildingFeat) {
        if (buildingBucket.has(matchKey)) {
          buildingBucket.get(matchKey).entries.push(entry);
        } else {
          buildingBucket.set(matchKey, {
            geometry: buildingFeat.geometry,
            entries: [entry],
            address: address,
            street: street || streetForMatch,
            postcode: postcode,
            lsoa: lsoa,
          });
        }
      } else if (pcInfo) {
        var fbKey = matchKey || (postcode + '|' + address);
        if (fallbackBucket.has(fbKey)) {
          fallbackBucket.get(fbKey).entries.push(entry);
        } else {
          fallbackBucket.set(fbKey, {
            geometry: { type: 'Point', coordinates: [pcInfo.lon, pcInfo.lat] },
            entries: [entry],
            address: address,
            street: street || streetForMatch,
            postcode: postcode,
            lsoa: lsoa,
          });
        }
      }
    });

    // Pass 2: consolidate buckets into GeoJSON features
    var buildingFeatures = [];
    buildingBucket.forEach(function (bucket) {
      var entries = bucket.entries;
      var isMulti = entries.length > 1;
      if (isMulti) stats.multiHousehold++;

      var subUnits = entries.map(function (e) { return e.sub_unit; }).filter(Boolean);
      var ids = entries.map(function (e) { return e.hmo_id; }).filter(Boolean);

      var props = {
        address: bucket.address,
        street: bucket.street,
        postcode: bucket.postcode,
        lsoa: bucket.lsoa,
        hmo_id: ids.join(', '),
        licence_start: entries[0].licence_start,
        licence_end: entries[0].licence_end,
      };

      if (isMulti) {
        props.sub_units = subUnits.join(', ');
        props.entry_count = entries.length;
      } else if (entries[0].sub_unit) {
        props.sub_units = entries[0].sub_unit;
      }

      stats.matched++;
      buildingFeatures.push({
        type: 'Feature',
        geometry: bucket.geometry,
        properties: props,
      });
    });

    var fallbackFeatures = [];
    fallbackBucket.forEach(function (bucket) {
      var entries = bucket.entries;
      var isMulti = entries.length > 1;
      if (isMulti) stats.multiHousehold++;

      var subUnits = entries.map(function (e) { return e.sub_unit; }).filter(Boolean);
      var ids = entries.map(function (e) { return e.hmo_id; }).filter(Boolean);

      var props = {
        address: bucket.address,
        street: bucket.street,
        postcode: bucket.postcode,
        lsoa: bucket.lsoa,
        hmo_id: ids.join(', '),
        licence_start: entries[0].licence_start,
        licence_end: entries[0].licence_end,
      };

      if (isMulti) {
        props.sub_units = subUnits.join(', ');
        props.entry_count = entries.length;
      } else if (entries[0].sub_unit) {
        props.sub_units = entries[0].sub_unit;
      }

      stats.fallback++;
      fallbackFeatures.push({
        type: 'Feature',
        geometry: bucket.geometry,
        properties: props,
      });
    });

    onProgress('Done.');

    return {
      hmoBuildings:      { type: 'FeatureCollection', features: buildingFeatures },
      hmoFallbackPoints: { type: 'FeatureCollection', features: fallbackFeatures },
      lsoaCounts: lsoaCounts,
      matchStats: stats,
      timestamp: Date.now(),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.HmoUpload = {
    processHmoCsv: processHmoCsv,
  };
})();
