// Mystische Pfade – Wanderapp
// Router, Ansichten, GPS-Navigation, Import/Export, Offline-Karten

import {
  $, $$, esc, toast, sperre, dist, kumDistanz, aufTrack, bbox,
  fmtKm, fmtM, fmtDauer, fmtBytes, gehzeit, miniVorschau, hoehenmeter,
} from './util.js';
import { gpxLesen, gpxSchreiben, zipEntpacken, bauTour } from './gpx.js';
import { sucheRouten, sucheImAusschnitt, sucheNachNamen, ladeRoute, QUELLE } from './osm.js';
import {
  erstelleKarte, setzeLayer, setzeWanderwege, zeichneTour, passeAn,
  LAYER, kachelListe, ladeKacheln, kachelBestand, kachelnLoeschen, schaetzeGroesse,
  dreheKarte, peilung, erlaubeFingerDrehung, richteZiehenAus,
} from './karte.js';
import { zeichneProfil } from './profil.js';
import {
  eigeneTouren, eigeneTour, tourSpeichern, tourLoeschen, neueId,
  einstellungen, setzeEinstellung,
  aufnahmeLesen, aufnahmeSchreiben, aufnahmeLoeschen,
} from './store.js';

const S = {
  index: null,          // Metadaten aller Buchtouren
  eigene: [],           // importierte Touren
  geometrien: new Map(),// id -> volle Tour
  einst: null,
  karteU: null,         // Übersichtskarte
  karteT: null,         // Detailkarte
  tour: null,           // aktuell geöffnete Tour
  tourGruppe: null,
  nav: null,            // aktive Navigation
  standort: null,       // letzte bekannte Position
  watchId: null,
  wakeLock: null,
  filter: { region: null, suche: '' },
  installEreignis: null,
};

// --- Start ---------------------------------------------------------------

async function start() {
  S.einst = await einstellungen();

  const [index, eigene] = await Promise.all([
    ladeIndex(),
    eigeneTouren().catch(() => []),
  ]);
  S.index = index;
  S.eigene = eigene;

  baueFilterChips();
  verdrahteOberflaeche();
  setzeFolgen(S.einst.folgen);   // gespeicherte Wahl übernehmen
  window.addEventListener('hashchange', route);
  route();

  stelleNavigationWiederHer();
  stelleAufnahmeWiederHer();
  setInterval(() => { if (S.aufnahme && !S.aufnahme.pausiert) zeigeRecBanner(); }, 20000);
  registriereServiceWorker();
  sichereSpeicher();
  starteStandort();
  vorladeGeometrien();
}

/**
 * Lädt die Übersicht der Buchtouren. Fehlt der Ordner data/ – etwa weil die
 * App bewusst ohne die Buchdaten veröffentlicht wurde – startet sie leer;
 * die Touren kommen dann über den Import.
 */
async function ladeIndex() {
  try {
    const antwort = await fetch('data/index.json');
    if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
    return await antwort.json();
  } catch {
    return { titel: 'Mystische Pfade Schwarzwald', touren: [] };
  }
}

/**
 * Bittet den Browser, die Daten dauerhaft zu halten. Ohne das darf Android
 * Tourendaten und Offline-Kacheln bei Speicherdruck wegräumen – ausgerechnet
 * dann, wenn man ohne Empfang im Wald steht.
 * Auf dem Startbildschirm installierte Apps bekommen das meist ohne Nachfrage.
 */
async function sichereSpeicher() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    await navigator.storage.persist();
  } catch { /* nicht kritisch, die App läuft auch ohne */ }
}

/**
 * Lädt alle Tourverläufe im Hintergrund nach (zusammen < 300 KB).
 * Erst danach können Listenvorschau und Übersichtskarte sofort zeichnen.
 */
async function vorladeGeometrien() {
  for (const t of S.index.touren) {
    try { await ladeGeometrie(t.id); } catch { /* offline und noch nicht im Cache */ }
  }
  if (!$('#view-touren').hidden) zeigeListe();
}

// --- Routing -------------------------------------------------------------

const ANSICHTEN = ['touren', 'karte', 'eigene', 'mehr', 'tour'];

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'touren';
  const [name, arg] = hash.split('/');
  const ziel = ANSICHTEN.includes(name) ? name : 'touren';

  for (const a of ANSICHTEN) {
    const el = $('#view-' + a);
    if (el) el.hidden = (a !== ziel);
  }
  $$('#tabbar a').forEach(a => {
    const aktiv = a.dataset.tab === ziel || (ziel === 'tour' && a.dataset.tab === 'touren');
    a.toggleAttribute('aria-current', aktiv);
    if (aktiv) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  // Die Navigation läuft weiter, auch wenn man kurz in die Übersicht
  // schaut – beendet wird sie nur über den Knopf oder mit einer anderen Tour.

  if (ziel === 'touren') zeigeListe();
  if (ziel === 'karte') zeigeUebersicht();
  if (ziel === 'eigene') zeigeEigene();
  if (ziel === 'mehr') zeigeMehr();
  if (ziel === 'tour') zeigeTour(arg);
}

// --- Tourenliste ---------------------------------------------------------

function alleTouren() {
  const eigen = S.eigene.map(t => ({
    id: t.id, nr: null, titel: t.titel, km: t.km, auf: t.auf, ab: t.ab,
    emin: t.emin, emax: t.emax, rundweg: t.rundweg, region: 'Eigene',
    start: t.start, bbox: t.bbox, eigen: true,
  }));
  return [...S.index.touren, ...eigen];
}

function baueFilterChips() {
  const regionen = [...new Set(S.index.touren.map(t => t.region))];
  const box = $('#filter-region');
  box.innerHTML = ['Alle', ...regionen, 'In meiner Nähe']
    .map(r => `<button class="chip" data-region="${esc(r)}" aria-pressed="${r === 'Alle'}">${esc(r)}</button>`)
    .join('');
  box.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('.chip', box).forEach(c => c.setAttribute('aria-pressed', c === chip));
    S.filter.region = chip.dataset.region === 'Alle' ? null : chip.dataset.region;
    zeigeListe();
  });
}

function zeigeListe() {
  const suche = S.filter.suche.toLowerCase().trim();
  let touren = alleTouren();

  // Entfernung zum Start, sobald der Standort bekannt ist – sie wird für
  // den Filter, die Sortierung und die Anzeige im Eintrag gebraucht.
  if (S.standort) {
    const { latitude: la, longitude: lo } = S.standort.coords;
    touren = touren.map(t => ({ ...t, entfernung: dist(la, lo, t.start[0], t.start[1]) }));
  }

  if (S.filter.region === 'In meiner Nähe') {
    if (!S.standort) toast('Warte auf GPS-Signal …');
    else touren = touren.filter(t => t.entfernung < 60000)
                        .sort((a, b) => a.entfernung - b.entfernung);
  } else if (S.filter.region) {
    touren = touren.filter(t => t.region === S.filter.region);
  }

  if (suche) {
    touren = touren.filter(t =>
      t.titel.toLowerCase().includes(suche) ||
      String(t.nr ?? '').padStart(2, '0').includes(suche));
  }

  if (S.filter.region !== 'In meiner Nähe') {
    const s = S.einst.sortierung;
    if (s === 'naehe') {
      if (S.standort) touren.sort((a, b) => a.entfernung - b.entfernung);
      else toast('Ohne GPS-Signal keine Sortierung nach Entfernung');
    }
    else if (s === 'km') touren.sort((a, b) => a.km - b.km);
    else if (s === 'km-ab') touren.sort((a, b) => b.km - a.km);
    else if (s === 'hm') touren.sort((a, b) => b.auf - a.auf);
    // Buchtouren nach Nummer; importierte haben keine und werden nach Titel
    // sortiert – der beginnt bei den Buchdateien ebenfalls mit der Nummer.
    else touren.sort((a, b) => ((a.nr ?? 9999) - (b.nr ?? 9999))
      || a.titel.localeCompare(b.titel, 'de', { numeric: true }));
  }

  $('#tourliste').innerHTML = touren.map(eintrag).join('');
  const leer = $('#liste-leer');
  leer.hidden = touren.length > 0;
  leer.innerHTML = alleTouren().length === 0
    ? 'Noch keine Touren auf dem Gerät.<br><br>'
      + '<a class="btn primary" href="#/eigene">GPX- oder ZIP-Datei importieren</a>'
    : 'Keine Tour gefunden.';
}

