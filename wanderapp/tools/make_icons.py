# -*- coding: utf-8 -*-
"""Erzeugt die PWA-Icons ohne externe Abhaengigkeiten (reiner zlib-PNG-Writer)."""
import zlib, struct, math, os

def png(path, w, h, px):
    raw = b''.join(b'\x00' + bytes(v for p in row for v in p) for row in px)
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

BG_O, BG_U = (26, 71, 52), (13, 40, 30)      # Verlauf gruen
BERG_H, BERG_D = (149, 213, 178), (82, 155, 122)
SCHNEE = (240, 253, 244)
SONNE = (244, 162, 97)

def zeichne(size, safe=1.0):
    """safe<1 -> Motiv kleiner, fuer maskable Icons (Android beschneidet die Raender)."""
    px = []
    c = size / 2.0
    s = size * safe
    o = (size - s) / 2.0
    for y in range(size):
        row = []
        for x in range(size):
            col = mix(BG_O, BG_U, y / size)
            # Sonne
            dx, dy = x - (o + s * 0.72), y - (o + s * 0.27)
            r = math.hypot(dx, dy)
            if r < s * 0.105:
                col = SONNE
            elif r < s * 0.115:
                col = mix(SONNE, col, (r - s * 0.105) / (s * 0.01))
            # Berge: zwei Dreiecke, hinterer rechts versetzt
            fy = (y - o) / s
            fx = (x - o) / s
            def berg(gipfel_x, gipfel_y, breite, farbe, col):
                if fy < gipfel_y: return col
                halb = (fy - gipfel_y) * breite
                if gipfel_x - halb <= fx <= gipfel_x + halb:
                    # Schneekappe
                    if fy < gipfel_y + 0.075:
                        return SCHNEE
                    return farbe
                return col
            col = berg(0.68, 0.46, 0.80, BERG_D, col)
            col = berg(0.38, 0.34, 0.78, BERG_H, col)
            row.append((col[0], col[1], col[2], 255))
        px.append(row)
    return px

os.makedirs('icons', exist_ok=True)
for size, name, safe in ((192, 'icon-192.png', 1.0), (512, 'icon-512.png', 1.0),
                         (512, 'icon-maskable.png', 0.78), (180, 'apple-touch-icon.png', 1.0)):
    png(os.path.join('icons', name), size, size, zeichne(size, safe))
    print('icons/' + name)
