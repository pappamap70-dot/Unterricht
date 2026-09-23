// GPX lesen und schreiben, ZIP-Archive ohne Fremdbibliothek entpacken

import { dist, hoehenmeter, bbox } from './util.js';

// --- GPX lesen -----------------------------------------------------------

const tags = (el, name) => [...el.getElementsByTagNameNS('*', name)];
const text = (el, name) => {
  const t = tags(el, name)[0];
  return t ? t.textContent.trim() : '';
};

/**
 * Liest eine GPX-Datei. Liefert ein Array von Touren – eine je <trk> bzw. <rte>.
 * Mehrere <trkseg> einer Spur werden zusammengefasst; das längste Segment
 * wird zur Hauptroute, kürzere Reststücke landen als Varianten.
 */
export function gpxLesen(inhalt, dateiname = '') {
  const doc = new DOMParser().parseFromString(inhalt, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Die Datei ist kein gültiges GPX.');
  }
  const metaName = (() => {
    const m = tags(doc, 'metadata')[0];
    return m ? text(m, 'name') : '';
  })();

  // Alle Segmente der Datei einsammeln – über <trk>- und <trkseg>-Grenzen
  // hinweg. Die Buchdateien verteilen Abstecher mal auf mehrere Segmente,
  // mal auf mehrere Spuren; für die Tour selbst ist das derselbe Fall.
  const segmente = [];
  for (const spur of [...tags(doc, 'trk'), ...tags(doc, 'rte')]) {
    const spurName = text(spur, 'name');
    const segTags = tags(spur, 'trkseg');
    const quellen = segTags.length ? segTags : [spur];   // <rte> hat keine Segmente

    for (const seg of quellen) {
      const punkte = [...seg.getElementsByTagNameNS('*', 'trkpt'),
                      ...seg.getElementsByTagNameNS('*', 'rtept')];
      const coords = [], eles = [];
      for (const p of punkte) {
        const la = parseFloat(p.getAttribute('lat')), lo = parseFloat(p.getAttribute('lon'));
        if (!isFinite(la) || !isFinite(lo)) continue;
        coords.push([la, lo]);
        const e = text(p, 'ele');
        eles.push(e === '' ? null : parseFloat(e));
      }
      if (coords.length > 1) segmente.push({ coords, eles, spurName, m: laenge(coords) });
    }
  }

  const touren = [];
  if (segmente.length) {
    segmente.sort((a, b) => b.m - a.m);
    const haupt = segmente[0];
    const andere = segmente.slice(1);

    // Was im selben Gebiet liegt, gehört zur Tour – Abstecher, Alternativweg
    // oder eine zweite Aufzeichnung derselben Runde. Was woanders liegt, ist
    // eine eigene Tour. Die Länge sagt darüber nichts: In den Buchdateien ist
    // ein 8-km-Stück eine Teilkopie der 13-km-Runde.
    const varianten = andere.filter(s => s.m > 300 && imSelbenGebiet(haupt, s));
    const eigenstaendig = andere.filter(s => !imSelbenGebiet(haupt, s));

    // Enthält die Datei nur eine Tour, ist ihr Name meist die beste Quelle –
    // interne Spurnamen heißen gern „Gesamt“ oder „Track 1“. Bei mehreren
    // Touren pro Datei kann nur der Spurname sie auseinanderhalten.
    const GENERISCH = /^(track|tracks|export|route|gpx|download|aktivität|activity|waypoints|wegpunkte)?[\s_\-.]*\d*$/i;
    const roh = dateiname.replace(/\.[^.]+$/, '').trim();
    const dateiTitel = GENERISCH.test(roh) ? '' : roh;
    const mehrere = eigenstaendig.length > 0;
    const benennen = s => (mehrere
      ? (s.spurName || dateiTitel || metaName)
      : (dateiTitel || s.spurName || metaName)) || 'Ohne Namen';

    touren.push(bauTour(benennen(haupt), haupt.coords, haupt.eles,
      varianten.map(v => {
        const idx = vereinfache(v.coords, 4);
        return { km: +(v.m / 1000).toFixed(1),
                 c: idx.map(i => [+v.coords[i][0].toFixed(5), +v.coords[i][1].toFixed(5)]) };
      })));

    for (const s of eigenstaendig) touren.push(bauTour(benennen(s), s.coords, s.eles, []));
  }

  // Datei ohne Spur, aber mit Wegpunkten: daraus eine Punktliste machen
  if (!touren.length) {
    const wpts = tags(doc, 'wpt');
    if (wpts.length > 1) {
      const coords = wpts.map(p => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))]);
      const eles = wpts.map(p => { const e = text(p, 'ele'); return e === '' ? null : parseFloat(e); });
      touren.push(bauTour(metaName || dateiname || 'Wegpunkte', coords, eles, []));
    }
  }
  return touren;
}

/**
 * Überschneiden sich die umschließenden Rechtecke zweier Segmente (mit
 * Puffer)? Dann gehören sie zur selben Wanderung.
 */
