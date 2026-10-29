---
name: pv-planer
description: PV-Modulauslegung mit Luftbild. Aktivieren, wenn der Nutzer eine Adresse für eine PV-Planung nennt, eine Zeile "PV-Planer Adresse: …" oder "PV-Auswahl …" einfügt, oder der Planer (Artifact) eine neue Version mit Anfrage gespeichert hat.
---

# PV-Planer (Luftbild)

Planer-Seite: https://claude.ai/artifact/PjdiaaCkvYrmLLaLFPUDS7 (nur diese eine; keine weiteren Planer-Artifacts anlegen).
Code: `pv-planer/planer.html` (Seite), `pv-planer/tools/areas.js` (baut die Seite), `pv-planer/tools/aerial.js` (Luftbild-Hilfen), `pv-planer/engine.js` (Belegung).
Ausgabe immer in dieselbe URL veröffentlichen, mit `capabilities: {artifact: {}}`.

Nur Modulauslegung: keine Wirtschaftlichkeit, kein Speicher, kein Verbrauch. Verschattung nicht aussparen (nur auf ausdrücklichen Wunsch).

**Grundregel (Wunsch des Nutzers): verlässliche Planung ohne Fehler — alle verfügbaren Quellen nutzen und Ergebnisse selbst gegenprüfen**, bevor sie dem Nutzer gezeigt werden: Liegenschaftskataster, 3D-Gebäudemodell, Luftbild (Bing, Zoom 21), Street View aus mehreren Blickrichtungen, OpenStreetMap. Jede Fläche erst eintragen, wenn sie in mindestens zwei Quellen plausibel ist; Unsicheres in `note` kennzeichnen. Neue Quellen, die sich als nützlich erweisen, hier ergänzen.

## Anfrage lesen
Die Seite speichert Anfragen, indem sie sich selbst neu veröffentlicht. Das Wecken der Sitzung kommt nicht zuverlässig an; bei jeder Nachricht zum Planer zuerst das Artifact mit `action: "read"` lesen, JSON aus `<script id="pv-data">` → `request` (und `processed`). Offen ist eine Anfrage, wenn `processed.at < request.at`.
Bei einem Publish-Konflikt die gespeicherte Version auswerten (sie enthält oft eine neue Anfrage) und darauf aufbauen.

## request.type = "adresse"
Rangfolge der Quellen: **amtliche Daten vor Bildauswertung.** Luftbilder (Bing) sind keine echten Orthofotos (Dächer leicht versetzt), Linien im Dach sind mehrdeutig (First, Traufkante, Fensterband).

1. Nominatim per Firecrawl (`formats: ["rawHtml"]`, `maxAge: 0`): `https://nominatim.openstreetmap.org/search?q=<Adresse>&format=jsonv2&limit=1`.
2. **Liegenschaftskataster (ALKIS, nur Niedersachsen, LGLN Open Data):** Gebäudeumrisse per Firecrawl `rawHtml`:
   `https://opendata.lgln.niedersachsen.de/doorman/noauth/alkis_wfs_einfach?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ave:GebaeudeBauwerk&COUNT=20&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX=<lat1>,<lon1>,<lat2>,<lon2>,urn:ogc:def:crs:EPSG::4326`
   Antwort als Datei speichern, `node pv-planer/tools/kataster.js alkis <datei> [oid]`. Liefert Umriss, Funktion (z. B. Kindergarten), Adresse, Stand.
