---
name: pv-planer
description: PV-Anlage für eine Adresse auslegen. Aktivieren, wenn der Nutzer eine Adresse für eine PV-Planung nennt, "PV planen", "PV-Auslegung", "Solaranlage für <Adresse>" sagt oder eine bestehende Auslegung ändern will.
---

# PV-Planer

## Anfragen aus dem Luftbild-Planer (Artifact weckt die Sitzung)
Der Planer (`pv-planer/planer.html`, gebaut mit `tools/areas.js`, veröffentlicht mit `capabilities: {artifact: {}}`) speichert Anfragen, indem er sich selbst neu veröffentlicht. Beim Wecken:
1. Artifact mit `action: "read"` lesen, JSON aus `<script id="pv-data">` → `request`.
2. `request.type === "adresse"`: Nominatim + Luftbild + Georeferenz (siehe unten), ALLE möglichen Dachflächen des Grundstücks als Kandidaten erfassen (ohne `mountings`), `address`/`title` setzen.
   `request.type === "auswahl"`: für `request.ids` Hindernisse erfassen, `mountings`/`edge` setzen, `selected` übernehmen, PVGIS je Montage holen.
3. `request` unverändert übernehmen, `processed = {type, at: <jetzt ISO>}` setzen (sonst zeigt die Seite weiter "in Arbeit"), bei Problemen `status` mit Klartext.
4. `node pv-planer/tools/areas.js roof.json seite.html` und unter DERSELBEN URL veröffentlichen (bei Konflikt neu lesen).
Konfiguration je Adresse im Scratchpad halten; Beispiel `pv-planer/beispiele/lueneburg-auf-der-hoehe-56.json`.

Ablauf: Adresse → Gebäudeumriss (OpenStreetMap) → wenige Fragen → PVGIS-Erträge → Optimierung → Planungsseite als Artifact → Änderungen auf Zuruf.
Werkzeuge: `pv-planer/plan.js` (CLI), `pv-planer/engine.js` (Rechenkern, auch in der Seite), `pv-planer/template.html`.
Arbeitsordner je Adresse: `<scratchpad>/pv/<kurzname>/` mit `nom.json`, `cfg.json`, `plan.html`.

Der Container erreicht Nominatim und PVGIS nicht direkt (Proxy 403). Beide über `mcp__Firecrawl__firecrawl_scrape` mit `formats: ["rawHtml"]`, `maxAge: 0` abrufen.

## 1. Adresse auflösen
```
https://nominatim.openstreetmap.org/search?q=<Adresse URL-kodiert>&format=jsonv2&limit=1&polygon_geojson=1
```
JSON-Array aus `rawHtml` unverändert nach `nom.json` schreiben, dann:
```
node pv-planer/plan.js init nom.json cfg.json
```
- `category` muss `building` sein. Sonst (Straße, Punkt) nach Hausnummer/Schreibweise fragen oder Gebäudemaße erfragen und ein Rechteck setzen:
  `node pv-planer/plan.js rect cfg.json <Länge m> <Breite m> <Längsachse ° ab Nord>`
- Ausgabe nennt Maße, Längsachse und abgeleitete Dachflächen.

## 2. Fragen (eine AskUserQuestion-Runde, 4 Fragen)
Jede Frage nennt die gefundenen Gebäudedaten (z. B. "19,5 × 10,6 m, Längsachse Ost–West").
1. **Dachform**: Satteldach First längs (Standard) · Satteldach First quer · Walmdach · Flachdach / Pultdach.
2. **Neigung**: ca. 30° · ca. 38° · ca. 45° · weiß nicht (dann 35° ansetzen und sagen).
3. **Stromverbrauch Haushalt**: 1–2 Personen ≈ 2.500 · 3 Personen ≈ 3.500 · 4+ Personen ≈ 4.500 kWh (Other = genauer Wert).
4. **Hindernisse auf den Dachflächen** (multiSelect): Dachfenster · Schornstein · Strangentlüftung/Antenne · Gaube/Dachausstieg. (Wärmepumpe/E-Auto über "Other" oder in Runde 2.)

