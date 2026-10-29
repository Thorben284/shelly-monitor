#!/usr/bin/env node
/* Amtliche Referenzdaten Niedersachsen (LGLN, CC BY 4.0) für den Flächenabgleich.
   node tools/kataster.js alkis <wfs.gml> [oid]          Gebäudeumrisse aus dem ALKIS-WFS (vereinfacht, EPSG:4326) → JSON
   node tools/kataster.js lod2 <dump.txt|.json> <id>      Dachflächen eines LoD2-Gebäudes (Text ohne XML-Tags, wie Firecrawl ihn liefert) → JSON
   node tools/kataster.js uv <frame.json> <data.json>     Umrisse/Dachflächen in Gebäudekoordinaten u/v (Meter) umrechnen
   Ausgabe: {buildings:[{oid, name, ll:[[lon,lat],…]}]} bzw. {ground, roofs:[{tilt, az, area, plan, zmin, zmax, ll}]} */
"use strict";
const fs = require("fs");
const D2R = Math.PI / 180;

/* UTM (ETRS89/WGS84, Zone 32) → [lat, lon] */
function utmToLL(E, N, zone = 32) {
  const a = 6378137, f = 1 / 298.257223563, k0 = .9996, e2 = f * (2 - f), ep = e2 / (1 - e2), x = E - 500000;
  const mu = N / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256)), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep * Math.cos(p1) ** 2, R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, d = x / (N1 * k0);
  const lat = p1 - N1 * Math.tan(p1) / R1 * (d * d / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep) * d ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep - 3 * C1 * C1) * d ** 6 / 720);
  const lon = (d - (1 + 2 * T1 + C1) * d ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep + 24 * T1 * T1) * d ** 5 / 120) / Math.cos(p1);
  return [lat / D2R, (zone * 6 - 183) + lon / D2R];
}

/* ALKIS-WFS: GebaeudeBauwerk mit posList "lat lon lat lon …" */
function alkis(gml, oid) {
  const out = [];
  for (const m of gml.matchAll(/<GebaeudeBauwerk[\s\S]*?<\/GebaeudeBauwerk>/g)) {
    const g = m[0], id = (g.match(/<oid>([^<]+)/) || [])[1];
    if (oid && id !== oid) continue;
    const n = (g.match(/<gml:posList[^>]*>([^<]+)/) || [])[1].trim().split(/\s+/).map(Number), ll = [];
    for (let i = 0; i < n.length; i += 2) ll.push([n[i + 1], n[i]]);
    out.push({ oid: id, name: (g.match(/<name>([^<]+)/) || [])[1] || "", funktion: (g.match(/<funktion>([^<]+)/) || [])[1] || "", lage: (g.match(/<lagebeztxt>([^<]+)/) || [])[1] || "", ll });
  }
  return { buildings: out };
}

/* LoD2 ohne Tags: Koordinaten "E N H" je Ring durch Leerzeichen getrennt, Ringe direkt aneinandergeklebt */
function lod2(text, id) {
  const i = text.indexOf(id);
  if (i < 0) throw new Error("Gebäude " + id + " nicht gefunden");
  const rest = text.slice(i), next = [...rest.matchAll(/DENIAL\w{12}/g)].find(m => !m[0].startsWith(id));
  const seg = rest.slice(0, next ? next.index : rest.length).replace(/(\d{2}\.\d{1,3})(?=5\d{5}\.\d)/g, "$1|");
  const rings = [];
  for (const ch of seg.split("|")) {
    const p = [...ch.matchAll(/(5\d{5}\.\d{1,3}) (5\d{6}\.\d{1,3}) (\d{2,3}\.\d{1,3})/g)].map(m => [+m[1], +m[2], +m[3]]);
    if (p.length >= 4 && p[0].every((v, k) => v === p[p.length - 1][k])) rings.push(p.slice(0, -1));
  }
  if (!rings.length) throw new Error("keine Flächen erkannt");
  const ground = Math.min(...rings.flat().map(p => p[2])), roofs = [];
  for (const r of rings) {
    let nx = 0, ny = 0, nz = 0;
    r.forEach((p, k) => { const q = r[(k + 1) % r.length]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); });
    const L = Math.hypot(nx, ny, nz);
    if (!L || Math.abs(nz) / L < .05 || r.every(p => Math.abs(p[2] - ground) < .01)) continue;   // Wände, Grundfläche
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const tilt = Math.acos(nz / L) / D2R, zs = r.map(p => p[2] - ground);
    roofs.push({ tilt: +tilt.toFixed(1), az: tilt > 2 ? Math.round((Math.atan2(nx, ny) / D2R + 360) % 360) : null, area: +(L / 2).toFixed(1), plan: +(nz / 2).toFixed(1),
      zmin: +Math.min(...zs).toFixed(2), zmax: +Math.max(...zs).toFixed(2), ll: r.map(p => { const [la, lo] = utmToLL(p[0], p[1]); return [lo, la]; }) });
  }
  return { id, ground: +ground.toFixed(2), roofs };
}

/* lon/lat → u/v im Gebäudesystem von roof.json */
function toUV(frame) {
  const b = frame.bearing, eu = [Math.sin(b * D2R), Math.cos(b * D2R)], ev = [Math.sin((b + 90) * D2R), Math.cos((b + 90) * D2R)];
  const kx = Math.cos(frame.origin[1] * D2R) * 111320, ky = 110540;
  return ([lo, la]) => { const e = (lo - frame.origin[0]) * kx, n = (la - frame.origin[1]) * ky; return [+(e * eu[0] + n * eu[1]).toFixed(2), +(e * ev[0] + n * ev[1]).toFixed(2)]; };
}

module.exports = { utmToLL, alkis, lod2, toUV };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2), read = f => { const t = fs.readFileSync(f, "utf8"); try { const j = JSON.parse(t); return j.answer || j.rawHtml || t; } catch { return t; } };
  let r;
  if (cmd === "alkis") r = alkis(read(a), b);
  else if (cmd === "lod2") r = lod2(read(a), b);
  else if (cmd === "uv") {
    const R = JSON.parse(fs.readFileSync(a, "utf8")), uv = toUV(R.frame || R), d = JSON.parse(fs.readFileSync(b, "utf8"));
    for (const x of d.buildings || d.roofs) x.uv = x.ll.map(uv);
    r = d;
  } else { console.error("node tools/kataster.js alkis|lod2|uv …"); process.exit(1); }
  console.log(JSON.stringify(r));
}
