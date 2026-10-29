---
name: pv-planer
description: PV-Anlage für eine Adresse auslegen. Aktivieren, wenn der Nutzer eine Adresse für eine PV-Planung nennt, "PV planen", "PV-Auslegung", "Solaranlage für <Adresse>" sagt oder eine bestehende Auslegung ändern will.
---

# PV-Planer

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
- `category` muss `building` sein. Sonst (Straße, Punkt) nach Hausnummer/Schreibweise fragen oder Gebäudemaße erfragen und `geo.coords` als Rechteck selbst setzen.
- Ausgabe nennt Maße, Längsachse und abgeleitete Dachflächen.

## 2. Fragen (eine AskUserQuestion-Runde, 4 Fragen)
Jede Frage nennt die gefundenen Gebäudedaten (z. B. "19,5 × 10,6 m, Längsachse Ost–West").
1. **Dachform**: Satteldach First längs (Standard) · Satteldach First quer · Walmdach · Flachdach / Pultdach.
2. **Neigung**: ca. 30° · ca. 38° · ca. 45° · weiß nicht (dann 35° ansetzen und sagen).
3. **Stromverbrauch Haushalt**: 1–2 Personen ≈ 2.500 · 3 Personen ≈ 3.500 · 4+ Personen ≈ 4.500 kWh (Other = genauer Wert).
4. **Zusätzlich** (multiSelect): Wärmepumpe · E-Auto · Dachfenster/Gauben/Kamin auf der Sonnenseite · Verschattung (Bäume, Nachbarhaus).

Nur wenn nötig eine zweite Runde: WP-Verbrauch (sonst ≈ 3.500 kWh/a ansetzen), E-Auto km/a (× 0,18 kWh/km) und ob tagsüber zu Hause (`evMode: "tag"`), Anzahl/Lage der Dachfenster (→ `reduce`), Pultdach-Richtung, Flachdach Süd oder Ost-West.
Nicht nach Preisen fragen; Standardwerte nehmen, auf der Seite änderbar.

## 3. Konfiguration
In `cfg.json` setzen (alles optional, Rest sind Standardwerte aus `plan.js`):
```json
"roof": {"type": "sattel|walm|pult|flach", "tilt": 35, "ridge": "long|short", "edge": 0.3, "overhang": 0, "pultDir": "sued|andere", "mounting": "ow|sued"},
"consumption": {"household": 4000, "heatpump": 0, "ev": 0, "evMode": "abends|tag"},
"faceOverrides": {"F1": {"reduce": 4, "exclude": false, "orient": "p|l", "shape": {"eave": 9.5, "top": 9.5, "slope": 5.8}}},
"module": {"wp": 450, "l": 1.762, "b": 1.134, "kg": 21.5, "ukKg": 3},
"econ": {"price": 32, "pvKwp": 1000, "pvFix": 2500, "batKwh": 450, "batFix": 2000, "fit10": 7.70, "fit40": 6.67, ...},
"feedCap": true,
"notes": ["freier Hinweistext für die Seite"],
"best": {"counts": [20, 0], "cap": 5}
```
`best` nur setzen, wenn der Nutzer eine bestimmte Variante festlegt; sonst wählt die Optimierung.
Bei Verschattung: Fläche über `reduce` verkleinern oder Hinweis in `notes`; PVGIS kennt nur den Geländehorizont.

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

## Grenzen, immer offen benennen
- Maße aus dem OSM-Umriss ohne Dachüberstand, Dachfenster und Gauben; Aufmaß vor Ort nötig.
- Stundenwerte modelliert (PVGIS-Monatssummen, synthetisches Wetter, vereinfachtes Lastprofil): Eigenverbrauch/Autarkie eher zu hoch.
- Vergütungssätze Stand 08/2026 aus Ratgeberseiten, nicht amtlich bestätigt; EEG-Novelle 2027 offen.
- Statik nicht nachgewiesen.
