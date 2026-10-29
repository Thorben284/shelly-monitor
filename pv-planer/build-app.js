#!/usr/bin/env node
/* Baut die eigenständige Planerseite: node build-app.js <out.html> */
"use strict";
const fs = require("fs"), path = require("path");
const rd = f => fs.readFileSync(path.join(__dirname, f), "utf8");
/* Beispiel: fiktives Haus 12 × 9 m in Kiel, Längsachse Ost-West; PVGIS-Werte für Kiel, 35°, Süd/Nord */
const lat = 54.32, lon = 10.13, L = 12, W = 9, br = 84;
const b = br * Math.PI / 180, u = [Math.sin(b), Math.cos(b)], v = [u[1], -u[0]], kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
const coords = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([s, t]) => [+(lon + (s * L / 2 * u[0] + t * W / 2 * v[0]) / kx).toFixed(7), +(lat + (s * L / 2 * u[1] + t * W / 2 * v[1]) / ky).toFixed(7)]);
const EXAMPLE = {
  example: true, planned: true, address: "Beispielhaus, Kiel", geo: { lat, lon, coords, osm: "" },
  obstacles: [{ type: "dachfenster", face: "F1", x: "halb links", y: "unten" }, { type: "schornstein", face: "F1", x: "rechts", y: "oben" }],
  pvgis: {
    "35|-6": { m: [25.24, 41.69, 82.74, 122.54, 133.83, 131.99, 126.13, 114.19, 93.67, 63.83, 31.03, 20.01] },
    "35|174": { m: [6.71, 12.64, 27.02, 53.24, 88.03, 101.22, 93.31, 64.89, 33.0, 18.02, 8.0, 4.75] }
  }
};
const html = rd("app.html").replace("/*__ENGINE__*/", () => rd("engine.js")).replace("/*__VIEW__*/", () => rd("view.js"))
  .replace("/*__EXAMPLE__*/null", () => JSON.stringify(EXAMPLE).replace(/</g, "\\u003c"));
fs.writeFileSync(process.argv[2] || "pv-planer.html", html);
console.log(`${process.argv[2] || "pv-planer.html"}: ${Math.round(html.length / 1024)} KB`);
