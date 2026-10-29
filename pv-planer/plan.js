#!/usr/bin/env node
/* PV-Planer CLI
   node plan.js init  <nominatim.json> <config.json>   Konfiguration aus Adresssuche anlegen
   node plan.js rect  <config.json> <L> <B> <Achse°>   Rechteck statt OSM-Umriss (Maße in m, Längsachse ab Nord)
   node plan.js faces <config.json>                    Dachflächen + benötigte PVGIS-Abfragen anzeigen
   node plan.js pvgis <config.json> <tilt> <aspect> <E_m1,...,E_m12>   PVGIS-Monatswerte eintragen
   node plan.js build <config.json> <out.html>         Optimieren und Planungsseite erzeugen */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./engine.js");

const DEFAULTS = {
  roof: { type: "sattel", tilt: 35, ridge: "long", edge: 0.3, overhang: 0, pultDir: "sued", mounting: "ow" },
  faceOverrides: {},
  consumption: { household: 4000, heatpump: 0, ev: 0, evMode: "abends" },
  module: { wp: 450, l: 1.762, b: 1.134, kg: 21.5, ukKg: 3 },
  econ: { pvFix: 2500, pvKwp: 1000, batFix: 2000, batKwh: 450, price: 32, inc: 2, fit10: 7.70, fit40: 6.67, fit100: 5.45,
    opexPct: 1, deg: 0.5, years: 20, disc: 3 },
  feedCap: true,
  pvgis: {}
};
const key = (t, a) => `${Math.round(t)}|${Math.round(a)}`;
const fmt = (x, d = 0) => Number.isFinite(x) ? x.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
const shortAddr = a => { const p = String(a || "").split(",").map(x => x.trim()); return /^\d/.test(p[0]) ? `${p[1]} ${p[0]}` : p[0]; };
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
const merge = (d, c) => { const o = {}; for (const k in d) o[k] = (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) ? Object.assign({}, d[k], c[k] || {}) : (c[k] !== undefined ? c[k] : d[k]); for (const k in c) if (!(k in o)) o[k] = c[k]; return o; };

function load(file) {
  const c = merge(DEFAULTS, read(file));
  if (!c.geo || !c.geo.coords) throw new Error("Kein Gebäudeumriss in der Konfiguration (geo.coords).");
  c.fp = E.footprint(c.geo.coords);
  c.faces = E.deriveFaces(c.fp, c.roof).map(f => {
    const o = c.faceOverrides[f.id] || {};
    Object.assign(f, o.shape || {});
    if (o.orient) f.orient = o.orient;
    if (o.obstacles) f.obstacles = o.obstacles;
    f.layout = E.layoutFace(f, c.module);
    f.reduce = o.reduce || 0;
    f.exclude = !!o.exclude;
    f.max = f.exclude ? 0 : Math.max(0, f.layout.count - f.reduce);
    return f;
  });
  return c;
}
const pvgisUrl = (c, f) => `https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=${c.geo.lat}&lon=${c.geo.lon}&peakpower=1&loss=14&angle=${Math.round(f.tilt)}&aspect=${Math.round(f.aspect)}&usehorizon=1&outputformat=json`;

