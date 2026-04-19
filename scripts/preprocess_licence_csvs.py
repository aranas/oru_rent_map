#!/usr/bin/env python3
"""
preprocess_hmo_csv.py
=====================
Preprocesses HMO and Selective licence CSV files, matches addresses against 
building data, and merges into a single output CSV for mapping.

Usage:
  python scripts/preprocess_hmo_csv.py hmo.csv selective.csv output.csv

The output CSV contains only the columns needed for mapping:
- address: Original address from input
- licence_type: 'hmo' or 'selective'
- match_key: Normalized key for building matching
- street: Extracted street name
- housenumber: Extracted house number
- postcode: Normalized postcode
"""

import csv
import json
import os
import re
import sys

# Same regexes and logic as hmo-upload.js
UK_POSTCODE_RE = re.compile(r'[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}', re.IGNORECASE)
SUBUNIT_RE = re.compile(r'^((?:(?:the|ground|first|second|third|basement)\s+)?(?:flat|room|unit|apt\.?|apartment|studio|annex|annexe|floor)\s+[0-9a-z]+)(?:\s*,\s*|\s+(?=\d))', re.IGNORECASE)
HOUSENUMBER_RANGE_RE = re.compile(r'(\d+[A-Za-z]?\s*[-\u2010-\u2015]\s*\d+[A-Za-z]?)')

def normalise_match_key(s):
    """Same as JavaScript normaliseMatchKey function."""
    if not s:
        return ''
    s = s.lower()
    s = re.sub(r'[^a-z0-9\s]', '', s)
    return ' '.join(s.split()).strip()

def normalise_postcode(pc):
    """Same as JavaScript normalisePostcode function."""
    return pc.upper().replace(' ', '').strip()

def normalise_housenumber_token(housenumber):
    """Normalize dash variants and whitespace inside housenumbers."""
    if not housenumber:
        return ''
    token = str(housenumber).strip()
    token = re.sub(r'[\u2010-\u2015]', '-', token)
    token = re.sub(r'\s*-\s*', '-', token)
    return token

def extract_housenumber(address):
    """Same as JavaScript extractHousenumber function."""
    range_match = HOUSENUMBER_RANGE_RE.search(address)
    if range_match:
        return normalise_housenumber_token(range_match.group(1))
    m = re.search(r'(\d+[A-Za-z]?)', address)
    return m.group(1) if m else ''

def extract_housenumber_numeric_part(housenumber):
    """Return the leading numeric part of a housenumber, if present."""
    if not housenumber:
        return None
    m = re.match(r'(\d+)', str(housenumber).strip())
    return int(m.group(1)) if m else None

def parse_housenumber_range(housenumber):
    """Parse simple numeric housenumber ranges like '62-92'."""
    if not housenumber:
        return None
    normalised = normalise_housenumber_token(housenumber)
    m = re.fullmatch(r'\s*(\d+)\s*-\s*(\d+)\s*', normalised)
    if not m:
        return None
    start = int(m.group(1))
    end = int(m.group(2))
    if start > end:
        start, end = end, start
    return start, end

def split_housenumber_list(housenumber):
    """Split comma-separated housenumbers into normalized individual values."""
    if not housenumber or ',' not in str(housenumber):
        return []

    values = []
    seen = set()
    for part in str(housenumber).split(','):
        token = normalise_match_key(part)
        if not token or token in seen:
            continue
        seen.add(token)
        values.append(token)
    return values

def generate_street_variants(street):
    """Return progressively shorter normalized street candidates."""
    street_key = normalise_match_key(street)
    if not street_key:
        return []

    tokens = street_key.split()
    variants = [street_key]
    if len(tokens) <= 2:
        return variants

    for end in range(len(tokens) - 1, 1, -1):
        candidate = ' '.join(tokens[:end])
        if candidate not in variants:
            variants.append(candidate)
    return variants

def strip_sub_unit(address):
    """Same as JavaScript stripSubUnit function."""
    m = SUBUNIT_RE.match(address)
    if m:
        return {
            'sub_unit': m.group(1).strip(),
            'core_address': address[m.end():]
        }
    return {
        'sub_unit': '',
        'core_address': address
    }

