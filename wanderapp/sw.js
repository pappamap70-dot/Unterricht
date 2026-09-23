// Service Worker: App offline lauffähig halten und Kartenkacheln zwischenspeichern

const VERSION = 'v1.1.1';

// Eigenes Namenspräfix: caches.keys() liefert alle Caches der Domain, nicht nur
// die dieser App. Liegt die App neben anderen Seiten auf derselben Domain
// (z. B. github.io), dürfen beim Aufräumen nur eigene Caches fallen.
const PRAEFIX = 'mp-';
const SHELL_CACHE = PRAEFIX + 'shell-' + VERSION;
const DATEN_CACHE = PRAEFIX + 'daten-' + VERSION;
const KACHEL_CACHE = PRAEFIX + 'kacheln-v1';   // versionslos: überlebt App-Updates

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/util.js',
  './js/gpx.js',
  './js/karte.js',
  './js/profil.js',
  './js/store.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './vendor/images/layers.png',
  './vendor/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  './icons/apple-touch-icon.png',
];

const KACHEL_HOSTS = [
  'tile.opentopomap.org',
  'tile.openstreetmap.org',
  'tile.waymarkedtrails.org',
  'server.arcgisonline.com',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);

    // Alle Tourendaten gleich mitnehmen – zusammen unter 300 KB
    const daten = await caches.open(DATEN_CACHE);
    try {
      await daten.add('./data/index.json');
      const index = await (await daten.match('./data/index.json')).json();
      await daten.addAll(index.touren.map(t => `./data/tracks/${t.id}.json`));
    } catch (err) {
      console.warn('Tourendaten konnten nicht vorgeladen werden:', err);
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const behalten = [SHELL_CACHE, DATEN_CACHE, KACHEL_CACHE];
    for (const name of await caches.keys()) {
      // fremde Caches auf derselben Domain bleiben unangetastet
      if (name.startsWith(PRAEFIX) && !behalten.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const anfrage = e.request;
  if (anfrage.method !== 'GET') return;
  const url = new URL(anfrage.url);

  // Kartenkacheln: erst Cache, sonst Netz – und was ankommt, wird behalten
  if (KACHEL_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(KACHEL_CACHE);
      const treffer = await cache.match(anfrage);
      if (treffer) return treffer;
      try {
        const antwort = await fetch(anfrage);
        if (antwort.ok) cache.put(anfrage, antwort.clone());
        return antwort;
      } catch {
        // Ohne Empfang und ohne gespeicherte Kachel: leeres Bild statt Fehlerbild
        return new Response(LEERE_KACHEL, { headers: { 'Content-Type': 'image/png' } });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Seitenaufrufe immer auf die App-Shell zurückführen (Hash-Routing)
  if (anfrage.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        return await fetch(anfrage);
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Eigene Dateien: Cache zuerst, im Hintergrund auffrischen
  e.respondWith((async () => {
    const treffer = await caches.match(anfrage);
    const netz = fetch(anfrage).then(async antwort => {
      if (antwort.ok) {
        const ziel = url.pathname.includes('/data/') ? DATEN_CACHE : SHELL_CACHE;
        (await caches.open(ziel)).put(anfrage, antwort.clone());
      }
      return antwort;
    }).catch(() => null);
    return treffer || (await netz) || Response.error();
  })());
});

// 1×1 transparentes PNG
const LEERE_KACHEL = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));
