// ════════════════════════════════════════════════════════════════
//  Jarvis – Sprachassistent für die Energie-Zentrale
//  Claude mit Werkzeugen: Energie lesen, Shelly schalten, Wetter,
//  Termine, Kameras. Dazu ein tägliches Briefing.
// ════════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const env = process.env;
const jcfg = {
  apiKeySet:  !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  model:      env.JARVIS_MODEL  || 'claude-opus-5-5',
  effort:     env.JARVIS_EFFORT || 'low',          // low = schnelle Sprachantworten
  token:      env.JARVIS_TOKEN  || '',             // Zugangsschutz; ohne Token kein Schalten
  name:       env.JARVIS_USER_NAME || '',
  lat:        env.JARVIS_LAT || '',
  lon:        env.JARVIS_LON || '',
  place:      env.JARVIS_PLACE || '',
  icsUrl:     env.CALENDAR_ICS_URL || '',
  briefingAt: env.BRIEFING_TIME || '06:30',        // HH:MM, Ortszeit des Pi
};

// ── Schaltbare Shelly-Geräte (nur diese darf Jarvis schalten) ─────────
function loadSwitches() {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const id = env[`SWITCH${i}_ID`];
    if (!id) continue;
    list.push({
      name:    (env[`SWITCH${i}_NAME`] || `Schalter ${i}`).trim(),
      id,
      channel: parseInt(env[`SWITCH${i}_CHANNEL`] || '0', 10),
    });
  }
  return list;
}
const switches = loadSwitches();

