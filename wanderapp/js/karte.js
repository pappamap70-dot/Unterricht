// Kartenebenen, Tourdarstellung und Offline-Kacheln

import { bbox, grad, dist } from './util.js';

export const KACHEL_CACHE = 'mp-kacheln-v1';

// Bewusst ohne {s}-Platzhalter: so sind Anzeige und Offline-Download
// byte-gleiche URLs und der Service Worker findet die Kachel wieder.
export const LAYER = {
  topo: {
    name: 'OpenTopoMap',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    attribution: '© <a href="https://openstreetmap.org/copyright">OSM</a>-Mitwirkende, '
      + 'SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  },
  luft: {
    name: 'Luftbild',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18,
    attribution: '© Esri, Maxar, Earthstar Geographics',
  },
};

export const WANDERWEGE = {
  name: 'Wanderwege',
  url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
  maxZoom: 18,
  attribution: '© <a href="https://waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)',
};

/** Leaflet-Karte mit gewählter Grundebene und optionalem Wanderwege-Overlay. */
export function erstelleKarte(el, { layer = 'topo', wanderwege = true } = {}) {
  const karte = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    tap: false,
    maxZoom: 18,
    // Sanfter auf dem Handy
    inertia: true,
    zoomSnap: 0.5,
  });
  karte.attributionControl.setPrefix('');
  karte._ebenen = {};
  setzeLayer(karte, layer);
  setzeWanderwege(karte, wanderwege);
  return karte;
}

export function setzeLayer(karte, schluessel) {
  const def = LAYER[schluessel] || LAYER.topo;
  if (karte._ebenen.grund) karte.removeLayer(karte._ebenen.grund);
  karte._ebenen.grund = L.tileLayer(def.url, {
    maxZoom: 18,
    maxNativeZoom: def.maxZoom,
    attribution: def.attribution,
    crossOrigin: 'anonymous',
    keepBuffer: 3,
  }).addTo(karte);
  karte._ebenen.grund.bringToBack();
  karte._layerSchluessel = schluessel;
}

export function setzeWanderwege(karte, an) {
  if (karte._ebenen.wege) { karte.removeLayer(karte._ebenen.wege); karte._ebenen.wege = null; }
  if (an) {
    karte._ebenen.wege = L.tileLayer(WANDERWEGE.url, {
      // erst ab Zoom 12: in der Übersicht würden die Wegemarkierungen
      // die eigentlichen Touren zudecken
      minZoom: 12, maxZoom: 18, maxNativeZoom: WANDERWEGE.maxZoom, opacity: 0.75,
      attribution: WANDERWEGE.attribution, crossOrigin: 'anonymous',
    }).addTo(karte);
  }
}

/** Zeichnet Track, Varianten, Start-/Zielmarke und optional Kilometermarken. */
export function zeichneTour(karte, tour, { kmMarken = true, farbe = null } = {}) {
  const gruppe = L.layerGroup().addTo(karte);
  const stil = farbe || getComputedStyle(document.body).getPropertyValue('--track').trim() || '#d1471f';
  const rand = getComputedStyle(document.body).getPropertyValue('--track-rand').trim() || '#fff';

  for (const v of tour.varianten || []) {
    L.polyline(v.c, { color: stil, weight: 3, opacity: .55, dashArray: '6 7' }).addTo(gruppe);
  }
  // Doppelte Linie: heller Rand darunter für Kontrast auf jeder Karte
  L.polyline(tour.c, { color: rand, weight: 8, opacity: .9, lineJoin: 'round' }).addTo(gruppe);
  const linie = L.polyline(tour.c, { color: stil, weight: 4.5, opacity: 1, lineJoin: 'round' }).addTo(gruppe);

  L.marker(tour.c[0], { icon: pin('🚩'), keyboard: false })
    .bindTooltip('Start', { direction: 'top' }).addTo(gruppe);
  if (!tour.rundweg) {
    L.marker(tour.c.at(-1), { icon: pin('🏁'), keyboard: false })
      .bindTooltip('Ziel', { direction: 'top' }).addTo(gruppe);
  }

  if (kmMarken) marken(gruppe, tour);
  gruppe._linie = linie;
  return gruppe;
}