def levenshtein_distance(a, b):
    """Calculate Levenshtein distance between two strings."""
    if len(a) == 0:
        return len(b)
    if len(b) == 0:
        return len(a)

    matrix = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]

    for i in range(len(a) + 1):
        matrix[i][0] = i
    for j in range(len(b) + 1):
        matrix[0][j] = j

    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i-1] == b[j-1] else 1
            matrix[i][j] = min(
                matrix[i-1][j] + 1,      # deletion
                matrix[i][j-1] + 1,      # insertion
                matrix[i-1][j-1] + cost  # substitution
            )

    return matrix[len(a)][len(b)]

def load_building_index():
    """Load the building index from oxford_buildings.geojson."""
    data_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
    buildings_path = os.path.join(data_dir, 'oxford_buildings.geojson')
    
    if not os.path.exists(buildings_path):
        print(f"Error: Building data not found at {buildings_path}")
        print("Run 'python scripts/generate_building_data.py' first")
        sys.exit(1)
    
    with open(buildings_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    building_index = {}
    ranged_buildings = []
    listed_buildings = []
    for feature in data['features']:
        properties = feature.get('properties', {})
        match_key = properties.get('match_key', '')
        if match_key:
            building_index[match_key] = feature

        housenumber_range = parse_housenumber_range(properties.get('addr_housenumber', ''))
        street = properties.get('addr_street', '')
        street_key = normalise_match_key(street)
        postcode = normalise_postcode(properties.get('addr_postcode', ''))
        if housenumber_range and street_key:
            ranged_buildings.append({
                'start': housenumber_range[0],
                'end': housenumber_range[1],
                'street_key': street_key,
                'postcode': postcode,
                'match_key': match_key,
                'feature': feature
            })

        for listed_housenumber in split_housenumber_list(properties.get('addr_housenumber', '')):
            if street_key:
                listed_buildings.append({
                    'housenumber': listed_housenumber,
                    'street_key': street_key,
                    'postcode': postcode,
                    'match_key': match_key,
                    'feature': feature
                })
    
    print(f"Loaded {len(building_index)} building entries")
    print(f"Indexed {len(ranged_buildings)} ranged building entries")
    print(f"Indexed {len(listed_buildings)} listed housenumber entries")
    return {
        'exact': building_index,
        'ranges': ranged_buildings,
        'lists': listed_buildings
    }

def find_best_match(parsed, building_index):
    """Find the best match for a candidate key in the building index."""
    housenumber = parsed['housenumber']
    street_variants = generate_street_variants(parsed['street'])
    postcode = parsed['postcode']
    if not housenumber or not street_variants:
        return None, 'none'

    listed_housenumber = normalise_match_key(housenumber)
    candidate_range = parse_housenumber_range(housenumber)
    housenumber_value = extract_housenumber_numeric_part(housenumber)

    def choose_entry(entries, expected_key, confidence):
        if len(entries) == 1:
            return entries[0]['match_key'], confidence
        if len(entries) > 1:
            exact_key_matches = [m for m in entries if m['match_key'] == expected_key]
            if exact_key_matches:
                return exact_key_matches[0]['match_key'], confidence
            return entries[0]['match_key'], confidence
        return None, None

    for street_key in street_variants:
        candidate_key = normalise_match_key(f"{housenumber} {street_key}")

        if candidate_key in building_index['exact']:
            return candidate_key, 'exact'

        if listed_housenumber:
            postcode_matches = []
            fallback_matches = []
            for listed_entry in building_index['lists']:
                if listed_entry['street_key'] != street_key:
                    continue
                if listed_entry['housenumber'] != listed_housenumber:
                    continue
                if postcode and listed_entry['postcode'] == postcode:
                    postcode_matches.append(listed_entry)
                else:
                    fallback_matches.append(listed_entry)

            chosen_key, confidence = choose_entry(postcode_matches, candidate_key, 'list')
            if chosen_key:
                return chosen_key, confidence
            chosen_key, confidence = choose_entry(fallback_matches, candidate_key, 'list')
            if chosen_key:
                return chosen_key, confidence

        if candidate_range:
            postcode_matches = []
            fallback_matches = []
            for range_entry in building_index['ranges']:
                if range_entry['street_key'] != street_key:
                    continue
                if not (range_entry['start'] <= candidate_range[0] and candidate_range[1] <= range_entry['end']):
                    continue
                if postcode and range_entry['postcode'] == postcode:
                    postcode_matches.append(range_entry)
                else:
                    fallback_matches.append(range_entry)

            chosen_key, confidence = choose_entry(postcode_matches, candidate_key, 'range')
            if chosen_key:
                return chosen_key, confidence
            chosen_key, confidence = choose_entry(fallback_matches, candidate_key, 'range')
            if chosen_key:
                return chosen_key, confidence

        if housenumber_value is not None:
            postcode_matches = []
            fallback_matches = []
            for range_entry in building_index['ranges']:
                if range_entry['street_key'] != street_key:
                    continue
                if not (range_entry['start'] <= housenumber_value <= range_entry['end']):
                    continue
                if postcode and range_entry['postcode'] == postcode:
                    postcode_matches.append(range_entry)
                else:
                    fallback_matches.append(range_entry)

            chosen_key, confidence = choose_entry(postcode_matches, candidate_key, 'range')
            if chosen_key:
                return chosen_key, confidence
            chosen_key, confidence = choose_entry(fallback_matches, candidate_key, 'range')
            if chosen_key:
                return chosen_key, confidence
    
    # Skip fuzzy matching for now to improve performance
    return None, 'none'

def strip_geographic_qualifiers(address):
    """Same as JavaScript stripGeographicQualifiers function."""
    qualifiers = [
        'city of oxford', 'north oxford', 'south oxford', 'east oxford', 'west oxford',
        'oxford', 'england', 'uk'
    ]

    parts = [p.strip() for p in address.split(',') if p.strip()]
    while len(parts) > 1:
        last_part = parts[-1].lower()
        if last_part in qualifiers:
            parts.pop()
        else:
            break
    return ', '.join(parts)

def parse_address(raw_address):
    """Parse address using same logic as JavaScript matchRows function."""
    if not raw_address.strip():
        return {
            'match_key': '',
            'housenumber': '',
            'street': '',
            'postcode': '',
            'sub_unit': ''
        }

    # Strip sub-unit
    parsed = strip_sub_unit(raw_address)
    address = parsed['core_address']
    sub_unit = parsed['sub_unit']

    # Find postcode
    pc_match = UK_POSTCODE_RE.search(address)
    if not pc_match:
        pc_match = UK_POSTCODE_RE.search(raw_address)
    if not pc_match:
        return {
            'match_key': '',
            'housenumber': '',
            'street': '',
            'postcode': '',
            'sub_unit': sub_unit
        }

    postcode = normalise_postcode(pc_match.group(0))

    # Remove postcode for parsing
    addr_no_postcode = address.replace(pc_match.group(0), '').strip()
    addr_no_postcode = re.sub(r'[\u2010-\u2015]', '-', addr_no_postcode)

    # Extract housenumber
    housenumber = extract_housenumber(addr_no_postcode)

    # Parse street
    street_for_match = ''
    parts = [p.strip() for p in addr_no_postcode.split(',') if p.strip()]

    # Remove geographic qualifiers from end
    qualifiers = ['oxford', 'headington', 'summertown', 'jericho', 'cowley', 'iffley', 'marston', 'blackbirdleys', 'woodfarm', 'littlemore', 'botley', 'cutteslowe', 'wolvercote', 'northoxford', 'southoxford', 'eastoxford', 'westoxford', 'cityofoxford', 'england', 'uk']
    while len(parts) > 1:
        last_part = parts[-1].lower()
        if last_part in qualifiers:
            parts.pop()
        else:
            break

    # If multiple parts and no housenumber, first part might be house name
    if len(parts) > 1 and not housenumber:
        housenumber = parts[0]
        parts = parts[1:]

    # Last part is street
    if parts:
        street_for_match = parts[-1]

    # Remove housenumber from street if found
    if housenumber and street_for_match:
        # Escape regex special chars
        hn_pattern = re.escape(housenumber)
        street_for_match = re.sub(r'\b' + hn_pattern + r'\b', '', street_for_match, flags=re.IGNORECASE).strip()

    # Generate match key
    match_key = normalise_match_key(f"{housenumber} {street_for_match}")

    return {
        'match_key': match_key,
        'housenumber': housenumber,
        'street': street_for_match,
        'postcode': postcode,
        'sub_unit': sub_unit
    }

def process_csv(input_path, building_index, licence_type):
    """Process a single CSV file and return processed rows."""
    print(f"Processing {licence_type} licences from {input_path}")
    
    rows = []
    
    # Try different encodings
    encodings = ['utf-8', 'iso-8859-1', 'cp1252', 'latin1']
    infile = None
    encoding = None
    
    for enc in encodings:
        try:
            with open(input_path, 'rb') as f:
                # Read first 10KB to detect encoding
                sample = f.read(10240)
                sample.decode(enc)
            # If we get here, encoding works
            encoding = enc
            break
        except UnicodeDecodeError:
            continue
    
    if not encoding:
        print(f"Error: Could not determine encoding for {input_path}")
        return rows
    
    print(f"  Using encoding: {encoding}")
    
    try:
        infile = open(input_path, 'r', newline='', encoding=encoding, errors='replace')
        reader = csv.DictReader(infile)
        fieldnames = reader.fieldnames

        exact_matches = 0
        list_matches = 0
        range_matches = 0
        fuzzy_matches = 0
        no_matches = 0
        
        for row in reader:
            # Find address column (case-insensitive)
            address_col = None
            for col in fieldnames:
                if col and col.lower() == 'address':
                    address_col = col
                    break
            
            if not address_col:
                print(f"Warning: No 'address' column found in {input_path}, skipping row")
                continue
            
            raw_address = row.get(address_col, '')
            parsed = parse_address(raw_address)
            
            # Try to find the best match in building data
            matched_key, confidence = find_best_match(parsed, building_index)
            
            if confidence == 'exact':
                exact_matches += 1
            elif confidence == 'list':
                list_matches += 1
            elif confidence == 'range':
                range_matches += 1
            elif confidence == 'fuzzy':
                fuzzy_matches += 1
            else:
                no_matches += 1
            
            # Create standardized row with only required columns
            processed_row = {
                'address': raw_address,
                'licence_type': licence_type,
                'match_key': matched_key or '',
                'street': parsed['street'],
                'housenumber': parsed['housenumber'],
                'postcode': parsed['postcode']
            }
            rows.append(processed_row)
    finally:
        if infile:
            infile.close()

    print(f"  {licence_type} results: {exact_matches} exact, {list_matches} list, {range_matches} range, {fuzzy_matches} fuzzy, {no_matches} none")
    
    return rows

def main():
    if len(sys.argv) != 4:
        print("Usage: python scripts/preprocess_hmo_csv.py hmo.csv selective.csv output.csv")
        sys.exit(1)
    
    hmo_path = sys.argv[1]
    selective_path = sys.argv[2]
    output_path = sys.argv[3]
    
    if not os.path.exists(hmo_path):
        print(f"Error: HMO file {hmo_path} does not exist")
        sys.exit(1)
    if not os.path.exists(selective_path):
        print(f"Error: Selective file {selective_path} does not exist")
        sys.exit(1)
    
    # Load building index
    building_index = load_building_index()
    
    # Process both files
    hmo_rows = process_csv(hmo_path, building_index, 'hmo')
    selective_rows = process_csv(selective_path, building_index, 'selective')
    all_rows = hmo_rows + selective_rows
    
    # Write merged output
    print(f"Writing {len(all_rows)} total rows to {output_path}")
    
    fieldnames = ['address', 'licence_type', 'match_key', 'street', 'housenumber', 'postcode']
    
    with open(output_path, 'w', newline='', encoding='utf-8') as outfile:
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)
    
    print(f"Preprocessing complete: {output_path}")

if __name__ == '__main__':
    main()
