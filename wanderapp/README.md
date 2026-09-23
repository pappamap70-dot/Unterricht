# Mystische Pfade – Wanderapp

Werbefreie Wander-App für die 38 GPX-Touren zum Buch *Mystische Pfade Schwarzwald*.
Läuft als PWA im Handy-Browser, lässt sich auf den Startbildschirm legen und
funktioniert unterwegs ohne Empfang.

Kein Konto, keine Werbung, keine Analyse. Die App ruft nur Kartenkacheln ab –
sonst verlässt nichts das Gerät.

## Funktionen

- **38 Touren** aus dem Buch, bereinigt und mit berechneten Kennzahlen
- **Karten**: OpenTopoMap (Höhenlinien), OpenStreetMap, Luftbild, dazu ein
  Wanderwege-Overlay von Waymarked Trails
- **Offline**: App und Tourendaten sind nach dem ersten Aufruf dauerhaft
  verfügbar; Kartenkacheln lassen sich je Tour herunterladen (3–19 MB)
- **GPS-Navigation**: Standort auf dem Track, Rest-Kilometer, Rest-Höhenmeter,
  Restzeit und Warnung, wenn man mehr als 60 m neben dem Weg ist
- **Höhenprofil** zum Antippen – zeigt den Punkt auf der Karte
- **Import** eigener `.gpx`-Dateien und ganzer `.zip`-Archive
- **Export** jeder Tour als GPX
- Hell/Dunkel nach Systemeinstellung, Bildschirm bleibt beim Navigieren an

## Aufs Handy bringen

Entscheidend ist eine Adresse, die der Browser als **sicheren Kontext** ansieht.
Nur dann gibt Chrome GPS und den Offline-Modus frei. Sicher sind `https://…`
und `http://localhost`. **Nicht** sicher sind `file://` (App aus dem
Dateimanager geöffnet) und LAN-Adressen wie `http://192.168.178.20:8099`.

Deshalb bringt es nichts, die Dateien einfach aufs Handy zu kopieren und
`index.html` anzutippen: Karte, Liste und Höhenprofil erscheinen zwar,
aber Standortanzeige, Navigation und Offline-Karten bleiben tot.

### Weg A – lokaler Server auf dem Handy (alles funktioniert, ohne Internet-Hosting)

1. [Termux](https://f-droid.org/packages/com.termux/) aus F-Droid installieren
2. Projektordner aufs Handy kopieren, z. B. nach `Download/wanderapp`
3. In Termux:

   ```bash
   pkg install python
   termux-setup-storage
   cd ~/storage/downloads/wanderapp
   python -m http.server 8099
   ```

4. Im Chrome `http://localhost:8099` öffnen → ⋮ → **Zum Startbildschirm
   hinzufügen**

`localhost` zählt als sicher, also läuft alles: GPS, Navigation, Offline-Karten,
Installation als App. Der Termux-Befehl muss laufen, wenn du die App öffnest –
danach kann Termux zu, die App bedient sich aus dem Cache.

### Weg B – HTTPS-Hosting

Ordner zu GitHub Pages, Cloudflare Pages, Netlify oder eigenem Webspace
hochladen, Adresse im Handy-Chrome öffnen, zum Startbildschirm hinzufügen.
Bequemer, weil kein Server auf dem Handy laufen muss.

### In beiden Fällen

Einmal bei Empfang öffnen – dabei lädt die App alle Tourendaten dauerhaft.
Pro Tour dann bei Bedarf **Karte offline laden**.

## Lokal ausprobieren

```bash
node tools/server.js      # http://localhost:8099
```

`tools/vorschau.html` zeigt die App am Rechner in Handygröße (400 × 860),
damit sich das Layout prüfen lässt.

## Daten neu erzeugen

```bash
python tools/build_tracks.py <verzeichnis-mit-gpx-dateien>
python tools/make_icons.py
```

`build_tracks.py` schreibt `data/index.json` (Übersicht) und
`data/tracks/NN.json` (Verläufe). Dabei passiert Folgendes:

- pro Datei wird das längste Segment zur Hauptroute, kürzere Reststücke werden
  als gestrichelte Varianten mitgeführt
- Höhenmeter über eine Median-Glättung (Fenster 5) mit 5-m-Schwelle
- Douglas-Peucker mit 3 m Toleranz – aus 17.093 Rohpunkten werden 7.966
- die im Quellmaterial vertauschten Nummern 36/37 werden korrigiert

Die Quelldateien enthielten einige Fehler, die hier bereinigt sind: Tour 16 war
durch ein doppeltes Segment mit 32,6 km statt 13,4 km ausgewiesen, Tour 29
mischte drei Touren aus drei Jahren, und die Zeitstempel sind über weite
Strecken unbrauchbar (eine Tour behauptet 14,4 km in 88 Sekunden). Gehzeiten
werden deshalb nach DIN 33466 geschätzt, nicht aus den Daten gelesen.

## Aufbau

```
index.html              Gerüst aller Ansichten
css/app.css             Styles, mobile first, Hell/Dunkel
js/app.js               Router, Ansichten, Navigation, Import
js/karte.js             Kartenebenen, Tourdarstellung, Offline-Kacheln
js/gpx.js               GPX lesen/schreiben, ZIP entpacken
js/profil.js            Höhenprofil (Canvas)
js/util.js              Geometrie und Formatierung
js/store.js             IndexedDB für eigene Touren und Einstellungen
sw.js                   Service Worker: Offline-Betrieb, Kachel-Cache
data/                   erzeugte Tourendaten
vendor/                 Leaflet 1.9.4, lokal abgelegt
tools/                  Build-Skripte, Dev-Server, Handy-Vorschau
```

Keine Build-Kette, keine npm-Abhängigkeiten. ZIP-Archive entpackt der Browser
mit `DecompressionStream`, das Höhenprofil ist handgezeichnetes Canvas.

Beim Ändern von Dateien die Zahl in `sw.js` (`VERSION`) und in `js/app.js`
(`APP_VERSION`) erhöhen – sonst liefert der Service Worker weiter die alte
Fassung aus.

## Karten und Rechte

Kartendaten © [OpenStreetMap](https://openstreetmap.org/copyright)-Mitwirkende,
Darstellung © [OpenTopoMap](https://opentopomap.org) (CC-BY-SA),
Wanderwege © [Waymarked Trails](https://waymarkedtrails.org) (CC-BY-SA),
Luftbild © Esri.

Die Kachelserver sind Spendenprojekte, keine CDNs. Der Offline-Download ist
deshalb auf vier gleichzeitige Abrufe gedrosselt und je Tour auf den nötigen
Ausschnitt begrenzt. Bitte nicht die gesamte Region auf Vorrat laden.

Die Tourendaten stammen aus dem Buch und sind nur für den privaten Gebrauch
gedacht.
