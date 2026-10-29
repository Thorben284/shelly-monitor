/* PV-Planer Rechenkern. Läuft in Node (require) und im Browser (window.PVE). */
(function (G) {
  "use strict";
  const D2R = Math.PI / 180;
  const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const MONTH = new Uint8Array(8760);
  { let i = 0; for (let m = 0; m < 12; m++) for (let k = 0; k < MDAYS[m] * 24; k++) MONTH[i++] = m; }

  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  /* ---------- Einstrahlung: nur für den Tagesgang innerhalb eines Monats ----------
     Die Monatssummen kommen aus PVGIS; dieses Modell verteilt sie auf Stunden. */
  const KT = [.30, .36, .40, .46, .48, .48, .49, .48, .44, .37, .30, .27];
  function erbs(kt) {
    if (kt <= .22) return 1 - .09 * kt;
    if (kt <= .8) return .9511 - .1604 * kt + 4.388 * kt * kt - 16.638 * kt ** 3 + 12.336 * kt ** 4;
    return .165;
  }
  const DAYKT = (() => {
    const r = rng(42), a = [];
    for (let m = 0; m < 12; m++) for (let d = 0; d < MDAYS[m]; d++) {
      const base = r() < .41 ? .35 : 1.45;
      a.push(clamp(KT[m] * base * (.8 + .4 * r()), .05, .78));
    }
    return a;
  })();

  function poaHourly(lat, tilt, aspect) {
    const phi = lat * D2R, b = tilt * D2R, g = aspect * D2R, cb = Math.cos(b), sb = Math.sin(b);
    const out = new Float64Array(8760);
    let i = 0;
    for (let d = 0; d < 365; d++) {
      const nd = d + 1, dec = 23.45 * D2R * Math.sin(2 * Math.PI * (284 + nd) / 365);
      const g0 = 1367 * (1 + .033 * Math.cos(2 * Math.PI * nd / 365)), kt = DAYKT[d], kd = erbs(kt);
      for (let h = 0; h < 24; h++, i++) {
        const w = 15 * (h + .5 - 12) * D2R;
        const cz = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(w);
        if (cz <= .03) continue;
        const sz = Math.sqrt(1 - cz * cz);
        const az = Math.atan2(Math.sin(w), Math.cos(w) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
        const ghi = kt * g0 * cz, dhi = ghi * kd;
        const cth = cz * cb + sz * sb * Math.cos(az - g);
        out[i] = (cth > 0 ? (ghi - dhi) * cth / cz : 0) + dhi * (1 + cb) / 2 + ghi * .2 * (1 - cb) / 2;
      }
    }
    return out;
  }

  /* Stundenprofil in kWh je kWp, Monatssummen = PVGIS E_m */
  function pvProfile(lat, tilt, aspect, monthly) {
    const p = poaHourly(lat, tilt, aspect), ms = new Array(12).fill(0), out = new Float64Array(8760);
    for (let i = 0; i < 8760; i++) ms[MONTH[i]] += p[i];
    for (let i = 0; i < 8760; i++) { const m = MONTH[i]; out[i] = ms[m] > 0 ? p[i] / ms[m] * monthly[m] : 0; }
    return out;
  }

  /* ---------- Last ---------- */
  const L24 = [.30, .25, .22, .22, .22, .28, .45, .70, .65, .55, .50, .50, .55, .50, .45, .45, .50, .70, .95, 1.0, .95, .80, .60, .42];
  const HP24 = [.9, .9, .9, .9, .9, 1.0, 1.25, 1.25, 1.2, 1.0, .95, .9, .9, .9, .9, .95, 1.0, 1.1, 1.1, 1.1, 1.05, 1.0, .95, .9];
  const HPM = [.17, .15, .13, .08, .04, .01, .01, .01, .03, .08, .13, .16];

  function loadProfile(c) {
    const r = rng(7), hh = new Float64Array(8760), hp = new Float64Array(8760);
    let i = 0, sh = 0, sp = 0, sw = 0;
    const dhw = new Float64Array(8760);
    for (let m = 0, d = 0; m < 12; m++) for (let k = 0; k < MDAYS[m]; k++, d++) {
      const dow = (d + 3) % 7, weekend = dow >= 5;          // 1.1. als Donnerstag
      const season = 1 + .15 * Math.cos(2 * Math.PI * (d - 15) / 365);
      const dayF = .8 + .4 * r(), hpDay = .75 + .5 * r();
      for (let h = 0; h < 24; h++, i++) {
        const wk = weekend && h >= 9 && h <= 16 ? 1.3 : 1;
        hh[i] = L24[h] * season * dayF * wk * (.7 + .6 * r()); sh += hh[i];
        hp[i] = HPM[m] / MDAYS[m] * hpDay * HP24[h]; sp += hp[i];
        dhw[i] = HP24[h]; sw += dhw[i];
      }
    }
    const base = new Float64Array(8760), H = c.household || 0, P = c.heatpump || 0;
    for (let j = 0; j < 8760; j++) base[j] = hh[j] / sh * H + (hp[j] / sp * .8 + dhw[j] / sw * .2) * P;
    return { base, evDay: (c.ev || 0) / 365, evMode: c.evMode || "abends" };
  }

  /* ---------- Simulation ---------- */
  function simulate(pv, L, cap, feedCapKw) {
    const eta = .95, pmax = cap > 0 ? Math.max(2.5, cap * .5) : 0, fc = feedCapKw > 0 ? feedCapKw : Infinity;
    let soc = 0, evNeed = 0, P = 0, load = 0, direct = 0, evSolar = 0, toBat = 0, fromBat = 0, feed = 0, curt = 0, grid = 0;
    const mPv = new Array(12).fill(0), mLoad = new Array(12).fill(0), mSelf = new Array(12).fill(0);
    for (let i = 0; i < 8760; i++) {
      const h = i % 24, m = MONTH[i];
      if (h === 0) evNeed = L.evDay;
      const p = pv[i], l = L.base[i];
      P += p; load += l; mPv[m] += p; mLoad[m] += l;
      const d = Math.min(p, l); direct += d; mSelf[m] += d;
      let sur = p - d, def = l - d;
      if (L.evMode === "tag" && evNeed > 0 && h >= 8 && h <= 17 && sur > 0) {
        const c = Math.min(sur, evNeed, 11); evNeed -= c; sur -= c; evSolar += c; load += c; mLoad[m] += c; mSelf[m] += c;
      }
      if (sur > 0 && cap > 0) { const c = Math.min(sur, pmax, (cap - soc) / eta); soc += c * eta; toBat += c; sur -= c; }
      if (sur > 0) { const f = Math.min(sur, fc); feed += f; curt += sur - f; }
      if (def > 0 && soc > 0) { const x = Math.min(def, pmax, soc * eta); soc -= x / eta; fromBat += x; def -= x; mSelf[m] += x; }
      grid += def;
      if (evNeed > 0 && h >= 18 && h <= 22) {
        const x = h === 22 ? evNeed : Math.min(evNeed, L.evDay / 5);
        evNeed -= x; grid += x; load += x; mLoad[m] += x;
      }
    }
    const self = direct + evSolar + fromBat;
    return {
      pv: P, load, direct, evSolar, toBat, fromBat, feed, curt, grid, self,
      evQuote: P > 0 ? (direct + evSolar + toBat) / P : 0,
      autarky: load > 0 ? self / load : 0,
      cycles: cap > 0 ? fromBat / cap : 0,
      monthly: { pv: mPv, load: mLoad, self: mSelf }
    };
  }

  /* ---------- Wirtschaftlichkeit ---------- */
  function fitRate(kwp, e) { // ct/kWh, anteilig nach Leistungsstufen
    if (kwp <= 0) return 0;
    const a = Math.min(kwp, 10), b = clamp(kwp, 10, 40) - 10, c = Math.max(0, kwp - 40);
    return (a * e.fit10 + b * e.fit40 + c * e.fit100) / kwp;
  }
  function cost(kwp, cap, e) {
    return (kwp > 0 ? e.pvFix + e.pvKwp * kwp : 0) + (cap > 0 ? e.batFix + e.batKwh * cap : 0);
  }
  function irr(cfs) {
    const npv = r => cfs.reduce((a, c, i) => a + c / Math.pow(1 + r, i), 0);
    let lo = -.5, hi = 1; if (npv(lo) * npv(hi) > 0) return NaN;
    for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (npv(lo) * npv(m) <= 0) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  function economics(sim, kwp, cap, e) {
    const invest = cost(kwp, cap, e), opex = invest * e.opexPct / 100, fit = fitRate(kwp, e) / 100;
    const price = e.price / 100, N = e.years, disc = e.disc / 100;
    const cum = [-invest], cfs = [-invest];
    let acc = -invest, payback = null, npv = -invest, sumE = 0;
    for (let y = 1; y <= N; y++) {
      const f = Math.pow(1 - e.deg / 100, y - 1);
      const sav = sim.self * f * price * Math.pow(1 + e.inc / 100, y - 1);
      const cf = sav + (y <= 20 ? sim.feed * f * fit : 0) - opex;
      sumE += sim.pv * f;
      const prev = acc; acc += cf; cum.push(acc); cfs.push(cf); npv += cf / Math.pow(1 + disc, y);
      if (payback === null && acc >= 0 && invest > 0) payback = y - 1 + (cf > 0 ? -prev / cf : 0);
    }
    return {
      invest, opex, fit: fit * 100, cum, payback, npv, irr: invest > 0 ? irr(cfs) : NaN,
      lcoe: sumE > 0 ? (invest + opex * N) / sumE * 100 : NaN,
      y1: sim.self * price + sim.feed * fit - opex, saving1: sim.self * price, feed1: sim.feed * fit
    };
  }

  /* ---------- Belegung ---------- */
  function layoutFace(f, mod) {
    if (f.flat) {
      const A = Math.max(0, f.eave - 2 * f.edge) * Math.max(0, f.slope - 2 * f.edge);
      return { flat: true, count: Math.floor(A * f.coverage / (mod.l * mod.b)), rows: [], orient: f.mounting };
    }
    const g = .02;
    const fit = (w, h) => {
      const rows = []; let y = f.edge;
      while (y + h <= f.slope - f.edge + 1e-9) {
        const W = f.eave - (f.eave - f.top) * ((y + h) / f.slope);
        rows.push({ y, n: Math.max(0, Math.floor((W - 2 * f.edge + g) / (w + g))) });
        y += h + g;
      }
      return { rows, w, h, count: rows.reduce((a, r) => a + r.n, 0) };
    };
    const p = fit(mod.b, mod.l), q = fit(mod.l, mod.b);
    p.orient = "hochkant"; q.orient = "quer";
    if (f.orient === "p") return p; if (f.orient === "l") return q;
    return p.count >= q.count ? p : q;
  }

  /* ---------- Gebäudeumriss ---------- */
  function footprint(coords) {
    const n = coords.length - (coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1] ? 1 : 0);
    let lat0 = 0, lon0 = 0; for (let i = 0; i < n; i++) { lon0 += coords[i][0]; lat0 += coords[i][1]; }
    lat0 /= n; lon0 /= n;
    const kx = Math.cos(lat0 * D2R) * 111320, ky = 110540;
    const pts = coords.slice(0, n).map(c => [(c[0] - lon0) * kx, (c[1] - lat0) * ky]);
    let area = 0; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    area = Math.abs(area) / 2;
    const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of s) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of s.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const hull = lo.slice(0, -1).concat(up.slice(0, -1));
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const c = Math.cos(-ang), sn = Math.sin(-ang);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { const x = p[0] * c - p[1] * sn, y = p[0] * sn + p[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const A = (x1 - x0) * (y1 - y0);
      if (!best || A < best.A) best = { A, ang, w: x1 - x0, h: y1 - y0 };
    }
    let L = best.w, W = best.h, ang = best.ang;
    if (W > L) { [L, W] = [W, L]; ang += Math.PI / 2; }
    let bearing = (90 - ang / D2R) % 180; if (bearing < 0) bearing += 180;   // Längsachse, 0° = Nord
    return { lat: lat0, lon: lon0, pts, area, L, W, bearing };
  }

  const DIRS = ["Nord", "Nordost", "Ost", "Südost", "Süd", "Südwest", "West", "Nordwest"];
  const compassName = c => DIRS[Math.round(((c % 360) + 360) % 360 / 45) % 8];
  const toAspect = c => { let a = c - 180; while (a > 180) a -= 360; while (a <= -180) a += 360; return Math.round(a); };

  /* Dachflächen aus Umriss und Dachform ableiten. compass: Richtung der Flächennormalen, 0° = Nord */
  function deriveFaces(fp, roof) {
    const t = roof.tilt, ct = Math.cos(t * D2R), e = roof.edge, ov = roof.overhang || 0;
    const ax = roof.ridge === "short" ? fp.bearing + 90 : fp.bearing;   // Firstrichtung
    const along = roof.ridge === "short" ? fp.W : fp.L, across = roof.ridge === "short" ? fp.L : fp.W;
    const mk = (compass, shape) => Object.assign({ compass: ((compass % 360) + 360) % 360, tilt: t, edge: e }, shape);
    let faces = [];
    if (roof.type === "sattel") {
      const sl = (across / 2 + ov) / ct;
      faces = [mk(ax + 90, { eave: along, top: along, slope: sl }), mk(ax - 90, { eave: along, top: along, slope: sl })];
    } else if (roof.type === "walm") {
      const sl = (fp.W / 2 + ov) / ct;
      faces = [mk(fp.bearing + 90, { eave: fp.L, top: Math.max(0, fp.L - fp.W), slope: sl }), mk(fp.bearing - 90, { eave: fp.L, top: Math.max(0, fp.L - fp.W), slope: sl }),
        mk(fp.bearing, { eave: fp.W, top: 0, slope: sl }), mk(fp.bearing + 180, { eave: fp.W, top: 0, slope: sl })];
    } else if (roof.type === "pult") {
      const c1 = ax + 90, c2 = ax - 90, south = n => Math.abs(toAspect(n));
      const c = roof.pultDir === "andere" ? (south(c1) < south(c2) ? c2 : c1) : (south(c1) <= south(c2) ? c1 : c2);
      faces = [mk(c, { eave: along, top: along, slope: (across + ov) / ct })];
    } else if (roof.type === "flach") {
      const cov = roof.mounting === "sued" ? .5 : .8, tilt = roof.mounting === "sued" ? 15 : 10;
      if (roof.mounting === "sued") {
        faces = [{ compass: 180, tilt, edge: e, eave: fp.L, top: fp.L, slope: fp.W, flat: true, coverage: cov, mounting: "Süd 15°" }];
      } else {
        const ce = [0, 90, 180, 270].map(k => fp.bearing + k).sort((a, b) => Math.abs(toAspect(a) + 90) - Math.abs(toAspect(b) + 90))[0];
        faces = [{ compass: ((ce % 360) + 360) % 360, tilt, edge: e, eave: fp.L, top: fp.L, slope: fp.W / 2 + e, flat: true, coverage: cov, mounting: "Ost-West 10°" },
          { compass: ((ce + 180) % 360 + 360) % 360, tilt, edge: e, eave: fp.L, top: fp.L, slope: fp.W / 2 + e, flat: true, coverage: cov, mounting: "Ost-West 10°" }];
      }
    }
    return faces.map((f, i) => Object.assign(f, { id: "F" + (i + 1), name: compassName(f.compass), aspect: toAspect(f.compass) }));
  }

  /* ---------- Optimierung ---------- */
  const BATS = [0, 5, 7.5, 10, 12.5, 15, 20];
  function evaluate(faces, counts, cap, L, p) {
    const pv = new Float64Array(8760); let kwp = 0;
    faces.forEach((f, i) => { const k = counts[i] * p.module.wp / 1000; kwp += k; if (k > 0) for (let j = 0; j < 8760; j++) pv[j] += f.profile[j] * k; });
    const sim = simulate(pv, L, kwp > 0 ? cap : 0, p.feedCap ? kwp * .6 : 0);
    return { counts: counts.slice(), cap: kwp > 0 ? cap : 0, kwp, sim, eco: economics(sim, kwp, kwp > 0 ? cap : 0, p.econ) };
  }
  function optimize(faces, L, p) {
    const out = [], nF = faces.length, seen = new Set();
    for (let mask = 1; mask < (1 << nF); mask++) {
      const counts = faces.map((f, i) => (mask >> i) & 1 ? f.max : 0);
      const kwp = counts.reduce((a, c) => a + c, 0) * p.module.wp / 1000;
      if (kwp <= 0) continue;
      const sets = [counts];
      const n10 = Math.floor(10000 / p.module.wp), tot = counts.reduce((a, c) => a + c, 0);
      if (tot > n10) {   // Variante bis 10 kWp, beste Flächen zuerst
        const c10 = counts.map(() => 0); let rest = n10;
        faces.map((f, i) => [i, f.profile.reduce((a, v) => a + v, 0)]).sort((a, b) => b[1] - a[1])
          .forEach(([i]) => { const k = Math.min(counts[i], rest); c10[i] = k; rest -= k; });
        sets.push(c10);
      }
      for (const cs of sets) {
        const k = cs.join(","); if (seen.has(k)) continue; seen.add(k);
        const kw = cs.reduce((a, c) => a + c, 0) * p.module.wp / 1000;
        for (const b of BATS) if (b <= 1.5 * kw + 1e-9) out.push(evaluate(faces, cs, b, L, p));
      }
    }
    out.sort((a, b) => b.eco.npv - a.eco.npv);
    return out;
  }

  const API = { MONTH, MDAYS, pvProfile, loadProfile, simulate, economics, fitRate, cost, layoutFace, footprint, deriveFaces, compassName, toAspect, evaluate, optimize, BATS };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else G.PVE = API;
})(typeof window !== "undefined" ? window : globalThis);
