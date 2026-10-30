#!/usr/bin/env node
/* Tests für den PV-Planer: node test.js */
"use strict";
const E = require("./engine.js");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("FEHLER:", msg); } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b} (±${tol})`);
const sum = a => { let s = 0; for (const v of a) s += v; return s; };

/* Rechteck um Ursprung: L × W Meter, Längsachse mit Kompasswinkel bearing */
function rect(L, W, bearing, lat = 52, lon = 10, closed = true) {
  const b = bearing * Math.PI / 180, u = [Math.sin(b), Math.cos(b)], v = [u[1], -u[0]];
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => {
    const x = s * L / 2 * u[0] + t * W / 2 * v[0], y = s * L / 2 * u[1] + t * W / 2 * v[1];
    return [lon + x / kx, lat + y / ky];
  });
  return closed ? c.concat([c[0]]) : c;
}

/* ---------- Gebäudeumriss ---------- */
for (const br of [0, 30, 84, 90, 135, 179]) {
  const fp = E.footprint(rect(12, 8, br));
  near(fp.L, 12, .05, `footprint L bei ${br}°`);
  near(fp.W, 8, .05, `footprint W bei ${br}°`);
  near(fp.area, 96, .5, `footprint Fläche bei ${br}°`);
  const d = Math.abs(fp.bearing - br % 180); near(Math.min(d, 180 - d), 0, .5, `footprint Längsachse bei ${br}°`);
}
{ const fp = E.footprint(rect(10, 10, 20, 52, 10, false)); near(fp.area, 100, .5, "offener Ring Fläche"); }
{ // L-Form 10×10 minus 5×5
  const kx = Math.cos(52 * Math.PI / 180) * 111320, ky = 110540, P = ([x, y]) => [10 + x / kx, 52 + y / ky];
  const fp = E.footprint([[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0]].map(P));
  near(fp.area, 75, .5, "L-Form Fläche"); near(fp.L, 10, .05, "L-Form Rechteck");
}

/* ---------- Dachflächen ---------- */
{
  const fp = E.footprint(rect(12, 8, 90)); // Längsachse Ost-West
  const s = E.deriveFaces(fp, { type: "sattel", tilt: 40, ridge: "long", edge: .3 });
  ok(s.length === 2, "Satteldach 2 Flächen");
  const asp = s.map(f => f.aspect).sort((a, b) => a - b);
  ok(asp[0] === 0 && asp[1] === 180, `Satteldach Süd/Nord: ${asp}`);
  near(s[0].slope, 4 / Math.cos(40 * Math.PI / 180), .01, "Sparrenlänge");
  near(s[0].eave, 12, .05, "Traufe");
  const q = E.deriveFaces(fp, { type: "sattel", tilt: 40, ridge: "short", edge: .3 });
  ok(q.map(f => Math.abs(f.aspect)).every(a => a === 90), `First quer → Ost/West: ${q.map(f => f.aspect)}`);
  near(q[0].eave, 8, .05, "First quer Traufe");
  const w = E.deriveFaces(fp, { type: "walm", tilt: 30, edge: .3 });
  ok(w.length === 4, "Walmdach 4 Flächen");
  ok(w.filter(f => f.top === 0).length === 2, "Walmdach 2 Dreiecke");
  near(w[0].top, 4, .05, "Walm Firstlänge L−W");
  const p = E.deriveFaces(fp, { type: "pult", tilt: 10, edge: .3 });
  ok(p.length === 1 && p[0].aspect === 0, `Pultdach nach Süden: ${p[0].aspect}`);
  const p2 = E.deriveFaces(fp, { type: "pult", tilt: 10, edge: .3, pultDir: "andere" });
  ok(p2[0].aspect === 180, `Pultdach andere Richtung: ${p2[0].aspect}`);
  const fo = E.deriveFaces(fp, { type: "flach", mounting: "ow", edge: 1 });
  ok(fo.length === 2 && fo.map(f => f.aspect).sort((a, b) => a - b).join() === "-90,90", `Flachdach OW: ${fo.map(f => f.aspect)}`);
  const fs2 = E.deriveFaces(fp, { type: "flach", mounting: "sued", edge: 1 });
  ok(fs2.length === 1 && fs2[0].aspect === 0 && fs2[0].tilt === 15, "Flachdach Süd");
  const st = E.deriveFaces(fp, { type: "sattel", tilt: 90, edge: .3 });
  ok(st.every(f => Number.isFinite(f.slope) && f.slope < 100), `Neigung 90° bleibt endlich: ${st[0].slope}`);
  const fp2 = E.footprint(rect(12, 8, 0)); // Längsachse Nord-Süd
  const fo2 = E.deriveFaces(fp2, { type: "flach", mounting: "ow", edge: 1 });
  near((fo2[0].eave - 2) * (fo2[0].slope - 2) + (fo2[1].eave - 2) * (fo2[1].slope - 2), (12 - 2) * (8 - 2), .5, "Flachdach OW nutzbare Fläche");
}

/* ---------- Belegung ---------- */
const MOD = { wp: 450, l: 1.762, b: 1.134 };
{
  const f = { eave: 10, top: 10, slope: 5.5, edge: .3 };
  const p = E.layoutFace(Object.assign({ orient: "p" }, f), MOD);
  ok(p.count === 8 * 2, `hochkant 10×5,5: ${p.count}`);
  const l = E.layoutFace(Object.assign({ orient: "l" }, f), MOD);
  ok(l.count === 5 * 4, `quer 10×5,5: ${l.count}`);
  ok(E.layoutFace(f, MOD).count === 20, "automatisch nimmt Maximum");
  ok(E.layoutFace({ eave: 2 * 1.762 + .02 + .6, top: 2 * 1.762 + .02 + .6, slope: 1.134 + .6, edge: .3, orient: "l" }, MOD).count === 2, "exakt passende Breite (Rundung)");
  const t = E.layoutFace({ eave: 10, top: 0, slope: 5, edge: .3 }, MOD);
  const perRow = {}; t.pos.forEach(q => perRow[q.y] = (perRow[q.y] || 0) + 1); const rn = Object.keys(perRow).sort((a, b) => a - b).map(k => perRow[k]);
  ok(t.count > 0 && rn.every((n, i) => i === 0 || n <= rn[i - 1]), "Dreieck: Reihen nach oben kürzer");
  // Dreieck: kein Modul ragt über die Gratlinie
  ok(t.pos.every(q => { const W = 10 * (1 - (q.y + t.h) / 5), xl = (10 - W) / 2; return q.x >= xl + .3 - 1e-6 && q.x + t.w <= 10 - xl - .3 + 1e-6; }), "Dreieck: Module innerhalb der Grate");
  ok(E.layoutFace({ eave: 1, top: 1, slope: 1, edge: .3 }, MOD).count === 0, "zu kleine Fläche: 0 Module");
  ok(E.layoutFace({ eave: 0, top: 0, slope: 0, edge: .3 }, MOD).count === 0, "Nullfläche");
  ok(E.layoutFace({ eave: -5, top: -5, slope: 3, edge: .3 }, MOD).count === 0, "negative Maße");
  const fl = E.layoutFace({ flat: true, eave: 12, slope: 8, edge: 1, coverage: .8, mounting: "x" }, MOD);
  const flRef = 10 * 6 * .8 / (1.762 * 1.134);
  ok(fl.count >= flRef * .75 && fl.count <= flRef * 1.05, `Flachdach Belegung: ${fl.count} (Belegungsgrad ergibt ${flRef.toFixed(1)})`);
  // alle Module innerhalb der Fläche, keine Überlappung
  const inside = (L, F) => L.pos.every(q => q.x >= F.edge - 1e-6 && q.x + L.w <= F.eave - F.edge + 1e-6 && q.y >= F.edge - 1e-6 && q.y + L.h <= F.slope - F.edge + 1e-6);
  ok(inside(p, f) && inside(l, f), "Module innerhalb der Randabstände");
  const overlap = L => L.pos.some((a, i) => L.pos.some((b, j) => i < j && a.x < b.x + L.w - 1e-6 && b.x < a.x + L.w - 1e-6 && a.y < b.y + L.h - 1e-6 && b.y < a.y + L.h - 1e-6));
  ok(!overlap(p) && !overlap(l) && !overlap(fl), "keine überlappenden Module");

  /* Hindernisse */
  const hit = (L) => L.pos.some(q => L.obstacles.some(o => q.x < o.x + o.w / 2 + o.c - 1e-6 && q.x + L.w > o.x - o.w / 2 - o.c + 1e-6 && q.y < o.y + o.h / 2 + o.c - 1e-6 && q.y + L.h > o.y - o.h / 2 - o.c + 1e-6));
  const types = Object.keys(E.OBST);
  for (const ty of types) for (const [x, y] of [["links", "unten"], ["mitte", "mitte"], ["rechts", "oben"], [3.3, 2.1]]) {
    for (const orient of ["p", "l"]) {
      const L = E.layoutFace(Object.assign({ orient, obstacles: [{ type: ty, x, y }] }, f), MOD);
      ok(!hit(L), `${ty} ${x}/${y} ${orient}: kein Modul im Sperrbereich`);
      ok(L.count <= (orient === "p" ? p.count : l.count), `${ty} ${x}/${y} ${orient}: nicht mehr Module als ohne`);
    }
  }
  const many = E.layoutFace(Object.assign({ obstacles: [{ type: "dachfenster", x: 2, y: 2 }, { type: "dachfenster", x: 6, y: 2 }, { type: "schornstein", x: 8.5, y: 4.8 }, { type: "entlueftung", x: 4, y: 4 }, { type: "antenne", x: "links", y: "oben" }] }, f), MOD);
  ok(!hit(many) && many.count < 20 && many.count > 0, `mehrere Hindernisse: ${many.count} Module`);
  const big = E.layoutFace(Object.assign({ obstacles: [{ type: "gaube", x: 5, y: 2.75, w: 10, h: 6 }] }, f), MOD);
  ok(big.count === 0, "Hindernis über ganze Fläche → 0 Module");
  const own = E.resolveObstacles({ eave: 10, slope: 5, obstacles: [{ type: "dachfenster", w: 1.14, h: 1.18, c: .1, x: "halb links", y: "unten" }] })[0];
  ok(own.w === 1.14 && own.h === 1.18 && own.c === .1 && Math.abs(own.x - 3.5) < 1e-9 && Math.abs(own.y - 1) < 1e-9, "eigene Maße und Lageangaben");
  ok(E.resolveObstacles({ eave: 10, slope: 5, obstacles: [{ type: "unbekannt" }] })[0].label === "Hindernis", "unbekannter Typ → Hindernis");
  const flo = E.layoutFace({ eave: 12, top: 12, slope: 8, edge: 1, flat: true, coverage: .8, mounting: "x", obstacles: [{ type: "ausstieg", x: 6, y: 4 }] }, MOD);
  ok(!hit(flo) && flo.count < fl.count, "Flachdach mit Dachausstieg");
}

/* ---------- Belegung freier Umrisse ---------- */
{
  const base = { edge: .5, w: 1.762, h: 1.095, pitches: [1.115] };
  const sq = Object.assign({ poly: [[0, 0], [10, 0], [10, 6], [0, 6]] }, base);
  ok(E.layoutArea(sq).count === 20, `Rechteck 10×6: ${E.layoutArea(sq).count}`);
  const Ls = Object.assign({}, base, { poly: [[0, 0], [10, 0], [10, 3], [4, 3], [4, 6], [0, 6]] });
  const L = E.layoutArea(Ls);
  const insideP = (R, P, e) => R.pos.every(q => [[q.x, q.y], [q.x + R.w, q.y], [q.x + R.w, q.y + R.h], [q.x, q.y + R.h]].every(c => E.inPoly(c[0], c[1], P)));
  ok(L.count > 0 && insideP(L, Ls.poly), `L-Form: alle Module im Umriss (${L.count})`);
  const ob = Object.assign({}, sq, { obstacles: [{ x: 5, y: 3, w: .4, h: .4, c: .3 }, { x: 2, y: 1.5, w: 1.2, h: 1.2, c: .5 }] });
  const O = E.layoutArea(ob);
  ok(O.count < 20 && O.pos.every(q => ob.obstacles.every(o => q.x + O.w <= o.x - o.w / 2 - o.c + 1e-9 || q.x >= o.x + o.w / 2 + o.c - 1e-9 || q.y + O.h <= o.y - o.h / 2 - o.c + 1e-9 || q.y >= o.y + o.h / 2 + o.c - 1e-9)), `Hindernisse frei (${O.count})`);
  const hole = Object.assign({}, sq, { holes: [[[0, 0], [5, 0], [5, 3], [0, 3]]], holeGap: .3 });
  const Hh = E.layoutArea(hole);
  ok(Hh.pos.every(q => q.x >= 5.3 - 1e-9 || q.y >= 3.3 - 1e-9), `Aussparung frei (${Hh.count})`);
  const xs = new Set(L.pos.map(q => (q.x - L.pos[0].x) / (L.w + .02))); ok([...xs].every(v => Math.abs(v - Math.round(v)) < 1e-6), "Spalten fluchten");
  const tri = Object.assign({}, base, { poly: [[0, 0], [12, 0], [6, 8]] });
  const T = E.layoutArea(tri); ok(T.count > 0 && insideP(T, tri.poly), `Dreieck (${T.count})`);
  ok(E.layoutArea(Object.assign({}, base, { poly: [[0, 0], [1, 0], [1, 1], [0, 1]] })).count === 0, "zu kleine Fläche: 0");
  const ow = Object.assign({}, base, { poly: [[0, 0], [10, 0], [10, 6], [0, 6]], pitches: [1.167, 1.467] });
  const W = E.layoutArea(ow), ys = [...new Set(W.pos.map(q => q.y))].sort((a, b) => a - b);
  ok(ys.length > 1 && ys.slice(1).every((y, i) => { const d = y - ys[i]; return Math.abs(d - 1.167) < 1e-6 || Math.abs(d - 1.467) < 1e-6; }), "Ost-West: Reihenabstände wechseln");
}

/* ---------- PV-Profil ---------- */
const PVG = [25.2, 41.7, 82.7, 122.5, 133.8, 132, 126.1, 114.2, 93.7, 63.8, 31, 20];
{
  const pr = E.pvProfile(54.3, 35, 0, PVG, 10.1);
  ok(pr.length === 8760, "Profil 8760 h");
  ok(pr.every(v => v >= 0 && Number.isFinite(v)), "Profil nicht negativ, endlich");
  const ms = new Array(12).fill(0); pr.forEach((v, i) => ms[E.MONTH[i]] += v);
  ms.forEach((v, m) => near(v, PVG[m], 1e-6, `Monatssumme ${m + 1}`));
  // Nachtstunden (Ortszeit) ohne Ertrag, Mittag mit Ertrag
  let night = 0, noon = 0; for (let d = 0; d < 365; d++) { night += pr[d * 24 + 1] + pr[d * 24 + 23]; noon += pr[d * 24 + 12]; }
  ok(night === 0 && noon > 0, "Nacht 0, Mittag > 0");
  // Sommerzeit: Schwerpunkt Juni später als Januar
  const cog = m => { let a = 0, b = 0; for (let i = 0; i < 8760; i++) if (E.MONTH[i] === m) { a += pr[i] * (i % 24 + .5); b += pr[i]; } return a / b; };
  const cj = cog(0), cs = cog(5);
  ok(cj > 12 && cj < 13 && cs > 13 && cs < 14, `Tagesschwerpunkt Jan ${cj.toFixed(2)} h, Jun ${cs.toFixed(2)} h (Ortszeit)`);
  const east = E.pvProfile(54.3, 35, -90, PVG, 10.1), west = E.pvProfile(54.3, 35, 90, PVG, 10.1);
  let ce = 0, cw = 0, se = 0, sw = 0; for (let i = 0; i < 8760; i++) { ce += east[i] * (i % 24); se += east[i]; cw += west[i] * (i % 24); sw += west[i]; }
  ok(ce / se < cw / sw - 2, "Ostdach vormittags, Westdach nachmittags");
  ok(E.pvProfile(54.3, 35, 180, new Array(12).fill(0), 10).every(v => v === 0), "Nullerträge → Nullprofil");
}

/* ---------- Last ---------- */
{
  const L = E.loadProfile({ household: 4000, heatpump: 3000, ev: 1800, evMode: "tag" });
  near(sum(L.base), 7000, 1e-6, "Grundlast Summe Haushalt + WP");
  near(L.evDay * 365, 1800, 1e-9, "E-Auto Tagesbedarf");
  const z = E.loadProfile({});
  ok(sum(z.base) === 0 && z.evDay === 0, "leerer Verbrauch");
  const hp = E.loadProfile({ heatpump: 1000 }); let jan = 0, jul = 0;
  hp.base.forEach((v, i) => { if (E.MONTH[i] === 0) jan += v; if (E.MONTH[i] === 6) jul += v; });
  ok(jan > 5 * jul, "Wärmepumpe im Winter deutlich höher");
}

/* ---------- Simulation: Energiebilanz ---------- */
function balance(sim, tag) {
  near(sim.pv, sim.direct + sim.evSolar + sim.toBat + sim.feed + sim.curt, 1e-6, `${tag} PV-Bilanz`);
  near(sim.load, sim.direct + sim.evSolar + sim.fromBat + sim.grid, 1e-6, `${tag} Lastbilanz`);
  ok(sim.fromBat <= sim.toBat * .95 * .95 + 1e-6, `${tag} Speicher erzeugt keine Energie`);
  ok(sim.direct >= 0 && sim.feed >= 0 && sim.grid >= 0 && sim.toBat >= 0, `${tag} keine negativen Flüsse`);
  ok(sim.autarky >= 0 && sim.autarky <= 1 && sim.evQuote >= 0 && sim.evQuote <= 1, `${tag} Quoten 0..1`);
  const ms = sim.monthly; near(sum(ms.pv), sim.pv, 1e-6, `${tag} Monats-PV`); near(sum(ms.load), sim.load, 1e-6, `${tag} Monatslast`);
  near(sum(ms.self), sim.self, 1e-6, `${tag} Monats-Eigendeckung`);
}
{
  const pr = E.pvProfile(52, 35, 0, PVG, 10), pv = pr.map(v => v * 10);
  for (const ev of ["abends", "tag"]) for (const cap of [0, 5, 20]) for (const fc of [0, 6]) {
    const L = E.loadProfile({ household: 4000, heatpump: 2000, ev: 2000, evMode: ev });
    const s = E.simulate(pv, L, cap, fc); balance(s, `${ev}/${cap}kWh/cap${fc}`);
    if (fc) ok(s.curt >= 0, "Abregelung ≥ 0");
    if (!fc) ok(s.curt === 0, "ohne Begrenzung keine Abregelung");
  }
  const L = E.loadProfile({ household: 4000 });
  const a = E.simulate(pv, L, 0, 0), b = E.simulate(pv, L, 10, 0);
  ok(b.autarky > a.autarky, "Speicher erhöht Autarkie");
  const n = E.simulate(new Float64Array(8760), L, 10, 0);
  ok(n.self === 0 && n.grid > 0 && n.autarky === 0, "ohne PV alles aus dem Netz");
  const z = E.simulate(pv, E.loadProfile({}), 10, 0);
  ok(z.autarky === 0 && Number.isFinite(z.evQuote), "ohne Verbrauch keine NaN");
  const tag = E.simulate(pv, E.loadProfile({ household: 4000, ev: 2000, evMode: "tag" }), 0, 0);
  const abd = E.simulate(pv, E.loadProfile({ household: 4000, ev: 2000, evMode: "abends" }), 0, 0);
  ok(tag.autarky > abd.autarky, "PV-Überschussladen erhöht Autarkie");
}

/* ---------- Kalibrierung gegen Referenzfälle (HTW / 42watt), Toleranz ±4 Punkte ---------- */
{
  const pr = E.pvProfile(51, 35, 0, PVG, 10);
  const aut = (cons, kwp, cap) => E.simulate(pr.map(v => v * kwp), E.loadProfile({ household: cons }), cap, 0).autarky * 100;
  near(aut(4700, 5, 0), 30, 4, "Referenz 4.700 kWh / 5 kWp / ohne Speicher");
  near(aut(4000, 10, 0), 37, 4, "Referenz 4.000 kWh / 10 kWp / ohne Speicher");
  near(aut(4700, 5, 6), 60, 4, "Referenz 4.700 kWh / 5 kWp / 6 kWh");
  near(aut(4700, 10, 10), 80, 4, "Referenz 4.700 kWh / 10 kWp / 10 kWh");
}

/* ---------- Wirtschaftlichkeit ---------- */
const ECON = { pvFix: 2500, pvKwp: 1000, batFix: 2000, batKwh: 450, price: 32, inc: 0, fit10: 7.7, fit40: 6.67, fit100: 5.45, opexPct: 0, deg: 0, years: 20, disc: 0 };
{
  near(E.fitRate(5, ECON), 7.7, 1e-9, "Vergütung ≤10");
  near(E.fitRate(20, ECON), (10 * 7.7 + 10 * 6.67) / 20, 1e-9, "Vergütung 20 kWp anteilig");
  near(E.fitRate(50, ECON), (10 * 7.7 + 30 * 6.67 + 10 * 5.45) / 50, 1e-9, "Vergütung 50 kWp");
  ok(E.fitRate(0, ECON) === 0, "Vergütung 0 kWp");
  ok(E.cost(0, 10, ECON) === 2000 + 4500, "Kosten nur Speicher");
  ok(E.cost(10, 0, ECON) === 12500, "Kosten 10 kWp");
  const sim = { self: 2000, feed: 0, pv: 2000 };   // 640 €/a
  const e = E.economics(sim, 10, 0, ECON);
  near(e.y1, 640, 1e-6, "Überschuss 1. Jahr");
  near(e.payback, 12500 / 640, 1e-6, "Amortisation linear");
  near(e.npv, 20 * 640 - 12500, 1e-6, "Kapitalwert ohne Zins");
  // IRR: 12500 Invest, 20 × 640 → Barwertgleichung prüfen
  let npvIrr = -12500; for (let y = 1; y <= 20; y++) npvIrr += 640 / Math.pow(1 + e.irr, y);
  near(npvIrr, 0, 1, "IRR erfüllt Barwert 0");
  const bad = E.economics({ self: 10, feed: 0, pv: 10 }, 10, 0, ECON);
  ok(bad.payback === null && !Number.isFinite(bad.irr) || bad.irr < 0, "unwirtschaftlich: keine Amortisation");
  const none = E.economics({ self: 0, feed: 0, pv: 0 }, 0, 0, ECON);
  ok(none.invest === 0 && none.payback === null && Number.isNaN(none.irr), "ohne Anlage");
  const f21 = E.economics({ self: 0, feed: 1000, pv: 1000 }, 10, 0, Object.assign({}, ECON, { years: 25 }));
  near(f21.cum[21] - f21.cum[20], 0, 1e-9, "keine Vergütung nach 20 Jahren");
}

/* ---------- Optimierung ---------- */
{
  const pr = E.pvProfile(52, 35, 0, PVG, 10), pn = E.pvProfile(52, 35, 180, PVG.map(v => v * .5), 10);
  const faces = [{ profile: pr, max: 50 }, { profile: pn, max: 50 }, { profile: pr, max: 0 }];
  const P = { module: MOD, econ: Object.assign({}, ECON, { disc: 3, opexPct: 1 }), feedCap: true };
  const L = E.loadProfile({ household: 4000 });
  const v = E.optimize(faces, L, P);
  ok(v.length > 0, "Varianten vorhanden");
  ok(v.every((x, i) => i === 0 || x.eco.npv <= v[i - 1].eco.npv), "nach Kapitalwert sortiert");
  ok(v.every(x => x.cap <= 1.5 * x.kwp + 1e-9), "Speicher ≤ 1,5 kWh/kWp");
  const keys = v.map(x => x.counts.join() + "|" + x.cap); ok(new Set(keys).size === keys.length, "keine doppelten Varianten");
  ok(v.every(x => x.counts[2] === 0), "Fläche ohne Module bleibt leer");
  ok(v.some(x => x.kwp <= 10 && x.kwp > 9), "10-kWp-Variante vorhanden");
  ok(E.optimize([{ profile: pr, max: 0 }], L, P).length === 0, "keine belegbare Fläche → leer");
}

console.log("Kataster (ALKIS, LoD2)");
{
  const K = require("./tools/kataster.js");
  const [la, lo] = K.utmToLL(592464.88, 5899756.48);
  near(la, 53.2390261, 2e-6, "UTM → Breite"); near(lo, 10.3855050, 2e-6, "UTM → Länge");
  const gml = '<GebaeudeBauwerk gml:id="x"><oid>DENIALtest0001</oid><gml:posList>53.1 10.1 53.1 10.2 53.2 10.2 53.1 10.1</gml:posList><name>Kita</name></GebaeudeBauwerk>';
  const A = K.alkis(gml);
  ok(A.buildings.length === 1 && A.buildings[0].ll[1][0] === 10.2 && A.buildings[0].ll[1][1] === 53.1, "ALKIS: lat/lon getauscht gelesen");
  // Pultdach 10 × 5 m, 3 m Anstieg nach Westen (Fall nach Osten), Wand und Boden
  const r = (p) => p.concat([p[0]]).map(q => q.map(v => v.toFixed(3)).join(" ")).join(" ");   // wie im Dump: 3 Nachkommastellen, Ringe aneinandergeklebt
  const txt = "DENIAL0000testAA" + r([[500000, 5900000, 40], [500005, 5900000, 43], [500005, 5900010, 43], [500000, 5900010, 40]])
    + r([[500000, 5900000, 37], [500005, 5900000, 37], [500005, 5900000, 43], [500000, 5900000, 40]])
    + r([[500000, 5900000, 37], [500000, 5900010, 37], [500005, 5900010, 37], [500005, 5900000, 37]]) + "DENIAL0000testBB";
  const L = K.lod2(txt, "DENIAL0000testAA");
  ok(L.roofs.length === 1, "LoD2: nur die Dachfläche bleibt");
  near(L.roofs[0].tilt, 31, .1, "LoD2: Neigung"); near(L.roofs[0].az, 270, 1, "LoD2: Ausrichtung (Gefälle nach Westen)");
  near(L.roofs[0].plan, 50, .1, "LoD2: Grundfläche"); near(L.ground, 37, 0, "LoD2: Geländehöhe");
}

{
  const K = require("./tools/kataster.js"), D = Math.PI / 180, kx = Math.cos(53 * D) * 111320, ky = 110540;
  // Rechteck 20 m (Achse 30° ab Nord) × 8 m
  const P = [[0, 0], [20 * Math.sin(30 * D), 20 * Math.cos(30 * D)], [20 * Math.sin(30 * D) + 8 * Math.sin(120 * D), 20 * Math.cos(30 * D) + 8 * Math.cos(120 * D)], [8 * Math.sin(120 * D), 8 * Math.cos(120 * D)]].map(([e, n]) => [10 + e / kx, 53 + n / ky]);
  const f = K.rahmen(P);
  near(f.bearing, 30, .2, "Rahmen: Achse der längsten Wand");
  const uv = K.toUV(f);
  ok(P.every(p => { const [u, v] = uv(p); return v > -0.01 && u < 0.01; }), "Rahmen: Ursprung an der Nordwestecke (u ≤ 0, v ≥ 0)");
}

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