Zweite Runde nur wenn nötig, als **eine Freitextfrage** mit Beispiel, damit es schnell geht:
"Wo sitzen die Hindernisse? Je Hindernis: Art, Dachseite, Lage von links (links/halb links/mitte/halb rechts/rechts oder Meter ab linker Traufecke) und Höhe (unten/mitte/oben oder Meter ab Traufe), Größe falls bekannt. Beispiel: 2 Dachfenster Süd, unten, 4 m und 7 m von links; Schornstein Süd oben rechts."
Dazu bei Bedarf: WP-Verbrauch (sonst ≈ 3.500 kWh/a), E-Auto km/a (× 0,18 kWh/km) und ob tagsüber zu Hause (`evMode: "tag"`), Pultdach-Richtung, Flachdach Süd oder Ost-West.
"Links" heißt immer: Blick von außen/unten auf die jeweilige Dachfläche.
Nicht nach Preisen fragen; Standardwerte nehmen, auf der Seite änderbar.

## 3. Konfiguration
In `cfg.json` setzen (alles optional, Rest sind Standardwerte aus `plan.js`):
```json
"roof": {"type": "sattel|walm|pult|flach", "tilt": 35, "ridge": "long|short", "edge": 0.3, "overhang": 0, "pultDir": "sued|andere", "mounting": "ow|sued"},
"consumption": {"household": 4000, "heatpump": 0, "ev": 0, "evMode": "abends|tag"},
"faceOverrides": {"F1": {"obstacles": [
    {"type": "dachfenster", "x": 4, "y": "unten"},
    {"type": "schornstein", "x": "rechts", "y": "oben", "w": 0.5, "h": 0.8, "c": 0.5},
    {"type": "entlueftung", "x": "halb rechts", "y": "mitte"}],
  "reduce": 0, "exclude": false, "orient": "p|l", "shape": {"eave": 9.5, "top": 9.5, "slope": 5.8}}},
"module": {"wp": 450, "l": 1.762, "b": 1.134, "kg": 21.5, "ukKg": 3},
"econ": {"price": 32, "pvKwp": 1000, "pvFix": 2500, "batKwh": 450, "batFix": 2000, "fit10": 7.70, "fit40": 6.67, ...},
"feedCap": true,
"notes": ["freier Hinweistext für die Seite"],
"best": {"counts": [20, 0], "cap": 5}
```
Hindernis-Typen mit Standardmaß / Abstand (Annahmen): `dachfenster` 0,78×1,40 / 0,30 · `schornstein` 0,60×0,60 / 0,50 · `entlueftung` 0,20×0,20 / 0,30 · `antenne` 0,30×0,30 / 0,50 · `gaube` 2,0×2,0 / 0,30 (Maße erfragen) · `ausstieg` 0,60×0,80 / 0,30 · `sonstiges` 0,50×0,50 / 0,30.
`x`/`y` = Mitte des Hindernisses (Meter oder Lagewort), `w` quer, `h` entlang Sparren, `c` Abstand. Nach `faces` die gelisteten Lagen kurz plausibilisieren.
`best` nur setzen, wenn der Nutzer eine bestimmte Variante festlegt; sonst wählt die Optimierung.
Verschattung (Bäume, Nachbarhaus, Schornsteinschatten) wird nicht berechnet: nur über `exclude`/`reduce` oder Hinweis in `notes`. Keine Zeit in genauere Ertragsprognosen stecken.

## 4. PVGIS
`node pv-planer/plan.js faces cfg.json` listet die fehlenden PVGIS-URLs. Jede per Firecrawl abrufen (parallel), die 12 `E_m`-Werte eintragen:
```
node pv-planer/plan.js pvgis cfg.json <tilt> <aspect> <E_m Jan>,...,<E_m Dez>
```

## 5. Bauen und veröffentlichen
```
node pv-planer/plan.js build cfg.json plan.html
```
Die Konsole zeigt Vorschlag und Top-Varianten. `plan.html` mit dem Artifact-Tool veröffentlichen (Icon `sun`, Beschreibung mit Adresse). Bei späteren Änderungen dieselbe Datei neu veröffentlichen, damit der Link gleich bleibt.

