// Höhenprofil als Canvas – antippen zeigt den Punkt auf der Karte

import { kumDistanz, fmtKm } from './util.js';

export function zeichneProfil(canvas, tour, { beiAuswahl, marker } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const breite = canvas.clientWidth, hoehe = canvas.clientHeight;
  if (!breite || !hoehe) return null;
  canvas.width = breite * dpr;
  canvas.height = hoehe * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const stil = getComputedStyle(document.body);
  const farbe = stil.getPropertyValue('--gruen').trim() || '#1a4734';
  const schwach = stil.getPropertyValue('--text-schwach').trim() || '#666';
  const linie = stil.getPropertyValue('--linie').trim() || '#ddd';
  const akzent = stil.getPropertyValue('--akzent').trim() || '#e07a3f';

  const kum = kumDistanz(tour.c);
  const gesamt = kum[kum.length - 1];
  const eles = tour.e || [];
  // Lücken in den Höhendaten linear überbrücken
  const h = [];
  let letzte = eles.find(x => x != null) ?? 0;
  for (let i = 0; i < tour.c.length; i++) {
    if (eles[i] != null) letzte = eles[i];
    h.push(letzte);
  }
  const hMin = Math.min(...h), hMax = Math.max(...h);
  const spanne = Math.max(hMax - hMin, 40);
  const padL = 34, padR = 6, padO = 8, padU = 17;
  const iw = breite - padL - padR, ih = hoehe - padO - padU;

  const X = m => padL + (gesamt ? m / gesamt : 0) * iw;
  const Y = e => padO + ih - ((e - hMin) / spanne) * ih;

  ctx.clearRect(0, 0, breite, hoehe);

  // Höhenraster
  ctx.strokeStyle = linie; ctx.fillStyle = schwach;
  ctx.lineWidth = 1; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right';
  const schritt = spanne > 600 ? 200 : spanne > 300 ? 100 : 50;
  for (let e = Math.ceil(hMin / schritt) * schritt; e <= hMax; e += schritt) {
    const y = Math.round(Y(e)) + .5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(breite - padR, y); ctx.stroke();
    ctx.fillText(e, padL - 5, y + 3);
  }

  // Fläche
  const verlauf = ctx.createLinearGradient(0, padO, 0, padO + ih);
  verlauf.addColorStop(0, farbe + 'aa');
  verlauf.addColorStop(1, farbe + '18');
  ctx.beginPath();
  ctx.moveTo(X(0), padO + ih);
  for (let i = 0; i < h.length; i++) ctx.lineTo(X(kum[i]), Y(h[i]));
  ctx.lineTo(X(gesamt), padO + ih);
  ctx.closePath();
  ctx.fillStyle = verlauf; ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < h.length; i++) {
    const x = X(kum[i]), y = Y(h[i]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = farbe; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();

  // Kilometerachse
  ctx.fillStyle = schwach; ctx.textAlign = 'center';
  const kmSchritt = gesamt > 20000 ? 5000 : gesamt > 8000 ? 2000 : 1000;
  for (let m = 0; m <= gesamt; m += kmSchritt) {
    ctx.fillText(fmtKm(m / 1000), X(m), hoehe - 5);
  }

  // Positionsmarke (aktueller Standort oder Antippen)
  function markiere(meter, label) {
    zeichneProfil(canvas, tour, { beiAuswahl, marker: null });   // Grundbild neu
    if (meter == null) return;
    const i = naechsterIndex(kum, meter);
    const x = X(meter), y = Y(h[i]);
    ctx.save();
    ctx.strokeStyle = akzent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, padO); ctx.lineTo(x, padO + ih); ctx.stroke();
    ctx.fillStyle = akzent;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    return { index: i, hoehe: h[i] };
  }

  if (marker != null) markiere(marker);

  // Zeigen/Ziehen
  if (beiAuswahl && !canvas._verdrahtet) {
    canvas._verdrahtet = true;
    const auswerten = ev => {
      const r = canvas.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const anteil = Math.max(0, Math.min(1, (px - padL) / iw));
      const meter = anteil * canvas._gesamt;
      const idx = naechsterIndex(canvas._kum, meter);
      beiAuswahl(idx, meter, canvas._hoehen[idx]);
    };
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId); auswerten(e); e.preventDefault();
    });
    canvas.addEventListener('pointermove', e => {
      if (canvas.hasPointerCapture(e.pointerId)) auswerten(e);
    });
    canvas.addEventListener('pointerup', () => beiAuswahl(null));
    canvas.addEventListener('pointercancel', () => beiAuswahl(null));
  }
  canvas._kum = kum; canvas._gesamt = gesamt; canvas._hoehen = h;

  return { markiere, kum, gesamt, hoehen: h };
}

function naechsterIndex(kum, meter) {
  let lo = 0, hi = kum.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (kum[m] < meter) lo = m + 1; else hi = m;
  }
  return lo;
}