function eintrag(t) {
  const dauer = fmtDauer(gehzeit(t.km, t.auf, t.ab));
  const nr = t.nr != null ? `<span class="nummer">${String(t.nr).padStart(2, '0')}</span>` : '';
  const naehe = t.entfernung != null ? `<span>${fmtM(t.entfernung)} entfernt</span>` : '';
  const geo = S.geometrien.get(t.id);
  return `
  <button class="karte-eintrag" data-id="${esc(t.id)}">
    <div class="vorschau" style="color:var(--gruen)">${geo ? miniVorschau(geo.c) : ''}</div>
    <div class="eintrag-text">
      <div class="eintrag-kopf">${nr}<span class="eintrag-titel">${esc(t.titel)}</span></div>
      <div class="meta">
        <span><b>${fmtKm(t.km)}</b> km</span>
        <span><b>${t.auf}</b> Hm</span>
        <span>${dauer}</span>
        ${naehe}
      </div>
      <span class="marke">${t.rundweg ? 'Rundweg' : 'Streckenweg'}${t.eigen ? ' · importiert' : ''}</span>
    </div>
  </button>`;
}

// --- Übersichtskarte -----------------------------------------------------

async function zeigeUebersicht() {
  if (!S.karteU) {
    S.karteU = erstelleKarte($('#map-uebersicht'), S.einst);
    S.karteU.setView([48.2, 8.2], 9);
    S.karteU.on('dragstart', wegGezogen);
    merkeZoomen(S.karteU);
    erlaubeFingerDrehung(S.karteU, w => dreheVonHand(S.karteU, w));
    richteZiehenAus(S.karteU);
  }
  setTimeout(() => S.karteU.invalidateSize(), 60);

  // Buchtouren und importierte gemeinsam; nach einem Import neu zeichnen
  const stand = alleTouren().map(t => t.id).join(',');
  if (S.karteU._stand === stand) return;
  S.karteU._stand = stand;

  sperre('Touren werden geladen …');
  const alle = [];
  for (const t of alleTouren()) {
    try { alle.push(await ladeGeometrie(t.id)); } catch { /* Datei fehlt */ }
  }
  sperre(null);

  if (S.karteU._gruppe) S.karteU.removeLayer(S.karteU._gruppe);
  if (!alle.length) { $('#karte-info').hidden = true; return; }

  const stil = getComputedStyle(document.body).getPropertyValue('--track').trim();
  const gruppe = L.layerGroup().addTo(S.karteU);
  S.karteU._gruppe = gruppe;
  for (const tour of alle) {
    const linie = L.polyline(tour.c, { color: stil, weight: 3.5, opacity: .85 }).addTo(gruppe);
    linie.on('click', () => zeigeKarteInfo(tour));
    L.circleMarker(tour.c[0], {
      radius: 5, color: '#fff', weight: 2, fillColor: stil, fillOpacity: 1,
    }).addTo(gruppe).on('click', () => zeigeKarteInfo(tour));
  }
  const alleCoords = alle.flatMap(t => [t.bbox.slice(0, 2), t.bbox.slice(2)]);
  S.karteU.fitBounds(bbox(alleCoords), { padding: [24, 24] });
  zeigeListe();   // Vorschaubilder nachtragen
}

function zeigeKarteInfo(tour) {
  const box = $('#karte-info');
  box.hidden = false;
  box.innerHTML = `
    <div class="eintrag-kopf">
      ${tour.nr != null ? `<span class="nummer">${String(tour.nr).padStart(2,'0')}</span>` : ''}
      <span class="eintrag-titel">${esc(tour.titel)}</span>
    </div>
    <div class="meta">
      <span><b>${fmtKm(tour.km)}</b> km</span>
      <span><b>${tour.auf}</b> Hm</span>
      <span>${fmtDauer(gehzeit(tour.km, tour.auf, tour.ab))}</span>
      <span style="margin-left:auto;color:var(--gruen);font-weight:600">Öffnen ›</span>
    </div>`;
  box.onclick = () => { location.hash = '#/tour/' + tour.id; };
}

// --- Tourdetail ----------------------------------------------------------

// Stufen des Detail-Sheets, von flach nach hoch
const STUFEN = ['klein', 'normal', 'gross'];

/** Stellt das Sheet auf eine Stufe und hält die Ansichtsklasse nach. */
function setzeSheet(stufe) {
  const sheet = $('#sheet'), view = $('#view-tour');
  sheet.classList.toggle('klein', stufe === 'klein');
  sheet.classList.toggle('gross', stufe === 'gross');
  for (const s of STUFEN) view.classList.toggle('sheet-' + s, s === stufe);
  S.sheetStufe = stufe;
}

/**
 * Schaltet das Mitwandern der Karte. Der Knopf zeigt den Zustand an, damit
 * man sieht, ob die Karte der eigenen Position folgt.
 */
/**
 * Schaltet das Mitwandern der Karte. `merken` schreibt die Wahl in die
 * Einstellungen – das unterbleibt beim Wegziehen der Karte und beim Start
 * einer Navigation, damit die bewusste Wahl des Nutzers erhalten bleibt.
 */
function setzeFolgen(an, merken = false) {
  S.folgen = an;
  if (!an) {
    S.blickRichtung = null;
    for (const k of [S.karteU, S.karteT]) if (k) dreheKarte(k, null);
  }
  for (const wahl of ['#fab-locate', '#fab-locate-u']) {
    const knopf = $(wahl);
    if (knopf) knopf.setAttribute('aria-pressed', String(an));
  }
  const schalter = $('#opt-folgen');
  if (schalter) schalter.checked = an;
  if (!$('#view-mehr').hidden) zeigeMehr();   // Statuszeile nachziehen
  if (merken) setzeEinstellung('folgen', an).then(e => { S.einst = e; });
}

/**
 * Wer die Karte wegzieht, will sie dort haben – also Nachführen aus.
 * Beim Zoomen gilt das nicht: Zwei Finger auf der Karte verschieben sie
 * leicht mit, das ist keine Absicht, die Karte zu verlassen.
 */
function wegGezogen(e) {
  if (!S.folgen) return;
  const karte = e && e.target;
  if (karte && (karte._zoomtGerade || karte._animatingZoom)) return;
  setzeFolgen(false);
  toast('Karte folgt nicht mehr – ◎ tippen');
}

/** Merkt sich, dass gerade gezoomt wird – siehe wegGezogen(). */
function merkeZoomen(karte) {
  karte.on('zoomstart', () => { karte._zoomtGerade = true; });
  karte.on('zoomend', () => {
    // kurz nachwirken lassen: dragend trifft manchmal erst danach ein
    setTimeout(() => { karte._zoomtGerade = false; }, 400);
  });
}

/**
 * Bestimmt die Bewegungsrichtung. Bevorzugt wird die Angabe des Geräts;
 * fehlt sie, wird aus der letzten Strecke gepeilt. Unter 1,5 m/s bleibt die
 * alte Richtung stehen – im Stand liefert GPS nur Rauschen, und eine Karte,
 * die sich beim Pausieren dreht, ist unbrauchbar.
 */
