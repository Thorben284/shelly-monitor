# PV-Planer

Planer mit Luftbild: Adresse → mögliche Dachflächen des Grundstücks → Auswahl → Hinderniserkennung und Modulauslegung.
Die Seite (`planer.html`) sendet Anfragen, indem sie sich selbst neu veröffentlicht; Claude beantwortet sie und aktualisiert die Seite.
Ablauf: `.claude/skills/pv-planer/SKILL.md`.

```
node tools/aerial.js overlay bild.png a.json ov.png      # Umrisse/Flächen auf das Luftbild zeichnen (Kontrolle)
node tools/aerial.js grid bild.png x0 y0 x1 y1 out.png 3 # vergrößerter Ausschnitt mit Pixelraster
node tools/areas.js roof.json seite.html                 # Planerseite bauen (Kandidaten, Belegung)
```

`engine.js`: Rechenkern (Belegung freier Umrisse, Hindernisse, PVGIS-Profile). Tests: `node test.js`.
Beispiel: `beispiele/lueneburg-auf-der-hoehe-54.json`. Benötigt Node ≥ 18 und Playwright (Luftbild-Werkzeuge).