function printFaces(c) {
  const fp = c.fp;
  console.log(`Gebäude: ${fmt(fp.L, 1)} × ${fmt(fp.W, 1)} m (Rechteck um Umriss), Grundfläche ${fmt(fp.area)} m², Längsachse ${fmt(fp.bearing)}° (${E.compassName(fp.bearing)}–${E.compassName(fp.bearing + 180)})`);
  console.log(`Dach: ${c.roof.type}, ${c.roof.tilt}°, First ${c.roof.ridge === "short" ? "quer" : "längs"}`);
  for (const f of c.faces) {
    console.log(`${f.id} ${f.name.padEnd(9)} Azimut ${String(f.aspect).padStart(4)}° Neigung ${f.tilt}°  Traufe ${fmt(f.eave, 2)} m, oben ${fmt(f.top, 2)} m, Sparren ${fmt(f.slope, 2)} m → ${f.layout.count} Module (${f.layout.orient})${f.reduce ? `, −${f.reduce}` : ""}${f.exclude ? " AUSGESCHLOSSEN" : ""}`);
    f.layout.obstacles.forEach((o, i) => console.log(`     ${i + 1}. ${o.label} ${fmt(o.w, 2)}×${fmt(o.h, 2)} m bei x=${fmt(o.x, 2)} m, y=${fmt(o.y, 2)} m, Abstand ${fmt(o.c, 2)} m`));
  }
  const need = [...new Map(c.faces.map(f => [key(f.tilt, f.aspect), f])).values()].filter(f => !c.pvgis[key(f.tilt, f.aspect)]);
  if (need.length) { console.log("\nPVGIS fehlt für:"); need.forEach(f => console.log(`  ${key(f.tilt, f.aspect)}  ${pvgisUrl(c, f)}`)); }
  else console.log("\nPVGIS-Daten vollständig.");
}

