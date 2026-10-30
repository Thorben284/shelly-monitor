#!/usr/bin/env node
/* Planer mit Luftbild: Flächenauswahl und Modulauslegung.
   node tools/areas.js <roof.json> <out.html>
   roof.json: frame (Ursprung lon/lat + Längsachse °), areas = Kandidaten (Umrisse in Gebäudekoordinaten u/v, Meter;
   `selected` = vom Nutzer gewählt, `mountings` gesetzt = analysiert und belegt), excluded, obstacles,
   aerial (Bild + Georeferenz + Ausschnitt), pvgis (kWh/kWp·a je "Neigung|Azimut"), request (letzte Auswahl der Seite). */
"use strict";
const fs = require("fs"), path = require("path");
const E = require("../engine.js"), A = require("./aerial.js");
const { chromium } = require("playwright");

const OB = {   // Hindernisse auf Flachdächern: Maß (m) und Abstand c (m), Annahmen
  lichtkuppel: { label: "Lichtkuppel", w: 1.2, h: 1.2, c: .5 },
  entlueftung: { label: "Lüfter/Entlüftung", w: .4, h: .4, c: .3 },
  ausstieg: { label: "Dachausstieg", w: .9, h: .9, c: .5 },
  schornstein: { label: "Schornstein", w: .6, h: .6, c: .5 },
  antenne: { label: "Antenne", w: .4, h: .4, c: .5 },
  sonstiges: { label: "Hindernis", w: .5, h: .5, c: .3 }
};
const D2R = Math.PI / 180;

