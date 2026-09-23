// Kleiner Entwicklungsserver: node tools/server.js -> http://localhost:8099
// Nur für den Rechner gedacht; auf dem Handy braucht die App HTTPS.

const http = require('http');
const fs = require('fs');
const path = require('path');

const WURZEL = path.join(__dirname, '..');
const PORT = process.env.PORT || 8099;

const TYPEN = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.gpx': 'application/gpx+xml',
  '.zip': 'application/zip',
};

http.createServer((req, res) => {
  let pfad = decodeURIComponent(req.url.split('?')[0]);
  if (pfad.endsWith('/')) pfad += 'index.html';

  const datei = path.join(WURZEL, path.normalize(pfad));
  if (!datei.startsWith(WURZEL)) { res.writeHead(403).end('403'); return; }

  fs.readFile(datei, (fehler, inhalt) => {
    if (fehler) { res.writeHead(404).end('404 – ' + pfad); return; }
    res.writeHead(200, {
      'Content-Type': TYPEN[path.extname(datei)] || 'application/octet-stream',
      'Cache-Control': 'no-store',      // beim Entwickeln immer frisch
    });
    res.end(inhalt);
  });
}).listen(PORT, () => {
  console.log(`Wanderapp läuft auf http://localhost:${PORT}`);
  console.log(`Handy-Vorschau:      http://localhost:${PORT}/tools/vorschau.html`);
});
