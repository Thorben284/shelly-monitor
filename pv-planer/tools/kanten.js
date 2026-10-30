#!/usr/bin/env node
/* Kantenhilfen für dunkle Dächer: Grate zwischen dunklen Flächen haben im Luftbild kaum Kontrast.
   node tools/kanten.js kontrast <bild> x0 y0 x1 y1 <out.png> [maßstab=1] [raster=10]   Ausschnitt kontrastverstärkt, mit Pixelraster
   node tools/kanten.js sprung <bild> h|v a0 a1 schritt b0 b1                           stärkster Helligkeitssprung je Zeile a (h: Suche in x b0..b1)
                                                                                         bzw. je Spalte a (v: Suche in y b0..b1); Ausgabe a:Lage:Stärke */
"use strict";
const fs = require("fs"), { chromium } = require("playwright");

async function inPage(file, fn, args) {
  const b = await chromium.launch(), p = await b.newPage();
  try { return await p.evaluate(fn, ["data:image/png;base64," + fs.readFileSync(file).toString("base64"), ...args]); }
  finally { await b.close(); }
}

/* Helligkeit zwischen 2. und 60. Perzentil auf 0..255 strecken, vergrößern, Raster mit Bildpixel-Beschriftung */
const kontrast = (src, x0, y0, x1, y1, sc, step) => inPage(src, async ([s, x0, y0, x1, y1, sc, step]) => {
  const i = new Image(); i.src = s; await i.decode();
  const w = x1 - x0, h = y1 - y0, c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(i, x0, y0, w, h, 0, 0, w, h);
  const im = g.getImageData(0, 0, w, h), a = im.data, L = [];
  for (let k = 0; k < a.length; k += 4) L.push(.3 * a[k] + .59 * a[k + 1] + .11 * a[k + 2]);
  L.sort((p, q) => p - q);
  const lo = L[Math.floor(L.length * .02)], hi = L[Math.floor(L.length * .6)];
  for (let k = 0; k < a.length; k += 4) for (let j = 0; j < 3; j++) a[k + j] = Math.max(0, Math.min(255, (a[k + j] - lo) / (hi - lo) * 255));
  g.putImageData(im, 0, 0);
  const o = document.createElement("canvas"); o.width = w * sc; o.height = h * sc;
  const q = o.getContext("2d"); q.imageSmoothingEnabled = false; q.drawImage(c, 0, 0, w * sc, h * sc); q.font = "12px monospace";
  for (let X = Math.ceil(x0 / step) * step; X < x1; X += step) {
    q.strokeStyle = X % (step * 5) ? "rgba(255,255,0,.35)" : "rgba(255,255,0,.9)"; q.beginPath(); q.moveTo((X - x0) * sc, 0); q.lineTo((X - x0) * sc, h * sc); q.stroke();
    if (X % (step * 5) === 0) { q.fillStyle = "#ff0"; q.fillText(X, (X - x0) * sc + 2, 12); }
  }
  for (let Y = Math.ceil(y0 / step) * step; Y < y1; Y += step) {
    q.strokeStyle = Y % (step * 5) ? "rgba(0,255,255,.35)" : "rgba(0,255,255,.9)"; q.beginPath(); q.moveTo(0, (Y - y0) * sc); q.lineTo(w * sc, (Y - y0) * sc); q.stroke();
    if (Y % (step * 5) === 0) { q.fillStyle = "#0ff"; q.fillText(Y, 2, (Y - y0) * sc - 2); }
  }
  return o.toDataURL("image/png");
}, [x0, y0, x1, y1, sc, step]);

/* Differenz der mittleren Helligkeit (5 Pixel quer gemittelt) beiderseits jeder Stelle; Maximum je Zeile/Spalte */
const sprung = (src, dir, a0, a1, step, b0, b1) => inPage(src, async ([s, dir, a0, a1, step, b0, b1]) => {
  const i = new Image(); i.src = s; await i.decode();
  const c = document.createElement("canvas"); c.width = i.width; c.height = i.height;
  const g = c.getContext("2d"); g.drawImage(i, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const L = (x, y) => { let t = 0; for (let e = -2; e <= 2; e++) { const k = 4 * (dir === "h" ? (y + e) * c.width + x : y * c.width + x + e); t += .3 * d[k] + .59 * d[k + 1] + .11 * d[k + 2]; } return t / 5; };
  const out = [];
  for (let a = a0; a <= a1; a += step) {
    let best = 0, at = 0;
    for (let b = b0 + 3; b < b1 - 3; b++) {
      const v = dir === "h" ? L(b + 3, a) + L(b + 2, a) - L(b - 3, a) - L(b - 2, a) : L(a, b + 3) + L(a, b + 2) - L(a, b - 3) - L(a, b - 2);
      if (Math.abs(v) > Math.abs(best)) { best = v; at = b; }
    }
    out.push([a, at, Math.round(best)]);
  }
  return out;
}, [dir, a0, a1, step, b0, b1]);

module.exports = { kontrast, sprung };

if (require.main === module) {
  const [cmd, src, ...r] = process.argv.slice(2);
  (async () => {
    if (cmd === "kontrast") {
      const [x0, y0, x1, y1, out, sc = 1, step = 10] = r;
      const url = await kontrast(src, +x0, +y0, +x1, +y1, +sc, +step);
      fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64")); console.log(out);
    } else if (cmd === "sprung") {
      const [dir, a0, a1, step, b0, b1] = r;
      console.log((await sprung(src, dir, +a0, +a1, +step, +b0, +b1)).map(x => x.join(":")).join("  "));
    } else { console.error("node tools/kanten.js kontrast|sprung …"); process.exit(1); }
  })().catch(e => { console.error(e.message || e); process.exit(1); });
}
