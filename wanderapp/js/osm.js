// Wanderwege aus OpenStreetMap suchen und übernehmen.
//
// Datenquelle ist Waymarked Trails: Namenssuche und Wegverläufe (letztere
// samt Höhenwerten). Overpass liefert die Umkreis- und Ausschnittssuche und
// springt beim Wegverlauf ein, wenn der erste Weg nichts hergibt.
// Beide liefern OSM-Daten unter der ODbL: Weiterverwendung ist erlaubt,
// solange OpenStreetMap genannt wird.
//
// Beides sind Spendenprojekte. Abfragen laufen nur auf Knopfdruck, nie im
// Hintergrund, und sind in Umfang und Anzahl begrenzt.

import { dist, grad } from './util.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Netzwerkstufen von OSM, absteigend nach Bedeutung
const NETZ = {
  iwn: 'Internationaler Fernwanderweg',
  nwn: 'Nationaler Fernwanderweg',
  rwn: 'Regionaler Wanderweg',
  lwn: 'Örtlicher Wanderweg',
};

/**
 * Stellt eine Overpass-Abfrage, mit Wiederholung.
 *
 * Der Dienst weist Anfragen bei Last mit 504 ab – gemessen etwa jede zweite,
 * wobei der nächste Versuch meist durchgeht. Deshalb wird bis zu dreimal
 * angefragt, mit wachsender Pause. `melde` zeigt den Stand an, damit die
 * Wartezeit nicht wie ein Hänger wirkt.
 */
async function frage(abfrage, zeit = 60000, melde = null, versuche = 3) {

  for (let n = 1; n <= versuche; n++) {
    if (n > 1) {
      const pause = n * 2500;
      if (melde) melde(`Dienst ausgelastet – neuer Versuch in ${Math.round(pause / 1000)} s …`);
      await new Promise(r => setTimeout(r, pause));
      if (melde) melde(`Versuch ${n} von ${versuche} …`);
    }

    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), zeit);
    try {
      const antwort = await fetch(OVERPASS, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(abfrage),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: abbruch.signal,
      });
      if (antwort.status === 429 || antwort.status === 504) continue;   // erneut
      if (!antwort.ok) throw new Error('Abfrage fehlgeschlagen (HTTP ' + antwort.status + ')');
      return await antwort.json();
    } catch (e) {
      if (e.name === 'AbortError') continue;      // zu langsam, erneut
      throw e;
    } finally {
      clearTimeout(uhr);
    }
  }

  throw new Error('Der Kartendienst war bei ' + versuche + ' Versuchen belegt. '
    + 'Er ist ein Spendenprojekt und zeitweise stark ausgelastet – in ein paar '
    + 'Minuten klappt es meist. Die Suche nach Namen nutzt einen anderen Dienst '
    + 'und funktioniert auch dann.');
}

/**
 * Sucht Wanderrouten im Umkreis. `umkreisM` wird in ein Rechteck umgerechnet,
 * weil Overpass für Relationen kein echtes Radius-Filter kennt.
 */
export async function sucheRouten(lat, lon, umkreisM = 15000, grenze = 60, melde = null) {
  const dLat = umkreisM / 111320;
  const dLon = umkreisM / (111320 * Math.cos(grad(lat)));
  const box = [lat - dLat, lon - dLon, lat + dLat, lon + dLon]
    .map(x => x.toFixed(5)).join(',');

  const daten = await frage(
    `[out:json][timeout:30];rel["route"="hiking"]["name"](${box});out tags center ${grenze};`,
    60000, melde);
  return zuRouten(daten.elements || [], lat, lon);
}

/** Sucht Routen in einem Kartenausschnitt. */
export async function sucheImAusschnitt(box, lat, lon, grenze = 60, melde = null) {
  const b = [box[0], box[1], box[2], box[3]].map(x => x.toFixed(5)).join(',');
  const daten = await frage(
    `[out:json][timeout:30];rel["route"="hiking"]["name"](${b});out tags center ${grenze};`,
    60000, melde);
  return zuRouten(daten.elements || [], lat, lon);
}

function zuRouten(elemente, lat, lon) {
  return elemente
    .map(e => {
      const t = e.tags || {};
      const mitte = e.center || {};
      const km = parseFloat(String(t.distance || '').replace(',', '.'));
      return {
        id: e.id,
        titel: t.name,
        netz: NETZ[t.network] || 'Wanderweg',
        netzStufe: ['iwn', 'nwn', 'rwn', 'lwn'].indexOf(t.network),
        kmLautOsm: isFinite(km) ? km : null,
        betreiber: t.operator || '',
        lat: mitte.lat, lon: mitte.lon,
        bbox: Array.isArray(e.bounds)
          ? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon]
          : (e.bounds ? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null),
        entfernung: (mitte.lat != null && lat != null) ? dist(lat, lon, mitte.lat, mitte.lon) : null,
      };
    })
    .filter(r => r.titel)
    .sort((a, b) => (a.entfernung ?? 1e9) - (b.entfernung ?? 1e9));
}

