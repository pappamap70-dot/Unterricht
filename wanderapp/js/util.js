// Hilfsfunktionen: Geometrie, Formatierung, kleine DOM-Helfer

export const R_ERDE = 6371008.8;

export function grad(x) { return x * Math.PI / 180; }

/** Entfernung zweier WGS84-Punkte in Metern. */
export function dist(lat1, lon1, lat2, lon2) {
  const p1 = grad(lat1), p2 = grad(lat2);
  const dp = p2 - p1, dl = grad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_ERDE * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Aufsummierte Streckenlänge je Punkt (Meter), gleiche Länge wie coords. */
export function kumDistanz(coords) {
  const k = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    k[i] = k[i - 1] + dist(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return k;
}

/**
 * Projiziert einen Standort auf die Trackline.
 * Liefert den Fußpunkt, die Entfernung dorthin und die Position entlang der Strecke.
 */
export function aufTrack(coords, kum, lat, lon) {
  const mlat = 111320, mlon = 111320 * Math.cos(grad(lat));
  const px = lon * mlon, py = lat * mlat;
  let best = Infinity, bi = 0, bt = 0;
  for (let i = 1; i < coords.length; i++) {
    const x1 = coords[i - 1][1] * mlon, y1 = coords[i - 1][0] * mlat;
    const x2 = coords[i][1] * mlon, y2 = coords[i][0] * mlat;
    const dx = x2 - x1, dy = y2 - y1;
    const n2 = dx * dx + dy * dy;
    const t = n2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / n2));
    const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  const a = coords[bi - 1], b = coords[bi];
  return {
    index: bi,
    lat: a[0] + (b[0] - a[0]) * bt,
    lon: a[1] + (b[1] - a[1]) * bt,
    abstand: Math.sqrt(best),                                  // Meter neben dem Weg
    entlang: kum[bi - 1] + (kum[bi] - kum[bi - 1]) * bt,        // Meter seit Start
  };
}

/** Bounding-Box einer Koordinatenliste: [südwest, nordost] */
export function bbox(coords) {
  let s = 90, w = 180, n = -90, o = -180;
  for (const [la, lo] of coords) {
    if (la < s) s = la; if (la > n) n = la;
    if (lo < w) w = lo; if (lo > o) o = lo;
  }
  return [[s, w], [n, o]];
}

/** Höhenmeter mit Median-Glättung und 5-m-Schwelle – gleiche Regel wie im Build-Skript. */
export function hoehenmeter(eles) {
  const e = eles.filter(x => x != null);
  if (e.length < 2) return { auf: 0, ab: 0 };
  const g = [];
  for (let i = 0; i < e.length; i++) {
    const w = e.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    g.push(w[w.length >> 1]);
  }
  let auf = 0, ab = 0, ref = g[0];
  for (const x of g.slice(1)) {
    const d = x - ref;
    if (d >= 5) { auf += d; ref = x; }
    else if (d <= -5) { ab -= d; ref = x; }
  }
  return { auf: Math.round(auf), ab: Math.round(ab) };
}

/**
 * Gehzeit nach DIN 33466: Steig- und Horizontalzeit, die größere voll,
 * die kleinere zur Hälfte. Ergebnis in Minuten.
 */
export function gehzeit(km, auf, ab) {
  const vertikal = auf / 300 + ab / 500;   // Stunden
  const horizontal = km / 4;               // Stunden
  const h = Math.max(vertikal, horizontal) + Math.min(vertikal, horizontal) / 2;
  return Math.round(h * 60);
}

// Formatierung ------------------------------------------------------------

export function fmtKm(km) {
  return (km < 10 ? km.toFixed(1) : Math.round(km).toString()).replace('.', ',');
}

export function fmtM(m) {
  return m < 1000 ? Math.round(m / 10) * 10 + ' m' : fmtKm(m / 1000) + ' km';
}

export function fmtDauer(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}:${String(m).padStart(2, '0')} h` : `${m} min`;
}

export function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
}

// DOM ---------------------------------------------------------------------

export const $ = (sel, wurzel = document) => wurzel.querySelector(sel);
export const $$ = (sel, wurzel = document) => [...wurzel.querySelectorAll(sel)];

/** Escaped Text für Einbau in HTML-Strings. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer;
export function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function sperre(text) {
  $('#sperre-text').textContent = text || '';
  $('#sperre').hidden = !text;
}

/** Erzeugt eine kleine SVG-Vorschau der Tourform für die Liste. */
export function miniVorschau(coords, farbe = 'currentColor') {
  if (!coords || coords.length < 2) return '';
  const [[s, w], [n, o]] = bbox(coords);
  const br = Math.max(o - w, 1e-6), ho = Math.max(n - s, 1e-6);
  // Seitenverhältnis der Längengrade auf dieser Breite ausgleichen
  const skalaX = Math.cos(grad((n + s) / 2));
  const spanne = Math.max(br * skalaX, ho);
  const schritt = Math.max(1, Math.floor(coords.length / 90));
  const pts = [];
  for (let i = 0; i < coords.length; i += schritt) {
    const [la, lo] = coords[i];
    const x = 50 + ((lo - (w + o) / 2) * skalaX / spanne) * 88;
    const y = 50 - ((la - (n + s) / 2) / spanne) * 88;
    pts.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${farbe}"
      stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>
  </svg>`;
}
