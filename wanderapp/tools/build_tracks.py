# -*- coding: utf-8 -*-
"""Baut aus den GPX-Dateien des Buches die JSON-Daten fuer die Wanderapp.

Aufruf:  python tools/build_tracks.py <gpx-verzeichnis>

Bereinigungen (siehe Analyse):
  * pro Datei wird das laengste Segment zur Hauptroute, der Rest zu 'varianten'
  * Hoehenmeter mit Median-Glaettung (Fenster 5) + 5-m-Schwelle
  * vertauschte Nummerierung 36/37 wird korrigiert
  * <name>Position N</name> je Trackpunkt wird verworfen
"""
import sys, os, re, glob, json, math
import xml.etree.ElementTree as ET

NS = {'g': 'http://www.topografix.com/GPX/1/1'}
R = 6371008.8

# Buchtitel je Nummer - laengere Fassung aus metadata/name, wo sie mehr hergibt
TITEL = {
    1: "Eichener See – Hasler Höhle", 4: "Höllbachwasserfälle und Gugelturm",
    6: "Höchenschwand – Eselfuß", 23: "Nordrach – Heidensteinsofa",
    29: "Karlsruher Grat", 30: "Ruhestein – Wildsee",
}
# Region nach geografischer Lage (Breitengrad)
def region(lat):
    if lat < 47.80: return "Hochrhein & Südschwarzwald"
    if lat < 48.10: return "Hochschwarzwald"
    if lat < 48.45: return "Mittlerer Schwarzwald"
    return "Nordschwarzwald"

def hav(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    x = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

def laenge(pts):
    return sum(hav(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]) for i in range(1, len(pts)))

def hoehenmeter(pts):
    """Median-Glaettung (Fenster 5), danach Akkumulation ab 5 m Differenz."""
    e = [p[2] for p in pts]
    if not any(x is not None for x in e):
        return 0.0, 0.0, None, None
    e = [x if x is not None else 0.0 for x in e]
    g = []
    for i in range(len(e)):
        w = e[max(0, i-2):i+3]
        g.append(sorted(w)[len(w)//2])
    auf = ab = 0.0
    ref = g[0]
    for x in g[1:]:
        d = x - ref
        if d >= 5:   auf += d; ref = x
        elif d <= -5: ab += -d; ref = x
    return auf, ab, min(g), max(g)

def douglas_peucker(pts, tol):
    """Vereinfacht die Linie; behaelt Index-Bezug zu Hoehen bei."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = [0, len(pts) - 1]
    stack = [(0, len(pts) - 1)]
    # Naeherung: Grad -> Meter im Zielgebiet
    mlat, mlon = 111320.0, 111320.0 * math.cos(math.radians(48.2))
    while stack:
        a, b = stack.pop()
        if b - a < 2: continue
        x1, y1 = pts[a][1] * mlon, pts[a][0] * mlat
        x2, y2 = pts[b][1] * mlon, pts[b][0] * mlat
        dx, dy = x2 - x1, y2 - y1
        n2 = dx*dx + dy*dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i][1] * mlon, pts[i][0] * mlat
            if n2 == 0:
                dist = math.hypot(px - x1, py - y1)
            else:
                t = max(0.0, min(1.0, ((px-x1)*dx + (py-y1)*dy) / n2))
                dist = math.hypot(px - (x1 + t*dx), py - (y1 + t*dy))
            if dist > best: best, bi = dist, i
        if best > tol:
            keep.append(bi); stack.append((a, bi)); stack.append((bi, b))
    return sorted(keep)

def lade(f):
    root = ET.parse(f).getroot()
    meta = (root.findtext('g:metadata/g:name', default='', namespaces=NS) or '').strip()
    segs = []
    for trk in root.findall('g:trk', NS):
        for seg in trk.findall('g:trkseg', NS):
            pts = []
            for p in seg.findall('g:trkpt', NS):
                ele = p.findtext('g:ele', namespaces=NS)
                pts.append((float(p.get('lat')), float(p.get('lon')),
                            float(ele) if ele not in (None, '') else None))
            if len(pts) > 1:
                segs.append(pts)
    return meta, segs

def main():
    src = sys.argv[1]
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    os.makedirs(os.path.join(out, 'tracks'), exist_ok=True)
    index = []
    for f in sorted(glob.glob(os.path.join(src, '*.gpx'))):
        base = os.path.splitext(os.path.basename(f))[0]
        m = re.match(r'\s*(\d+)\s+(.*)', base)
        nr, name = (int(m.group(1)), m.group(2).strip()) if m else (0, base)
        # 36/37 waren in den Quelldateien vertauscht -> Buchnummer korrigieren
        if 'Zavelstein' in name: nr = 37
        elif 'Ebersteinburg' in name: nr = 36
        meta, segs = lade(f)
        if not segs: continue
        segs.sort(key=len, reverse=True)
        haupt, varianten = segs[0], segs[1:]

        idx = douglas_peucker(haupt, 3.0)          # 3 m Toleranz
        coords = [[round(haupt[i][0], 5), round(haupt[i][1], 5)] for i in idx]
        eles   = [round(haupt[i][2]) if haupt[i][2] is not None else None for i in idx]
        km = laenge(haupt) / 1000.0
        auf, ab, emin, emax = hoehenmeter(haupt)
        lats = [p[0] for p in haupt]; lons = [p[1] for p in haupt]
        rund = hav(haupt[0][0], haupt[0][1], haupt[-1][0], haupt[-1][1]) < 250

        var = []
        for v in varianten:
            if laenge(v) < 300: continue
            vi = douglas_peucker(v, 4.0)
            var.append({'km': round(laenge(v)/1000.0, 1),
                        'c': [[round(v[i][0], 5), round(v[i][1], 5)] for i in vi]})

        titel = TITEL.get(nr, name.replace('_', ' – '))
        tid = f'{nr:02d}'
        json.dump({
            'id': tid, 'nr': nr, 'name': name, 'titel': titel,
            'km': round(km, 1), 'auf': round(auf), 'ab': round(ab),
            'emin': round(emin), 'emax': round(emax),
            'rundweg': rund, 'region': region(lats[0]),
            'bbox': [round(min(lats),5), round(min(lons),5), round(max(lats),5), round(max(lons),5)],
            'c': coords, 'e': eles, 'varianten': var,
        }, open(os.path.join(out, 'tracks', tid + '.json'), 'w', encoding='utf-8'),
            ensure_ascii=False, separators=(',', ':'))

        index.append({
            'id': tid, 'nr': nr, 'titel': titel, 'km': round(km, 1),
            'auf': round(auf), 'ab': round(ab), 'emin': round(emin), 'emax': round(emax),
            'rundweg': rund, 'region': region(lats[0]),
            'start': [round(haupt[0][0], 5), round(haupt[0][1], 5)],
            'bbox': [round(min(lats),5), round(min(lons),5), round(max(lats),5), round(max(lons),5)],
            'n': len(coords), 'varianten': len(var),
        })

    index.sort(key=lambda t: t['nr'])
    json.dump({'titel': 'Mystische Pfade Schwarzwald', 'touren': index},
              open(os.path.join(out, 'index.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    print(f'{len(index)} Touren geschrieben')
    print(f'{sum(t["km"] for t in index):.1f} km, {sum(t["auf"] for t in index)} Hm')
    print(f'{sum(t["n"] for t in index)} Punkte nach Vereinfachung')

main()
