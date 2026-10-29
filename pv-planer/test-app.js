#!/usr/bin/env node
/* Browsertest der eigenständigen Planerseite mit nachgebildetem Firecrawl-Konnektor: node test-app.js <pv-planer.html> */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FEHLER:", m); } };

/* mode: "ok" | "noBuilding" | "notConnected" | "pvgisFail" | "none" (kein mcp) */
const mock = mode => `
window.__calls=[];
window.claude={use:async n=>{
  if(n!=="mcp"||"${mode}"==="none")return null;
  return {callTool:async(server,tool,input)=>{
    window.__calls.push(input.url);
    if("${mode}"==="notConnected")throw {code:"server_not_connected",message:"x"};
    const u=input.url;let body;
    if(u.includes("nominatim")){
      body="${mode}"==="noBuilding"
        ?[{osm_type:"way",osm_id:5,lat:"52.5",lon:"13.4",category:"highway",type:"residential",display_name:"Teststraße, Berlin"}]
        :[{osm_type:"way",osm_id:7,lat:"52.5",lon:"13.4",category:"building",type:"house",display_name:"5, Teststraße, Berlin, Deutschland",
           geojson:{type:"Polygon",coordinates:[[[13.39993,52.49997],[13.40007,52.49997],[13.40007,52.50003],[13.39993,52.50003],[13.39993,52.49997]]]}}];
    }else{
      if("${mode}"==="pvgisFail")throw {code:"server_unavailable",retryable:true,message:"down"};
      const asp=+/aspect=(-?\\d+)/.exec(u)[1],f=1-0.45*Math.pow(Math.abs(asp)/180,1.5);
      body={outputs:{monthly:{fixed:[25,42,83,123,134,132,126,114,94,64,31,20].map((e,i)=>({month:i+1,E_m:e*f}))}}};
    }
    const payload={rawHtml:JSON.stringify(body),metadata:{statusCode:200}};
    return {content:[{type:"text",text:JSON.stringify(payload)}],payload};
  }};
}};`;

