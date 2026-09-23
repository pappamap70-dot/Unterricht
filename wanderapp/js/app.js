// Mystische Pfade – Wanderapp
// Router, Ansichten, GPS-Navigation, Import/Export, Offline-Karten

import {
  $, $$, esc, toast, sperre, dist, kumDistanz, aufTrack, bbox,
  fmtKm, fmtM, fmtDauer, fmtBytes, gehzeit, miniVorschau,
} from './util.js';
import { gpxLesen, gpxSchreiben, zipEntpacken, bauTour } from './gpx.js';
import {
  erstelleKarte, setzeLayer, setzeWanderwege, zeichneTour, passeAn,
  LAYER, kachelListe, ladeKacheln, kachelBestand, kachelnLoeschen, schaetzeGroesse,
} from './karte.js';
import { zeichneProfil } from './profil.js';
import {
  eigeneTouren, eigeneTour, tourSpeichern, tourLoeschen, neueId,
  einstellungen, setzeEinstellung,
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
  window.addEventListener('hashchange', route);
  route();

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

  if (ziel !== 'tour') beendeNavigation(false);

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

  if (S.filter.region === 'In meiner Nähe') {
    if (!S.standort) {
      toast('Warte auf GPS-Signal …');
    } else {
      const { latitude: la, longitude: lo } = S.standort.coords;
      touren = touren
        .map(t => ({ ...t, entfernung: dist(la, lo, t.start[0], t.start[1]) }))
        .filter(t => t.entfernung < 60000)
        .sort((a, b) => a.entfernung - b.entfernung);
    }
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
    if (s === 'km') touren.sort((a, b) => a.km - b.km);
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
  S.tour = tour;

  if (!S.karteT) {
    S.karteT = erstelleKarte($('#map-tour'), S.einst);
  }
  setTimeout(() => S.karteT.invalidateSize(), 60);

  if (S.tourGruppe) S.karteT.removeLayer(S.tourGruppe);
  S.tourGruppe = zeichneTour(S.karteT, tour, { kmMarken: S.einst.kmMarken });
  setzeSheet('normal');
  passeAn(S.karteT, tour, { untenFrei: sheetVerdeckt() });
  zeichneDetail(tour);
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
  $('#nav-banner').hidden = false;
  $('#fab-locate').setAttribute('aria-pressed', 'true');
  setzeSheet('klein');        // beim Wandern zählt die Karte, nicht die Tabelle
  haltWach(true);
  if (S.standort) aktualisiereNavigation(S.standort);
  else $('#nav-banner').innerHTML = '<div style="flex:1">Warte auf GPS-Signal …</div>';
}

function beendeNavigation(meldung) {
  if (!S.nav) return;
  S.nav = null;
  $('#nav-banner').hidden = true;
  $('#nav-banner').classList.remove('abseits');
  const b = $('#btn-nav');
  if (b) { b.textContent = 'Navigation starten'; b.classList.add('primary'); }
  $('#fab-locate').setAttribute('aria-pressed', 'false');
  if (!$('#view-tour').hidden) setzeSheet('normal');
  haltWach(false);
  if (meldung) toast('Navigation beendet.');
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
  if (S.folgen !== false) S.karteT.panTo([pos.coords.latitude, pos.coords.longitude], { animate: true, duration: .5 });
}

// --- Standort ------------------------------------------------------------

function starteStandort() {
  if (!navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition(
    pos => {
      S.standort = pos;
      zeichneStandort(S.karteU, pos);
      zeichneStandort(S.karteT, pos);
      aktualisiereNavigation(pos);
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

function zeigeStandort(karte) {
  if (!S.standort) { toast('Noch kein GPS-Signal.'); return; }
  karte.setView([S.standort.coords.latitude, S.standort.coords.longitude], Math.max(karte.getZoom(), 15));
}

async function haltWach(an) {
  if (!S.einst.wachhalten || !('wakeLock' in navigator)) return;
  try {
    if (an && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen');
    if (!an && S.wakeLock) { await S.wakeLock.release(); S.wakeLock = null; }
  } catch { /* Akkusparmodus o. ä. – nicht kritisch */ }
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

  $('#opt-wach').checked = S.einst.wachhalten;
  $('#opt-km').checked = S.einst.kmMarken;

  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  $('#app-info').innerHTML =
    `Version ${APP_VERSION}<br>`
    + `<span class="hint">${sw ? 'Offline einsatzbereit' : 'Offline-Modus wird eingerichtet …'} · `
    + `${S.index.touren.length} Buchtouren, ${S.eigene.length} eigene</span>`;
}

const APP_VERSION = '1.2.0';

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
    const folge = ['nr', 'km', 'km-ab', 'hm'];
    const namen = { nr: 'Buchreihenfolge', km: 'kürzeste zuerst', 'km-ab': 'längste zuerst', hm: 'meiste Höhenmeter' };
    const next = folge[(folge.indexOf(S.einst.sortierung) + 1) % folge.length];
    S.einst = await setzeEinstellung('sortierung', next);
    toast('Sortierung: ' + namen[next]);
    zeigeListe();
  };

  // Detail
  $('#btn-zurueck').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/touren');
  $('#fab-fit').onclick = () => {
    S.folgen = false;
    if (S.tour) passeAn(S.karteT, S.tour, { untenFrei: sheetVerdeckt() });
  };
  $('#fab-locate').onclick = () => { S.folgen = true; zeigeStandort(S.karteT); };
  $('#fab-locate-u').onclick = () => zeigeStandort(S.karteU);
  $('#fab-layers').onclick = () => layerWechsel(S.karteT);
  $('#fab-layers-u').onclick = () => layerWechsel(S.karteU);
  $('#map-tour').addEventListener('pointerdown', () => { S.folgen = false; });

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

  // Einstellungen
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
    if (document.visibilityState === 'visible' && S.nav) haltWach(true);
  });
}

async function layerWechsel(karte) {
  const folge = [...Object.keys(LAYER), 'wege'];
  const jetzt = S.einst.layer;
  const idx = folge.indexOf(jetzt);
  const next = folge[(idx + 1) % folge.length];

  if (next === 'wege') {
    S.einst = await setzeEinstellung('wanderwege', !S.einst.wanderwege);
    for (const k of [S.karteU, S.karteT]) if (k) setzeWanderwege(k, S.einst.wanderwege);
    toast('Wanderwege ' + (S.einst.wanderwege ? 'an' : 'aus'));
    return;
  }
  S.einst = await setzeEinstellung('layer', next);
  for (const k of [S.karteU, S.karteT]) if (k) setzeLayer(k, next);
  toast(LAYER[next].name);
}

// --- Service Worker ------------------------------------------------------

function registriereServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const neu = reg.installing;
      neu.addEventListener('statechange', () => {
        if (neu.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Neue Version verfügbar – App neu öffnen.', 5000);
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
