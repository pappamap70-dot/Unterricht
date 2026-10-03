// Wanderwege aus OpenStreetMap suchen und übernehmen.
//
// Datenquellen sind Overpass (Umkreis, Ausschnitt, Wegverläufe) und der
// Suchindex von Waymarked Trails (Namenssuche). Die Daten stehen unter ODbL – sie dürfen
// weiterverwendet werden, solange OpenStreetMap genannt wird. Overpass ist
// ein Spendenprojekt, deshalb sind die Abfragen eng begrenzt und werden
// einzeln ausgelöst, nie im Hintergrund.

import { dist, grad } from './util.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Netzwerkstufen von OSM, absteigend nach Bedeutung
const NETZ = {
  iwn: 'Internationaler Fernwanderweg',
  nwn: 'Nationaler Fernwanderweg',
  rwn: 'Regionaler Wanderweg',
  lwn: 'Örtlicher Wanderweg',
};

async function frage(abfrage, zeit = 60000) {
  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), zeit);
  try {
    const antwort = await fetch(OVERPASS, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(abfrage),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: abbruch.signal,
    });
    if (antwort.status === 429 || antwort.status === 504) {
      throw new Error('Der Kartendienst ist gerade überlastet. Das passiert bei '
        + 'langen Fernwanderwegen öfter – eine einzelne Etappe klappt meist, '
        + 'sonst in ein paar Minuten noch einmal versuchen.');
    }
    if (!antwort.ok) throw new Error('Abfrage fehlgeschlagen (HTTP ' + antwort.status + ')');
    return await antwort.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Die Abfrage hat zu lange gedauert.');
    throw e;
  } finally {
    clearTimeout(uhr);
  }
}

/**
 * Sucht Wanderrouten im Umkreis. `umkreisM` wird in ein Rechteck umgerechnet,
 * weil Overpass für Relationen kein echtes Radius-Filter kennt.
 */
export async function sucheRouten(lat, lon, umkreisM = 15000, grenze = 60) {
  const dLat = umkreisM / 111320;
  const dLon = umkreisM / (111320 * Math.cos(grad(lat)));
  const box = [lat - dLat, lon - dLon, lat + dLat, lon + dLon]
    .map(x => x.toFixed(5)).join(',');

  const daten = await frage(
    `[out:json][timeout:30];rel["route"="hiking"]["name"](${box});out tags center ${grenze};`);
  return zuRouten(daten.elements || [], lat, lon);
}

/** Sucht Routen in einem Kartenausschnitt. */
export async function sucheImAusschnitt(box, lat, lon, grenze = 60) {
  const b = [box[0], box[1], box[2], box[3]].map(x => x.toFixed(5)).join(',');
  const daten = await frage(
    `[out:json][timeout:30];rel["route"="hiking"]["name"](${b});out tags center ${grenze};`);
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

/** Sucht Routen nach Namen – deutschlandweit, über den Suchindex. */
export async function sucheNachNamen(text, grenze = 25) {
  const sauber = text.trim();
  if (sauber.length < 3) return [];
  const antwort = await fetch(
    `${WMT}/list/search?query=${encodeURIComponent(sauber)}&limit=${grenze}`);
  if (!antwort.ok) throw new Error('Die Suche ist gerade nicht erreichbar (HTTP ' + antwort.status + ')');
  const daten = await antwort.json();
  return (daten.results || []).map(r => ({
    id: r.id,
    titel: r.name,
    netz: WMT_GRUPPE[r.group] || 'Wanderweg',
    kmLautOsm: null,
    betreiber: '',
    zeichen: r.symbol_description || '',
    entfernung: null,
  }));
}

/**
 * Holt den Verlauf einer Route. Die Wege einer Relation kommen unsortiert und
 * teils verkehrt herum – sie werden hier zu einer durchgehenden Linie
 * verkettet. Bleiben Stücke übrig, werden sie als Varianten mitgegeben.
 */
export async function ladeRoute(id) {
  // Fernwanderwege sind oft mehrfach geschachtelt ("superroute"): Die Route
  // enthält Etappen, die Etappen wiederum Abschnitte. Drei Ebenen decken das
  // ab; direkt eingehängte Wege kommen über way(r.a) mit.
  const daten = await frage(
    `[out:json][timeout:120];rel(${id})->.a;.a out tags;`
    + `rel(r.a)->.b;rel(r.b)->.c;`
    + `(way(r.a);way(r.b);way(r.c););out geom;`, 150000);
  const elemente = daten.elements || [];
  const rel = elemente.find(e => e.type === 'relation');
  const wege = elemente
    .filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1)
    .map(e => e.geometry.map(p => [p.lat, p.lon]));

  if (!wege.length) {
    throw new Error('Für diese Route sind keine Wegstücke hinterlegt – sie ist in '
      + 'OpenStreetMap nur als Sammlung von Etappen erfasst. Bitte eine einzelne '
      + 'Etappe auswählen.');
  }

  const ketten = verkette(wege);
  ketten.sort((a, b) => laenge(b) - laenge(a));

  return {
    titel: (rel && rel.tags && rel.tags.name) || 'Wanderweg',
    tags: (rel && rel.tags) || {},
    haupt: ketten[0],
    varianten: ketten.slice(1).filter(k => laenge(k) > 500),
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
function verkette(wege, toleranz = 25) {
  const stuecke = wege.map(w => ({ w, benutzt: false }));
  const ketten = [];

  for (const start of stuecke) {
    if (start.benutzt) continue;
    start.benutzt = true;
    let kette = start.w.slice();

    for (const amEnde of [true, false]) {
      let weiter = true;
      while (weiter) {
        weiter = false;
        const p = amEnde ? kette[kette.length - 1] : kette[0];
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
        let stueck = umdrehen ? best.w.slice().reverse() : best.w.slice();
        if (gleich) stueck = stueck.slice(1);
        kette = amEnde ? kette.concat(stueck) : stueck.reverse().concat(kette);
        best.benutzt = true;
        weiter = true;
      }
    }
    ketten.push(kette);
  }
  return ketten;
}

/** Namensnennung, wie sie die ODbL verlangt. */
export const QUELLE = '© OpenStreetMap-Mitwirkende (ODbL)';