3. **3D-Gebäudemodell LoD2 (LGLN):** Kachel über `https://lod.stac.lgln.niedersachsen.de/collections/lod2/items?bbox=<lon1>,<lat1>,<lon2>,<lat2>` (Firecrawl `rawHtml`). Die GML-Datei (≈6 MB) direkt per Firecrawl mit `formats: ["query"]`, `queryOptions.mode: "directQuote"` abrufen: das Ergebnis wird als Datei abgelegt und enthält den Text ohne XML-Tags. Gebäude-ID = ALKIS-oid ohne „BL“. `node pv-planer/tools/kataster.js lod2 <datei> <id>` → Dachflächen mit Neigung, Ausrichtung, Fläche, Trauf-/Firsthöhe. Achtung: Grundriss im Modell kann älter sein (Anbauten fehlen) → mit ALKIS abgleichen.
4. Gebäudesystem am Kataster ausrichten: Ursprung = ALKIS-Ecke, `bearing` = Richtung der langen Außenwand. `node pv-planer/tools/kataster.js uv <roof.json> <daten.json>` rechnet in u/v um. Dachflächen aus LoD2 übernehmen (Umrisse liegen auf den Wänden, Überstände fehlen → sichere Seite), Teile ohne LoD2 aus ALKIS.
5. Luftbild: Firecrawl-Screenshot `https://www.bing.com/maps?cp=<lat>~<lon>&lvl=21&style=a` (Zoom 21 ≈4,5 cm/px), `waitFor: 6000`, Viewport 1400×1100; PNG per `curl` aus der storage.googleapis.com-URL laden. Kartenmitte = Pixel (700, 590). Dient für Dachdeckung, Dachfenster, Technik — nicht für Maße. Schatten sind keine Dächer: Sonnenrichtung an Bäumen/Autos bestimmen, dunkle Flächen auf der Schattenseite prüfen.
6. Street View (Pflicht, mehrere Blickrichtungen, zusätzlich vergrößert mit `30y`–`35y`): `https://www.google.com/maps/@<lat>,<lon>,3a,<fov>y,<Blickrichtung>h,<95–101>t/data=!3m4!1e1!3m2!1s<panoid>!2e0` (`waitFor: 8000`, Viewport 1400×900). Dachform, Neigung am Giebel (Steigung im Bild, horizontal mit cos(Blickwinkel zur Giebelnormalen) korrigieren), Geschosse.
7. Ohne amtliche Daten (andere Bundesländer): Umrisse aus dem Luftbild, Maßstab an Referenzen prüfen (Pkw ≈4,5 × 1,8 m, Stellplatz 2,5 m, Ziegelschicht NF 8,3 cm / DF 6,25 cm, Pfannenreihe ≈33 cm, Normfenster) und die Unsicherheit in `note` nennen.

**Gegenprüfung (Pflicht vor dem Veröffentlichen):**
- Overlay aller Flächen + ALKIS-Umriss auf dem Luftbild (`tools/aerial.js overlay`) ansehen; jede Fläche liegt im Umriss (± Dachüberstand).
- Neigung: LoD2 gegen Street View (Abweichung > 5° → klären). Ausrichtung: LoD2-Azimut gegen Gebäudeachse.
- Flächengrößen: LoD2/ALKIS gegen Luftbild-Maßstab (Abweichung > 5 % → klären).
- Fläche nur aufnehmen, wenn mindestens zwei unabhängige Quellen sie stützen; was weder im Kataster noch im 3D-Modell steht, in `notes` begründet weglassen.
- Quellen und Stand in `notes` nennen (LGLN-Daten: CC BY 4.0, Namensnennung).

8. roof.json: `address`, `title`, `geo`, `frame`, `aerial` (file, lat, lon, zoom, cx, cy, crop, scale), `areas` (id, name, kind, building, note, poly in u/v, `selected: false`, ohne `mountings`; geneigte Flächen mit `slope: {tilt, fall}` aus LoD2), `excluded: []`, `obstacles: []`, `pvgis: {}`, `notes`, `request` übernehmen, `processed = {type, at: jetzt}`.
9. `node pv-planer/tools/areas.js roof.json <veröffentlichte Datei>` und veröffentlichen.

## request.type = "auswahl"
1. Für `request.ids`: Hindernisse auf diesen Flächen aus dem Luftbild erfassen (`obstacles`: type lichtkuppel/entlueftung/ausstieg/schornstein/antenne/sonstiges, u, v; optional w, h, c). Nicht nutzbare Teilflächen (Technik) als `excluded`.
2. `selected` = genau die ids; `mountings` + `edge` setzen: Flachdach `["ow","sued"]`, edge 0,8; Carport `["eben"]`, edge 0,3. Geneigte Dachseiten: `["dach_quer","dach_hoch"]`, edge 0,3; Neigung aus LoD2 (sonst Street View) in `notes` nennen.
3. PVGIS je Montage per Firecrawl (`PVcalc`, loss 14, usehorizon 1), Jahreswert `E_y` in `pvgis["<Neigung>|<Azimut>"]` (Schlüssel, die areas.js als fehlend meldet).
4. `processed` setzen, bauen, veröffentlichen. Beispiel: `pv-planer/beispiele/lueneburg-auf-der-hoehe-54.json`.

Luftbilder nicht ins Repo legen (Bildrechte). Nach Code-Änderungen `node pv-planer/test.js`.