function richtung(pos) {
  const { latitude: la, longitude: lo, heading, speed } = pos.coords;
  // 0,5 m/s = 1,8 km/h trennt Stehen von Gehen. Wandern liegt bei 4-5 km/h,
  // also 1,1-1,4 m/s - eine höhere Schwelle hielte Wandern für Stillstand.
  const langsam = typeof speed === 'number' && isFinite(speed) && speed < 0.5;

  let neu = null;
  if (typeof heading === 'number' && isFinite(heading) && !langsam) {
    neu = heading;
  } else if (S.letzterOrt && !langsam) {
    const weg = dist(S.letzterOrt[0], S.letzterOrt[1], la, lo);
    // 8 m sind beim Wandern gut sechs Sekunden und liegen klar über dem
    // GPS-Rauschen von wenigen Metern.
    if (weg > 8) neu = peilung(S.letzterOrt[0], S.letzterOrt[1], la, lo);
  }

  // Den Bezugspunkt immer nachführen – auch wenn diesmal keine Richtung
  // herauskam. Sonst bliebe er für immer leer und es gäbe nie eine Peilung.
  if (!S.letzterOrt || dist(S.letzterOrt[0], S.letzterOrt[1], la, lo) > 8) {
    S.letzterOrt = [la, lo];
  }
  if (neu == null) return S.blickRichtung ?? null;

  // Sanft nachführen, sonst zuckt die Karte bei jedem Messfehler
  if (S.blickRichtung == null) {
    S.blickRichtung = neu;
  } else {
    let d = ((neu - S.blickRichtung + 540) % 360) - 180;   // kürzester Weg
    S.blickRichtung = (S.blickRichtung + d * 0.4 + 360) % 360;
  }
  return S.blickRichtung;
}

/**
 * Drehen mit zwei Fingern. Von Hand gedreht gilt vorrangig: Die automatische
 * Ausrichtung nach Fahrtrichtung setzt erst wieder ein, wenn man sie über den
 * Standortknopf neu einschaltet.
 */
function dreheVonHand(karte, winkel) {
  S.handDrehung = true;
  S.blickRichtung = winkel;
  dreheKarte(karte, winkel);
  if (!S.handHinweis) {
    S.handHinweis = true;
    toast('Karte von Hand gedreht – ◎ stellt sie wieder nach Fahrtrichtung');
  }
}

/** Peilung als Himmelsrichtung, für die Anzeige unter "Mehr". */
function himmelsrichtung(grad) {
  const namen = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return namen[Math.round(((grad % 360) + 360) % 360 / 45) % 8];
}

/** Die Karte der gerade sichtbaren Ansicht, sonst nichts. */
function sichtbareKarte() {
  if (!$('#view-tour').hidden) return S.karteT;
  if (!$('#view-karte').hidden) return S.karteU;
  return null;
}

/** Wie viele Pixel der Karte das Sheet gerade verdeckt. */
function sheetVerdeckt() {
  const karte = $('#map-tour').getBoundingClientRect();
  const sheet = $('#sheet').getBoundingClientRect();
  return Math.max(0, Math.round(karte.bottom - sheet.top));
}

async function ladeGeometrie(id) {
  if (S.geometrien.has(id)) return S.geometrien.get(id);
  let tour;
  if (id.startsWith('e')) {
    tour = await eigeneTour(id);
  } else {
    tour = await fetch(`data/tracks/${id}.json`).then(r => r.json());
  }
  if (!tour) throw new Error('Tour nicht gefunden: ' + id);
  S.geometrien.set(id, tour);
  return tour;
}

async function zeigeTour(id) {
  if (!id) { location.hash = '#/touren'; return; }
  let tour;
  try {
    tour = await ladeGeometrie(id);
  } catch {
    toast('Diese Tour gibt es nicht.');
    location.hash = '#/touren';
    return;
  }
  // Eine Navigation auf einer anderen Tour endet hier
  if (S.nav && S.nav.tour.id !== tour.id) beendeNavigation(false);
  S.tour = tour;

  if (!S.karteT) {
    S.karteT = erstelleKarte($('#map-tour'), S.einst);
    // Nur wer die Karte wegzieht, will sie nicht mehr nachgeführt haben.
    // Ein Antippen oder Zoomen lässt das Folgen bestehen.
    S.karteT.on('dragstart', wegGezogen);
    merkeZoomen(S.karteT);
    erlaubeFingerDrehung(S.karteT, w => dreheVonHand(S.karteT, w));
    richteZiehenAus(S.karteT);
  }
  setTimeout(() => S.karteT.invalidateSize(), 60);

  if (S.tourGruppe) S.karteT.removeLayer(S.tourGruppe);
  S.tourGruppe = zeichneTour(S.karteT, tour, { kmMarken: S.einst.kmMarken });
  const laeuft = !!S.nav;
  setzeSheet(laeuft ? 'klein' : 'normal');
  if (!laeuft) passeAn(S.karteT, tour, { untenFrei: sheetVerdeckt() });
  zeichneDetail(tour);

  // Kehrt man zu einer laufenden Navigation zurück, muss die Ansicht sie
  // wiedererkennen - zeichneDetail baut die Knöpfe neu auf.
  if (laeuft) {
    $('#btn-nav').textContent = 'Navigation beenden';
    $('#btn-nav').classList.remove('primary');
    setzeFolgen(true);
    zeigeNavPunkt(true);
    if (S.standort) aktualisiereNavigation(S.standort);
  } else if (S.navWiederaufnehmen === tour.id) {
    S.navWiederaufnehmen = null;
    starteNavigation(tour);
    toast('Navigation fortgesetzt.');
  }
}

function zeichneDetail(tour) {
  const min = gehzeit(tour.km, tour.auf, tour.ab);
  const start = tour.start || tour.c[0];
  $('#tour-detail').innerHTML = `
    <h3>${tour.nr != null ? String(tour.nr).padStart(2, '0') + ' · ' : ''}${esc(tour.titel)}</h3>
    <div class="unter">${esc(tour.region || 'Eigene Tour')} · ${tour.rundweg ? 'Rundweg' : 'Streckenweg'}</div>

    <div class="stat-reihe">
      <div class="stat"><div class="wert">${fmtKm(tour.km)}</div><div class="bez">Kilometer</div></div>
      <div class="stat"><div class="wert">${tour.auf}</div><div class="bez">Hm aufwärts</div></div>
      <div class="stat"><div class="wert">${tour.ab}</div><div class="bez">Hm abwärts</div></div>
      <div class="stat"><div class="wert">${fmtDauer(min)}</div><div class="bez">Gehzeit</div></div>
    </div>

    <canvas class="profil" id="profil"></canvas>
    <div class="profil-info" id="profil-info">
      <span>Höhe ${tour.emin}–${tour.emax} m</span>
      <span>Profil antippen</span>
    </div>

    <div class="btn-reihe">
      <button class="btn primary" id="btn-nav">Navigation starten</button>
      <button class="btn" id="btn-offline">Karte offline laden</button>
    </div>
    <div id="offline-status"></div>

    <div class="btn-reihe">
      <a class="btn" id="btn-anfahrt" href="geo:${start[0]},${start[1]}?q=${start[0]},${start[1]}(Start)">Anfahrt zum Start</a>
      <button class="btn" id="btn-export">Als GPX sichern</button>
    </div>
    ${tour.id && tour.id.startsWith('e')
      ? '<button class="btn warn block" id="btn-loeschen">Tour löschen</button>' : ''}

    <h2>Details</h2>
    <div class="status">
      Höchster Punkt ${tour.emax} m · tiefster ${tour.emin} m<br>
      Start bei ${start[0].toFixed(5)}, ${start[1].toFixed(5)}<br>
      ${tour.varianten && tour.varianten.length
        ? `${tour.varianten.length} zusätzliche Wegvariante(n) gestrichelt eingezeichnet`
        : 'Keine Varianten'}
    </div>
    <p class="hint">Gehzeit nach DIN 33466 (4 km/h, 300 Hm/h aufwärts, 500 Hm/h abwärts), ohne Pausen.</p>
  `;

  const canvas = $('#profil');
  const info = $('#profil-info');
  requestAnimationFrame(() => {
    const p = zeichneProfil(canvas, tour, {
      beiAuswahl: (idx, meter) => {
        if (idx == null) {
          entferneProfilMarke();
          if (S.profil) S.profil.markiere(null);     // Linie wieder weg
          info.children[1].textContent = 'Profil antippen';
          return;
        }
        setzeProfilMarke(tour.c[idx]);
        if (S.profil) S.profil.markiere(meter);      // senkrechte Linie mit Höhe
        info.children[1].textContent = `${fmtKm(meter / 1000)} km · ${tour.e[idx] ?? '–'} m`;
      },
    });
    S.profil = p;
  });

  $('#btn-nav').onclick = () => (S.nav ? beendeNavigation(true) : starteNavigation(tour));
  $('#btn-offline').onclick = () => offlineDialog(tour);
  $('#btn-export').onclick = () => exportiere(tour);
  const del = $('#btn-loeschen');
  if (del) del.onclick = () => loescheTour(tour);
}

