#!/usr/bin/env python3
"""
build_locality_anchors.py
---------------------------
Extracts named-locality reference points (Cowley, Temple Cowley, Rose Hill,
Littlemore, Blackbird Leys, Iffley, OXFORD, etc.) from the OS OpenMap Local
"Named Place" layer, converts them from OSGB36 National Grid (the shapefile's
native easting/northing) to WGS84 lat/lon, and writes a small lookup used to
tell real Cowley apart from the neighbouring areas that share its OX4
postcode district (Rose Hill, Littlemore, Blackbird Leys, Iffley Fields,
St Clement's/city centre).

Why this exists: postcode district alone is too coarse a proxy for "Cowley"
— OX4 also covers those neighbouring areas, which have their own identity
and are not what most people mean by "Cowley". OS OpenMap Local ships label
points (not polygons) for these places, so the nearest-named-point is used
downstream as a lightweight neighbourhood assignment (a Voronoi-style
nearest-label lookup), not a true boundary.

Input:
  data/OS OpenMap Local (ESRI Shape File) SP/data/SP_NamedPlace.{shp,shx,dbf}
  (OS OpenMap Local, Ordnance Survey, OGL licence — not gitignored data,
  see data licences in README.md)

Output (committed):
  data/oxford_locality_anchors.json — [{name, lat, lon}, ...] for every
  "Populated Place" within a generous bounding box around Oxford.

Run time: under a second, no network calls.
"""

import json, math, os, struct

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")

NAMED_PLACE_BASE = os.path.join(
    DATA, "OS OpenMap Local (ESRI Shape File) SP", "data", "SP_NamedPlace")
OUT_ANCHORS = os.path.join(DATA, "oxford_locality_anchors.json")

# Generous OSGB36 easting/northing box around Oxford (metres) — wide enough
# to catch every place name relevant to the city, trimmed of the rest of SP.
E_MIN, E_MAX = 440000, 462000
N_MIN, N_MAX = 195000, 212000


# ── Minimal shapefile reader (dbf attributes + shp PointZ geometry) ────────
# No third-party dependency: the subset of the shapefile spec needed for a
# point layer is a couple of struct.unpack calls.

def read_dbf_field(path):
    names = []
    with open(path, "rb") as f:
        header = f.read(32)
        num_records, = struct.unpack("<I", header[4:8])
        header_len, = struct.unpack("<H", header[8:10])
        record_len, = struct.unpack("<H", header[10:12])
        fields = []
        while True:
            fd = f.read(32)
            if fd[0:1] == b"\r":
                break
            name = fd[0:11].split(b"\x00")[0].decode("ascii")
            flen = fd[16]
            fields.append((name, flen))
        f.seek(header_len)
        for _ in range(num_records):
            rec = f.read(record_len)
            pos = 1  # skip the deletion flag byte
            vals = {}
            for name, flen in fields:
                vals[name] = rec[pos:pos + flen].decode("latin-1").strip()
                pos += flen
            names.append(vals)
    return names


def read_shp_points(path):
    with open(path, "rb") as f:
        content = f.read()
    points = []
    pos = 100  # past the 100-byte file header
    while pos < len(content):
        rec_num, content_len_words = struct.unpack(">2i", content[pos:pos + 8])
        body = pos + 8
        shape_type, = struct.unpack("<i", content[body:body + 4])
        x, y = struct.unpack("<2d", content[body + 4:body + 20])
        points.append((x, y))
        pos = body + content_len_words * 2
    return points


# ── OSGB36 National Grid (E,N) -> OSGB36 lat/lon (Airy 1830 ellipsoid) ─────
# Standard Ordnance Survey inverse Transverse Mercator formulas
# ("A guide to coordinate systems in Great Britain", OS, appendix C).

_A = 6377563.396
_B = 6356256.909
_F0 = 0.9996012717
_LAT0 = math.radians(49.0)
_LON0 = math.radians(-2.0)
_N0 = -100000.0
_E0 = 400000.0
_E2 = 1 - (_B * _B) / (_A * _A)
_N = (_A - _B) / (_A + _B)


