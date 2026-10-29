#!/usr/bin/env node
/* Browsertest der Planungsseite: node test-ui.js <plan.html>  (benötigt playwright) */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const file = process.argv[2];
if (!file) { console.log("node test-ui.js <plan.html>"); process.exit(2); }
const html = fs.readFileSync(file, "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FEHLER:", m); } };

(async () => {
  const b = await chromium.launch();
  for (const [w, scheme] of [[1280, "light"], [360, "dark"]]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
    const errs = [];
    p.on("pageerror", e => errs.push(e.message));
    p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>${html}</body></html>`);
    await p.waitForTimeout(600);
    const tag = `[${w}px ${scheme}]`;
    const text = () => p.evaluate(() => document.querySelector("main").innerText);
    const clean = async step => { const t = await text(); ok(!/NaN|undefined|Infinity/.test(t), `${tag} ${step}: NaN/undefined im Text`); };
    const set = async (id, v) => { await p.fill("#" + id, String(v)); await p.dispatchEvent("#" + id, "input"); await p.waitForTimeout(400); };
    const kpi = id => p.evaluate(i => document.getElementById(i).textContent, id);

    ok(errs.length === 0, `${tag} Fehler beim Laden: ${errs.join(" | ")}`);
    await clean("Start");
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tag} kein horizontales Scrollen`);
    const nFaces = await p.evaluate(() => document.querySelectorAll("#faceInputs input").length);
    ok(nFaces >= 1, `${tag} Eingaben je Dachfläche`);
    ok(await p.evaluate(() => document.querySelectorAll("#vars tbody tr").length) >= 2, `${tag} Variantentabelle`);
    ok(await p.evaluate(() => document.querySelectorAll("#roofs svg").length) === nFaces, `${tag} Dachzeichnung je Fläche`);
    ok(await p.evaluate(() => !!document.querySelector("#vars tr.on")), `${tag} Vorschlag in Tabelle markiert`);
    ok(await p.evaluate(() => document.getElementById("changed").hidden), `${tag} Hinweis „eigene Auswahl“ anfangs aus`);

    // Module ändern → Zeichnung und Kennzahl folgen
    const max0 = +(await p.getAttribute("#cnt0", "max"));
    await set("cnt0", Math.max(0, max0 - 1));
    ok(await p.evaluate(() => !document.getElementById("changed").hidden), `${tag} eigene Auswahl erkannt`);
    const rects = await p.evaluate(() => document.querySelectorAll("#roofs > div:first-child svg rect[fill='var(--module)']").length);
    ok(rects === Math.max(0, max0 - 1), `${tag} Zeichnung zeigt ${max0 - 1} Module, ist ${rects}`);
    // über Maximum → begrenzt
    await set("cnt0", max0 + 50);
    await p.dispatchEvent("#cnt0", "change"); await p.waitForTimeout(300);
    ok(+(await p.inputValue("#cnt0")) === max0, `${tag} Modulzahl auf Maximum begrenzt (Feld zeigt ${await p.inputValue("#cnt0")})`);
    // alles auf 0
    for (let i = 0; i < nFaces; i++) await set("cnt" + i, 0);
    await clean("ohne Module");
    ok(/^0,00/.test(await kpi("kKwp")), `${tag} 0 kWp`);
    ok(/keine Anlage/i.test(await kpi("kChip")) || await p.evaluate(() => document.getElementById("kChip").hidden), `${tag} Chip ohne Anlage nicht „wirtschaftlich“`);
    // negative Eingabe
    await set("cnt0", -5); await clean("negative Module");
    await set("cap", -3); await clean("negativer Speicher");
    // Verbrauch 0, leere Felder
    await set("household", 0); await set("heatpump", ""); await clean("ohne Verbrauch");
    await set("years", ""); await clean("Laufzeit leer");
    await set("years", 30); await set("price", 0); await clean("Strompreis 0");
    // E-Auto tagsüber
    await set("household", 4000); await set("ev", 2500);
    await p.selectOption("#evMode", "tag"); await p.dispatchEvent("#evMode", "input"); await p.waitForTimeout(400);
    await clean("E-Auto tagsüber");
    // Optimum
    await p.click("#opt"); await p.waitForTimeout(500);
    ok(await p.evaluate(() => !!document.querySelector("#vars tbody tr.on")), `${tag} Optimum in Tabelle markiert`);
    await clean("nach Optimierung");
    // Variante anklicken
    const rows = await p.$$("#vars tbody tr");
    await rows[rows.length - 1].click(); await p.waitForTimeout(300);
    ok(await p.evaluate(() => document.querySelector("#vars tbody tr:last-child").classList.contains("on")), `${tag} angeklickte Variante markiert`);
    // Tastatur
    await p.focus("#vars tbody tr:first-child"); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
    ok(await p.evaluate(() => document.querySelector("#vars tbody tr:first-child").classList.contains("on")), `${tag} Variante per Enter`);
    // Wiederherstellen
    await p.click("#restore"); await p.waitForTimeout(500);
    ok(await p.evaluate(() => document.getElementById("changed").hidden), `${tag} Vorschlag wiederhergestellt`);
    ok(await p.inputValue("#household") !== "0", `${tag} Verbrauch wiederhergestellt`);
    await clean("nach Wiederherstellen");
    // Einspeisebegrenzung aus
    await p.click("#feedCap"); await p.waitForTimeout(400); await clean("ohne 60-%-Grenze");
    ok(errs.length === 0, `${tag} Fehler während der Bedienung: ${errs.join(" | ")}`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tag} kein horizontales Scrollen am Ende`);
    await p.close();
  }
  await b.close();
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