let profilMarke = null;
function setzeProfilMarke(latlng) {
  if (!profilMarke) {
    profilMarke = L.circleMarker(latlng, {
      radius: 7, color: '#fff', weight: 3,
      fillColor: getComputedStyle(document.body).getPropertyValue('--akzent').trim(),
      fillOpacity: 1,
    }).addTo(S.karteT);
  } else {
    profilMarke.setLatLng(latlng);
  }
}
function entferneProfilMarke() {
  if (profilMarke) { S.karteT.removeLayer(profilMarke); profilMarke = null; }
}

// --- Navigation ----------------------------------------------------------

function starteNavigation(tour) {
  if (!navigator.geolocation) { toast('Dieses Gerät liefert keine Position.'); return; }
  const kum = kumDistanz(tour.c);
  // Aufstieg ab jedem Punkt bis zum Ende vorberechnen
  const restAuf = new Float64Array(tour.c.length);
  for (let i = tour.c.length - 2; i >= 0; i--) {
    const d = (tour.e[i + 1] ?? 0) - (tour.e[i] ?? 0);
    restAuf[i] = restAuf[i + 1] + (d > 0 ? d : 0);
  }
  S.nav = { tour, kum, restAuf, gesamt: kum[kum.length - 1], marke: null };
  $('#btn-nav').textContent = 'Navigation beenden';
  $('#btn-nav').classList.remove('primary');
  setzeFolgen(true);
  setzeSheet('klein');        // beim Wandern zählt die Karte, nicht die Tabelle
  merkeNavigation(tour.id);
  zeigeNavPunkt(true);
  haltWach(true);
  if (S.standort) aktualisiereNavigation(S.standort);
  else $('#nav-banner').innerHTML = '<div style="flex:1">Warte auf GPS-Signal …</div>';
}

function beendeNavigation(meldung) {
  if (!S.nav) return;
  S.nav = null;
  merkeNavigation(null);
  $('#nav-banner').classList.remove('abseits');
  const b = $('#btn-nav');
  if (b) { b.textContent = 'Navigation starten'; b.classList.add('primary'); }
  setzeFolgen(S.einst.folgen);   // zurück auf die eigene Wahl
  if (!$('#view-tour').hidden) setzeSheet('normal');
  zeigeNavPunkt(false);
  haltWach(false);
  if (meldung) toast('Navigation beendet.');
}

// Android darf die Seite bei ausgeschaltetem Bildschirm aus dem Speicher
// werfen. Damit eine laufende Navigation das übersteht, wird sie vermerkt.
const NAV_SCHLUESSEL = 'laufende-navigation';
const NAV_FRIST = 12 * 60 * 60 * 1000;   // nach 12 Stunden nicht mehr aufnehmen

function merkeNavigation(tourId) {
  try {
    if (tourId) localStorage.setItem(NAV_SCHLUESSEL, JSON.stringify({ id: tourId, zeit: Date.now() }));
    else localStorage.removeItem(NAV_SCHLUESSEL);
  } catch { /* privater Modus o. ä. */ }
}

/** Nimmt eine Navigation wieder auf, die vom Neuladen unterbrochen wurde. */
function stelleNavigationWiederHer() {
  let vermerk = null;
  try { vermerk = JSON.parse(localStorage.getItem(NAV_SCHLUESSEL) || 'null'); } catch { return; }
  if (!vermerk) return;
  if (Date.now() - vermerk.zeit > NAV_FRIST) { merkeNavigation(null); return; }

  S.navWiederaufnehmen = vermerk.id;
  const ziel = '#/tour/' + vermerk.id;
  if (location.hash === ziel) route(); else location.hash = ziel;
}

/**
 * Schaltet die Anzeigen für eine laufende Navigation: Punkt am Touren-
 * Reiter und der Balken über allen Ansichten. Der Balken nimmt Platz weg,
 * deshalb müssen die Karten ihre Grösse neu bestimmen.
 */
function zeigeNavPunkt(an) {
  const reiter = $('#tabbar a[data-tab="touren"]');
  reiter.classList.toggle('laeuft', an);
  reiter.setAttribute('aria-label', an ? 'Touren – Navigation läuft' : 'Touren');

  $('#nav-banner').hidden = !an;
  passeBalkenHoeheAn();
}

function aktualisiereNavigation(pos) {
  if (!S.nav) return;
  const { tour, kum, restAuf, gesamt } = S.nav;
  const p = aufTrack(tour.c, kum, pos.coords.latitude, pos.coords.longitude);
  const restKm = Math.max(0, gesamt - p.entlang) / 1000;
  const abseits = p.abstand > 60;

  const banner = $('#nav-banner');
  banner.classList.toggle('abseits', abseits);
  banner.innerHTML = `
    <div><span class="wert">${fmtKm(restKm)}</span><span class="bez">km übrig</span></div>
    <div><span class="wert">${Math.round(restAuf[Math.max(0, p.index - 1)])}</span><span class="bez">Hm übrig</span></div>
    <div><span class="wert">${fmtDauer(gehzeit(restKm, restAuf[Math.max(0, p.index - 1)], 0))}</span><span class="bez">Restzeit</span></div>
    <div><span class="wert">${abseits ? fmtM(p.abstand) : 'auf Weg'}</span><span class="bez">${abseits ? 'abseits' : 'Position'}</span></div>`;

  if (S.profil && S.profil.markiere) S.profil.markiere(p.entlang);
}

// --- Standort ------------------------------------------------------------