// Für die Namenssuche hat Waymarked Trails einen eigenen Index – Overpass
// lehnt Mustersuchen über grosse Gebiete regelmässig ab. Beide Dienste
// liefern dieselben OSM-Routen unter derselben Lizenz.
const WMT = 'https://hiking.waymarkedtrails.org/api/v1';

const WMT_GRUPPE = {
  INT: 'Internationaler Fernwanderweg',
  NAT: 'Nationaler Fernwanderweg',
  REG: 'Regionaler Wanderweg',
  LOC: 'Örtlicher Wanderweg',
};

/**
 * Sucht Routen nach Namen – deutschlandweit, über den Suchindex.
 *
 * Der Index liefert nur Name und Art. Länge und Lage stehen in den
 * Einzelheiten, die deshalb nachgeladen werden – gedrosselt, weil es je
 * Treffer eine Abfrage ist.
 */
export async function sucheNachNamen(text, grenze = 20, lat = null, lon = null, melde = null) {
  const sauber = text.trim();
  if (sauber.length < 3) return [];
  const antwort = await fetch(
    `${WMT}/list/search?query=${encodeURIComponent(sauber)}&limit=${grenze}`);
  if (!antwort.ok) throw new Error('Die Suche ist gerade nicht erreichbar (HTTP ' + antwort.status + ')');
  const daten = await antwort.json();

  const treffer = (daten.results || []).map(r => ({
    id: r.id,
    titel: r.name,
    netz: WMT_GRUPPE[r.group] || 'Wanderweg',
    kmLautOsm: null,
    betreiber: '',
    zeichen: r.symbol_description || '',
    entfernung: null,
  }));

  if (treffer.length) {
    if (melde) melde(`${treffer.length} gefunden – Einzelheiten werden geholt …`);
    await ergaenzeEinzelheiten(treffer, lat, lon);
  }
  return treffer.sort((a, b) => (a.entfernung ?? 1e9) - (b.entfernung ?? 1e9));
}

/** Holt Länge, Betreiber und Lage nach – höchstens vier Abfragen gleichzeitig. */
async function ergaenzeEinzelheiten(treffer, lat, lon) {
  const reihe = treffer.slice();
  const arbeiter = async () => {
    while (reihe.length) {
      const r = reihe.shift();
      try {
        const a = await fetch(`${WMT}/details/relation/${r.id}`);
        if (!a.ok) continue;
        const d = await a.json();
        const t = d.tags || {};
        const km = parseFloat(String(t.distance || '').replace(',', '.'));
        if (isFinite(km)) r.kmLautOsm = km;
        if (d.operator) r.betreiber = d.operator;
        if (Array.isArray(d.bbox) && d.bbox.length === 4) {
          // bbox ist Web-Mercator: Mittelpunkt umrechnen – er dient als Lage
          // auf der Karte und als Bezug für die Entfernung
          const [la, lo] = ausMercator((d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2);
          r.lat = la; r.lon = lo;
          const [s1, w1] = ausMercator(d.bbox[0], d.bbox[1]);
          const [n1, o1] = ausMercator(d.bbox[2], d.bbox[3]);
          r.bbox = [s1, w1, n1, o1];
          if (lat != null) r.entfernung = dist(lat, lon, la, lo);
        }
      } catch { /* einzelner Treffer ohne Einzelheiten ist kein Beinbruch */ }
    }
  };
  await Promise.all([arbeiter(), arbeiter(), arbeiter(), arbeiter()]);
}

/** Web-Mercator (wie ihn Waymarked Trails liefert) nach WGS84. */
function ausMercator(x, y) {
  const lon = x * 180 / 20037508.34;
  const lat = Math.atan(Math.exp(y * Math.PI / 20037508.34)) * 360 / Math.PI - 90;
  return [lat, lon];
}

/**
 * Holt den Verlauf über Waymarked Trails. Dieser Weg ist der verlässlichere
 * und liefert als einziger auch Höhenwerte – damit funktioniert das
 * Höhenprofil übernommener Routen.
 */
async function ladeUeberWmt(id, melde) {
  if (melde) melde('Wegverlauf wird geladen …');
  const antwort = await fetch(`${WMT}/details/relation/${id}/way-elevation`);
  if (!antwort.ok) throw new Error('WMT ' + antwort.status);
  const daten = await antwort.json();
  const segmente = daten.segments || {};

  const wege = [], hoehen = [];
  for (const schluessel of Object.keys(segmente)) {
    const punkte = segmente[schluessel].elevation || [];
    if (punkte.length < 2) continue;
    const sortiert = punkte.slice().sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    wege.push(sortiert.map(p => ausMercator(p.x, p.y)));
    hoehen.push(sortiert.map(p => (typeof p.ele === 'number' ? p.ele : null)));
  }
  if (!wege.length) throw new Error('keine Segmente');
  return { wege, hoehen };
}

/**
 * Holt den Verlauf einer Route. Die Wegstücke kommen unsortiert und teils
 * verkehrt herum – sie werden zu einer durchgehenden Linie verkettet.
 * Reststücke (echte Abzweigungen) kommen als Varianten zurück.
 */
export async function ladeRoute(id, melde = null) {
  let wege = null, hoehen = null, titel = null, tags = {};

  // Erst der verlässliche Weg mit Höhenwerten …
  try {
    const w = await ladeUeberWmt(id, melde);
    wege = w.wege; hoehen = w.hoehen;
  } catch {
    // … sonst Overpass. Fernwanderwege sind oft mehrfach geschachtelt
    // ("superroute"): Die Route enthält Etappen, die Etappen Abschnitte.
    if (melde) melde('Wegverlauf über zweite Quelle …');
    const daten = await frage(
      `[out:json][timeout:120];rel(${id})->.a;.a out tags;`
      + `rel(r.a)->.b;rel(r.b)->.c;`
      + `(way(r.a);way(r.b);way(r.c););out geom;`, 150000, melde);
    const elemente = daten.elements || [];
    const rel = elemente.find(e => e.type === 'relation');
    if (rel && rel.tags) { titel = rel.tags.name; tags = rel.tags; }
    wege = elemente
      .filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1)
      .map(e => e.geometry.map(p => [p.lat, p.lon]));
    hoehen = wege.map(w => w.map(() => null));
  }

  if (!wege || !wege.length) {
    throw new Error('Für diese Route sind keine Wegstücke hinterlegt – sie ist in '
      + 'OpenStreetMap nur als Sammlung von Etappen erfasst. Bitte eine einzelne '
      + 'Etappe auswählen.');
  }

  // Name nachtragen, wenn er nicht aus Overpass kam
  if (!titel) {
    try {
      const a = await fetch(`${WMT}/details/relation/${id}`);
      if (a.ok) { const d = await a.json(); titel = d.name; tags = d.tags || {}; }
    } catch { /* Name ist nicht entscheidend */ }
  }

  const ketten = verkette(wege, 25, hoehen);
  ketten.sort((a, b) => laenge(b.punkte) - laenge(a.punkte));

  return {
    titel: titel || 'Wanderweg',
    tags,
    haupt: ketten[0].punkte,
    hoehen: ketten[0].hoehen,
    varianten: ketten.slice(1).filter(k => laenge(k.punkte) > 500).map(k => k.punkte),
  };
}