module.exports = function mountJarvis(app, ctx) {
  const { cfg, getShelly, getShellyHistory, getVictron, getEufy } = ctx;
  const client = jcfg.apiKeySet ? new Anthropic() : null;
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  // ── Zugangsschutz ──────────────────────────────────────────────
  function tokenOk(req) {
    if (!jcfg.token) return true;
    const given = req.get('x-jarvis-token') || '';
    const a = Buffer.from(given), b = Buffer.from(jcfg.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  router.use((req, res, next) => tokenOk(req) ? next() : res.status(401).json({ error: 'Zugangscode fehlt oder falsch' }));

  // ── Shelly schalten ────────────────────────────────────────────
  async function shellyCloud(path, params) {
    const res = await fetch(`${cfg.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_key: cfg.authKey, ...params }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Shelly HTTP ${res.status}`);
    const json = await res.json();
    if (!json.isok) throw new Error(JSON.stringify(json.errors || 'Shelly API Fehler'));
    return json.data;
  }

  async function switchState(sw) {
    const d = await shellyCloud('/device/status', { id: sw.id });
    const s = d.device_status || {};
    const gen2 = s[`switch:${sw.channel}`];
    if (gen2) return { an: !!gen2.output, leistung_w: gen2.apower ?? null, online: true };
    const gen1 = s.relays?.[sw.channel];
    if (gen1) return { an: !!gen1.ison, leistung_w: s.meters?.[sw.channel]?.power ?? null, online: true };
    return { an: null, leistung_w: null, online: !!s.cloud?.connected };
  }

  function findSwitch(name) {
    const n = String(name || '').toLowerCase().trim();
    return switches.find(s => s.name.toLowerCase() === n)
        || switches.find(s => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()));
  }

  async function setSwitch(name, on) {
    if (!jcfg.token) throw new Error('Schalten ist gesperrt: JARVIS_TOKEN ist nicht gesetzt.');
    if (cfg.simulate) throw new Error('Simulationsmodus: es ist keine Shelly-Cloud konfiguriert.');
    const sw = findSwitch(name);
    if (!sw) throw new Error(`Unbekannter Schalter "${name}". Erlaubt: ${switches.map(s => s.name).join(', ') || 'keine'}`);
    await shellyCloud('/device/relay/control', { id: sw.id, channel: String(sw.channel), turn: on ? 'on' : 'off' });
    console.log(`Jarvis: ${sw.name} → ${on ? 'AN' : 'AUS'}`);
    return { schalter: sw.name, gesetzt: on ? 'an' : 'aus' };
  }

  // ── Wetter (Open-Meteo, ohne Schlüssel) ────────────────────────
  const WMO = { 0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt', 45: 'Nebel', 48: 'Reifnebel',
    51: 'leichter Niesel', 53: 'Niesel', 55: 'starker Niesel', 61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen',
    66: 'gefrierender Regen', 67: 'starker gefrierender Regen', 71: 'leichter Schneefall', 73: 'Schneefall',
    75: 'starker Schneefall', 77: 'Schneegriesel', 80: 'leichte Schauer', 81: 'Schauer', 82: 'heftige Schauer',
    85: 'Schneeschauer', 86: 'starke Schneeschauer', 95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Gewitter mit starkem Hagel' };

  async function weather() {
    if (!jcfg.lat || !jcfg.lon) throw new Error('Kein Standort: JARVIS_LAT / JARVIS_LON setzen.');
    const q = new URLSearchParams({
      latitude: jcfg.lat, longitude: jcfg.lon, timezone: 'Europe/Berlin', forecast_days: '2',
      current: 'temperature_2m,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunshine_duration',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Wetter HTTP ${res.status}`);
    const j = await res.json();
    const day = i => ({
      datum: j.daily.time[i],
      wetter: WMO[j.daily.weather_code[i]] ?? `Code ${j.daily.weather_code[i]}`,
      max_c: j.daily.temperature_2m_max[i], min_c: j.daily.temperature_2m_min[i],
      regen_wahrscheinlichkeit_pct: j.daily.precipitation_probability_max[i],
      sonnenstunden: Math.round((j.daily.sunshine_duration[i] || 0) / 360) / 10,
    });
    return {
      ort: jcfg.place || `${jcfg.lat}, ${jcfg.lon}`,
      jetzt: { temp_c: j.current.temperature_2m, wetter: WMO[j.current.weather_code] ?? '', wind_kmh: j.current.wind_speed_10m },
      heute: day(0), morgen: day(1),
    };
  }

  // ── Kalender (ICS-Link, z. B. Google „Privatadresse im iCal-Format") ──
  function parseIcsDate(val, params) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(val.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (!h) return { date: new Date(+y, +mo - 1, +d), allDay: true };
    if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
    // TZID oder „floating": als Ortszeit des Pi behandeln (Pi auf Europe/Berlin stellen)
    return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false, tz: params.TZID };
  }

  async function eventsOn(offsetDays = 0) {
    if (!jcfg.icsUrl) throw new Error('Kein Kalender: CALENDAR_ICS_URL setzen.');
    const res = await fetch(jcfg.icsUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Kalender HTTP ${res.status}`);
    const lines = (await res.text()).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + offsetDays);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const out = []; let ev = null; let skippedRecurring = 0;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
      if (line === 'END:VEVENT') {
        if (ev?.rrule) skippedRecurring++;
        else if (ev?.start && ev.start.date < end && (ev.end?.date ?? ev.start.date) >= start) {
          out.push({
            titel: ev.summary || '(ohne Titel)',
            ganztags: ev.start.allDay,
            beginn: ev.start.allDay ? null : ev.start.date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            ort: ev.location || null,
            _t: ev.start.date.getTime(),
          });
        }
        ev = null; continue;
      }
      if (!ev) continue;
      const idx = line.indexOf(':'); if (idx < 0) continue;
      const [key, ...pp] = line.slice(0, idx).split(';');
      const params = Object.fromEntries(pp.map(p => p.split('=')));
      const val = line.slice(idx + 1).replace(/\\n/g, ' ').replace(/\\([,;\\])/g, '$1');
      if (key === 'DTSTART') ev.start = parseIcsDate(val, params);
      else if (key === 'DTEND') ev.end = parseIcsDate(val, params);
      else if (key === 'SUMMARY') ev.summary = val;
      else if (key === 'LOCATION') ev.location = val;
      else if (key === 'RRULE') ev.rrule = true;
    }
    out.sort((a, b) => a._t - b._t).forEach(e => delete e._t);
    return {
      datum: start.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }),
      termine: out,
      hinweis: skippedRecurring ? `${skippedRecurring} Serientermin(e) im Kalender werden nicht ausgewertet.` : undefined,
    };
  }

  // ── Energie ────────────────────────────────────────────────────
  function energyNow() {
    const s = getShelly(), v = getVictron();
    return {
      simulation: !!cfg.simulate,
      pv_w: Math.round(s.pv), verbrauch_w: Math.round(s.consumption),
      netz_w: Math.round(s.grid), netz_hinweis: 'positiv = Bezug aus dem Netz, negativ = Einspeisung',
      heizstab_w: s.heizstab ?? null,
      messfehler: !!s.error, stand: new Date(s.ts).toLocaleTimeString('de-DE'),
      batterie: v ? { ladestand_pct: v.soc, leistung_w: v.batteryPower, zustand: v.state } : null,
    };
  }

  function energyHistory(minutes) {
    const since = Date.now() - minutes * 60_000;
    const h = getShellyHistory().filter(x => x.ts >= since);
    if (!h.length) return { hinweis: 'Keine Daten im Zeitraum (Verlauf reicht max. ca. 2 Stunden zurück).' };
    const stat = k => {
      const v = h.map(x => x[k]);
      return { min: Math.round(Math.min(...v)), max: Math.round(Math.max(...v)), mittel: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
    };
    return { minuten: Math.round((Date.now() - h[0].ts) / 60_000), messpunkte: h.length, pv_w: stat('pv'), verbrauch_w: stat('consumption'), netz_w: stat('grid') };
  }

  // ── Werkzeuge für Claude ───────────────────────────────────────
  const noArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const tools = [
    { name: 'energie_status', description: 'Aktuelle Werte: PV-Erzeugung, Hausverbrauch, Netzbezug/Einspeisung, Heizstab und Batterie (Victron).', input_schema: noArgs, strict: true },
    { name: 'energie_verlauf', description: 'Minimum, Maximum und Mittelwert von PV, Verbrauch und Netz über die letzten N Minuten (max. ca. 120).',
      input_schema: { type: 'object', properties: { minuten: { type: 'integer', description: 'Zeitraum in Minuten, 5 bis 120' } }, required: ['minuten'], additionalProperties: false }, strict: true },
    { name: 'schalter_liste', description: 'Liste der Shelly-Schalter, die Jarvis schalten darf, mit aktuellem Zustand.', input_schema: noArgs, strict: true },
    { name: 'schalter_setzen', description: 'Schaltet einen freigegebenen Shelly-Schalter an oder aus. Nur ausführen, wenn der Nutzer es klar verlangt hat.',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Name des Schalters aus schalter_liste' }, an: { type: 'boolean', description: 'true = einschalten, false = ausschalten' } }, required: ['name', 'an'], additionalProperties: false }, strict: true },
    { name: 'wetter', description: 'Wetter jetzt, heute und morgen am Standort, inkl. Sonnenstunden (für PV-Prognose).', input_schema: noArgs, strict: true },
    { name: 'termine', description: 'Termine aus dem Kalender für heute (tag=0) oder morgen (tag=1).',
      input_schema: { type: 'object', properties: { tag: { type: 'integer', enum: [0, 1] } }, required: ['tag'], additionalProperties: false }, strict: true },
    { name: 'kameras', description: 'Status der eufy-Kameras (online, Akku, letztes Ereignis).', input_schema: noArgs, strict: true },
  ];

  async function runTool(name, input) {
    switch (name) {
      case 'energie_status':  return energyNow();
      case 'energie_verlauf': return energyHistory(Math.min(120, Math.max(5, +input.minuten || 30)));
      case 'schalter_liste':
        if (cfg.simulate) return { hinweis: 'Simulationsmodus – keine echten Schalter.', schalter: switches.map(s => s.name) };
        return Promise.all(switches.map(async s => ({ name: s.name, ...(await switchState(s).catch(e => ({ fehler: e.message }))) })));
      case 'schalter_setzen': return setSwitch(input.name, !!input.an);
      case 'wetter':          return weather();
      case 'termine':         return eventsOn(input.tag === 1 ? 1 : 0);
      case 'kameras': {
        const cams = getEufy();
        return cams.configured ? cams.cameras : { hinweis: 'eufy ist nicht eingerichtet.' };
      }
      default: throw new Error(`Unbekanntes Werkzeug ${name}`);
    }
  }

  const SYSTEM = [
    'Du bist Jarvis, der Hausassistent für Energie und Smart Home' + (jcfg.name ? ` von ${jcfg.name}` : '') + '.',
    'Antworte immer auf Deutsch, kurz und gesprochen formuliert: ein bis drei Sätze, keine Aufzählungen, kein Markdown, keine Emojis.',
    'Zahlen gerundet und mit Einheit aussprechbar (z. B. "3,2 Kilowatt").',
    'Hole Werte immer über die Werkzeuge, rate nie. Wenn ein Werkzeug einen Fehler meldet, sag das ehrlich.',
    'Schalte nur, wenn der Nutzer es eindeutig verlangt; bestätige danach knapp, was geschaltet wurde.',
  ].join('\n');

  // ── Gespräche (im Speicher, 30 Min.) ───────────────────────────
  const convos = new Map();
  setInterval(() => { const cut = Date.now() - 30 * 60_000; for (const [k, c] of convos) if (c.ts < cut) convos.delete(k); }, 60_000).unref();

  async function ask(messages) {
    // Server-seitiger Fallback: lehnt das Modell ab, beantwortet ein anderes Modell automatisch.
    return client.beta.messages.create({
      model: jcfg.model,
      max_tokens: 4000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: jcfg.effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  }

  async function converse(convo, text) {
    convo.messages.push({ role: 'user', content: text });
    const actions = [];
    for (let i = 0; i < 8; i++) {
      const r = await ask(convo.messages);
      convo.messages.push({ role: 'assistant', content: r.content });
      if (r.stop_reason === 'refusal') return { text: 'Dazu kann ich leider nichts sagen.', actions };
      if (r.stop_reason === 'pause_turn') continue;
      const uses = r.content.filter(b => b.type === 'tool_use');
      if (r.stop_reason !== 'tool_use' || !uses.length) {
        const out = r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        return { text: out || (r.stop_reason === 'max_tokens' ? 'Die Antwort wurde abgeschnitten.' : '…'), actions };
      }
      const results = await Promise.all(uses.map(async u => {
        try {
          const res = await runTool(u.name, u.input || {});
          if (u.name === 'schalter_setzen') actions.push(res);
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(res) };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: u.id, content: e.message, is_error: true };
        }
      }));
      convo.messages.push({ role: 'user', content: results });
    }
    return { text: 'Das hat zu viele Schritte gebraucht, ich breche ab.', actions };
  }

  router.post('/chat', async (req, res) => {
    if (!client) return res.status(503).json({ error: 'ANTHROPIC_API_KEY ist nicht gesetzt.' });
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Kein Text' });
    let id = String(req.body?.conversation || '');
    let convo = convos.get(id);
    if (!convo || convo.messages.length > 60) { id = crypto.randomUUID(); convo = { messages: [], ts: 0 }; convos.set(id, convo); }
    convo.ts = Date.now();
    try {
      const out = await converse(convo, text);
      res.json({ conversation: id, ...out });
    } catch (e) {
      convos.delete(id); // Gespräch mit offenem Werkzeugaufruf nicht weiterführen
      console.warn('Jarvis:', e.message);
      const msg = e instanceof Anthropic.AuthenticationError ? 'API-Schlüssel ungültig.'
                : e instanceof Anthropic.RateLimitError ? 'Zu viele Anfragen, bitte gleich nochmal.'
                : e instanceof Anthropic.APIError ? `Claude-Fehler ${e.status}.` : e.message;
      res.status(502).json({ error: msg });
    }
  });

  // ── Schalter direkt (für die Kacheln in der Oberfläche) ─────────
  router.get('/switches', async (_q, res) => {
    if (cfg.simulate) return res.json({ simulated: true, canSwitch: false, switches: switches.map(s => ({ name: s.name })) });
    const list = await Promise.all(switches.map(async s => ({ name: s.name, ...(await switchState(s).catch(e => ({ fehler: e.message }))) })));
    res.json({ simulated: false, canSwitch: !!jcfg.token, switches: list });
  });

  router.post('/switches', async (req, res) => {
    try { res.json(await setSwitch(req.body?.name, !!req.body?.an)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Tägliches Briefing ─────────────────────────────────────────
  let briefing = null;
  let briefingBusy = null;

  async function buildBriefing() {
    const settle = p => p.then(v => v, e => ({ fehler: e.message }));
    const [wetter, termine, termineMorgen] = await Promise.all([
      settle(weather()), settle(eventsOn(0)), settle(eventsOn(1)),
    ]);
    const data = { jetzt: new Date().toLocaleString('de-DE'), energie: energyNow(), wetter, termine_heute: termine, termine_morgen: termineMorgen, kameras: getEufy().configured ? getEufy().cameras : null };
    let text;
    if (client) {
      const r = await client.beta.messages.create({
        model: jcfg.model, max_tokens: 2000,
        system: SYSTEM + '\nErstelle jetzt das Morgen-Briefing: Begrüßung, Wetter und was das für die PV-Erzeugung heißt, Termine heute, Energie- und Batteriestand, Auffälligkeiten (z. B. Kamera offline). Höchstens sechs Sätze, zum Vorlesen. Fehlende Daten kurz erwähnen, nichts erfinden.',
        messages: [{ role: 'user', content: JSON.stringify(data) }],
        output_config: { effort: jcfg.effort },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      });
      text = r.stop_reason === 'refusal' ? 'Briefing konnte nicht erstellt werden.' : r.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    } else {
      text = 'Kein API-Schlüssel gesetzt – hier nur die Rohdaten.';
    }
    briefing = { text, data, ts: Date.now() };
    console.log('Jarvis: Briefing erstellt');
    return briefing;
  }

  function getBriefing(force) {
    if (!force && briefing && new Date(briefing.ts).toDateString() === new Date().toDateString()) return Promise.resolve(briefing);
    if (!briefingBusy) briefingBusy = buildBriefing().finally(() => { briefingBusy = null; });
    return briefingBusy;
  }

  setInterval(() => {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hm === jcfg.briefingAt) getBriefing(true).catch(e => console.warn('Briefing:', e.message));
  }, 60_000).unref();

  router.get('/briefing', async (req, res) => {
    try { res.json(await getBriefing(req.query.refresh === '1')); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  router.get('/config', (_q, res) => res.json({
    ai: !!client, model: jcfg.model, switches: switches.length, canSwitch: !!jcfg.token && !cfg.simulate,
    weather: !!(jcfg.lat && jcfg.lon), calendar: !!jcfg.icsUrl, briefingAt: jcfg.briefingAt,
  }));

  app.use('/api/jarvis', router);
  app.get('/jarvis', (_q, res) => res.redirect('/jarvis.html'));

  console.log(`  Jarvis: ${client ? jcfg.model : 'ohne KI (ANTHROPIC_API_KEY fehlt)'}, ${switches.length} Schalter${jcfg.token ? '' : ' (Schalten gesperrt – JARVIS_TOKEN fehlt)'}`);
};