function starteStandort() {
  if (!navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition(
    pos => {
      S.standort = pos;
      zeichneStandort(S.karteU, pos);
      zeichneStandort(S.karteT, pos);
      // Karte mitziehen, solange das Folgen eingeschaltet ist – auf der
      // Übersicht genauso wie im Tourdetail
      const karte = sichtbareKarte();
      if (S.folgen && karte) {
        karte.panTo([pos.coords.latitude, pos.coords.longitude], { animate: true, duration: .35 });
      }
      // Karte in Fahrtrichtung drehen – nur solange sie auch mitwandert
      if (karte) {
        if (!S.handDrehung) {
          const winkel = (S.einst.drehen && S.folgen) ? richtung(pos) : null;
          dreheKarte(karte, winkel);
        }
      }
      aktualisiereNavigation(pos);
      recPunkt(pos);

      // Nach Entfernung sortierte oder gefilterte Liste nachziehen, sobald
      // sich die Position nennenswert geändert hat – nicht bei jedem Tick.
      const braucht = S.einst.sortierung === 'naehe' || S.filter.region === 'In meiner Nähe'
        || !S.listeHatteStandort;
      if (braucht && !$('#view-touren').hidden) {
        const weit = !S.listeStand || dist(S.listeStand[0], S.listeStand[1],
                                           pos.coords.latitude, pos.coords.longitude) > 200;
        if (weit) {
          S.listeStand = [pos.coords.latitude, pos.coords.longitude];
          S.listeHatteStandort = true;
          zeigeListe();
        }
      }
    },
    fehler => {
      if (fehler.code === 1) toast('Standortfreigabe verweigert – Navigation ist ohne sie nicht möglich.');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

const markenProKarte = new WeakMap();
function zeichneStandort(karte, pos) {
  if (!karte) return;
  const { latitude: la, longitude: lo, accuracy: g } = pos.coords;
  let m = markenProKarte.get(karte);
  if (!m) {
    m = {
      punkt: L.marker([la, lo], {
        icon: L.divIcon({ className: '', html: '<div class="ich"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false, keyboard: false, zIndexOffset: 1000,
      }).addTo(karte),
      kreis: L.circle([la, lo], { radius: g, color: '#2979ff', weight: 1, fillOpacity: .12, interactive: false }).addTo(karte),
    };
    markenProKarte.set(karte, m);
  } else {
    m.punkt.setLatLng([la, lo]);
    m.kreis.setLatLng([la, lo]).setRadius(g);
  }
}

/**
 * Erster Druck zentriert und schaltet das Mitwandern ein, der zweite
 * schaltet es wieder aus. So lässt sich die Karte in Ruhe betrachten.
 */
function standortKnopf(karte) {
  if (S.folgen) {
    setzeFolgen(false, true);
    toast('Karte folgt nicht mehr');
    return;
  }
  S.handDrehung = false;
  S.handHinweis = false;
  setzeFolgen(true, true);
  zeigeStandort(karte);
  toast('Karte folgt deinem Standort');
}

function zeigeStandort(karte) {
  if (!S.standort) { toast('Noch kein GPS-Signal.'); return; }
  karte.setView([S.standort.coords.latitude, S.standort.coords.longitude], Math.max(karte.getZoom(), 15));
}

async function haltWach(an) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (an && S.einst.wachhalten) {
      // Android gibt die Sperre selbst frei, sobald die Seite in den
      // Hintergrund geht. Der Verweis bleibt dann bestehen, zeigt aber auf
      // eine freigegebene Sperre – deshalb 'released' prüfen und nicht nur,
      // ob überhaupt etwas da ist.
      if (S.wakeLock && !S.wakeLock.released) return;
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wachGrund = 'gehalten';
      S.wakeLock.addEventListener('release', () => {
        S.wakeLock = null;
        S.wachGrund = 'vom System freigegeben';
      }, { once: true });
    } else if (S.wakeLock) {
      const sperre = S.wakeLock;
      S.wakeLock = null;
      if (!sperre.released) await sperre.release();
    }
  } catch (e) {
    // Häufigster Grund: Akkusparmodus. Dann bleibt der Bildschirm nicht an.
    S.wachGrund = 'abgelehnt (' + (e.name || 'Fehler') + ')';
  }
}

// --- Offline-Karten ------------------------------------------------------

async function offlineDialog(tour) {
  const box = $('#offline-status');
  const urls = kachelListe(tour.bbox, S.einst.layer, 12, 16, 800, S.einst.wanderwege);
  const mb = fmtBytes(schaetzeGroesse(urls.length));

  // Das Fenster erscheint unterhalb des Knopfes – ohne Hochfahren und
  // Hinscrollen sieht es so aus, als sei nichts passiert. scrollIntoView
  // greift hier nicht zuverlässig, also den Innenbereich direkt setzen.
  const sheet = $('#sheet');
  setzeSheet('gross');
  const zeigeFenster = () => {
    const innen = $('.sheet-inner');
    const ziel = innen.scrollTop
      + (box.getBoundingClientRect().top - innen.getBoundingClientRect().top) - 12;
    // ohne Animation: ein weicher Lauf wird vom hochfahrenden Sheet abgebrochen
    innen.scrollTop = Math.max(0, ziel);
  };
  // sobald das Sheet oben ist; die Frist greift, wenn es schon oben war
  sheet.addEventListener('transitionend', zeigeFenster, { once: true });
  setTimeout(zeigeFenster, 320);

  box.innerHTML = `
    <div class="status">
      <b>${urls.length} Kacheln</b> (Zoom 12–16, etwa ${mb})<br>
      <span class="hint">Die Kartenserver sind Spendenprojekte – bitte nur laden, was du wirklich brauchst.</span>
      <div class="balken"><i id="dl-balken"></i></div>
      <div id="dl-text" class="hint">Bereit.</div>
    </div>
    <div class="btn-reihe">
      <button class="btn primary" id="dl-start">Herunterladen</button>
      <button class="btn" id="dl-stop">Abbrechen</button>
    </div>`;

  const abbruch = { abgebrochen: false };
  $('#dl-stop').onclick = () => { abbruch.abgebrochen = true; box.innerHTML = ''; };
  $('#dl-start').onclick = async () => {
    $('#dl-start').disabled = true;
    const balken = $('#dl-balken'), text = $('#dl-text');
    const ergebnis = await ladeKacheln(urls, (fertig, gesamt, neu) => {
      balken.style.width = (fertig / gesamt * 100) + '%';
      text.textContent = `${fertig} von ${gesamt} · ${neu} neu geladen`;
    }, abbruch);
    if (abbruch.abgebrochen) return;
    text.textContent = `Fertig – ${ergebnis.neu} Kacheln gespeichert`
      + (ergebnis.fehler ? `, ${ergebnis.fehler} nicht verfügbar` : '') + '.';
    toast('Diese Tour ist jetzt offline verfügbar.');
  };
}

// --- Eigene Touren -------------------------------------------------------

function zeigeEigene() {
  $('#eigene-liste').innerHTML = S.eigene
    .map(t => eintrag({ ...t, eigen: true }))
    .join('');
  $('#eigene-leer').hidden = S.eigene.length > 0;
}

async function importiere(dateien) {
  const status = $('#import-status');
  status.hidden = false;
  status.textContent = 'Wird gelesen …';
  let neu = 0;
  const fehler = [];

  for (const datei of dateien) {
    try {
      if (/\.zip$/i.test(datei.name)) {
        const eintraege = await zipEntpacken(await datei.arrayBuffer());
        if (!eintraege.length) { fehler.push(`${datei.name}: keine GPX-Dateien enthalten`); continue; }
        for (const e of eintraege) {
          status.textContent = `Lese ${e.name} …`;
          neu += await speichereAusGpx(e.inhalt, e.name, fehler);
        }
      } else {
        status.textContent = `Lese ${datei.name} …`;
        neu += await speichereAusGpx(await datei.text(), datei.name, fehler);
      }
    } catch (e) {
      fehler.push(`${datei.name}: ${e.message}`);
    }
  }

  S.eigene = await eigeneTouren();
  zeigeEigene();
  status.innerHTML = `<b>${neu} Tour(en) importiert.</b>`
    + (fehler.length ? `<br><span class="hint">${fehler.map(esc).join('<br>')}</span>` : '');
  if (neu) toast(`${neu} Tour(en) hinzugefügt.`);
}

async function speichereAusGpx(inhalt, name, fehler) {
  let touren;
  try {
    touren = gpxLesen(inhalt, name);
  } catch (e) {
    fehler.push(`${name}: ${e.message}`);
    return 0;
  }
  if (!touren.length) { fehler.push(`${name}: keine Trackpunkte gefunden`); return 0; }
  for (const t of touren) {
    t.id = neueId();
    t.quelle = name;
    t.angelegt = Date.now();
    await tourSpeichern(t);
  }
  return touren.length;
}

function exportiere(tour) {
  const blob = new Blob([gpxSchreiben(tour)], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (tour.nr != null ? String(tour.nr).padStart(2, '0') + ' ' : '') + tour.titel + '.gpx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function loescheTour(tour) {
  await tourLoeschen(tour.id);
  S.geometrien.delete(tour.id);
  S.eigene = await eigeneTouren();
  toast('Tour gelöscht.');
  location.hash = '#/eigene';
}

// --- Aufzeichnung --------------------------------------------------------

const REC_GENAU = 50;    // Punkte mit schlechterer Ortung werden verworfen
const REC_MIND = 5;      // Mindestabstand in Metern – darunter ist es Rauschen

/** Startet eine neue Aufzeichnung oder nimmt eine unterbrochene wieder auf. */
async function starteAufnahme(wieder = null) {
  S.aufnahme = wieder || {
    punkte: [],          // [lat, lon, höhe|null, zeit]
    start: Date.now(),
    pausiert: false,
    pausiertSeit: null,
    pausenDauer: 0,
  };
  zeigeRecBanner();
  haltWach(true);
  if (!wieder) {
    await sichereAufnahme();
    toast(S.einst.wachhalten
      ? 'Aufzeichnung läuft – Bildschirm bleibt an'
      : 'Aufzeichnung läuft – bei gesperrtem Bildschirm pausiert sie', 5000);
  }
}

function pausiereAufnahme() {
  const a = S.aufnahme;
  if (!a) return;
  if (a.pausiert) {
    a.pausenDauer += Date.now() - a.pausiertSeit;
    a.pausiertSeit = null;
    a.pausiert = false;
    toast('Aufzeichnung fortgesetzt');
  } else {
    a.pausiert = true;
    a.pausiertSeit = Date.now();
    toast('Aufzeichnung pausiert');
  }
  zeigeRecBanner();
  sichereAufnahme();
}

/** Beendet die Aufzeichnung und legt sie als eigene Tour ab. */
async function beendeAufnahme() {
  const a = S.aufnahme;
  if (!a) return;
  const strecke = recStrecke(a.punkte);

  if (a.punkte.length < 2 || strecke < 50) {
    if (!confirm('Die Aufzeichnung ist zu kurz zum Speichern. Verwerfen?')) return;
    await verwirfAufnahme();
    return;
  }

  const minuten = Math.round(recDauer(a) / 60000);
  const name = prompt('Name der Aufzeichnung:',
    'Wanderung ' + new Date(a.start).toLocaleDateString('de-DE'));
  if (name === null) return;                 // abgebrochen, weiter aufzeichnen

  const coords = a.punkte.map(p => [p[0], p[1]]);
  const hoehen = a.punkte.map(p => p[2]);
  const tour = bauTour(name.trim() || 'Wanderung', coords, hoehen, []);
  tour.id = neueId();
  tour.quelle = 'Eigene Aufzeichnung';
  tour.angelegt = Date.now();
  tour.gelaufenAm = a.start;
  tour.gelaufenMin = minuten;
  tour.region = 'Aufgezeichnet';
  await tourSpeichern(tour);

  S.aufnahme = null;
  await aufnahmeLoeschen();
  zeigeRecBanner();
  haltWach(!!S.nav);
  S.eigene = await eigeneTouren();
  zeigeEigene();
  toast(`„${tour.titel}" gespeichert – ${fmtKm(tour.km)} km in ${fmtDauer(minuten)}`);
  location.hash = '#/tour/' + tour.id;
}

async function verwirfAufnahme() {
  S.aufnahme = null;
  await aufnahmeLoeschen();
  zeigeRecBanner();
  haltWach(!!S.nav);
  toast('Aufzeichnung verworfen');
}

/**
 * Meldet eine Lücke, wenn die Seite im Hintergrund eingefroren war. Chrome
 * hält unsichtbare Seiten an, dann liefert die Ortung nichts – zwischen dem
 * letzten und dem nächsten Punkt liegt dann eine Luftlinie statt des
 * wirklichen Weges. Das soll man wissen, statt es im Track zu übersehen.
 */
function pruefeAufnahmeLuecke() {
  const a = S.aufnahme;
  if (!a || a.pausiert || !a.punkte.length) return;
  const letzter = a.punkte[a.punkte.length - 1];
  const still = Date.now() - letzter[3];
  if (still < 120000) return;                    // unter zwei Minuten: unauffällig
  if (a.gemeldeteLuecke === letzter[3]) return;  // schon gemeldet
  a.gemeldeteLuecke = letzter[3];
  toast(`Aufzeichnung stand ${fmtDauer(Math.round(still / 60000))} still – `
    + 'bei gesperrtem Bildschirm hält Android sie an.', 6000);
}

/** Nimmt einen Standort in die Aufzeichnung auf, wenn er brauchbar ist. */
function recPunkt(pos) {
  const a = S.aufnahme;
  if (!a || a.pausiert) return;
  const { latitude: la, longitude: lo, altitude, accuracy } = pos.coords;
  if (typeof accuracy === 'number' && accuracy > REC_GENAU) return;

  const letzter = a.punkte[a.punkte.length - 1];
  if (letzter && dist(letzter[0], letzter[1], la, lo) < REC_MIND) return;

  a.punkte.push([
    +la.toFixed(6), +lo.toFixed(6),
    (typeof altitude === 'number' && isFinite(altitude)) ? Math.round(altitude) : null,
    pos.timestamp || Date.now(),
  ]);
  zeichneAufnahmeLinie();
  zeigeRecBanner();

  // Sichern alle zehn Punkte, spätestens aber nach 30 Sekunden: Bei
  // langsamem Gehen lägen zwischen zehn Punkten sonst Minuten, die ein
  // Absturz mitnähme.
  const jetzt = Date.now();
  if (a.punkte.length % 10 === 0 || jetzt - (S.recGesichert || 0) > 30000) {
    S.recGesichert = jetzt;
    sichereAufnahme();
  }
}

const recStrecke = punkte => {
  let s = 0;
  for (let i = 1; i < punkte.length; i++) {
    s += dist(punkte[i-1][0], punkte[i-1][1], punkte[i][0], punkte[i][1]);
  }
  return s;
};

const recDauer = a => (a.pausiert ? a.pausiertSeit : Date.now()) - a.start - a.pausenDauer;

function sichereAufnahme() {
  return S.aufnahme ? aufnahmeSchreiben(S.aufnahme).catch(() => {}) : Promise.resolve();
}

/** Zeichnet den bisher gelaufenen Weg auf der sichtbaren Karte mit. */
function zeichneAufnahmeLinie() {
  const karte = sichtbareKarte();
  const a = S.aufnahme;
  if (!karte || !a || a.punkte.length < 2) return;
  const linie = a.punkte.map(p => [p[0], p[1]]);
  if (S.recLinie && S.recLinie._karte === karte) {
    S.recLinie.setLatLngs(linie);
  } else {
    if (S.recLinie) S.recLinie.remove();
    S.recLinie = L.polyline(linie, { color: '#d13b2f', weight: 4, opacity: .9, dashArray: '1 7', lineCap: 'round' })
      .addTo(karte);
    S.recLinie._karte = karte;
  }
}

function zeigeRecBanner() {
  const a = S.aufnahme;
  const banner = $('#rec-banner');
  banner.hidden = !a;
  for (const wahl of ['#fab-rec', '#fab-rec-u']) {
    const k = $(wahl);
    if (k) k.setAttribute('aria-pressed', String(!!a));
  }
  if (a) {
    const km = recStrecke(a.punkte) / 1000;
    const hm = hoehenmeter(a.punkte.map(p => p[2]));
    banner.classList.toggle('pause', a.pausiert);
    banner.innerHTML = `
      <span class="rec-punkt"></span>
      <div><span class="wert">${fmtKm(km)}</span><span class="bez">km</span></div>
      <div><span class="wert">${fmtDauer(Math.round(recDauer(a) / 60000))}</span><span class="bez">${a.pausiert ? 'pausiert' : 'unterwegs'}</span></div>
      <div><span class="wert">${hm.auf}</span><span class="bez">Hm</span></div>`;
  } else if (S.recLinie) {
    S.recLinie.remove();
    S.recLinie = null;
  }
  passeBalkenHoeheAn();
}

/** Die Ansicht muss so viel Platz lassen, wie die Balken zusammen brauchen. */
function passeBalkenHoeheAn() {
  const hoehe = $('#balken-leiste').offsetHeight;
  document.body.classList.toggle('navigiert', hoehe > 0);
  document.documentElement.style.setProperty('--nav-h', hoehe + 'px');
  setTimeout(() => {
    for (const k of [S.karteU, S.karteT]) if (k) k.invalidateSize();
  }, 60);
}

/** Fragt beim Start, ob eine unterbrochene Aufzeichnung weitergehen soll. */
async function stelleAufnahmeWiederHer() {
  let a = null;
  try { a = await aufnahmeLesen(); } catch { return; }
  if (!a || !a.punkte || !a.punkte.length) return;
  const km = fmtKm(recStrecke(a.punkte) / 1000);
  const wann = new Date(a.start).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  if (confirm(`Unterbrochene Aufzeichnung gefunden (${km} km, begonnen ${wann}).

Fortsetzen?`)) {
    await starteAufnahme(a);
  } else {
    await aufnahmeLoeschen();
  }
}

// --- Wanderwege aus OpenStreetMap ---------------------------------------

function osmStatus(text, art = '') {
  const el = $('#osm-status');
  el.hidden = !text;
  el.innerHTML = text;
  el.style.color = art === 'warn' ? 'var(--akzent)' : '';
}

async function osmSuche(aufgabe, womit) {
  // Sichtbare Rückmeldung: Das Statusfeld steht weit unten, ein Toast wird
  // überall gesehen.
  toast('Suche läuft …', 4000);
  osmStatus('Suche läuft …');
  $('#osm-liste').innerHTML = '';
  zeigeOsmBereich();
  try {
    const treffer = await aufgabe(text => osmStatus(esc(text)));
    S.osmTreffer = treffer;
    if (!treffer.length) {
      osmStatus(`Keine Wanderwege ${womit} gefunden.`);
      return;
    }
    const wort = treffer.length === 1 ? 'Wanderweg' : 'Wanderwege';
    const bezug = treffer.some(t => t.entfernung != null)
      ? (S.osmBezugStandort
          ? '<br>Entfernungen von deinem Standort zur Mitte des Weges.'
          : '<br>Ohne GPS gemessen ab Kartenmitte.')
      : '';
    osmStatus(`<b>${treffer.length} ${wort}</b> gefunden · ${QUELLE}${bezug}`);
    $('#osm-liste').innerHTML = treffer.map(osmEintrag).join('');
    toast(`${treffer.length} ${wort} gefunden`);
    zeigeOsmBereich();
  } catch (e) {
    osmStatus(esc(e.message), 'warn');
  }
}

/** Rollt den Suchbereich ins Bild – er steht am Ende einer langen Liste. */
function zeigeOsmBereich() {
  const ziel = $('#osm-status');
  setTimeout(() => ziel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}

function osmEintrag(r) {
  const km = r.kmLautOsm ? `<span><b>${fmtKm(r.kmLautOsm)}</b> km lang</span>` : '';
  // Die Entfernung zielt auf die Mitte des Weges: Den Startpunkt kennt man
  // erst, wenn der Verlauf geladen ist – das wäre eine Abfrage je Treffer.
  const weit = r.entfernung != null
    ? `<span>${fmtM(r.entfernung)} ${S.osmBezugStandort ? 'zur Wegmitte' : 'von der Kartenmitte'}</span>`
    : '';
  return `
  <button class="karte-eintrag" data-osm="${r.id}">
    <div class="osm-zeichen">🥾</div>
    <div class="eintrag-text">
      <div class="eintrag-kopf"><span class="eintrag-titel">${esc(r.titel)}</span></div>
      <div class="meta">${km}${weit}</div>
      <span class="marke">${esc(r.netz)}${r.betreiber ? ' · ' + esc(r.betreiber) : ''}</span>
    </div>
  </button>`;
}

/** Lädt eine OSM-Route und legt sie als eigene Tour ab. */
async function osmUebernehmen(id) {
  const gefunden = (S.osmTreffer || []).find(r => String(r.id) === String(id));
  sperre('Wegverlauf wird geladen …');
  try {
    const roh = await ladeRoute(id, text => sperre(text));
    const tour = bauTour(roh.titel, roh.haupt,
      roh.hoehen || roh.haupt.map(() => null),
      roh.varianten.map(v => ({ km: 0, c: v })));
    tour.id = neueId();
    tour.quelle = 'OpenStreetMap, Relation ' + id;
    tour.lizenz = QUELLE;
    tour.angelegt = Date.now();
    if (gefunden) tour.region = gefunden.netz;
    await tourSpeichern(tour);
    S.eigene = await eigeneTouren();
    zeigeEigene();

    const teile = roh.varianten.length;
    sperre(null);
    toast(teile
      ? `„${tour.titel}" übernommen – ${teile} Abzweigung(en) gestrichelt.`
      : `„${tour.titel}" übernommen.`);
    location.hash = '#/tour/' + tour.id;
  } catch (e) {
    sperre(null);
    osmStatus(esc(e.message), 'warn');
  }
}

// --- Einstellungen -------------------------------------------------------

async function zeigeMehr() {
  const b = await kachelBestand();
  const dauerhaft = navigator.storage && navigator.storage.persisted
    ? await navigator.storage.persisted().catch(() => false) : false;
  $('#speicher-info').innerHTML =
    `<b>${b.anzahl}</b> Kartenkacheln gespeichert<br>`
    + `<span class="hint">App-Daten insgesamt: ${fmtBytes(b.bytes)} · `
    + (dauerhaft
      ? 'dauerhaft gesichert'
      : 'nicht dauerhaft – Android darf sie bei Speichermangel löschen. '
        + 'Hilft meist: App auf den Startbildschirm legen.')
    + '</span>';

  $('#opt-folgen').checked = S.folgen;
  $('#opt-drehen').checked = S.einst.drehen;
  $('#opt-wach').checked = S.einst.wachhalten;
  $('#opt-km').checked = S.einst.kmMarken;

  const alter = S.standort ? Math.round((Date.now() - S.standort.timestamp) / 1000) : null;
  const gps = S.standort
    ? `letzte Ortung vor ${alter} s, auf ${Math.round(S.standort.coords.accuracy)} m genau`
    : 'noch keine Ortung empfangen';
  const tempo = S.standort && typeof S.standort.coords.speed === 'number'
    && isFinite(S.standort.coords.speed)
    ? (S.standort.coords.speed * 3.6).toFixed(1).replace('.', ',') + ' km/h'
    : 'kein Tempo gemeldet';
  const blick = S.blickRichtung != null
    ? Math.round(S.blickRichtung) + '° (' + himmelsrichtung(S.blickRichtung) + ')'
    : 'noch keine';
  const wach = !('wakeLock' in navigator)
    ? 'vom Browser nicht unterstützt'
    : (S.wakeLock && !S.wakeLock.released)
      ? 'Bildschirm wird wachgehalten'
      : (S.wachGrund || 'nicht angefordert');
  const aufn = S.aufnahme
    ? `${S.aufnahme.punkte.length} Punkte, zuletzt vor `
      + `${S.aufnahme.punkte.length ? Math.round((Date.now() - S.aufnahme.punkte.at(-1)[3]) / 1000) : '–'} s`
    : 'keine';

  $('#gps-info').innerHTML =
    `${gps}<br><span class="hint">Karte folgt: <b>${S.folgen ? 'ja' : 'nein'}</b>`
    + ` · Navigation: <b>${S.nav ? 'läuft' : 'aus'}</b><br>`
    + `Tempo: ${tempo} · Richtung: <b>${blick}</b><br>`
    + `Aufzeichnung: ${aufn}<br>`
    + `Bildschirmsperre: <b>${wach}</b></span>`;

  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  $('#app-info').innerHTML =
    `Version ${APP_VERSION}<br>`
    + `<span class="hint">${sw ? 'Offline einsatzbereit' : 'Offline-Modus wird eingerichtet …'} · `
    + `${S.index.touren.length} Buchtouren, ${S.eigene.length} eigene</span>`;
}

const APP_VERSION = '1.12.3';

// --- Oberfläche verdrahten ----------------------------------------------

function verdrahteOberflaeche() {
  // Liste
  $('#tourliste').addEventListener('click', e => {
    const k = e.target.closest('.karte-eintrag');
    if (k) location.hash = '#/tour/' + k.dataset.id;
  });
  $('#eigene-liste').addEventListener('click', e => {
    const k = e.target.closest('.karte-eintrag');
    if (k) location.hash = '#/tour/' + k.dataset.id;
  });
  $('#suche').addEventListener('input', e => { S.filter.suche = e.target.value; zeigeListe(); });

  $('#btn-sort').onclick = async () => {
    const folge = ['nr', 'naehe', 'km', 'km-ab', 'hm'];
    const namen = { nr: 'Buchreihenfolge', naehe: 'nächste zuerst', km: 'kürzeste zuerst',
                    'km-ab': 'längste zuerst', hm: 'meiste Höhenmeter' };
    const next = folge[(folge.indexOf(S.einst.sortierung) + 1) % folge.length];
    S.einst = await setzeEinstellung('sortierung', next);
    toast('Sortierung: ' + namen[next]);
    zeigeListe();
  };

  // Detail
  $('#btn-zurueck').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/touren');
  $('#fab-fit').onclick = () => {
    setzeFolgen(false);
    if (S.tour) passeAn(S.karteT, S.tour, { untenFrei: sheetVerdeckt() });
  };
  $('#fab-locate').onclick = () => standortKnopf(S.karteT);
  $('#fab-locate-u').onclick = () => standortKnopf(S.karteU);
  $('#fab-layers').onclick = oeffneLayerMenue;
  $('#fab-layers-u').onclick = oeffneLayerMenue;
  $('#layer-grund').onclick = schliesseLayerMenue;
  $('#layer-menue').addEventListener('click', e => {
    const zeile = e.target.closest('.menue-zeile');
    if (!zeile) return;
    if (zeile.dataset.layer) waehleLayer(zeile.dataset.layer);
    else schalteWanderwege();
  });

  // Sheet ziehen: klein – normal – gross
  const grip = $('#grip');
  let startY = null;
  grip.addEventListener('pointerdown', e => {
    startY = e.clientY;
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointerup', e => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    const i = STUFEN.indexOf(S.sheetStufe);
    if (dy < -25) setzeSheet(STUFEN[Math.min(STUFEN.length - 1, i + 1)]);
    else if (dy > 25) setzeSheet(STUFEN[Math.max(0, i - 1)]);
    else setzeSheet(S.sheetStufe === 'gross' ? 'normal' : 'gross');   // Tippen
    startY = null;
  });

  // Import
  $('#datei-input').addEventListener('change', e => {
    if (e.target.files.length) importiere([...e.target.files]);
    e.target.value = '';
  });

  // Aufzeichnung: tippen startet, erneut tippen beendet; langes Drücken pausiert
  for (const wahl of ['#fab-rec', '#fab-rec-u']) {
    const knopf = $(wahl);
    if (!knopf) continue;
    let lange = null, warLang = false;
    knopf.addEventListener('pointerdown', () => {
      warLang = false;
      lange = setTimeout(() => { warLang = true; if (S.aufnahme) pausiereAufnahme(); }, 600);
    });
    const beenden = () => { clearTimeout(lange); lange = null; };
    knopf.addEventListener('pointerup', () => {
      beenden();
      if (warLang) return;
      if (S.aufnahme) beendeAufnahme(); else starteAufnahme();
    });
    knopf.addEventListener('pointercancel', beenden);
    knopf.addEventListener('pointerleave', beenden);
  }
  $('#rec-banner').onclick = () => {
    if (S.aufnahme) pausiereAufnahme();
  };

  // Wanderwege aus OpenStreetMap
  $('#btn-osm-nah').onclick = () => {
    if (!S.standort) { osmStatus('Noch kein GPS-Signal – bitte kurz warten.', 'warn'); return; }
    const { latitude: la, longitude: lo } = S.standort.coords;
    S.osmBezugStandort = true;
    osmSuche(m => sucheRouten(la, lo, 15000, 60, m), 'in der Nähe');
  };
  $('#btn-osm-karte').onclick = () => {
    const karte = S.karteU || S.karteT;
    if (!karte) { osmStatus('Bitte zuerst die Karte öffnen.', 'warn'); return; }
    const b = karte.getBounds();
    // Entfernungen immer vom eigenen Standort aus – die Kartenmitte wäre ein
    // anderer Bezugspunkt als bei "In der Nähe" und damit irreführend.
    const bezug = S.standort
      ? [S.standort.coords.latitude, S.standort.coords.longitude]
      : [karte.getCenter().lat, karte.getCenter().lng];
    S.osmBezugStandort = !!S.standort;
    osmSuche(m => sucheImAusschnitt(
      [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], bezug[0], bezug[1], 60, m),
      'im Kartenausschnitt');
  };
  $('#osm-suche').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const text = e.target.value.trim();
    if (text.length < 3) { osmStatus('Bitte mindestens drei Buchstaben.', 'warn'); return; }
    osmSuche(() => sucheNachNamen(text), `für „${esc(text)}"`);
  });
  $('#osm-liste').addEventListener('click', e => {
    const k = e.target.closest('[data-osm]');
    if (k) osmUebernehmen(k.dataset.osm);
  });

  // Einstellungen
  $('#opt-folgen').onchange = e => setzeFolgen(e.target.checked, true);
  $('#opt-drehen').onchange = async e => {
    S.einst = await setzeEinstellung('drehen', e.target.checked);
    if (!e.target.checked) {
      S.blickRichtung = null;
      for (const k of [S.karteU, S.karteT]) if (k) dreheKarte(k, null);
    }
    toast(e.target.checked
      ? 'Karte dreht sich in Fahrtrichtung, sobald du dich bewegst'
      : 'Karte bleibt nach Norden ausgerichtet');
  };
  $('#opt-wach').onchange = async e => { S.einst = await setzeEinstellung('wachhalten', e.target.checked); };
  $('#opt-km').onchange = async e => {
    S.einst = await setzeEinstellung('kmMarken', e.target.checked);
    if (S.tour) zeigeTour(S.tour.id);
  };
  $('#btn-cache-leeren').onclick = async () => {
    await kachelnLoeschen();
    toast('Offline-Karten gelöscht.');
    zeigeMehr();
  };

  $('#nav-banner').onclick = () => {
    if (S.nav) location.hash = '#/tour/' + S.nav.tour.id;
  };

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    S.installEreignis = e;
    $('#btn-install').hidden = false;
  });
  $('#btn-install').onclick = async () => {
    if (!S.installEreignis) return;
    S.installEreignis.prompt();
    await S.installEreignis.userChoice;
    S.installEreignis = null;
    $('#btn-install').hidden = true;
  };

  // Bildschirmsperre kann den WakeLock verlieren
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Android gibt die Bildschirmsperre beim Wegschalten frei – sie muss für
    // Navigation UND Aufzeichnung neu angefordert werden.
    if (S.nav || S.aufnahme) haltWach(true);
    if (S.aufnahme) pruefeAufnahmeLuecke();
  });
}