function laenge(punkte) {
  let s = 0;
  for (let i = 1; i < punkte.length; i++) {
    s += dist(punkte[i-1][0], punkte[i-1][1], punkte[i][0], punkte[i][1]);
  }
  return s;
}

/**
 * Verkettet Wegstücke zu möglichst langen Linien. Ein Stück schliesst an,
 * wenn eines seiner Enden nahe genug am Kettenende liegt; es darf dabei
 * umgedreht werden. Die Toleranz fängt ab, dass benachbarte Wege in OSM
 * nicht immer exakt denselben Punkt teilen.
 *
 * Eine Wanderroute mit Abzweigungen lässt sich nicht zu einer einzigen Linie
 * machen – übrige Stücke kommen als eigene Ketten zurück.
 */
function verkette(wege, toleranz = 25, hoehen = null) {
  const stuecke = wege.map((w, i) => ({
    w,
    h: hoehen ? hoehen[i] : w.map(() => null),
    benutzt: false,
  }));
  const ketten = [];

  for (const start of stuecke) {
    if (start.benutzt) continue;
    start.benutzt = true;
    let punkte = start.w.slice();
    let hoehe = start.h.slice();

    for (const amEnde of [true, false]) {
      let weiter = true;
      while (weiter) {
        weiter = false;
        const p = amEnde ? punkte[punkte.length - 1] : punkte[0];
        let best = null, bestAbstand = toleranz, umdrehen = false;

        for (const k of stuecke) {
          if (k.benutzt) continue;
          const dAnfang = dist(p[0], p[1], k.w[0][0], k.w[0][1]);
          const dEnde = dist(p[0], p[1], k.w[k.w.length-1][0], k.w[k.w.length-1][1]);
          if (dAnfang < bestAbstand) { bestAbstand = dAnfang; best = k; umdrehen = false; }
          if (dEnde < bestAbstand) { bestAbstand = dEnde; best = k; umdrehen = true; }
        }
        if (!best) continue;

        // Den Anschlusspunkt nur weglassen, wenn er wirklich derselbe ist.
        // Sonst entstünde an der Naht eine Lücke von bis zu `toleranz`.
        const gleich = bestAbstand < 1;
        let sp = umdrehen ? best.w.slice().reverse() : best.w.slice();
        let sh = umdrehen ? best.h.slice().reverse() : best.h.slice();
        if (gleich) { sp = sp.slice(1); sh = sh.slice(1); }

        if (amEnde) {
          punkte = punkte.concat(sp);
          hoehe = hoehe.concat(sh);
        } else {
          punkte = sp.slice().reverse().concat(punkte);
          hoehe = sh.slice().reverse().concat(hoehe);
        }
        best.benutzt = true;
        weiter = true;
      }
    }
    ketten.push({ punkte, hoehen: hoehe });
  }
  return ketten;
}

/** Namensnennung, wie sie die ODbL verlangt. */
export const QUELLE = '© OpenStreetMap-Mitwirkende (ODbL)';