(async () => {
  const b = await chromium.launch();
  async function page(mode, w = 1200, scheme = "light") {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
    p.errs = []; p.on("pageerror", e => p.errs.push(e.message)); p.on("console", m => { if (m.type() === "error") p.errs.push(m.text()); });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>${mock(mode)}<\/script></head><body>${html}</body></html>`);
    await p.waitForTimeout(700);
    return p;
  }
  const txt = (p, sel) => p.evaluate(s => document.querySelector(s).innerText, sel);
  const clean = async (p, tag) => ok(!/NaN|undefined|Infinity/.test(await txt(p, ".wrap")), `${tag}: NaN/undefined im Text`);
  const noScroll = async (p, tag) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tag}: horizontales Scrollen`);
  const search = async (p, a) => { await p.fill("#addr", a); await p.click("#find"); await p.waitForTimeout(500); };
  const planIt = async p => { await p.click("#plan"); await p.waitForTimeout(900); };

  // 1. Start: Beispiel sichtbar
  for (const [w, sc] of [[1200, "light"], [360, "dark"]]) {
    const p = await page("ok", w, sc), tag = `Start ${w}px`;
    ok(p.errs.length === 0, `${tag}: Fehler ${p.errs.join(" | ")}`);
    ok(await p.isVisible("#result") && await p.isVisible("#exampleBanner"), `${tag}: Beispielplanung sichtbar`);
    ok(/Beispiel/.test(await txt(p, "#addrStatus")), `${tag}: Hinweis auf Beispiel`);
    ok(await p.evaluate(() => document.querySelectorAll("#roofs svg").length) === 2, `${tag}: zwei Dachflächen`);
    ok(await p.evaluate(() => document.querySelectorAll("#roofs rect[fill='var(--warn)']").length) === 2, `${tag}: Beispiel-Hindernisse gezeichnet`);
    await clean(p, tag); await noScroll(p, tag);
    await p.close();
  }

  // 2. Adresse mit Gebäudeumriss → planen
  {
    const p = await page("ok"), tag = "Adresse";
    await search(p, "Teststraße 5, Berlin");
    ok(/Gefunden: 5, Teststraße/.test(await txt(p, "#addrStatus")), `${tag}: gefunden`);
    ok(await p.isHidden("#manual"), `${tag}: keine Handeingabe nötig`);
    ok(/9,\d × 6,\d m|6,\d × 9,\d m/.test(await txt(p, "#siteMeta")), `${tag}: Maße aus Umriss (${await txt(p, "#siteMeta")})`);
    await planIt(p);
    ok(await p.isHidden("#exampleBanner"), `${tag}: Beispielbanner weg`);
    ok(/Fertig/.test(await txt(p, "#planStatus")), `${tag}: Planung fertig (${await txt(p, "#planStatus")})`);
    const calls = await p.evaluate(() => window.__calls);
    ok(calls.filter(u => u.includes("PVcalc")).length === 2, `${tag}: zwei PVGIS-Abrufe (${calls.length})`);
    ok(calls.filter(u => u.includes("PVcalc")).every(u => u.includes("lat=52.5")), `${tag}: Koordinaten aus Adresse`);
    await clean(p, tag);
    // Hindernis hinzufügen → weniger Module
    const before = await p.evaluate(() => +document.getElementById("cnt0").max);
    await p.click("#addObs"); await p.waitForTimeout(900);
    const after = await p.evaluate(() => +document.getElementById("cnt0").max);
    ok(after <= before, `${tag}: Dachfenster kostet keine zusätzlichen Module (${before} → ${after})`);
    ok(await p.evaluate(() => document.querySelectorAll("#roofs > div:first-child rect[fill='var(--warn)']").length) === 1, `${tag}: Dachfenster gezeichnet`);
    await p.selectOption(".obs select[data-k='type']", "gaube"); await p.waitForTimeout(900);
    const gaube = await p.evaluate(() => +document.getElementById("cnt0").max);
    ok(gaube < before, `${tag}: Gaube verringert Module (${before} → ${gaube})`);
    await p.selectOption(".obs select[data-k='type']", "schornstein"); await p.waitForTimeout(800);
    ok(/Schornstein/.test(await txt(p, "#roofs")), `${tag}: Hindernisart geändert`);
    await p.click(".obs [data-del]"); await p.waitForTimeout(800);
    ok(await p.evaluate(() => +document.getElementById("cnt0").max) === before, `${tag}: Hindernis entfernt`);
    // Neigung → neuer PVGIS-Abruf, danach Cache
    await p.click("#segTilt button[data-v='45']"); await p.waitForTimeout(900);
    ok((await p.evaluate(() => window.__calls)).filter(u => u.includes("angle=45")).length === 2, `${tag}: neue Neigung lädt PVGIS`);
    await p.click("#segTilt button[data-v='35']"); await p.waitForTimeout(900);
    ok((await p.evaluate(() => window.__calls)).filter(u => u.includes("angle=35")).length === 2, `${tag}: alte Neigung aus Zwischenspeicher`);
    // Dachformen
    for (const t of ["walm", "pult", "flach", "sattel"]) {
      await p.click(`#segType button[data-v='${t}']`); await p.waitForTimeout(900);
      const n = await p.evaluate(() => document.querySelectorAll("#roofs svg").length);
      ok(n === { walm: 4, pult: 1, flach: 2, sattel: 2 }[t], `${tag}: ${t} → ${n} Flächen`);
      await clean(p, `${tag} ${t}`);
    }
    await p.click("#segRidge button[data-v='short']"); await p.waitForTimeout(900); await clean(p, `${tag} First quer`);
    // Verbrauch
    await p.click("#segPers button[data-v='5']"); await p.waitForTimeout(800);
    ok(await p.inputValue("#household") === "5000", `${tag}: 5 Personen → 5000 kWh`);
    await p.check("#hpOn"); await p.waitForTimeout(800); ok(await p.isVisible("#hpKwh"), `${tag}: WP-Feld sichtbar`);
    await p.check("#evOn"); await p.waitForTimeout(400); await p.check("#evDay"); await p.waitForTimeout(800);
    await clean(p, `${tag} WP+E-Auto`);
    // Module und Speicher von Hand
    await p.fill("#cnt0", "999"); await p.dispatchEvent("#cnt0", "change"); await p.waitForTimeout(300);
    ok(+(await p.inputValue("#cnt0")) === +(await p.getAttribute("#cnt0", "max")), `${tag}: Modulzahl begrenzt`);
    await p.fill("#cnt0", "0"); await p.dispatchEvent("#cnt0", "change"); await p.fill("#cnt1", "0"); await p.dispatchEvent("#cnt1", "change"); await p.waitForTimeout(300);
    ok(/keine Anlage/.test(await txt(p, "#kChip")), `${tag}: ohne Module „keine Anlage“`); await clean(p, `${tag} 0 Module`);
    const rows = await p.$$("#vars tbody tr"); await rows[0].click(); await p.waitForTimeout(300);
    ok(await p.evaluate(() => document.querySelector("#vars tbody tr").classList.contains("on")), `${tag}: Variante übernommen`);
    await p.click("#segBat button[data-v='0']"); await p.waitForTimeout(300); ok(/ohne Speicher/.test(await txt(p, "#kInvS")), `${tag}: Speicher abwählbar`);
    // Preise
    await p.click("details summary"); await p.fill("#e_price", "45"); await p.dispatchEvent("#e_price", "change"); await p.waitForTimeout(300); await clean(p, `${tag} Preis`);
    await p.fill("#e_years", "99"); await p.dispatchEvent("#e_years", "change"); await p.waitForTimeout(300);
    ok(await p.inputValue("#e_years") === "30", `${tag}: Laufzeit begrenzt`);
    ok(p.errs.length === 0, `${tag}: Fehler ${p.errs.join(" | ")}`);
    await noScroll(p, tag);
    await p.close();
  }

  // 3. Adresse ohne Gebäude → Handeingabe
  {
    const p = await page("noBuilding"), tag = "ohne Umriss";
    await search(p, "Teststraße, Berlin");
    ok(await p.isVisible("#manual"), `${tag}: Handeingabe sichtbar`);
    await p.fill("#mL", "15"); await p.dispatchEvent("#mL", "change"); await p.waitForTimeout(200);
    await p.selectOption("#mDir", "225"); await p.waitForTimeout(200);
    ok(/15,0 ×/.test(await txt(p, "#siteMeta")), `${tag}: Länge übernommen`);
    ok(/Südwest/.test(await txt(p, "#siteMeta")), `${tag}: Ausrichtung übernommen (${await txt(p, "#siteMeta")})`);
    await planIt(p); await clean(p, tag);
    ok(p.errs.length === 0, `${tag}: Fehler ${p.errs.join(" | ")}`);
    await p.close();
  }

  // 4. Konnektor fehlt → klare Meldung
  {
    const p = await page("notConnected"), tag = "kein Konnektor";
    await search(p, "Teststraße 5, Berlin");
    ok(/Konnektoren hinzufügen/.test(await txt(p, "#addrStatus")), `${tag}: Hinweis auf Konnektor`);
    ok(await p.isVisible("#manual"), `${tag}: Handeingabe als Ausweg`);
    await p.close();
  }

  // 5. PVGIS fällt aus → Schätzung mit Hinweis
  {
    const p = await page("pvgisFail"), tag = "PVGIS-Ausfall";
    await search(p, "Teststraße 5, Berlin"); await planIt(p);
    ok(/geschätzt/.test(await txt(p, "#planStatus")) && /geschätzt/.test(await txt(p, "#kSpec")), `${tag}: Schätzung gekennzeichnet`);
    await clean(p, tag);
    await p.close();
  }

  // 6. Ohne Konnektor-Fähigkeit (außerhalb claude.ai)
  {
    const p = await page("none"), tag = "ohne mcp";
    await search(p, "Teststraße 5"); await p.waitForTimeout(400);
    ok(/claude\.ai öffnen/.test(await txt(p, "#addrStatus")), `${tag}: Hinweis (${await txt(p, "#addrStatus")})`);
    await p.close();
  }

  await b.close();
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
