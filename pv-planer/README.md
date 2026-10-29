# PV-Planer

PV-Auslegung für eine Adresse: Gebäudeumriss aus OpenStreetMap, Erträge aus PVGIS, stündliche Simulation mit Speicher, Optimierung nach Kapitalwert, Planungsseite als HTML.

Ablauf und Fragen: `.claude/skills/pv-planer/SKILL.md`.

```
node plan.js init  nom.json cfg.json        # Nominatim-Antwort (mit polygon_geojson=1) → Konfiguration
node plan.js rect  cfg.json 12 9 90         # Rechteck statt OSM-Umriss (Länge, Breite, Längsachse ° ab Nord)
node plan.js faces cfg.json                 # Dachflächen und fehlende PVGIS-Abfragen
node plan.js pvgis cfg.json 35 -6 25.2,...  # 12 PVGIS-Monatswerte (E_m, kWh/kWp) eintragen
node plan.js build cfg.json plan.html       # optimieren, Seite erzeugen
```

Tests: `node test.js` (Rechenkern, CLI, Kalibrierung) und `node test-ui.js plan.html` (Seite, benötigt Playwright).

Keine Abhängigkeiten außer Node ≥ 18.
