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
  const br = R.frame.bearing, eu = [Math.sin(br * D2R), Math.cos(br * D2R)], ev = [Math.sin((br + 90) * D2R), Math.cos((br + 90) * D2R)];
  const kx = Math.cos(R.frame.origin[1] * D2R) * 111320, ky = 110540;
  const ll = ([u, v]) => [R.frame.origin[0] + (u * eu[0] + v * ev[0]) / kx, R.frame.origin[1] + (u * eu[1] + v * ev[1]) / ky];
  const AE = R.aerial, [cx0, cy0, cx1, cy1] = AE.crop, S = AE.scale || 2;
  const px = uv => { const [lo, la] = ll(uv), p = A.toPx(AE, la, lo); return [+((p[0] - cx0) * S).toFixed(1), +((p[1] - cy0) * S).toFixed(1)]; };
  const toAsp = c => E.toAspect(c);
  const obst = R.obstacles.map(o => Object.assign({}, OB[o.type] || OB.sonstiges, o));
  const inside = (o, poly) => E.inPoly(o.u, o.v, poly);

  /* Montagearten: lokales System (x entlang Reihe, y quer), Modulgrundriss, Reihenabstände, Ausrichtungen */
  const facingV = Math.abs(toAsp(br + 90)) <= 90 ? 1 : -1;            // welche Querrichtung zur Sonne zeigt
  const MOUNT = {
    sued: { label: "Süd aufgeständert 15°", tilt: 15, axes: "uv", w: M.l, h: M.b * Math.cos(15 * D2R), pitches: [2.2], comp: [br + 90 * facingV] },
    ow: { label: "Ost-West 10°", tilt: 10, axes: "vu", w: M.l, h: M.b * Math.cos(10 * D2R), pitches: [M.b * Math.cos(10 * D2R) + .05, M.b * Math.cos(10 * D2R) + .35], comp: [br, br + 180] },
    eben: { label: "flach 5°", tilt: 5, axes: "uv", w: M.l, h: M.b * Math.cos(5 * D2R), pitches: [M.b * Math.cos(5 * D2R) + .02], comp: [br + 90 * facingV] }
  };
  const toLocal = (ax, [u, v]) => ax === "uv" ? [u, v] : [v, u];
  const fromLocal = (ax, [x, y]) => ax === "uv" ? [x, y] : [y, x];
  const yieldOf = m => { const ks = m.comp.map(c => `${m.tilt}|${toAsp(c)}`); const miss = ks.filter(k => !R.pvgis[k]); if (miss.length) throw new Error("PVGIS fehlt: " + miss.join(", ")); return ks.reduce((a, k) => a + R.pvgis[k], 0) / ks.length; };

  const areas = R.areas.map(a => {
    const area = (() => { let s = 0; const P = a.poly; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; })();
    const obs = a.mountings ? obst.filter(o => inside(o, a.poly)) : [];
    const variants = {};
    for (const mk of a.mountings || []) {
      const m = MOUNT[mk];
      const L = E.layoutArea({
        poly: a.poly.map(p => toLocal(m.axes, p)), edge: a.edge, w: m.w, h: m.h, pitches: m.pitches,
        obstacles: obs.map(o => { const [x, y] = toLocal(m.axes, [o.u, o.v]); return { x, y, w: m.axes === "uv" ? o.w : o.h, h: m.axes === "uv" ? o.h : o.w, c: o.c }; }),
        holes: (R.excluded || []).map(e => e.poly.map(p => toLocal(m.axes, p))), holeGap: a.edge
      });
      const mods = L.pos.map(q => [[q.x, q.y], [q.x + L.w, q.y], [q.x + L.w, q.y + L.h], [q.x, q.y + L.h]].map(p => px(fromLocal(m.axes, p))));
      variants[mk] = { label: m.label, tilt: m.tilt, aspects: m.comp.map(toAsp), count: L.count, spec: Math.round(yieldOf(m)), mods };
    }
    return { id: a.id, name: a.name, building: a.building, kind: a.kind || "", note: a.note || "", area: Math.round(area), edge: a.edge,
      analysed: !!a.mountings, mounting: a.mountings ? a.mountings[0] : null, selected: !!a.selected,
      outline: a.poly.map(px), obstacles: obs.map(o => ({ label: o.label, poly: [[o.u - o.w / 2, o.v - o.h / 2], [o.u + o.w / 2, o.v - o.h / 2], [o.u + o.w / 2, o.v + o.h / 2], [o.u - o.w / 2, o.v + o.h / 2]].map(px),
        zone: [[o.u - o.w / 2 - o.c, o.v - o.h / 2 - o.c], [o.u + o.w / 2 + o.c, o.v - o.h / 2 - o.c], [o.u + o.w / 2 + o.c, o.v + o.h / 2 + o.c], [o.u - o.w / 2 - o.c, o.v + o.h / 2 + o.c]].map(px) })),
      variants };
  });

  // Luftbildausschnitt als JPEG
  const b = await chromium.launch(), p = await b.newPage();
  const src = "data:image/png;base64," + fs.readFileSync(path.resolve(dir, AE.file)).toString("base64");
  const jpg = await p.evaluate(async ([src, c, S]) => {
    const im = new Image(); im.src = src; await im.decode();
    const cv = document.createElement("canvas"); cv.width = (c[2] - c[0]) * S; cv.height = (c[3] - c[1]) * S;
    const g = cv.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, c[0], c[1], c[2] - c[0], c[3] - c[1], 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", .82);
  }, [src, AE.crop, S]);
  await b.close();

  const data = {
    address: R.address, title: R.title || R.address, created: new Date().toISOString().slice(0, 10), stamp: Date.now(), module: M,
    image: { src: jpg, w: (cx1 - cx0) * S, h: (cy1 - cy0) * S, mpp: A.mpp(AE) / S, source: AE.source },
    excluded: (R.excluded || []).map(e => ({ name: e.name, poly: e.poly.map(px) })),
    areas, notes: R.notes || [], geo: R.geo, request: R.request || null
  };
  const tpl = fs.readFileSync(path.join(__dirname, "..", "planer.html"), "utf8");
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  fs.writeFileSync(out, tpl.replace(/__TITLE__/g, esc(R.title || R.address)).replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c")));
  for (const a of areas) console.log(a.selected ? "[x]" : "[ ]", a.id.padEnd(3), a.name.padEnd(22), `${a.area} m²`.padStart(7), Object.entries(a.variants).map(([k, v]) => `${k}: ${v.count} Mod. (${v.spec} kWh/kWp)`).join(" | "), `Hindernisse ${a.obstacles.length}`);
  console.log(out, Math.round(fs.statSync(out).size / 1024) + " KB");
}
main(process.argv[2], process.argv[3]).catch(e => { console.error(e.message || e); process.exit(1); });