function pin(zeichen) {
  return L.divIcon({ className: '', html: `<div class="start-pin">${zeichen}</div>`,
                     iconSize: [22, 22], iconAnchor: [11, 20] });
}

function marken(gruppe, tour) {
  let gelaufen = 0, naechste = 1;
  for (let i = 1; i < tour.c.length; i++) {
    gelaufen += dist(tour.c[i-1][0], tour.c[i-1][1], tour.c[i][0], tour.c[i][1]);
    while (gelaufen / 1000 >= naechste) {
      L.marker(tour.c[i], {
        icon: L.divIcon({ className: '', html: `<div class="kmmarke">${naechste}</div>`,
                          iconSize: [20, 15], iconAnchor: [10, 7] }),
        keyboard: false, interactive: false,
      }).addTo(gruppe);
      naechste++;
    }
  }
}

/**
 * Passt den Ausschnitt an die Tour an. `untenFrei` ist die Höhe, die unten
 * vom Sheet verdeckt wird – sonst liegt die halbe Tour darunter.
 */
export function passeAn(karte, tour, { polster = 30, untenFrei = 0 } = {}) {
  const [sw, no] = bbox(tour.c);
  karte.fitBounds([sw, no], {
    paddingTopLeft: [polster, polster + 60],          // Platz für Zurück und Banner
    paddingBottomRight: [polster, polster + untenFrei],
  });
}

// --- Offline-Kacheln -----------------------------------------------------

const x2 = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const y2 = (lat, z) => {
  const r = grad(lat);
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};

/** Liste der Kachel-URLs für eine Bounding-Box samt Puffer. */
export function kachelListe(box, layerSchluessel, zMin, zMax, pufferM = 800, mitWegen = true) {
  const [s, w, n, o] = box;
  const dLat = pufferM / 111320;
  const dLon = pufferM / (111320 * Math.cos(grad((s + n) / 2)));
  const s2 = s - dLat, n2 = n + dLat, w2 = w - dLon, o2 = o + dLon;
  const def = LAYER[layerSchluessel] || LAYER.topo;
  const urls = [];
  for (let z = zMin; z <= zMax; z++) {
    if (z > def.maxZoom) continue;
    const xa = x2(w2, z), xb = x2(o2, z);
    const ya = y2(n2, z), yb = y2(s2, z);
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y <= yb; y++) {
        urls.push(def.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        if (mitWegen && z <= WANDERWEGE.maxZoom) {
          urls.push(WANDERWEGE.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        }
      }
    }
  }
  return urls;
}

/**
 * Lädt Kacheln in den Cache. Bewusst gedrosselt – die Kartenserver sind
 * Spendenprojekte, kein CDN.
 */
export async function ladeKacheln(urls, fortschritt, abbruch) {
  const cache = await caches.open(KACHEL_CACHE);
  let fertig = 0, neu = 0, fehler = 0;
  const gleichzeitig = 4;

  async function arbeiter(liste) {
    for (const url of liste) {
      if (abbruch && abbruch.abgebrochen) return;
      try {
        if (await cache.match(url)) { fertig++; fortschritt(fertig, urls.length, neu); continue; }
        const antwort = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (antwort.ok) { await cache.put(url, antwort.clone()); neu++; }
        else fehler++;
      } catch { fehler++; }
      fertig++;
      fortschritt(fertig, urls.length, neu);
    }
  }

  const teile = Array.from({ length: gleichzeitig }, (_, i) =>
    urls.filter((_, j) => j % gleichzeitig === i));
  await Promise.all(teile.map(arbeiter));
  return { neu, fehler, gesamt: urls.length };
}

export async function kachelBestand() {
  if (!('caches' in window)) return { anzahl: 0, bytes: 0 };
  const cache = await caches.open(KACHEL_CACHE);
  const schluessel = await cache.keys();
  let bytes = 0;
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    bytes = e.usage || 0;
  }
  return { anzahl: schluessel.length, bytes };
}

export async function kachelnLoeschen() {
  await caches.delete(KACHEL_CACHE);
}

/** Grobe Größenschätzung: Topo-Kacheln liegen bei ~25 KB, Overlays bei ~8 KB. */
export function schaetzeGroesse(anzahl) {
  return anzahl * 22 * 1024;
}
