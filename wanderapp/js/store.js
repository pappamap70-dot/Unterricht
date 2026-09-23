// Kleiner IndexedDB-Wrapper für importierte Touren und Einstellungen

const DB_NAME = 'mystische-pfade';
const DB_VERSION = 1;
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((ok, fehler) => {
      const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
      anfrage.onupgradeneeded = () => {
        const d = anfrage.result;
        if (!d.objectStoreNames.contains('touren')) d.createObjectStore('touren', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('einst')) d.createObjectStore('einst');
      };
      anfrage.onsuccess = () => ok(anfrage.result);
      anfrage.onerror = () => fehler(anfrage.error);
    });
  }
  return dbPromise;
}

async function tx(store, modus, aktion) {
  const d = await db();
  return new Promise((ok, fehler) => {
    const t = d.transaction(store, modus);
    const anfrage = aktion(t.objectStore(store));
    t.oncomplete = () => ok(anfrage ? anfrage.result : undefined);
    t.onerror = () => fehler(t.error);
    t.onabort = () => fehler(t.error);
  });
}

// Touren ------------------------------------------------------------------

export const eigeneTouren = () => tx('touren', 'readonly', s => s.getAll());
export const eigeneTour = id => tx('touren', 'readonly', s => s.get(id));
export const tourSpeichern = tour => tx('touren', 'readwrite', s => s.put(tour));
export const tourLoeschen = id => tx('touren', 'readwrite', s => s.delete(id));

export function neueId() {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Einstellungen -----------------------------------------------------------

const vorgabe = {
  layer: 'topo',
  wanderwege: true,
  wachhalten: true,
  kmMarken: true,
  sortierung: 'nr',
};

let cache = null;

export async function einstellungen() {
  if (!cache) {
    const gespeichert = await tx('einst', 'readonly', s => s.get('alle'));
    cache = { ...vorgabe, ...(gespeichert || {}) };
  }
  return cache;
}

export async function setzeEinstellung(schluessel, wert) {
  const e = await einstellungen();
  e[schluessel] = wert;
  await tx('einst', 'readwrite', s => s.put({ ...e }, 'alle'));
  return e;
}