const [, , cmd, a1, a2, a3, a4] = process.argv;
if (cmd === "init") {
  const raw = read(a1), r = Array.isArray(raw) ? raw[0] : raw;
  if (!r) throw new Error("Adresse nicht gefunden.");
  const gj = r.geojson || {};
  const coords = gj.type === "Polygon" ? gj.coordinates[0] : gj.type === "MultiPolygon" ? gj.coordinates[0][0] : null;
  const cfg = { address: r.display_name, geo: { lat: +(+r.lat).toFixed(5), lon: +(+r.lon).toFixed(5), category: `${r.category}/${r.type}`, osm: `${r.osm_type}/${r.osm_id}`, coords } };
  fs.writeFileSync(a2, JSON.stringify(cfg, null, 2));
  console.log(`Gespeichert: ${a2}\nTreffer: ${r.display_name} (${cfg.geo.category})`);
  if (!coords) console.log("WARNUNG: kein Gebäudeumriss – Maße erfragen und geo.coords manuell setzen.");
  else printFaces(load(a2));
} else if (cmd === "rect") {   // Ersatz ohne OSM-Umriss: Länge, Breite, Längsachse (° von Nord)
  const raw = read(a1), Lm = +a2, Wm = +a3, br = +a4;
  if (!(Lm > 0 && Wm > 0 && Number.isFinite(br))) throw new Error("rect <config> <Länge m> <Breite m> <Längsachse °>");
  if (!raw.geo || !Number.isFinite(+raw.geo.lat)) throw new Error("geo.lat/geo.lon fehlen.");
  const b = br * Math.PI / 180, u = [Math.sin(b), Math.cos(b)], v = [u[1], -u[0]];
  const kx = Math.cos(raw.geo.lat * Math.PI / 180) * 111320, ky = 110540;
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([s, t]) =>
    [+(raw.geo.lon + (s * Lm / 2 * u[0] + t * Wm / 2 * v[0]) / kx).toFixed(7), +(raw.geo.lat + (s * Lm / 2 * u[1] + t * Wm / 2 * v[1]) / ky).toFixed(7)]);
  raw.geo.coords = pts; raw.geo.manual = true;
  fs.writeFileSync(a1, JSON.stringify(raw, null, 2));
  printFaces(load(a1));
} else if (cmd === "faces") {
  printFaces(load(a1));
} else if (cmd === "pvgis") {
  const raw = read(a1), vals = a4.split(",").map(Number);
  if (vals.length !== 12 || vals.some(v => !Number.isFinite(v))) throw new Error("12 Monatswerte erwartet.");
  raw.pvgis = raw.pvgis || {}; raw.pvgis[key(+a2, +a3)] = vals;
  fs.writeFileSync(a1, JSON.stringify(raw, null, 2));
  console.log(`PVGIS ${key(+a2, +a3)}: ${fmt(vals.reduce((x, y) => x + y, 0))} kWh/kWp·a`);
} else if (cmd === "build") {
  const c = load(a1);
  for (const f of c.faces) {
    const m = c.pvgis[key(f.tilt, f.aspect)];
    if (!m) throw new Error(`PVGIS fehlt für ${f.id} (${key(f.tilt, f.aspect)}). Erst 'faces' ausführen.`);
    f.pvgisYear = m.reduce((x, y) => x + y, 0);
    f.profile = E.pvProfile(c.geo.lat, f.tilt, f.aspect, m, c.geo.lon);
  }
  const L = E.loadProfile(c.consumption);
  const vars = E.optimize(c.faces, L, c);
  if (!vars.length) throw new Error("Keine belegbare Dachfläche.");
  let best = { counts: vars[0].counts, cap: vars[0].cap };
  if (c.best) {
    if (!Array.isArray(c.best.counts) || c.best.counts.length !== c.faces.length) console.log("HINWEIS: 'best' passt nicht zu den Dachflächen und wird ignoriert.");
    else best = { counts: c.best.counts.map((n, i) => Math.max(0, Math.min(c.faces[i].max, Math.round(n) || 0))), cap: Math.max(0, +c.best.cap || 0) };
  }
  const sel = E.evaluate(c.faces, best.counts, best.cap, L, c);
  // Ausgabe
  console.log(`\nVORSCHLAG (Kapitalwert ${c.econ.disc} %, ${c.econ.years} J.)`);
  c.faces.forEach((f, i) => console.log(`  ${f.id} ${f.name}: ${sel.counts[i]}/${f.max} Module, ${fmt(f.pvgisYear)} kWh/kWp`));
  const s = sel.sim, e = sel.eco;
  console.log(`  ${fmt(sel.kwp, 2)} kWp, Speicher ${fmt(sel.cap, 1)} kWh | Ertrag ${fmt(s.pv)} kWh | EV ${fmt(s.evQuote * 100)} % | Autarkie ${fmt(s.autarky * 100)} % | Abregelung ${fmt(s.curt)} kWh`);
  console.log(`  Invest ${fmt(e.invest)} € | Amortisation ${e.payback ? fmt(e.payback, 1) + " J." : "> Laufzeit"} | IRR ${fmt(e.irr * 100, 1)} % | Kapitalwert ${fmt(e.npv)} €`);
  console.log("\nTOP-VARIANTEN");
  vars.slice(0, 6).forEach(v => console.log(`  ${v.counts.join("+")} Mod. ${fmt(v.kwp, 1)} kWp, ${fmt(v.cap, 1)} kWh → Autarkie ${fmt(v.sim.autarky * 100)} %, IRR ${fmt(v.eco.irr * 100, 1)} %, KW ${fmt(v.eco.npv)} €`));
  // Seite
  const data = {
    address: c.address, geo: { lat: c.geo.lat, lon: c.geo.lon, osm: c.geo.osm }, created: new Date().toISOString().slice(0, 10),
    fp: { pts: c.fp.pts.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]), L: c.fp.L, W: c.fp.W, bearing: c.fp.bearing, area: c.fp.area },
    roof: c.roof, module: c.module, consumption: c.consumption, econ: c.econ, feedCap: c.feedCap, best, notes: c.notes || [],
    faces: c.faces.map(f => ({ id: f.id, name: f.name, compass: f.compass, aspect: f.aspect, tilt: f.tilt, eave: f.eave, top: f.top, slope: f.slope, edge: f.edge,
      flat: !!f.flat, coverage: f.coverage, mounting: f.mounting, layout: f.layout, max: f.max, reduce: f.reduce, exclude: f.exclude,
      pvgisYear: f.pvgisYear, pvgisUrl: pvgisUrl(c, f), profile: Array.from(f.profile, v => Math.round(v * 1000)) }))
  };
  const tpl = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
  const html = tpl.replace("/*__ENGINE__*/", () => fs.readFileSync(path.join(__dirname, "engine.js"), "utf8"))
    .replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"))
    .replace(/__TITLE__/g, () => esc(shortAddr(c.address)));
  fs.writeFileSync(a2, html);
  console.log(`\nSeite: ${a2} (${fmt(html.length / 1024)} KB)`);
} else {
  console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 8).join("\n"));
}
