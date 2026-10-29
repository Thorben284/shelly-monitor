#!/usr/bin/env node
/* Luftbild-Hilfen für die Dachanalyse (Bing-Screenshot, Web-Mercator, Zoom z).
   node tools/aerial.js overlay <bild.png> <aerial.json> <out.png>   Umrisse/Flächen/Hindernisse aufs Bild zeichnen
   node tools/aerial.js grid <bild.png> <x0> <y0> <x1> <y1> <out.png> [scale]   Ausschnitt vergrößert mit Pixelraster
   aerial.json: {lat, lon, zoom, cx, cy, polys:[{label, color, ll:[[lon,lat],...]} | {label,color,px:[[x,y],...]}]} */
"use strict";
const fs = require("fs");
const { chromium } = require("playwright");
const R = 6378137, TILE = 256;
function world(lat, lon, z) {
  const s = Math.sin(lat * Math.PI / 180), n = TILE * 2 ** z;
  return [(lon + 180) / 360 * n, (.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
const toPx = (a, lat, lon) => { const c = world(a.lat, a.lon, a.zoom), p = world(lat, lon, a.zoom); return [a.cx + p[0] - c[0], a.cy + p[1] - c[1]]; };
const mpp = a => 156543.03392 * Math.cos(a.lat * Math.PI / 180) / 2 ** a.zoom;
module.exports = { world, toPx, mpp };

async function draw(img, w, h, script, out, clip) {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: w, height: h } });
  const data = "data:image/png;base64," + fs.readFileSync(img).toString("base64");
  await p.setContent(`<body style="margin:0"><canvas id=c width=${w} height=${h}></canvas><script>
    const im=new Image();im.onload=()=>{const g=document.getElementById('c').getContext('2d');${script};window.done=1};im.src=${JSON.stringify(data)};</script></body>`);
  await p.waitForFunction("window.done===1");
  await p.screenshot({ path: out, clip }); await b.close();
}
if (require.main === module) (async () => {
  const [, , cmd, ...a] = process.argv;
  if (cmd === "overlay") {
    const [img, cfgFile, out] = a, A = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    const polys = (A.polys || []).map(q => ({ label: q.label, color: q.color || "#ff0", fill: q.fill, pts: q.px || q.ll.map(([lo, la]) => toPx(A, la, lo)) }));
    const W = A.w || 1400, H = A.h || 1100;
    await draw(img, W, H, `g.drawImage(im,0,0);g.lineWidth=2;g.font='bold 14px sans-serif';
      for(const q of ${JSON.stringify(polys)}){g.strokeStyle=q.color;g.beginPath();q.pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();
        if(q.fill){g.fillStyle=q.fill;g.fill()}g.stroke();if(q.label){const c=q.pts.reduce((s,p)=>[s[0]+p[0]/q.pts.length,s[1]+p[1]/q.pts.length],[0,0]);g.fillStyle='#000';g.fillText(q.label,c[0]+1,c[1]+1);g.fillStyle=q.color;g.fillText(q.label,c[0],c[1])}}`, out);
    console.log(out, "m/px", mpp(A).toFixed(4));
  } else if (cmd === "grid") {
    const [img, x0, y0, x1, y1, out, sc] = a, s = +(sc || 3), X0 = +x0, Y0 = +y0, w = (+x1 - X0) * s, h = (+y1 - Y0) * s;
    await draw(img, w, h, `g.imageSmoothingEnabled=false;g.drawImage(im,${X0},${Y0},${+x1 - X0},${+y1 - Y0},0,0,${w},${h});g.font='11px monospace';
      for(let x=Math.ceil(${X0}/10)*10;x<=${x1};x+=10){const X=(x-${X0})*${s};g.strokeStyle=x%50?'rgba(255,255,0,.25)':'rgba(255,255,0,.8)';g.beginPath();g.moveTo(X,0);g.lineTo(X,${h});g.stroke();if(x%50===0){g.fillStyle='#ff0';g.fillText(x,X+2,12)}}
      for(let y=Math.ceil(${Y0}/10)*10;y<=${y1};y+=10){const Y=(y-${Y0})*${s};g.strokeStyle=y%50?'rgba(0,255,255,.25)':'rgba(0,255,255,.8)';g.beginPath();g.moveTo(0,Y);g.lineTo(${w},Y);g.stroke();if(y%50===0){g.fillStyle='#0ff';g.fillText(y,2,Y-2)}}`, out);
    console.log(out);
  }
})();
/* Pixel → lat/lon */
function toLL(a, x, y) {
  const c = world(a.lat, a.lon, a.zoom), n = TILE * 2 ** a.zoom, wx = c[0] + x - a.cx, wy = c[1] + y - a.cy;
  const lon = wx / n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / n))) * 180 / Math.PI;
  return [lat, lon];
}
module.exports.toLL = toLL;
