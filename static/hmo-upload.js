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
  var HOUSENUMBER_RANGE_RE = /(\d+[A-Za-z]?\s*[-\u2010-\u2015]\s*\d+[A-Za-z]?)/;

  // ── Normalisation (must match generate_building_data.py) ───────────────

  function normaliseMatchKey(s) {
    if (!s) return '';
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function normalisePostcode(pc) {
    return pc.toUpperCase().replace(/\s+/g, '').trim();
  }

  function normaliseHousenumberToken(housenumber) {
    if (!housenumber) return '';
    return String(housenumber)
      .trim()
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/\s*-\s*/g, '-');
  }

  // ── Levenshtein distance for fuzzy matching ────────────────────────────

  function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    var matrix = [];
    for (var i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (var j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (var i = 1; i <= b.length; i++) {
      for (var j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  // ── Column detection ───────────────────────────────────────────────────

  function detectColumns(headers) {
    var lower = headers.map(function (h) { return h.toLowerCase().trim(); });
    var mapping = { 
      id: -1, 
      address: -1, 
      street: -1, 
      housenumber: -1, 
      matchKey: -1, 
      postcode: -1, 
      subUnit: -1, 
      matchConfidence: -1, 
      licenceStart: -1, 
      licenceEnd: -1,
      licenceType: -1
    };

    for (var i = 0; i < lower.length; i++) {
      var h = lower[i];
      if (mapping.id === -1 && (h === 'id' || h.indexOf('register') !== -1 || h.indexOf('ref') !== -1 || h.indexOf('licence id') !== -1)) {
        mapping.id = i;
      } else if (mapping.address === -1 && h.indexOf('address') !== -1) {
        mapping.address = i;
      } else if (mapping.street === -1 && h.indexOf('street') !== -1) {
        mapping.street = i;
      } else if (mapping.housenumber === -1 && h === 'housenumber') {
        mapping.housenumber = i;
      } else if (mapping.matchKey === -1 && h === 'match_key') {
        mapping.matchKey = i;
      } else if (mapping.postcode === -1 && h === 'postcode') {
        mapping.postcode = i;
      } else if (mapping.subUnit === -1 && h === 'sub_unit') {
        mapping.subUnit = i;
      } else if (mapping.matchConfidence === -1 && h === 'match_confidence') {
        mapping.matchConfidence = i;
      } else if (mapping.licenceStart === -1 && h.indexOf('start') !== -1) {
        mapping.licenceStart = i;
      } else if (mapping.licenceEnd === -1 && h.indexOf('end') !== -1) {
        mapping.licenceEnd = i;
      } else if (mapping.licenceType === -1 && h === 'licence_type') {
        mapping.licenceType = i;
      }
    }
    return mapping;
  }

  // ── Extract housenumber from address string ────────────────────────────
  // Handles "65 High Street", "65A High Street", "65, High Street", etc.

  function extractHousenumber(address) {
    var rangeMatch = address.match(HOUSENUMBER_RANGE_RE);
    if (rangeMatch) return normaliseHousenumberToken(rangeMatch[1]);

    // Look for housenumber anywhere in the address, preferring the first one
    var m = address.match(/(\d+[A-Za-z]?)/);
    return m ? m[1] : '';
  }

  function extractHousenumberNumericPart(housenumber) {
    if (!housenumber) return null;
    var m = String(housenumber).trim().match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function parseHousenumberRange(housenumber) {
    if (!housenumber) return null;
    var m = normaliseHousenumberToken(housenumber).match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (!m) return null;
    var start = parseInt(m[1], 10);
    var end = parseInt(m[2], 10);
    if (start > end) {
      var temp = start;
      start = end;
      end = temp;
    }
    return { start: start, end: end };
  }

  function splitHousenumberList(housenumber) {
    if (!housenumber || String(housenumber).indexOf(',') === -1) return [];
    var seen = new Set();
    var values = [];
    String(housenumber).split(',').forEach(function (part) {
      var token = normaliseMatchKey(part);
      if (!token || seen.has(token)) return;
      seen.add(token);
      values.push(token);
    });
    return values;
  }

  function generateStreetVariants(street) {
    var streetKey = normaliseMatchKey(street);
    if (!streetKey) return [];

    var tokens = streetKey.split(/\s+/);
    var variants = [streetKey];
    if (tokens.length <= 2) return variants;

    for (var end = tokens.length - 1; end > 1; end--) {
      var candidate = tokens.slice(0, end).join(' ');
      if (variants.indexOf(candidate) === -1) {
        variants.push(candidate);
      }
    }
    return variants;
  }

  // ── Strip geographic qualifiers (city, neighborhood, etc.) ────────────────
  // Removes common UK location names ONLY from the end of the address.
  // E.g., "105a London Road, Headington, Oxford, OX3 9AE" → "105a London Road"
  // But preserves "Iffley Turn" or "Marston Road" when they are street names.

  function stripGeographicQualifiers(address) {
    // Strip trailing geographic qualifiers (after last comma or at end)
    // Only strip from the end to preserve street names that contain these words
    var result = address;
    var qualifiers = [
      'City of Oxford', 'North Oxford', 'South Oxford', 'East Oxford', 'West Oxford',
      'Oxford', 'England', 'UK'
    ];
    
    // Try to match and remove trailing qualifiers after commas
    var parts = result.split(',').filter(function(p) { return p.trim(); }); // Filter out empty parts
    while (parts.length > 1) {
      var lastPart = parts[parts.length - 1].trim().toLowerCase();
      var found = false;
      for (var i = 0; i < qualifiers.length; i++) {
        if (lastPart === qualifiers[i].toLowerCase()) {
          parts.pop();
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    result = parts.join(',').trim();
    return result;
  }
  
  // ── Strip sub-unit prefix from address ─────────────────────────────────
  var SUBUNIT_RE = /^((?:(?:the|ground|first|second|third|basement)\s+)?(?:flat|room|unit|apt\.?|apartment|studio|annex|annexe|floor)\s+[0-9a-z]+)(?:\s*,\s*|\s+(?=\d))/i;

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
  var _addrIndex = null;       // Map<postcode|housenumber|street, feature> for fuzzy matching
  var _rangeIndex = null;      // Map<postcode|street, [{start, end, feature}]>
  var _advancedIndexesReady = false;

  function loadReferenceData(onProgress, options) {
    options = options || {};
    var needAdvancedMatching = !!options.needAdvancedMatching;

    if (_buildingIndex && _postcodeIndex && (!needAdvancedMatching || _advancedIndexesReady)) {
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
      _addrIndex = needAdvancedMatching ? new Map() : null;
      _rangeIndex = needAdvancedMatching ? new Map() : null;
      buildingsGeojson.features.forEach(function (f) {
        var key = f.properties.match_key;
        if (key && !_buildingIndex.has(key)) {
          _buildingIndex.set(key, f);
        }

        if (!needAdvancedMatching) return;

        // Build secondary index for component-based matching
        var pc = f.properties.addr_postcode ? normalisePostcode(f.properties.addr_postcode) : '';
        var hn = f.properties.addr_housenumber ? normaliseMatchKey(f.properties.addr_housenumber) : '';
        var st = f.properties.addr_street ? normaliseMatchKey(f.properties.addr_street) : '';

        if (pc && hn && st) {
          var compKey = pc + '|' + hn + '|' + st;
          if (!_addrIndex.has(compKey)) {
            _addrIndex.set(compKey, f);
          }
        }

        splitHousenumberList(f.properties.addr_housenumber || '').forEach(function (listedHn) {
          if (!pc || !st) return;
          var listedCompKey = pc + '|' + listedHn + '|' + st;
          if (!_addrIndex.has(listedCompKey)) {
            _addrIndex.set(listedCompKey, f);
          }
        });

        var housenumberRange = parseHousenumberRange(f.properties.addr_housenumber || '');
        if (pc && st && housenumberRange) {
          var rangeKey = pc + '|' + st;
          if (!_rangeIndex.has(rangeKey)) {
            _rangeIndex.set(rangeKey, []);
          }
          _rangeIndex.get(rangeKey).push({
            start: housenumberRange.start,
            end: housenumberRange.end,
            feature: f,
          });
        }
      });
      _advancedIndexesReady = needAdvancedMatching;
      
      // Debug: log sample keys from index
      var sampleKeys = Array.from(_buildingIndex.keys()).slice(0, 10);
      console.log('Sample keys from building index:', sampleKeys);
      console.log('Building index: ' + _buildingIndex.size + ' entries');
      if (needAdvancedMatching) {
        console.log('Address component index: ' + _addrIndex.size + ' entries');
        console.log('Range index: ' + _rangeIndex.size + ' street/postcode buckets');
      }
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

  function findRangeMatch(postcode, housenumber, streetForMatch) {
    if (!_rangeIndex) return null;

    if (!postcode) return null;

    var streetVariants = generateStreetVariants(streetForMatch);
    if (!streetVariants.length) return null;
    var candidateRange = parseHousenumberRange(housenumber);
    var number = extractHousenumberNumericPart(housenumber);

    for (var s = 0; s < streetVariants.length; s++) {
      var rangeKey = postcode + '|' + streetVariants[s];
      var candidates = _rangeIndex.get(rangeKey) || [];

      if (candidateRange) {
        for (var i = 0; i < candidates.length; i++) {
          if (candidates[i].start <= candidateRange.start && candidateRange.end <= candidates[i].end) {
            return candidates[i].feature;
          }
        }
        continue;
      }

      if (number === null) continue;
      for (var j = 0; j < candidates.length; j++) {
        if (candidates[j].start <= number && number <= candidates[j].end) {
          return candidates[j].feature;
        }
      }
    }
    return null;
  }

  // ── Main processing pipeline ───────────────────────────────────────────

  function processHmoCsv(file, onProgress) {
    onProgress = onProgress || function () {};
    
    console.log('processHmoCsv called with file:', file.name);

    return new Promise(function (resolve, reject) {
      onProgress('Parsing CSV...');
      console.log('About to parse CSV...');

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        worker: true,
        complete: function (results) {
          console.log('Papa.parse complete. Data rows:', results.data ? results.data.length : 0);
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
          var hasPrecomputed = colMap.matchKey !== -1;
          onProgress('Loading reference data...');

          loadReferenceData(onProgress, { needAdvancedMatching: !hasPrecomputed }).then(function () {
            console.log('Reference data loaded');
            onProgress(hasPrecomputed ? 'Loading preprocessed matches...' : 'Matching addresses to buildings...');
            return matchRows(rows, headers, colMap, onProgress);
          }).then(resolve).catch(reject);
        },
        error: function (err) { 
          console.log('Papa.parse error:', err);
          reject(err); 
        },
      });
    });
  }

  function matchRows(rows, headers, colMap, onProgress) {
    var lsoaCounts = {};
    var stats = { total: 0, matched: 0, fallback: 0, noPostcode: 0, noLsoa: 0, multiHousehold: 0 };
    var debugCount = 0;  // Track how many rows we've debug logged

    // Add preprocessing stats if available
    if (colMap.matchConfidence !== -1) {
      stats.preprocessing = { exact: 0, fuzzy: 0, none: 0 };
    }

    // Pass 1: parse each row, strip sub-units, collect per-building entries
    var buildingBucket = new Map();  // matchKey -> { geometry, entries[] }
    var fallbackBucket = new Map();  // matchKey|postcode -> { geometry, entries[] }

    function getLicenceTypeKey(licenceType) {
      var normalised = String(licenceType || '').trim().toLowerCase();
      return normalised === 'selective' ? 'selective' : 'hmo';
    }

    function bucketKeyFor(matchKey, licenceType, fallbackKey) {
      var typeKey = getLicenceTypeKey(licenceType);
      return typeKey + '|' + (fallbackKey || matchKey || '');
    }

    rows.forEach(function (row) {
      var rawAddress = colMap.address !== -1 ? (row[headers[colMap.address]] || '') : '';

      if (!rawAddress.trim()) return;
      stats.total++;

      var street       = colMap.street !== -1        ? (row[headers[colMap.street]] || '')       : '';
      var id           = colMap.id !== -1            ? (row[headers[colMap.id]] || '')           : '';
      var licenceStart = colMap.licenceStart !== -1  ? (row[headers[colMap.licenceStart]] || '') : '';
      var licenceEnd   = colMap.licenceEnd !== -1    ? (row[headers[colMap.licenceEnd]] || '')   : '';
      var licenceType  = colMap.licenceType !== -1   ? (row[headers[colMap.licenceType]] || '')  : '';

      // Check if CSV has precomputed columns
      var hasPrecomputed = colMap.matchKey !== -1;
      var matchKey, housenumber, postcode, subUnit, streetForMatch;
      var address = rawAddress;
      var pcInfo = null;
      var lsoa = '';

      if (hasPrecomputed) {
        // Use precomputed values
        matchKey = colMap.matchKey !== -1 ? (row[headers[colMap.matchKey]] || '') : '';
        housenumber = colMap.housenumber !== -1 ? (row[headers[colMap.housenumber]] || '') : '';
        streetForMatch = colMap.street !== -1 ? (row[headers[colMap.street]] || '') : '';
        postcode = colMap.postcode !== -1 ? (row[headers[colMap.postcode]] || '') : '';
        subUnit = colMap.subUnit !== -1 ? (row[headers[colMap.subUnit]] || '') : '';
        
        // Track preprocessing confidence
        if (colMap.matchConfidence !== -1) {
          var confidence = row[headers[colMap.matchConfidence]] || 'none';
          if (stats.preprocessing[confidence] !== undefined) {
            stats.preprocessing[confidence]++;
          }
        }
        
        // Still need to normalize postcode if provided
        if (postcode) {
          postcode = normalisePostcode(postcode);
          pcInfo = _postcodeIndex.get(postcode);
          lsoa = pcInfo ? pcInfo.lsoa : '';
          if (lsoa) {
            lsoaCounts[lsoa] = (lsoaCounts[lsoa] || 0) + 1;
          } else {
            stats.noLsoa++;
          }
        } else {
          stats.noPostcode++;
        }
      } else {
        // Parse address (original logic)
        var parsed = stripSubUnit(rawAddress);
        address = parsed.coreAddress;
        subUnit = parsed.subUnit;

        // Debug logging for random ~10 rows
        if (debugCount < 10 && Math.random() < 0.003) {
          debugCount++;
          console.log('  Sub-unit stripped:', subUnit, '| Core address:', address);
        }

        var pcMatch = address.match(UK_POSTCODE_RE);
        if (!pcMatch) {
          pcMatch = rawAddress.match(UK_POSTCODE_RE);
        }
        if (!pcMatch) {
          stats.noPostcode++;
          return;
        }
        postcode = normalisePostcode(pcMatch[0]);

        pcInfo = _postcodeIndex.get(postcode);
        lsoa = pcInfo ? pcInfo.lsoa : '';
        if (lsoa) {
          lsoaCounts[lsoa] = (lsoaCounts[lsoa] || 0) + 1;
        } else {
          stats.noLsoa++;
        }

        // Remove postcode from address for housenumber and street extraction
        var addrNoPostcode = address.replace(pcMatch[0], '').trim();
        addrNoPostcode = addrNoPostcode.replace(/[\u2010-\u2015]/g, '-');

        housenumber = extractHousenumber(addrNoPostcode);
        streetForMatch = street || '';
        if (!streetForMatch) {
          // Split on commas and filter out geographic qualifiers and empty parts from the end
          var parts = addrNoPostcode.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p; });
          var qualifiers = ['oxford', 'headington', 'summertown', 'jericho', 'cowley', 'iffley', 'marston', 'blackbirdleys', 'woodfarm', 'littlemore', 'botley', 'cutteslowe', 'wolvercote', 'northoxford', 'southoxford', 'eastoxford', 'westoxford', 'cityofoxford', 'england', 'uk'];
          
          while (parts.length > 1) {
            var lastPart = parts[parts.length - 1].toLowerCase();
            if (qualifiers.indexOf(lastPart) !== -1) {
              parts.pop();
            } else {
              break;
            }
          }
          
          // If we have multiple parts, the first part might be a house name/number
          if (parts.length > 1 && !housenumber) {
            housenumber = parts[0];
            parts.shift(); // Remove the house name from parts
          }
          
          // The last remaining part should be the street
          if (parts.length > 0) {
            streetForMatch = parts[parts.length - 1];
          }
          
          // If housenumber was found, remove it from the street
          if (housenumber && streetForMatch) {
            var hnRegex = new RegExp('\\b' + housenumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
            streetForMatch = streetForMatch.replace(hnRegex, '').trim();
          }
          
          // Debug logging for random ~10 rows
          if (debugCount < 10 && Math.random() < 0.003) {
            console.log('  Parts after split/filter:', parts);
            console.log('  Street before hn removal:', parts[parts.length - 1] || '');
            console.log('  Street after hn removal:', streetForMatch);
          }
        }

        matchKey = normaliseMatchKey(housenumber + ' ' + streetForMatch);
      }

      // Create entry object with parsed data
      var entry = {
        hmo_id: id,
        sub_unit: subUnit,
        licence_start: licenceStart,
        licence_end: licenceEnd,
        licence_type: licenceType
      };

      var buildingFeat = null;
      
      if (hasPrecomputed && matchKey) {
        // Preprocessed files already did the heavy matching work. Only do exact lookup here.
        buildingFeat = _buildingIndex.get(matchKey);
      } else {
        // Original logic for raw CSVs
        buildingFeat = matchKey ? _buildingIndex.get(matchKey) : null;
        
        // Debug logging for random ~10 rows
        if (debugCount < 10 && Math.random() < 0.003) {
          debugCount++;
          console.log('Row', stats.total, '| Raw:', rawAddress);
          console.log('  Housenumber:', housenumber, '| Street:', streetForMatch);
          console.log('  Generated matchKey:', matchKey);
          console.log('  Found in index:', !!buildingFeat);
        }

        // Fallback: try removing letter suffix from housenumber (e.g., "139a" -> "139")
        if (!buildingFeat && housenumber && /[a-z]$/i.test(housenumber)) {
          var housenumberNoLetter = housenumber.replace(/[a-z]$/i, '');
          var fallbackMatchKey = normaliseMatchKey(housenumberNoLetter + ' ' + streetForMatch);
          buildingFeat = fallbackMatchKey ? _buildingIndex.get(fallbackMatchKey) : null;
          if (debugCount < 10 && Math.random() < 0.003 && buildingFeat) {
            console.log('  Fallback matched by removing letter from housenumber:', housenumber, '->', housenumberNoLetter);
          }
          
          // Fuzzy matching for the fallback key
          if (!buildingFeat && fallbackMatchKey) {
            var bestMatch = null;
            var bestDistance = Infinity;
            var bestKey = null;
            
            _buildingIndex.forEach(function(value, key) {
              var distance = levenshteinDistance(fallbackMatchKey, key);
              if (distance <= 2 && distance < bestDistance) {
                bestDistance = distance;
                bestMatch = value;
                bestKey = key;
              }
            });
            
            if (bestMatch) {
              buildingFeat = bestMatch;
              if (debugCount < 10 && Math.random() < 0.003) {
                console.log('  Fuzzy matched fallback with distance', bestDistance, ':', fallbackMatchKey, '->', bestKey);
              }
            }
          }
        }

        // Fallback: try component-based matching (postcode + housenumber + street)
        if (!buildingFeat && _addrIndex && postcode && housenumber && streetForMatch) {
          var streetVariants = generateStreetVariants(streetForMatch);
          for (var s = 0; !buildingFeat && s < streetVariants.length; s++) {
            var compKey = postcode + '|' + normaliseMatchKey(housenumber) + '|' + streetVariants[s];
            buildingFeat = _addrIndex.get(compKey);
            if (debugCount < 10 && Math.random() < 0.003 && buildingFeat) {
              console.log('  Matched via component index with key:', compKey);
            }

            // Additional component fallback: try removing letter suffix from housenumber
            if (!buildingFeat && /[a-z]$/i.test(housenumber)) {
              var housenumberNoLetter = housenumber.replace(/[a-z]$/i, '');
              var fallbackCompKey = postcode + '|' + normaliseMatchKey(housenumberNoLetter) + '|' + streetVariants[s];
              buildingFeat = _addrIndex.get(fallbackCompKey);
              if (debugCount < 10 && Math.random() < 0.003 && buildingFeat) {
                console.log('  Fallback matched via component index by removing letter from housenumber:', housenumber, '->', housenumberNoLetter);
              }
            }
          }
        }

        // Fallback: try many-to-one numeric range matching for buildings like "62-92 Southfield Park"
        if (!buildingFeat && postcode && housenumber && streetForMatch) {
          buildingFeat = findRangeMatch(postcode, housenumber, streetForMatch);
          if (debugCount < 10 && Math.random() < 0.003 && buildingFeat) {
            console.log('  Matched via housenumber range for:', housenumber, streetForMatch, postcode);
          }
        }
        
        // Additional fallback: try component matching without housenumber if housenumber is empty
        if (!buildingFeat && _addrIndex && postcode && !housenumber && streetForMatch) {
          var emptyStreetVariants = generateStreetVariants(streetForMatch);
          for (var e = 0; !buildingFeat && e < emptyStreetVariants.length; e++) {
            var streetOnlyCompKey = postcode + '||' + emptyStreetVariants[e];
            buildingFeat = _addrIndex.get(streetOnlyCompKey);
            if (debugCount < 10 && Math.random() < 0.003 && buildingFeat) {
              console.log('  Matched via street-only component index with key:', streetOnlyCompKey);
            }
          }
        }

        // Fallback: try fuzzy matching with Levenshtein distance <= 2 (only for raw CSVs)
        if (!buildingFeat && matchKey && !hasPrecomputed && matchKey.length > 3) {
          var bestMatch = null;
          var bestDistance = Infinity;
          var bestKey = null;
          
          // Check all building keys for close matches
          _buildingIndex.forEach(function(value, key) {
            var distance = levenshteinDistance(matchKey, key);
            if (distance <= 2 && distance < bestDistance) {
              bestDistance = distance;
              bestMatch = value;
              bestKey = key;
            }
          });
          
          if (bestMatch) {
            buildingFeat = bestMatch;
            if (debugCount < 10 && Math.random() < 0.003) {
              console.log('  Fuzzy matched with distance', bestDistance, ':', matchKey, '->', bestKey);
            }
          }
        }
      }

      if (buildingFeat) {
        var groupedBuildingKey = bucketKeyFor(matchKey, licenceType);
        if (buildingBucket.has(groupedBuildingKey)) {
          buildingBucket.get(groupedBuildingKey).entries.push(entry);
        } else {
          buildingBucket.set(groupedBuildingKey, {
            geometry: buildingFeat.geometry,
            entries: [entry],
            address: address,
            street: street || streetForMatch,
            postcode: postcode,
            lsoa: lsoa,
            licence_type: getLicenceTypeKey(licenceType),
          });
        }
      } else if (pcInfo) {
        var fbKey = matchKey || (postcode + '|' + address);
        var groupedFallbackKey = bucketKeyFor(matchKey, licenceType, fbKey);
        if (fallbackBucket.has(groupedFallbackKey)) {
          fallbackBucket.get(groupedFallbackKey).entries.push(entry);
        } else {
          fallbackBucket.set(groupedFallbackKey, {
            geometry: { type: 'Point', coordinates: [pcInfo.lon, pcInfo.lat] },
            entries: [entry],
            address: address,
            street: street || streetForMatch,
            postcode: postcode,
            lsoa: lsoa,
            licence_type: getLicenceTypeKey(licenceType),
          });
        }
      }
    });

    // Pass 2: consolidate buckets into GeoJSON features
    var buildingFeatures = { hmo: [], selective: [] };
    buildingBucket.forEach(function (bucket) {
      var entries = bucket.entries;
      var isMulti = entries.length > 1;
      if (isMulti) stats.multiHousehold++;

      var subUnits = entries.map(function (e) { return e.sub_unit; }).filter(Boolean);
      var ids = entries.map(function (e) { return e.hmo_id; }).filter(Boolean);
      var licenceType = bucket.licence_type || 'hmo';

      var props = {
        address: bucket.address,
        street: bucket.street,
        postcode: bucket.postcode,
        lsoa: bucket.lsoa,
        licence_type: licenceType,
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
      buildingFeatures[licenceType].push({
        type: 'Feature',
        geometry: bucket.geometry,
        properties: props,
      });
    });

    var fallbackFeatures = { hmo: [], selective: [] };
    fallbackBucket.forEach(function (bucket) {
      var entries = bucket.entries;
      var isMulti = entries.length > 1;
      if (isMulti) stats.multiHousehold++;

      var subUnits = entries.map(function (e) { return e.sub_unit; }).filter(Boolean);
      var ids = entries.map(function (e) { return e.hmo_id; }).filter(Boolean);
      var licenceType = bucket.licence_type || 'hmo';

      var props = {
        address: bucket.address,
        street: bucket.street,
        postcode: bucket.postcode,
        lsoa: bucket.lsoa,
        licence_type: licenceType,
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
      fallbackFeatures[licenceType].push({
        type: 'Feature',
        geometry: bucket.geometry,
        properties: props,
      });
    });

    onProgress('Done.');

    return {
      hmoBuildings: { type: 'FeatureCollection', features: buildingFeatures.hmo },
      selectiveBuildings: { type: 'FeatureCollection', features: buildingFeatures.selective },
      hmoFallbackPoints: { type: 'FeatureCollection', features: fallbackFeatures.hmo },
      selectiveFallbackPoints: { type: 'FeatureCollection', features: fallbackFeatures.selective },
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
