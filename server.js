require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function loadPvMeters() {
  const meters = [];
  for (let i = 1; i <= 9; i++) {
    const id = process.env[`PV${i}_SHELLY_ID`];
    if (!id) break;
    meters.push({ id, type: process.env[`PV${i}_SHELLY_TYPE`] || 'pm1', index: i });
  }
  return meters;
}

const pvMeters = loadPvMeters();

const cfg = {
  authKey:   process.env.SHELLY_AUTH_KEY   || '',
  serverUrl: (process.env.SHELLY_SERVER_URL || 'https://shelly-103-eu.shelly.cloud').replace(/\/$/, ''),
  pvMeters,
  gridId:   process.env.GRID_SHELLY_ID   || '',
  gridType: process.env.GRID_SHELLY_TYPE || 'em3',
  pollMs:   parseInt(process.env.POLL_INTERVAL || '10000'),
  port:     parseInt(process.env.PORT          || '3000'),
};

cfg.simulate = process.env.SIMULATE === 'true' || !cfg.authKey || pvMeters.length === 0;

const HISTORY_LEN = 720;
const history = [];

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

// Unterstützte Gerätetypen und ihre Cloud-API-Felder:
//   em3    – Shelly Pro 3EM        → em:0 / total_act_power
//   em     – Shelly Pro EM-50      → em:0 / act_power
//   pm1    – Shelly PM Mini        → pm1:0 / apower
//   switch – Shelly Plus Plug S    → switch:0 / apower
//   gen1   – Shelly Plug S (alt)   → meters[0] / power
async function readMeter(id, type) {
  if (!id) return null;
  try {
    const s = await fetchDeviceStatus(id);
    if (type === 'em3')    return s['em:0']?.total_act_power ?? null;
    if (type === 'em')     return s['em:0']?.act_power       ?? null;
    if (type === 'pm1')    return s['pm1:0']?.apower         ?? null;
    if (type === 'switch') return s['switch:0']?.apower      ?? null;
    if (type === 'gen1')   return s.meters?.[0]?.power       ?? null;
    console.warn(`Unbekannter Gerätetyp: ${type}`);
    return null;
  } catch (e) {
    console.warn(`Meter-Fehler (${id}, Typ=${type}): ${e.message}`);
    return null;
  }
}

function simulate() {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const solarFactor = Math.max(0, Math.sin(Math.PI * (hour - 6) / 14));
  const pv = Math.max(0, Math.round(solarFactor * 4800 + (Math.random() - 0.5) * 150));
  const spike = Math.random() < 0.03 ? 800 + Math.random() * 1500 : 0;
  const consumption = Math.round(280 + Math.random() * 200 + spike);
  return { pv, consumption };
}

let current = { pv: 0, grid: 0, consumption: 0, ts: Date.now(), error: false };

async function poll() {
  if (cfg.simulate) {
    const { pv, consumption } = simulate();
    const grid = consumption - pv;
    current = { pv, grid, consumption, ts: Date.now(), error: false, simulated: true };
  } else {
    const results = await Promise.all([
      ...cfg.pvMeters.map(m => readMeter(m.id, m.type)),
      readMeter(cfg.gridId, cfg.gridType),
    ]);
    const pvReadings  = results.slice(0, cfg.pvMeters.length);
    const gridRaw     = results[cfg.pvMeters.length];
    const pv          = Math.max(0, pvReadings.reduce((sum, v) => sum + (v ?? 0), 0));
    const grid        = gridRaw ?? 0;
    const consumption = Math.max(0, pv + grid);
    current = { pv, grid, consumption, ts: Date.now(), error: pvReadings.some(v => v === null) };
  }
  history.push({ ...current });
  if (history.length > HISTORY_LEN) history.shift();
}

poll();
setInterval(poll, cfg.pollMs);

app.get('/api/data', (_req, res) => {
  res.json({
    current,
    history: history.slice(-72),
    pollInterval: cfg.pollMs,
    simulated: cfg.simulate,
    hasGrid: !!cfg.gridId || cfg.simulate,
  });
});

app.get('/api/history/full', (_req, res) => res.json(history));

app.listen(cfg.port, () => {
  const mode = cfg.simulate ? '[SIMULATIONSMODUS]' : '[SHELLY CLOUD]';
  console.log(`Shelly Monitor läuft auf http://localhost:${cfg.port} ${mode}`);
  if (!cfg.simulate) {
    cfg.pvMeters.forEach(m => console.log(`  PV-Shelly ${m.index}: ${m.id} (Typ: ${m.type})`));
    if (cfg.gridId) console.log(`  Netz-Shelly: ${cfg.gridId} (Typ: ${cfg.gridType})`);
  }
});