/**
 * Kartenauswahl als Menü. Ein blindes Durchschalten liess nicht erkennen,
 * welche Karte gerade aktiv ist und wie man zurückkommt.
 */
function oeffneLayerMenue() {
  zeichneLayerMenue();
  $('#layer-menue').hidden = false;
  $('#layer-grund').hidden = false;
}

function schliesseLayerMenue() {
  $('#layer-menue').hidden = true;
  $('#layer-grund').hidden = true;
}

function zeichneLayerMenue() {
  for (const z of $$('#layer-menue .menue-zeile')) {
    const aktiv = z.dataset.layer
      ? z.dataset.layer === S.einst.layer
      : S.einst.wanderwege;
    z.setAttribute('aria-checked', String(aktiv));
  }
}

async function waehleLayer(schluessel) {
  S.einst = await setzeEinstellung('layer', schluessel);
  for (const k of [S.karteU, S.karteT]) if (k) setzeLayer(k, schluessel);
  zeichneLayerMenue();
}

async function schalteWanderwege() {
  S.einst = await setzeEinstellung('wanderwege', !S.einst.wanderwege);
  for (const k of [S.karteU, S.karteT]) if (k) setzeWanderwege(k, S.einst.wanderwege);
  zeichneLayerMenue();
}

// --- Service Worker ------------------------------------------------------

function registriereServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const neu = reg.installing;
      neu.addEventListener('statechange', () => {
        if (neu.state !== 'installed' || !navigator.serviceWorker.controller) return;
        // Ohne Neuladen läuft der alte Programmcode weiter, auch wenn der
        // neue längst im Speicher liegt. Während einer Navigation wäre ein
        // Neustart aber störend – dann nur Bescheid sagen.
        if (S.nav) {
          toast('Neue Version verfügbar – nach der Tour neu öffnen.', 6000);
        } else {
          toast('Neue Version wird geladen …');
          setTimeout(() => location.reload(), 1500);
        }
      });
    });
  }).catch(() => { /* z. B. über file:// geöffnet */ });
}

start().catch(e => {
  console.error(e);
  document.body.innerHTML =
    `<p style="padding:24px">Die App konnte nicht starten: ${esc(e.message)}</p>`;
});