async function main(cfgFile, out) {
  const R = JSON.parse(fs.readFileSync(cfgFile, "utf8")), dir = path.dirname(path.resolve(cfgFile));
  const M = Object.assign({ wp: 450, l: 1.762, b: 1.134 }, R.module || {});
  R.areas = R.areas || []; R.obstacles = R.obstacles || []; R.pvgis = R.pvgis || {};
  const F = R.frame || { origin: [0, 0], bearing: 0 }, br = F.bearing;
  const eu = [Math.sin(br * D2R), Math.cos(br * D2R)], ev = [Math.sin((br + 90) * D2R), Math.cos((br + 90) * D2R)];
  const kx = Math.cos(F.origin[1] * D2R) * 111320, ky = 110540;
  const ll = ([u, v]) => [F.origin[0] + (u * eu[0] + v * ev[0]) / kx, F.origin[1] + (u * eu[1] + v * ev[1]) / ky];
  const AE = R.aerial, [cx0, cy0, cx1, cy1] = AE ? AE.crop : [0, 0, 0, 0], S = AE ? AE.scale || 2 : 1;
  const px = uv => { const [lo, la] = ll(uv), p = A.toPx(AE, la, lo); return [+((p[0] - cx0) * S).toFixed(1), +((p[1] - cy0) * S).toFixed(1)]; };
  const toAsp = c => E.toAspect(c);
  const obst = R.obstacles.map(o => Object.assign({}, OB[o.type] || OB.sonstiges, o));
  const inside = (o, poly) => E.inPoly(o.u, o.v, poly);

  /* Montagearten: lokales System (x entlang Reihe, y quer), Modulgrundriss, Reihenabstände, Ausrichtungen */
  const facingV = Math.abs(toAsp(br + 90)) <= 90 ? 1 : -1;            // welche Querrichtung zur Sonne zeigt
  /* Flachdach-Aufständerung; R.orient = "hoch": Module hochkant (lange Seite in Neigungsrichtung), Reihenabstand Süd im gleichen Verhältnis */
  const hoch = R.orient === "hoch", mw = hoch ? M.b : M.l, md = hoch ? M.l : M.b, dep = t => md * Math.cos(t * D2R);
  const MOUNT = {
    sued: { label: "Süd aufgeständert 15°", tilt: 15, axes: "uv", w: mw, h: dep(15), pitches: [2.2 * md / M.b], comp: [br + 90 * facingV] },
    ow: { label: "Ost-West 10°", tilt: 10, axes: "vu", w: mw, h: dep(10), pitches: [dep(10) + .05, dep(10) + .35], comp: [br, br + 180] },
    eben: { label: "flach 5°", tilt: 5, axes: "uv", w: mw, h: dep(5), pitches: [dep(5) + .02], comp: [br + 90 * facingV] }
  };
  /* Geneigte Dachfläche (`slope: {tilt, fall}`, fall = Gefällerichtung ° ab Nord): Module dachparallel,
     lokales x entlang der Traufe, y hangaufwärts in wahrer Länge (Grundriss / cos Neigung) */
  const pitched = (a, orient) => {
    const t = a.slope.tilt, f = a.slope.fall * D2R, d = [Math.sin(f), Math.cos(f)], r = [Math.cos(f), -Math.sin(f)], ct = Math.cos(t * D2R);
    const [w, h] = orient === "hoch" ? [M.b, M.l] : [M.l, M.b];
    return { label: `dachparallel ${t}°, ${orient}kant`, tilt: t, axes: "plane", plane: { d, r, ct }, w, h, pitches: [h + .02], comp: [a.slope.fall] };
  };
  const mountOf = (a, mk) => mk === "dach_hoch" ? pitched(a, "hoch") : mk === "dach_quer" ? pitched(a, "quer") : MOUNT[mk];
  const toLocal = (m, [u, v]) => {
    if (m.axes === "uv") return [u, v];
    if (m.axes === "vu") return [v, u];
    const { d, r, ct } = m.plane, e = u * eu[0] + v * ev[0], n = u * eu[1] + v * ev[1];
    return [e * r[0] + n * r[1], -(e * d[0] + n * d[1]) / ct];
  };
  const fromLocal = (m, [x, y]) => {
    if (m.axes === "uv") return [x, y];
    if (m.axes === "vu") return [y, x];
    const { d, r, ct } = m.plane, e = x * r[0] - y * ct * d[0], n = x * r[1] - y * ct * d[1];
    return [e * eu[0] + n * eu[1], e * ev[0] + n * ev[1]];
  };
  const missing = new Set();   // fehlende PVGIS-Werte sammeln, am Ende alle auf einmal melden (parallel abrufbar)
  const yieldOf = m => { const ks = m.comp.map(c => `${m.tilt}|${toAsp(c)}`); ks.filter(k => !R.pvgis[k]).forEach(k => missing.add(k)); return ks.reduce((a, k) => a + (R.pvgis[k] || 0), 0) / ks.length; };

  const areas = R.areas.map(a => {
    const area = (() => { let s = 0; const P = a.poly; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; })();
    const obs = a.mountings ? obst.filter(o => inside(o, a.poly)) : [];
    const variants = {};
    for (const mk of (a.mountings || []).filter(k => !hoch || k !== "dach_quer")) {
      const m = mountOf(a, mk);
      const L = E.layoutArea({
        poly: a.poly.map(p => toLocal(m, p)), edge: a.edge, w: m.w, h: m.h, pitches: m.pitches,
        obstacles: obs.map(o => { const [x, y] = toLocal(m, [o.u, o.v]); return { x, y, w: m.axes === "vu" ? o.h : o.w, h: m.axes === "vu" ? o.w : o.h, c: o.c }; }),
        holes: (R.excluded || []).map(e => e.poly.map(p => toLocal(m, p))), holeGap: a.edge
      });
      const mods = L.pos.map(q => [[q.x, q.y], [q.x + L.w, q.y], [q.x + L.w, q.y + L.h], [q.x, q.y + L.h]].map(p => px(fromLocal(m, p))));
      const off = ((a.off || {})[mk] || []).filter(j => j < mods.length);   // im Planer entfernte Module (gespeichert)
      variants[mk] = { label: m.label, tilt: m.tilt, aspects: m.comp.map(toAsp), count: L.count - off.length, spec: Math.round(yieldOf(m)), mods, off,
        m: { w: m.w, h: m.h, pitches: m.pitches, axes: m.axes, plane: m.plane } };   // Montagegeometrie: Neuberechnung im Planer nach Kantenänderung
    }
    return { id: a.id, name: a.name, building: a.building, kind: a.kind || "", note: a.note || "", area: Math.round(area), edge: a.edge, uv: a.poly,
      analysed: !!a.mountings, mounting: a.mountings ? Object.keys(variants).reduce((b, k) => variants[k].count > variants[b].count ? k : b) : null, selected: !!a.selected,   // Vorgabe: Variante mit den meisten Modulen
      outline: a.poly.map(px), obstacles: obs.map(o => ({ label: o.label, poly: [[o.u - o.w / 2, o.v - o.h / 2], [o.u + o.w / 2, o.v - o.h / 2], [o.u + o.w / 2, o.v + o.h / 2], [o.u - o.w / 2, o.v + o.h / 2]].map(px),
        zone: [[o.u - o.w / 2 - o.c, o.v - o.h / 2 - o.c], [o.u + o.w / 2 + o.c, o.v - o.h / 2 - o.c], [o.u + o.w / 2 + o.c, o.v + o.h / 2 + o.c], [o.u - o.w / 2 - o.c, o.v + o.h / 2 + o.c]].map(px) })),
      variants };
  });

  if (missing.size) {
    const g = R.geo || (R.aerial ? { lat: R.aerial.lat, lon: R.aerial.lon } : null), u = k => { const [t, a] = k.split("|"); return `https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=${g.lat.toFixed(4)}&lon=${g.lon.toFixed(4)}&peakpower=1&loss=14&angle=${t}&aspect=${a}&usehorizon=1&outputformat=basic`; };
    throw new Error("PVGIS fehlt (" + missing.size + "), Jahreswert = Zeile \"Year\", 2. Spalte:\n" + [...missing].map(k => `  "${k}": ${g ? u(k) : "(geo fehlt)"}`).join("\n"));
  }
  /* Obergrenze R.target_kwp: Flächen nach spezifischem Ertrag füllen; die letzte Fläche wird auf die Restzahl gekürzt */
  if (R.target_kwp) {
    let left = Math.floor(R.target_kwp * 1000 / M.wp + 1e-9);
    const cand = areas.filter(a => a.mounting).sort((x, y) => y.variants[y.mounting].spec - x.variants[x.mounting].spec);
    for (const a of areas) a.selected = false;
    for (const a of cand) {
      if (left <= 0) break;
      const v = a.variants[a.mounting];
      if (v.count > left) { for (const k of Object.keys(a.variants)) { const w = a.variants[k]; if (w.count > left) { const keep = new Set(w.off); let n = 0; w.off = w.mods.map((_, j) => j).filter(j => keep.has(j) || ++n > left); w.count = left; } } }
      a.selected = true; left -= a.variants[a.mounting].count;
    }
  }
  // Luftbildausschnitt als JPEG (ohne Luftbild: leerer Planer mit Adresseingabe)
  const jpg = AE ? await cropJpeg(path.resolve(dir, AE.file), AE.crop, S) : null;
  const data = {
    address: R.address || "", title: R.title || R.address || "", created: new Date().toISOString().slice(0, 10), stamp: Date.now(), module: M,
    image: AE ? { src: jpg, w: (cx1 - cx0) * S, h: (cy1 - cy0) * S, mpp: A.mpp(AE) / S, source: AE.source } : null,
    excluded: (R.excluded || []).map(e => ({ name: e.name, poly: e.poly.map(px) })),
    areas, target: R.target_kwp || null, entrances: R.entrances || null, addresses: R.addresses || null, split: R.split || null,
    // Hausteile je Hausnummer (Katasterumrisse) für die Aufteilung auf Eingänge
    parts: (R.parts || []).map(q => ({ name: q.name, poly: q.poly.map(px) })), notes: R.notes || [], geo: R.geo || null, request: R.request || null, processed: R.processed || null, status: R.status || null, progress: R.progress || null
  };
  /* Für die Kantenbearbeitung im Planer: Gebäudeachsen, lineare Abbildung u/v (m) → Bildpixel, Hindernisse und Aussparungen in u/v */
  if (AE) {
    const o = px([0, 0]), pu = px([10, 0]), pv = px([0, 10]);
    data.lay = { eu, ev, aff: { o, u: [(pu[0] - o[0]) / 10, (pu[1] - o[1]) / 10], v: [(pv[0] - o[0]) / 10, (pv[1] - o[1]) / 10] },
      obs: obst.map(q => ({ u: q.u, v: q.v, w: q.w, h: q.h, c: q.c, label: q.label })), excl: (R.excluded || []).map(e => e.poly) };
  }
  /* Belegungsrechnung aus dem Rechenkern in die Seite übernehmen (eine Quelle) */
  const eng = fs.readFileSync(path.join(__dirname, "..", "engine.js"), "utf8");
  const kit = "const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));\n" + eng.slice(eng.indexOf("  function inPoly("), eng.indexOf("  /* ---------- Gebäudeumriss"));
  const tpl = fs.readFileSync(path.join(__dirname, "..", "planer.html"), "utf8").replace("/*__LAYOUT__*/", () => kit);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  fs.writeFileSync(out, tpl.replace(/__TITLE__/g, esc(R.title || R.address || "")).replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c")));
  for (const a of areas) console.log(a.selected ? "[x]" : "[ ]", a.id.padEnd(3), a.name.padEnd(22), `${a.area} m²`.padStart(7), Object.entries(a.variants).map(([k, v]) => `${k}: ${v.count} Mod. (${v.spec} kWh/kWp)`).join(" | "), `Hindernisse ${a.obstacles.length}`);
  console.log(out, Math.round(fs.statSync(out).size / 1024) + " KB");
}

async function cropJpeg(file, c, S) {
  const b = await chromium.launch(), p = await b.newPage();
  const src = "data:image/png;base64," + fs.readFileSync(file).toString("base64");
  const jpg = await p.evaluate(async ([src, c, S]) => {
    const im = new Image(); im.src = src; await im.decode();
    const cv = document.createElement("canvas"); cv.width = (c[2] - c[0]) * S; cv.height = (c[3] - c[1]) * S;
    const g = cv.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, c[0], c[1], c[2] - c[0], c[3] - c[1], 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", .82);
  }, [src, c, S]);
  await b.close();
  return jpg;
}
main(process.argv[2], process.argv[3]).catch(e => { console.error(e.message || e); process.exit(1); });
