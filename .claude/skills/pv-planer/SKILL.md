---
name: pv-planer
description: PV-Modulauslegung mit Luftbild. Aktivieren, wenn der Nutzer eine Adresse für eine PV-Planung nennt, eine Zeile "PV-Planer Adresse: …" oder "PV-Auswahl …" einfügt, oder der Planer (Artifact) eine neue Version mit Anfrage gespeichert hat.
---

# PV-Planer (Luftbild)

Planer-Seite: https://claude.ai/artifact/PjdiaaCkvYrmLLaLFPUDS7 (nur diese eine; keine weiteren Planer-Artifacts anlegen).
Code: `pv-planer/planer.html` (Seite), `pv-planer/tools/areas.js` (baut die Seite), `pv-planer/tools/aerial.js` (Luftbild-Hilfen), `pv-planer/engine.js` (Belegung).
Ausgabe immer in dieselbe URL veröffentlichen, mit `capabilities: {artifact: {}}`.

Nur Modulauslegung: keine Wirtschaftlichkeit, kein Speicher, kein Verbrauch. Verschattung nicht aussparen (nur auf ausdrücklichen Wunsch).

## Anfrage lesen
Die Seite speichert Anfragen, indem sie sich selbst neu veröffentlicht. Das Wecken der Sitzung kommt nicht zuverlässig an; bei jeder Nachricht zum Planer zuerst das Artifact mit `action: "read"` lesen, JSON aus `<script id="pv-data">` → `request` (und `processed`). Offen ist eine Anfrage, wenn `processed.at < request.at`.
Bei einem Publish-Konflikt die gespeicherte Version auswerten (sie enthält oft eine neue Anfrage) und darauf aufbauen.

## request.type = "adresse"
1. Nominatim per Firecrawl (`formats: ["rawHtml"]`, `maxAge: 0`): `https://nominatim.openstreetmap.org/search?q=<Adresse>&format=jsonv2&limit=1&polygon_geojson=1`. Oft nur ein Adresspunkt.
2. Luftbild: Firecrawl-Screenshot `https://www.bing.com/maps?cp=<lat>~<lon>&lvl=20&style=a`, `waitFor: 6000`, Viewport 1400×1100; PNG per `curl` aus der storage.googleapis.com-URL in einen eigenen Ordner im Scratchpad laden. Kartenmitte = Pixel (700, 590), Zoom 20 (≈9 cm/px).
3. Mit `tools/aerial.js grid` Ausschnitte vergrößern; ALLE Dachflächen des Grundstücks erfassen (Haupt- und Anbauten, Carports, Garagen, Schuppen). Schatten sind keine Dächer (dunkle Flächen auf der Nordseite prüfen). Höhenstufen bei Bedarf aus Schattenlängen.
4. Gebäudesystem: Ursprung = eine Gebäudeecke, `bearing` = Richtung einer Gebäudekante (° ab Nord); Pixel → lat/lon (`aerial.toLL`) → u/v in Metern. Mit `tools/aerial.js overlay` prüfen und nachbessern, bis jede Fläche auf dem Dach liegt.
5. roof.json: `address`, `title`, `geo`, `frame`, `aerial` (file, lat, lon, zoom, cx, cy, crop, scale 2), `areas` (id, name, kind, building, note, poly in u/v, `selected: false`, ohne `mountings`), `excluded: []`, `obstacles: []`, `pvgis: {}`, `notes`, `request` übernehmen, `processed = {type, at: jetzt}`.
6. `node pv-planer/tools/areas.js roof.json <veröffentlichte Datei>` und veröffentlichen.

## request.type = "auswahl"
1. Für `request.ids`: Hindernisse auf diesen Flächen aus dem Luftbild erfassen (`obstacles`: type lichtkuppel/entlueftung/ausstieg/schornstein/antenne/sonstiges, u, v; optional w, h, c). Nicht nutzbare Teilflächen (Technik) als `excluded`.
2. `selected` = genau die ids; `mountings` + `edge` setzen: Flachdach `["ow","sued"]`, edge 0,8; Carport `["eben"]`, edge 0,3. Geneigte Dächer: Neigung nicht aus dem Bild ablesbar, Annahme in `notes` nennen.
3. PVGIS je Montage per Firecrawl (`PVcalc`, loss 14, usehorizon 1), Jahreswert `E_y` in `pvgis["<Neigung>|<Azimut>"]` (Schlüssel, die areas.js als fehlend meldet).
4. `processed` setzen, bauen, veröffentlichen. Beispiele: `pv-planer/beispiele/`.

Luftbilder nicht ins Repo legen (Bildrechte). Nach Code-Änderungen `node pv-planer/test.js`.