def _en_to_osgb36_latlon(E, N):
    lat = _LAT0
    M = 0.0
    while True:
        lat = (N - _N0 - M) / (_A * _F0) + lat
        Ma = (1 + _N + (5/4)*_N**2 + (5/4)*_N**3) * (lat - _LAT0)
        Mb = (3*_N + 3*_N**2 + (21/8)*_N**3) * math.sin(lat - _LAT0) * math.cos(lat + _LAT0)
        Mc = ((15/8)*_N**2 + (15/8)*_N**3) * math.sin(2*(lat - _LAT0)) * math.cos(2*(lat + _LAT0))
        Md = (35/24)*_N**3 * math.sin(3*(lat - _LAT0)) * math.cos(3*(lat + _LAT0))
        M = _B * _F0 * (Ma - Mb + Mc - Md)
        if abs(N - _N0 - M) < 0.00001:
            break

    sinlat, coslat, tanlat = math.sin(lat), math.cos(lat), math.tan(lat)
    nu = _A * _F0 / math.sqrt(1 - _E2 * sinlat**2)
    rho = _A * _F0 * (1 - _E2) / (1 - _E2 * sinlat**2) ** 1.5
    eta2 = nu / rho - 1
    tan2, tan4, tan6 = tanlat**2, tanlat**4, tanlat**6
    secLat = 1.0 / coslat

    VII = tanlat / (2 * rho * nu)
    VIII = tanlat / (24 * rho * nu**3) * (5 + 3*tan2 + eta2 - 9*tan2*eta2)
    IX = tanlat / (720 * rho * nu**5) * (61 + 90*tan2 + 45*tan4)
    X = secLat / nu
    XI = secLat / (6 * nu**3) * (nu/rho + 2*tan2)
    XII = secLat / (120 * nu**5) * (5 + 28*tan2 + 24*tan4)
    XIIA = secLat / (5040 * nu**7) * (61 + 662*tan2 + 1320*tan4 + 720*tan6)

    dE = E - _E0
    latr = lat - VII*dE**2 + VIII*dE**4 - IX*dE**6
    lonr = _LON0 + X*dE - XI*dE**3 + XII*dE**5 - XIIA*dE**7
    return math.degrees(latr), math.degrees(lonr)


# ── OSGB36 (Airy 1830) lat/lon -> WGS84 lat/lon (7-parameter Helmert) ──────

def _latlon_to_cartesian(lat_deg, lon_deg, h, a_ax, b_ax):
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    e2 = 1 - (b_ax**2) / (a_ax**2)
    sinlat = math.sin(lat)
    nu = a_ax / math.sqrt(1 - e2 * sinlat**2)
    x = (nu + h) * math.cos(lat) * math.cos(lon)
    y = (nu + h) * math.cos(lat) * math.sin(lon)
    z = ((1 - e2) * nu + h) * sinlat
    return x, y, z


def _cartesian_to_latlon(x, y, z, a_ax, b_ax):
    e2 = 1 - (b_ax**2) / (a_ax**2)
    p = math.sqrt(x*x + y*y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(10):
        sinlat = math.sin(lat)
        nu = a_ax / math.sqrt(1 - e2 * sinlat**2)
        lat = math.atan2(z + e2 * nu * sinlat, p)
    lon = math.atan2(y, x)
    return math.degrees(lat), math.degrees(lon)


# OSGB36 -> WGS84 Helmert parameters (OS "A guide to coordinate systems",
# small 7-parameter approximation; accurate to a few metres across the UK,
# far tighter than we need for neighbourhood-level assignment).
_TX, _TY, _TZ = -446.448, 125.157, -542.060
_S_PPM = 20.4894
_RX, _RY, _RZ = (math.radians(d / 3600.0) for d in (-0.1502, -0.2470, -0.8421))
_WGS_A, _WGS_B = 6378137.000, 6356752.3141


def en_to_wgs84(E, N):
    lat_osgb, lon_osgb = _en_to_osgb36_latlon(E, N)
    x1, y1, z1 = _latlon_to_cartesian(lat_osgb, lon_osgb, 0.0, _A, _B)
    s = _S_PPM * 1e-6
    x2 = _TX + (1 + s) * x1 + (-_RZ) * y1 + (_RY) * z1
    y2 = _TY + (_RZ) * x1 + (1 + s) * y1 + (-_RX) * z1
    z2 = _TZ + (-_RY) * x1 + (_RX) * y1 + (1 + s) * z1
    return _cartesian_to_latlon(x2, y2, z2, _WGS_A, _WGS_B)


def main():
    attrs = read_dbf_field(NAMED_PLACE_BASE + ".dbf")
    points = read_shp_points(NAMED_PLACE_BASE + ".shp")

    anchors = []
    for vals, (E, N) in zip(attrs, points):
        if vals.get("CLASSIFICA") != "Populated Place":
            continue
        if not (E_MIN <= E <= E_MAX and N_MIN <= N <= N_MAX):
            continue
        lat, lon = en_to_wgs84(E, N)
        anchors.append({"name": vals["DISTNAME"], "lat": round(lat, 6), "lon": round(lon, 6)})

    with open(OUT_ANCHORS, "w") as f:
        json.dump(anchors, f, indent=1)
    print(f"Wrote {len(anchors)} locality anchors -> {OUT_ANCHORS}")


if __name__ == "__main__":
    main()