function imSelbenGebiet(a, b, pufferM = 1000) {
  const [[as, aw], [an, ao]] = bbox(a.coords);
  const [[bs, bw], [bn, bo]] = bbox(b.coords);
  const dLat = pufferM / 111320;
  const dLon = pufferM / (111320 * Math.cos((as + an) / 2 * Math.PI / 180));
  return as <= bn + dLat && bs <= an + dLat
      && aw <= bo + dLon && bw <= ao + dLon;
}

function laenge(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += dist(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
  return s;
}

/** Baut aus Rohkoordinaten den gleichen Datensatz, den auch das Build-Skript erzeugt. */
export function bauTour(titel, coords, eles, varianten = []) {
  const vereinfacht = vereinfache(coords, 3);
  const c = vereinfacht.map(i => [+coords[i][0].toFixed(5), +coords[i][1].toFixed(5)]);
  const e = vereinfacht.map(i => eles[i] == null ? null : Math.round(eles[i]));
  const hm = hoehenmeter(eles);
  const vorhanden = eles.filter(x => x != null);
  const [[s, w], [n, o]] = bbox(coords);
  return {
    titel: titel.trim(),
    km: +(laenge(coords) / 1000).toFixed(1),
    auf: hm.auf, ab: hm.ab,
    emin: vorhanden.length ? Math.round(Math.min(...vorhanden)) : 0,
    emax: vorhanden.length ? Math.round(Math.max(...vorhanden)) : 0,
    rundweg: dist(coords[0][0], coords[0][1], coords.at(-1)[0], coords.at(-1)[1]) < 250,
    bbox: [s, w, n, o],
    start: [+coords[0][0].toFixed(5), +coords[0][1].toFixed(5)],
    c, e, varianten,
  };
}

/** Douglas-Peucker; liefert die Indizes der behaltenen Punkte. */
export function vereinfache(coords, toleranzM) {
  if (coords.length < 3) return coords.map((_, i) => i);
  const mlat = 111320, mlon = 111320 * Math.cos(coords[0][0] * Math.PI / 180);
  const behalten = new Set([0, coords.length - 1]);
  const stapel = [[0, coords.length - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop();
    if (b - a < 2) continue;
    const x1 = coords[a][1] * mlon, y1 = coords[a][0] * mlat;
    const x2 = coords[b][1] * mlon, y2 = coords[b][0] * mlat;
    const dx = x2 - x1, dy = y2 - y1, n2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][1] * mlon, py = coords[i][0] * mlat;
      let d;
      if (n2 === 0) d = Math.hypot(px - x1, py - y1);
      else {
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / n2));
        d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      }
      if (d > best) { best = d; bi = i; }
    }
    if (best > toleranzM) { behalten.add(bi); stapel.push([a, bi], [bi, b]); }
  }
  return [...behalten].sort((x, y) => x - y);
}

// --- GPX schreiben -------------------------------------------------------

export function gpxSchreiben(tour) {
  const x = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const punkte = tour.c.map(([la, lo], i) => {
    const e = tour.e && tour.e[i] != null ? `<ele>${tour.e[i]}</ele>` : '';
    const t = tour.t && tour.t[i] ? `<time>${new Date(tour.t[i]).toISOString()}</time>` : '';
    return `      <trkpt lat="${la}" lon="${lo}">${e}${t}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mystische Pfade Wanderapp" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(tour.titel)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${x(tour.titel)}</name>
    <trkseg>
${punkte}
    </trkseg>
  </trk>
</gpx>`;
}

// --- ZIP entpacken -------------------------------------------------------

// CP437, oberer Bereich – ältere Archive kodieren Umlaute so.
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function nameDekodieren(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
    return s;
  }
}

/**
 * Entpackt ein ZIP-Archiv über die zentrale Dateiliste.
 * Nutzt DecompressionStream – kein Fremdcode nötig.
 */
export async function zipEntpacken(puffer, filter = /\.gpx$/i) {
  const dv = new DataView(puffer);
  const u8 = new Uint8Array(puffer);

  // Ende der zentralen Dateiliste suchen (rückwärts, Kommentar bis 64 KB)
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Kein gültiges ZIP-Archiv.');

  const anzahl = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dateien = [];

  for (let n = 0; n < anzahl; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const methode = dv.getUint16(p + 10, true);
    const gepackt = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const kommLen = dv.getUint16(p + 32, true);
    const lokal = dv.getUint32(p + 42, true);
    const name = nameDekodieren(u8.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    p += 46 + nameLen + extraLen + kommLen;

    if (name.endsWith('/') || !filter.test(name)) continue;

    // Lokaler Kopf: Längen der Namens- und Extrafelder können abweichen
    const lNameLen = dv.getUint16(lokal + 26, true);
    const lExtraLen = dv.getUint16(lokal + 28, true);
    const start = lokal + 30 + lNameLen + lExtraLen;
    const roh = u8.subarray(start, start + gepackt);

    let daten;
    if (methode === 0) {
      daten = roh;
    } else if (methode === 8) {
      const strom = new Blob([roh]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      daten = new Uint8Array(await new Response(strom).arrayBuffer());
    } else {
      continue;   // andere Verfahren (z. B. bzip2) kommen in GPX-Archiven nicht vor
    }
    dateien.push({ name: name.split('/').pop(), inhalt: new TextDecoder('utf-8').decode(daten) });
  }
  return dateien;
}