Antwort an den Nutzer, knapp: Anlagengröße, Module je Fläche, Speicher, Ertrag, Autarkie, Investition, Amortisation, warum diese Variante (z. B. Nordseite unwirtschaftlich), 1–2 wichtigste Vorbehalte, Link.

## 6. Änderungen
Wunsch in `cfg.json` übertragen (Dachform, Neigung, `reduce`, `exclude`, Verbrauch, Preise, `best`), ab Schritt 4 wiederholen (PVGIS nur für neue Neigung/Ausrichtung), neu veröffentlichen.
Modulzahl, Speicher, Verbrauch und Preise kann der Nutzer auch direkt auf der Seite ändern; die Seite rechnet live.

## Modulauslegung mit Luftbild (Flachdach, mehrere Dachabschnitte, Carport)
Wenn nur die Modulauslegung gefragt ist oder das Dach komplex ist:
1. Nominatim (wie oben) → Lage und OSM-Umriss.
2. Luftbild: Firecrawl-Screenshot von `https://www.bing.com/maps?cp=<lat>~<lon>&lvl=20&style=a`, `waitFor: 6000`, Viewport 1400×1100; PNG per `curl` von der zurückgegebenen storage.googleapis.com-URL laden (eigener Ordner). Kartenmitte = Pixel (700, 590).
3. Georeferenz prüfen: `node pv-planer/tools/aerial.js overlay bild.png a.json ov.png` (OSM-Umriss einzeichnen, ansehen). Für Details: `tools/aerial.js grid bild.png x0 y0 x1 y1 out.png 3`.
4. Gebäudesystem u/v (u = Längsachse ab OSM-Ecke, Meter) anlegen; Dachabschnitte, nicht nutzbare Flächen und Hindernisse (Lüfter, Lichtkuppeln, Ausstiege …) in u/v eintragen; zur Kontrolle wieder auf das Luftbild legen. Carports u. ä. fehlen oft in OSM: aus dem Bild nachzeichnen.
5. PVGIS je Montage holen (Süd 15°, Ost-West 10° beide Richtungen, flach 5°), als Jahreswert in `pvgis` eintragen.
6. Zweistufig: Erst ALLE möglichen Flächen des Grundstücks als Kandidaten (`areas` ohne `mountings`, `selected: false`, Nebengebäude/Carports aus dem Bild nachzeichnen) → `node pv-planer/tools/areas.js roof.json seite.html` → mit `capabilities: {artifact: {}}` veröffentlichen. Der Nutzer wählt im Luftbild und sendet; die Seite veröffentlicht sich selbst mit `request.ids` (weckt die Sitzung) oder er fügt die Kopierzeile in den Chat ein.
7. Nach der Auswahl (Artifact `read`, `pv-data` → `request.ids`): nur für die gewählten Flächen Hindernisse aus dem Luftbild erfassen (`obstacles`, ggf. `excluded`), `mountings` + `edge` setzen, `selected: true`, `request` übernehmen, neu bauen und unter derselben URL veröffentlichen. Beispiel: `pv-planer/beispiele/lueneburg-auf-der-hoehe-56.json`.
Luftbilder nicht ins Repo legen (Bildrechte).

## Tests nach jeder Änderung am Code
```
node pv-planer/test.js                                   # Rechenkern + CLI
NODE_PATH=$(npm root -g) node pv-planer/test-ui.js plan.html   # Seite im Browser
```

## Grenzen, immer offen benennen
- Maße aus dem OSM-Umriss ohne Dachüberstand; Hindernislagen aus dem Gespräch. Aufmaß vor Ort nötig.
- Stundenwerte modelliert (PVGIS-Monatssummen, synthetisches Wetter, vereinfachtes Lastprofil). Gegen HTW-Referenzen geprüft (±1 Punkt), mit Wärmepumpe eher zu hoch.
- Vergütungssätze Stand 08/2026 aus Ratgeberseiten, nicht amtlich bestätigt; EEG-Novelle 2027 offen.
- Statik nicht nachgewiesen.
