require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js vom Pi selbst ausliefern – Dashboard funktioniert auch ohne Internet
app.get('/vendor/chart.umd.js', (_q, res) => res.sendFile(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.js')));

// ── Konfiguration ──────────────────────────────────────────────────
function loadPvMeters() {
  const meters = [];
  for (let i = 1; i <= 9; i++) {
    const id = process.env[`PV${i}_SHELLY_ID`];
    if (!id) break;
    meters.push({ id, type: process.env[`PV${i}_SHELLY_TYPE`] || 'pm1', index: i });
  }
  return meters;
}

const cfg = {
  authKey:   process.env.SHELLY_AUTH_KEY   || '',
  serverUrl: (process.env.SHELLY_SERVER_URL || 'https://shelly-103-eu.shelly.cloud').replace(/\/$/, ''),
  pvMeters:  loadPvMeters(),
  gridId:    process.env.GRID_SHELLY_ID   || '',
  gridType:  process.env.GRID_SHELLY_TYPE || 'em3',
  heizstabId:   process.env.HEIZSTAB_SHELLY_ID   || '',
  heizstabType: process.env.HEIZSTAB_SHELLY_TYPE || 'pm1',
  pollMs:    parseInt(process.env.POLL_INTERVAL || '10000'),
  port:      parseInt(process.env.PORT          || '3000'),
  victronEmail:    process.env.VICTRON_EMAIL    || '',
  victronPassword: process.env.VICTRON_PASSWORD || '',
  victronToken:    process.env.VICTRON_TOKEN    || '',
  victronSiteId:   process.env.VICTRON_SITE_ID  || '459608',
  eufyEmail:    process.env.EUFY_EMAIL    || '',
  eufyPassword: process.env.EUFY_PASSWORD || '',
  eufyCountry:  process.env.EUFY_COUNTRY  || 'DE',
};

cfg.simulate   = process.env.SIMULATE === 'true' || !cfg.authKey || cfg.pvMeters.length === 0;
cfg.hasVictron = !!(cfg.victronToken || (cfg.victronEmail && cfg.victronPassword));
cfg.hasEufy    = !!(cfg.eufyEmail && cfg.eufyPassword);

// ── Shelly ─────────────────────────────────────────────────────────
const HIST = 720;
const shellyHistory = [];
let shellyCurrent = { pv: 0, grid: 0, consumption: 0, ts: Date.now(), error: false };

async function fetchDeviceStatus(deviceId) {
  const res = await fetch(`${cfg.serverUrl}/device/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ auth_key: cfg.authKey, id: deviceId }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.isok) throw new Error(json.errors?.join(', ') || 'Shelly API Fehler');
  return json.data.device_status;
}

async function readMeter(id, type) {
  if (!id) return null;
  try {
    const s = await fetchDeviceStatus(id);
    if (type === 'em3')    return s['em:0']?.total_act_power ?? null;
    if (type === 'em')     return s['em:0']?.act_power       ?? null;
    if (type === 'pm1')    return s['pm1:0']?.apower         ?? null;
    if (type === 'switch') return s['switch:0']?.apower      ?? null;
    if (type === 'gen1')   return s.meters?.[0]?.power       ?? null;
    return null;
  } catch (e) {
    console.warn(`Shelly (${id} / ${type}): ${e.message}`);
    return null;
  }
}

function simulateShelly() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const sun = Math.max(0, Math.sin(Math.PI * (h - 6) / 14));
  const pv  = Math.max(0, Math.round(sun * 4800 + (Math.random() - 0.5) * 150));
  const spike = Math.random() < 0.03 ? 800 + Math.random() * 1500 : 0;
  const heizstab = Math.random() < 0.4 ? 840 : 0;
  return { pv, consumption: Math.round(280 + Math.random() * 200 + spike + heizstab), heizstab };
}

async function pollShelly() {
  if (cfg.simulate) {
    const { pv, consumption, heizstab } = simulateShelly();
    shellyCurrent = { pv, grid: consumption - pv, consumption, heizstab, ts: Date.now(), error: false, simulated: true };
  } else {
    const results = await Promise.all([
      ...cfg.pvMeters.map(m => readMeter(m.id, m.type)),
      readMeter(cfg.gridId, cfg.gridType),
      readMeter(cfg.heizstabId, cfg.heizstabType),
    ]);
    const pvReadings  = results.slice(0, cfg.pvMeters.length);
    const gridRaw     = results[cfg.pvMeters.length];
    const heizstabRaw = results[cfg.pvMeters.length + 1];
    // Math.abs() pro PV-Gerät: negative Werte entstehen wenn der Shelly-Stromsensor
    // umgekehrt eingebaut ist — die Energie wird trotzdem erzeugt
    const pv          = pvReadings.reduce((s, v) => s + Math.abs(v ?? 0), 0);
    const grid        = gridRaw ?? 0;
    const heizstab    = heizstabRaw != null ? Math.abs(heizstabRaw) : null;
    shellyCurrent = { pv, grid, consumption: Math.max(0, pv + grid), heizstab, ts: Date.now(), error: pvReadings.some(v => v === null) };
  }
  shellyHistory.push({ ...shellyCurrent });
  if (shellyHistory.length > HIST) shellyHistory.shift();
}

pollShelly();
setInterval(pollShelly, cfg.pollMs);

// ── Victron VRM ────────────────────────────────────────────────────
const VRM = 'https://vrmapi.victronenergy.com/v2';
let vrmToken = cfg.victronToken || null;
let vrmExpiry = cfg.victronToken ? Date.now() + 86_400_000 : 0;
let victronCurrent = null;
const victronHistory = [];

async function vrmLogin() {
  const res = await fetch(`${VRM}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.victronEmail, password: cfg.victronPassword, remember_me: true }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`VRM Login HTTP ${res.status}`);
  const j = await res.json();
  if (!j.token) throw new Error(j.errors?.join(', ') || 'VRM: kein Token erhalten');
  vrmToken  = j.token;
  vrmExpiry = Date.now() + 86_400_000;
  console.log('Victron VRM: Angemeldet ✓');
}

async function vrmGet(path) {
  if (!vrmToken || Date.now() > vrmExpiry) await vrmLogin();
  const res = await fetch(`${VRM}${path}`, {
    headers: { 'X-Authorization': `Token ${vrmToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) { vrmToken = null; vrmExpiry = 0; throw new Error('VRM: Token abgelaufen'); }
  if (!res.ok) throw new Error(`VRM HTTP ${res.status}`);
  return res.json();
}

function parseVrmDiag(records) {
  const byId = {}, byName = {};
  for (const r of records) {
    byId[r.idDataAttribute] = r;
    byName[(r.description || '').toLowerCase().trim()] = r;
  }
  const num = (...ids) => { for (const id of ids) if (byId[id]?.rawValue != null) return +byId[id].rawValue; return null; };
  const nmd = (...ks)  => { for (const k  of ks)  if (byName[k]?.rawValue != null)  return +byName[k].rawValue;  return null; };
  const str = (...ids) => { for (const id of ids) if (byId[id]?.formattedValue) return byId[id].formattedValue;  return null; };
  const snm = (...ks)  => { for (const k  of ks)  if (byName[k]?.formattedValue)    return byName[k].formattedValue; return null; };

  return {
    soc:          num(336)       ?? nmd('battery state of charge'),
    voltage:      num(259)       ?? nmd('battery voltage'),
    current:      num(261)       ?? nmd('battery current'),
    batteryPower: num(855, 329)  ?? nmd('battery power'),
    pvPower:      num(850, 851)  ?? nmd('pv power') ?? nmd('solar charger pv power'),
    gridPower:    num(9, 852)    ?? nmd('grid power') ?? nmd('ac input power'),
    acLoad:       num(19)        ?? nmd('ac consumption') ?? nmd('ac loads'),
    state:        str(1027,1029) ?? snm('ve.bus state') ?? snm('system state') ?? snm('inverter/charger state'),
    ts: Date.now(),
    error: false,
  };
}

async function pollVictron() {
  if (!cfg.hasVictron) return;
  try {
    const json = await vrmGet(`/installations/${cfg.victronSiteId}/diagnostics`);
    victronCurrent = parseVrmDiag(json.records || []);
    victronHistory.push({ ...victronCurrent });
    if (victronHistory.length > HIST) victronHistory.shift();
  } catch (e) {
    console.warn('Victron:', e.message);
    if (victronCurrent) victronCurrent.error = true;
  }
}

if (cfg.hasVictron) {
  pollVictron();
  setInterval(pollVictron, 30_000);
}

// ── eufy Kameras ───────────────────────────────────────────────────
const EUFY_URL = {
  DE: 'https://security-app-eu.eufylife.com',
  EU: 'https://security-app-eu.eufylife.com',
  US: 'https://security-app.eufylife.com',
};
let eufySess = null;
let eufyCameras = [];
const CAM_TYPES = new Set([2, 7, 8, 14, 15, 30, 31, 35]);

function eufyHdrs() {
  return {
    'Content-Type': 'application/json',
    'app_version':  '5.4.0.11',
    'os_type':      '0',
    'model_type':   'PHONE',
    'language':     'de',
    'country':      cfg.eufyCountry,
    ...(eufySess ? { auth_token: eufySess.token } : {}),
  };
}

async function eufyLogin() {
  const base = EUFY_URL[cfg.eufyCountry] ?? EUFY_URL.EU;
  const pw   = crypto.createHash('md5').update(cfg.eufyPassword).digest('hex');
  const res  = await fetch(`${base}/v1/passport/login`, {
    method: 'POST', headers: eufyHdrs(),
    body: JSON.stringify({ email: cfg.eufyEmail, password: pw, ab_code: cfg.eufyCountry, time_zone: 'Europe/Berlin', child_station_list: '[]', verify_code: '' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`eufy Login HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== 0) throw new Error(`eufy: ${j.msg || j.code}`);
  eufySess = { token: j.data.auth_token, domain: j.data.domain || base, expiry: Date.now() + 30 * 86_400_000 };
  console.log('eufy: Angemeldet ✓');
}

async function eufyPost(path, body) {
  if (!eufySess || Date.now() > eufySess.expiry) await eufyLogin();
  const res = await fetch(`${eufySess.domain}${path}`, {
    method: 'POST', headers: eufyHdrs(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`eufy HTTP ${res.status}`);
  const j = await res.json();
  if ([26050, 10026, 100023].includes(j.code)) { eufySess = null; throw new Error('eufy: Session abgelaufen'); }
  return j.data;
}

async function pollEufy() {
  if (!cfg.hasEufy) return;
  try {
    const data = await eufyPost('/v1/app/get_devs_list', { count: 100, begin: 0 });
    const devs = data?.device_info || [];
    eufyCameras = devs.filter(d => CAM_TYPES.has(d.device_type)).map(d => {
      const params = Object.fromEntries((d.params || []).map(p => [p.param_type, p.param_value]));
      return {
        id:        d.device_sn,
        name:      d.device_name,
        model:     d.device_model || 'eufy Kamera',
        online:    d.p2p_conn_status === 1,
        thumbnail: d.cover_path || null,
        battery:   params[2015] != null ? +params[2015] : null,
        lastEvent: d.last_operate_time ? new Date(d.last_operate_time * 1000).toISOString() : null,
      };
    });
    console.log(`eufy: ${eufyCameras.length} Kamera(s)`);
  } catch (e) {
    console.warn('eufy:', e.message);
  }
}

if (cfg.hasEufy) {
  pollEufy();
  setInterval(pollEufy, 5 * 60_000);
}

// ── API Endpunkte ──────────────────────────────────────────────────
app.get('/api/data', (_q, res) => res.json({
  current: shellyCurrent,
  history: shellyHistory.slice(-72),
  pollInterval: cfg.pollMs,
  simulated: cfg.simulate,
  hasGrid: !!cfg.gridId || cfg.simulate,
}));

app.get('/api/history/full', (_q, res) => res.json(shellyHistory));

app.get('/api/victron', (_q, res) => res.json({
  current: victronCurrent,
  history: victronHistory.slice(-72),
  configured: cfg.hasVictron,
  siteId: cfg.victronSiteId,
}));

app.get('/api/eufy', (_q, res) => res.json({
  cameras: eufyCameras,
  configured: cfg.hasEufy,
}));

// ── Jarvis: Home Assistant, Lagebild, Hinweise, Befehle, KI ───────
const { HomeAssistant } = require('./jarvis/ha');
const { Home } = require('./jarvis/home');
const { Notifier } = require('./jarvis/notify');
const { Commands } = require('./jarvis/commands');
const { Assistant } = require('./jarvis/ai');
const { Discovery } = require('./jarvis/discovery');
const { MotionTracker } = require('./jarvis/motion');
const { SystemCheck } = require('./jarvis/systemcheck');
const { OTHER_DOMAINS } = require('./jarvis/ha');

const ha = new HomeAssistant({
  url: process.env.HA_URL,
  token: process.env.HA_TOKEN,
  hide: (process.env.JARVIS_HIDE || '').split(','),
});
const home = new Home({
  ha,
  getShelly: () => shellyCurrent,
  getVictron: () => victronCurrent,
  washer: {
    powerEntity: process.env.WASCHMASCHINE_POWER_ENTITY,
    statusEntity: process.env.WASCHMASCHINE_STATUS_ENTITY,
    endEntity: process.env.WASCHMASCHINE_ENDE_ENTITY,
  },
});
const notifier = new Notifier({ ha, home, surplusW: parseInt(process.env.JARVIS_UEBERSCHUSS_W || '1500') });
const commands = new Commands({ ha, home });
const assistant = new Assistant({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.JARVIS_MODEL,
  ha, home,
});
const motion = new MotionTracker({ ha, file: path.join(__dirname, 'data', 'bewegungen.json') });
home.motion = motion;
const discovery = new Discovery({
  ha, notifier,
  file: path.join(__dirname, 'data', 'bekannte-geraete.json'),
  intervalMin: parseInt(process.env.JARVIS_PRUEFUNG_MIN || '60'),
});
const CAM_REFRESH_MIN = Math.max(1, parseInt(process.env.JARVIS_KAMERA_MIN || '10'));
ha.start();
notifier.start();
discovery.start();
motion.start();
const systemCheck = new SystemCheck({
  root: __dirname, cfg, ha, home, motion, discovery, assistant,
  getShelly: () => shellyCurrent, getVictron: () => victronCurrent,
  pin: !!process.env.JARVIS_PIN, eufyUrl: process.env.EUFY_WS_URL || 'ws://127.0.0.1:3001',
});
commands.systemCheck = systemCheck;

// Optionale PIN: schützt alle schaltenden Endpunkte (Gäste-WLAN, Kinder …)
const JARVIS_PIN = process.env.JARVIS_PIN || '';
function pinCheck(req, res, next) {
  if (!JARVIS_PIN) return next();
  const cookie = /(?:^|;\s*)jarvis_pin=([^;]+)/.exec(req.get('cookie') || '');
  const given = String(req.get('x-jarvis-pin') || (cookie ? decodeURIComponent(cookie[1]) : ''));
  const a = Buffer.from(given), b = Buffer.from(JARVIS_PIN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'PIN erforderlich', pin: true });
}

// Alles unter /api/jarvis und /api/ha (außer config) nur mit PIN – auch Kamerabilder und Anwesenheit
app.use(['/api/jarvis', '/api/ha'], (req, res, next) => req.path === '/config' ? next() : pinCheck(req, res, next));

const haReady = (_q, res, next) => ha.enabled ? next() : res.status(503).json({ error: 'Home Assistant ist nicht eingerichtet (HA_URL / HA_TOKEN)' });

app.get('/api/jarvis/config', (_q, res) => res.json({
  ha: ha.enabled, haOk: ha.ok, haError: ha.error,
  ai: assistant.enabled, pinRequired: !!JARVIS_PIN,
  washer: home.washer.configured,
  cameraRefreshMin: CAM_REFRESH_MIN,
}));

app.get('/api/jarvis/home', (_q, res) => res.json({
  briefing: home.briefing(),
  energy: home.energy(),
  alarm: ha.ok ? home.alarm() : null,
  vacuums: ha.ok ? home.vacuums() : [],
  washer: home.washer.info(ha),
  lastMotion: ha.ok ? home.lastMotion() : null,
  motion: ha.ok ? ha.motionSensors().map(m => ({ ...m, lastMotion: motion.lastFor(m.id) })) : [],
  cameras: ha.ok ? ha.byDomain('camera').map(c => ({ ...c, ...motion.forCamera(c.id) })) : [],
  motionMap: motion.mapSource,
  switches: ha.ok ? ha.entities().filter(e => ['switch', 'light', 'fan'].includes(e.domain)) : [],
  others: ha.ok ? ha.entities().filter(e => OTHER_DOMAINS.has(e.domain)) : [],
  neu: Object.keys(discovery.newSince),
  discovery: discovery.status(),
  ha: { enabled: ha.enabled, ok: ha.ok, error: ha.error },
}));

app.get('/api/jarvis/hinweise', (_q, res) => res.json(notifier.log));
app.post('/api/jarvis/pruefen', (_q, res) => res.json(discovery.run()));
app.get('/api/jarvis/diagnose/bewegung', (_q, res) => res.json(motion.diagnose()));
app.get('/api/jarvis/systemcheck', async (_q, res) => {
  try { res.json(await systemCheck.run()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/jarvis/stream', (req, res) => notifier.attach(req, res));

app.post('/api/jarvis/ask', express.json({ limit: '4kb' }), async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Kein Text' });
  try {
    const r = await commands.run(text);
    if (r) return res.json({ ...r, source: 'regel' });
    const k = await assistant.ask(text);
    if (k) return res.json(k);
    res.json({ reply: `Das habe ich nicht verstanden. ${commands.help()}`, source: 'keine' });
  } catch (e) {
    res.json({ reply: `Das hat nicht geklappt: ${e.message}.`, source: 'fehler' });
  }
});

app.get('/api/ha/states', haReady, (_q, res) => res.json({ ok: ha.ok, error: ha.error, entities: ha.entities() }));

app.post('/api/ha/service/:domain/:service', express.json({ limit: '2kb' }), haReady, async (req, res) => {
  try {
    await ha.call(req.params.domain, req.params.service, req.body?.entity_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const CAM_ID = /^camera\.[a-z0-9_]+$/;
app.get('/api/ha/camera/:entityId', haReady, async (req, res) => {
  if (!CAM_ID.test(req.params.entityId)) return res.status(400).end();
  try {
    const img = await ha.cameraImage(req.params.entityId);
    res.set({ 'Content-Type': img.type, 'Cache-Control': 'no-store' }).send(img.body);
  } catch { res.status(502).end(); }
});

app.get('/api/ha/camera/:entityId/live', haReady, async (req, res) => {
  if (!CAM_ID.test(req.params.entityId)) return res.status(400).end();
  try { await ha.cameraStream(req.params.entityId, res, req); }
  catch { if (!res.headersSent) res.status(502).end(); }
});

app.get('/api/status', (_q, res) => res.json({
  shelly:   { ok: !cfg.simulate, sim: cfg.simulate },
  victron:  { ok: cfg.hasVictron, siteId: cfg.victronSiteId },
  eufy:     { ok: cfg.hasEufy, cameras: eufyCameras.length },
  homeassistant: { ok: ha.ok, enabled: ha.enabled },
  ki: { ok: assistant.enabled },
}));

app.listen(cfg.port, () => {
  const mode = cfg.simulate ? '[SIMULATION]' : '[LIVE]';
  console.log(`\nJarvis: http://localhost:${cfg.port}  ${mode}`);
  if (!cfg.simulate) cfg.pvMeters.forEach(m => console.log(`  PV ${m.index}: ${m.id} (${m.type})`));
  if (cfg.hasVictron) console.log(`  Victron VRM: Installation ${cfg.victronSiteId}`);
  if (cfg.hasEufy)    console.log(`  eufy: ${cfg.eufyEmail}`);
  console.log(`  Home Assistant: ${ha.enabled ? process.env.HA_URL : 'nicht eingerichtet'}`);
  console.log(`  KI: ${assistant.enabled ? assistant.model : 'aus'}   PIN: ${JARVIS_PIN ? 'aktiv' : 'aus'}`);
  console.log('');
});
