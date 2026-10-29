/* PV-Planer Zeichnungen (Lageplan, Dachflächen, Diagramme). Browser: window.PVV */
(function(G){
"use strict";
const fmt=(x,d=0)=>Number.isFinite(x)?x.toLocaleString("de-DE",{minimumFractionDigits:d,maximumFractionDigits:d}):"–";
function niceMax(x){if(x<=0)return 1;const e=Math.pow(10,Math.floor(Math.log10(x)));const f=x/e;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*e}
function siteSvg(D,counts){
  const fp=D.fp,pts=fp.pts,D2R=Math.PI/180;
  let cx=0,cy=0;pts.forEach(p=>{cx+=p[0];cy+=p[1]});cx/=pts.length;cy/=pts.length;
  const u=[Math.sin(fp.bearing*D2R),Math.cos(fp.bearing*D2R)],v=[u[1],-u[0]];
  const arrows=D.faces.map((f,i)=>{const d=[Math.sin(f.compass*D2R),Math.cos(f.compass*D2R)];
    const ext=Math.abs(d[0]*u[0]+d[1]*u[1])*fp.L/2+Math.abs(d[0]*v[0]+d[1]*v[1])*fp.W/2;
    return {f,on:counts[i]>0,a:[cx+d[0]*ext*.25,cy+d[1]*ext*.25],b:[cx+d[0]*(ext+3),cy+d[1]*(ext+3)],t:[cx+d[0]*(ext+5.2),cy+d[1]*(ext+5.2)]}});
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  const all=pts.concat(arrows.map(a=>a.t));all.forEach(p=>{x0=Math.min(x0,p[0]);x1=Math.max(x1,p[0]);y0=Math.min(y0,p[1]);y1=Math.max(y1,p[1])});
  const pad=4;x0-=pad+4;x1+=pad+4;y0-=pad;y1+=pad;
  const VW=380,s=Math.min((VW-20)/(x1-x0),300/(y1-y0)),VH=(y1-y0)*s+30;
  const X=x=>10+(x-x0)*s,Y=y=>10+(y1-y)*s;
  let o=`<svg viewBox="0 0 ${VW} ${VH.toFixed(0)}" role="img" aria-label="Lageplan mit Dachflächen">`;
  o+=`<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--sun)"/></marker><marker id="ahm" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--muted)"/></marker></defs>`;
  o+=`<polygon points="${pts.map(p=>X(p[0]).toFixed(1)+","+Y(p[1]).toFixed(1)).join(" ")}" fill="var(--roof)" stroke="var(--roof-line)" stroke-width="1.5"/>`;
  if(D.roof.type==="sattel"||D.roof.type==="walm"){
    const r=D.roof.ridge==="short"&&D.roof.type==="sattel"?v:u,len=D.roof.type==="walm"?Math.max(0,fp.L-fp.W)/2:(D.roof.ridge==="short"?fp.W:fp.L)/2;
    o+=`<line x1="${X(cx-r[0]*len)}" y1="${Y(cy-r[1]*len)}" x2="${X(cx+r[0]*len)}" y2="${Y(cy+r[1]*len)}" stroke="var(--ink)" stroke-width="1.6" stroke-dasharray="6 3"/>`;
  }
  arrows.forEach(A=>{o+=`<line x1="${X(A.a[0])}" y1="${Y(A.a[1])}" x2="${X(A.b[0])}" y2="${Y(A.b[1])}" stroke="${A.on?"var(--sun)":"var(--muted)"}" stroke-width="2" marker-end="url(#${A.on?"ah":"ahm"})"/>
    <text x="${X(A.t[0])}" y="${Y(A.t[1])+4}" text-anchor="middle" style="fill:${A.on?"var(--ink)":"var(--muted)"};font-weight:600">${A.f.id}</text>`});
  const nx=VW-24,ny=14;
  o+=`<path d="M${nx} ${ny}l7 20l-7-6l-7 6z" fill="var(--ink)"/><text x="${nx}" y="${ny+34}" text-anchor="middle" style="fill:var(--ink);font-weight:600">N</text>`;
  const sb=5*s;o+=`<line x1="12" y1="${VH-10}" x2="${12+sb}" y2="${VH-10}" stroke="var(--ink)" stroke-width="2"/><text x="${12+sb+6}" y="${VH-6}">5 m</text>`;
  return o+"</svg>";
}
/* Dachfläche maßstäblich: Traufe unten, Module und Hindernisse aus der Belegung (x ab linker Traufecke, y ab Traufe) */
function roofSvg(f,count){
  const VW=320,maxW=280,maxH=170,y0=20;
  const s=Math.min(maxW/f.eave,maxH/f.slope),w=f.eave*s,h=f.slope*s,x0=(VW-w)/2,tw=f.top*s,yb=y0+h;
  const lay=f.layout,mw=lay.w*s,mh=lay.h*s,X=x=>x0+x*s,Y=y=>yb-y*s;
  let mods="";
  lay.pos.slice(0,count).forEach(p=>{mods+=`<rect x="${X(p.x).toFixed(1)}" y="${(Y(p.y)-mh).toFixed(1)}" width="${mw.toFixed(1)}" height="${mh.toFixed(1)}" fill="var(--module)" stroke="var(--module-line)" stroke-width=".8"/>`});
  let obs="";
  (lay.obstacles||[]).forEach((o,i)=>{
    obs+=`<rect x="${X(o.x-o.w/2-o.c).toFixed(1)}" y="${Y(o.y+o.h/2+o.c).toFixed(1)}" width="${((o.w+2*o.c)*s).toFixed(1)}" height="${((o.h+2*o.c)*s).toFixed(1)}" fill="none" stroke="var(--warn)" stroke-dasharray="3 2" stroke-width=".9"/>
      <rect x="${X(o.x-o.w/2).toFixed(1)}" y="${Y(o.y+o.h/2).toFixed(1)}" width="${(o.w*s).toFixed(1)}" height="${(o.h*s).toFixed(1)}" fill="var(--warn)"><title>${o.label}</title></rect>
      <text x="${X(o.x+o.w/2+o.c).toFixed(1)}" y="${(Y(o.y+o.h/2+o.c)-2).toFixed(1)}" style="fill:var(--warn);font-weight:600;font-size:10px">${i+1}</text>`});
  const shape=f.flat?`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="var(--roof)" stroke="var(--roof-line)" stroke-width="1.2"/>`
    :`<polygon points="${x0},${yb} ${x0+w},${yb} ${VW/2+tw/2},${y0} ${VW/2-tw/2},${y0}" fill="var(--roof)" stroke="var(--roof-line)" stroke-width="1.2"/>`;
  return `<svg viewBox="0 0 ${VW} ${(yb+34).toFixed(0)}" role="img" aria-label="Belegung ${f.id}: ${count} Module">
    ${shape}${mods}${obs}
    <text x="${VW/2}" y="${y0-6}" text-anchor="middle">${f.flat?"Flachdach":(f.top>0?"First":"Firstpunkt")}</text>
    <text x="${VW/2}" y="${yb+14}" text-anchor="middle">${f.flat?`${fmt(f.eave,1)} × ${fmt(f.slope,1)} m`:`Traufe ${fmt(f.eave,2)} m · Sparren ${fmt(f.slope,2)} m`}</text>
    <text x="${VW/2}" y="${yb+28}" text-anchor="middle">${f.flat?f.mounting+" · ":f.tilt+"° · "}Azimut ${f.aspect}° (${f.name})</text></svg>`;
}
function monthSvg(m){
  const VW=560,VH=240,Lp=44,R=8,T=12,B=26,cw=(VW-Lp-R)/12;
  const max=niceMax(Math.max(...m.pv,...m.load)),y=v=>T+(VH-T-B)*(1-v/max);
  let s=`<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="Monatsbilanz">`;
  for(let t=0;t<=4;t++){const v=max*t/4,yy=y(v);s+=`<line x1="${Lp}" x2="${VW-R}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${Lp-6}" y="${yy+4}" text-anchor="end">${fmt(v)}</text>`}
  const ms="JFMAMJJASOND";
  for(let i=0;i<12;i++){const x=Lp+i*cw,bw=cw*.36,x2=x+cw*.12+bw+2;
    s+=`<rect x="${x+cw*.12}" y="${y(m.pv[i])}" width="${bw}" height="${y(0)-y(m.pv[i])}" fill="var(--sun)" rx="1.5"><title>${fmt(m.pv[i])} kWh PV</title></rect>`;
    s+=`<rect x="${x2}" y="${y(m.load[i])}" width="${bw}" height="${y(0)-y(m.load[i])}" fill="var(--blue)" rx="1.5"><title>${fmt(m.load[i])} kWh Verbrauch</title></rect>`;
    s+=`<rect x="${x2}" y="${y(m.self[i])}" width="${bw}" height="${y(0)-y(m.self[i])}" fill="var(--good)" rx="1.5"><title>${fmt(m.self[i])} kWh aus PV</title></rect>`;
    s+=`<text x="${x+cw/2}" y="${VH-8}" text-anchor="middle">${ms[i]}</text>`}
  return s+`<text x="${Lp}" y="${T-2}" style="font-size:10px">kWh</text></svg>`;
}
function cashSvg(cum,payback){
  const VW=720,VH=230,Lp=62,R=10,T=14,B=26,N=cum.length-1;
  let lo=Math.min(0,...cum),hi=Math.max(0,...cum);
  const span=niceMax(Math.max(hi-lo,1)/4);lo=Math.floor(lo/span)*span;hi=Math.ceil(hi/span)*span;if(hi===lo)hi=lo+span;
  const x=i=>Lp+(VW-Lp-R)*i/N,y=v=>T+(VH-T-B)*(hi-v)/(hi-lo);
  let s=`<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="Kumulierter Kapitalrückfluss">`;
  for(let v=lo;v<=hi+1e-6;v+=span)s+=`<line x1="${Lp}" x2="${VW-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" ${Math.abs(v)<1e-6?'stroke-width="1.8"':''}/><text x="${Lp-6}" y="${y(v)+4}" text-anchor="end">${fmt(v/1000)} T€</text>`;
  const step=N>20?5:N>10?2:1;for(let i=0;i<=N;i+=step)s+=`<text x="${x(i)}" y="${VH-8}" text-anchor="middle">${i}</text>`;
  const bw=Math.max(2,(VW-Lp-R)/N*.6);
  for(let i=1;i<=N;i++){const v=cum[i];s+=`<rect x="${x(i)-bw/2}" y="${Math.min(y(0),y(v))}" width="${bw}" height="${Math.abs(y(v)-y(0))}" fill="${v>=0?"var(--good)":"var(--warn)"}" opacity=".85"><title>Jahr ${i}: ${fmt(v)} €</title></rect>`}
  if(payback&&payback<=N)s+=`<line x1="${x(payback)}" x2="${x(payback)}" y1="${T}" y2="${VH-B}" stroke="var(--ink)" stroke-dasharray="4 3"/><text x="${x(payback)+5}" y="${T+8}" style="fill:var(--ink)">Amortisation ${fmt(payback,1)} J.</text>`;
  return s+`<text x="${VW-R}" y="${VH-B-4}" text-anchor="end" style="font-size:10px">Jahr</text></svg>`;
}

G.PVV={fmt,niceMax,siteSvg,roofSvg,monthSvg,cashSvg};
})(window);
