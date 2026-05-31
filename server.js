require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// PV-Meter: PV1_SHELLY_HOST … PV9_SHELLY_HOST (alle konfigurierten werden summiert)
function loadPvMeters() {
  const meters = [];
  for (let i = 1; i <= 9; i++) {
    const host = process.env[`PV${i}_SHELLY_HOST`];
    if (!host) break;
    meters.push({ host, type: process.env[`PV${i}_SHELLY_TYPE`] || 'pm1', index: i });
  }
  return meters;
}

const pvMeters = loadPvMeters();

const cfg = {
  pvMeters,
  gridHost: process.env.GRID_SHELLY_HOST || '',
  gridType: process.env.GRID_SHELLY_TYPE || 'em3',
  pollMs:   parseInt(process.env.POLL_INTERVAL || '5000'),
  port:     parseInt(process.env.PORT          || '3000'),
  simulate: process.env.SIMULATE === 'true' || pvMeters.length === 0,
};

// Ring-Puffer: 720 Punkte × 5 s = 1 Stunde
const HISTORY_LEN = 720;
const history = [];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`JSON-Fehler für ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// Unterstützte Gerätetypen:
//   em3    – Shelly Pro 3EM             (Gen2, /rpc/EM.GetStatus,      total_act_power)
//   em     – Shelly Pro EM-50           (Gen2, /rpc/EM.GetStatus,      act_power)
//   pm1    – Shelly PM Mini / Plus 1PM  (Gen2/3, /rpc/PM1.GetStatus,   apower)
//   switch – Shelly Plus Plug S         (Gen2, /rpc/Switch.GetStatus,  apower)
//   gen1   – Shelly Plug S (alt)        (Gen1, /status,                meters[0].power)
async function readMeter(host, type) {
  if (!host) return null;
  try {
    if (type === 'em3') {
      const j = await fetchJson(`http://${host}/rpc/EM.GetStatus?id=0`);
      return j.total_act_power ?? null;
    }
    if (type === 'em') {
      const j = await fetchJson(`http://${host}/rpc/EM.GetStatus?id=0`);
      return j.act_power ?? null;
    }
    if (type === 'pm1') {
      const j = await fetchJson(`http://${host}/rpc/PM1.GetStatus?id=0`);
      return j.apower ?? null;
    }
    if (type === 'switch') {
      const j = await fetchJson(`http://${host}/rpc/Switch.GetStatus?id=0`);
      return j.apower ?? null;
    }
    if (type === 'gen1') {
      const j = await fetchJson(`http://${host}/status`);
      return j.meters?.[0]?.power ?? j.emeters?.[0]?.power ?? null;
    }
    console.warn(`Unbekannter Gerätetyp: ${type}`);
    return null;
  } catch (e) {
    console.warn(`Meter-Fehler (${host}, Typ=${type}): ${e.message}`);
    return null;
  }
}

// Simuliert eine realistische Solar-Kurve + Hausverbrauch
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
      ...cfg.pvMeters.map(m => readMeter(m.host, m.type)),
      readMeter(cfg.gridHost, cfg.gridType),
    ]);

    const pvReadings = results.slice(0, cfg.pvMeters.length);
    const gridRaw    = results[cfg.pvMeters.length];

    const pv   = Math.max(0, pvReadings.reduce((sum, v) => sum + (v ?? 0), 0));
    const grid = gridRaw ?? 0;
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
    hasGrid: !!cfg.gridHost || cfg.simulate,
  });
});

app.get('/api/history/full', (_req, res) => {
  res.json(history);
});

app.listen(cfg.port, () => {
  const mode = cfg.simulate ? ' [SIMULATIONSMODUS]' : '';
  console.log(`Shelly Monitor läuft auf http://localhost:${cfg.port}${mode}`);
  if (!cfg.simulate) {
    cfg.pvMeters.forEach(m => console.log(`  PV-Shelly ${m.index}: ${m.host} (Typ: ${m.type})`));
    if (cfg.gridHost)
      console.log(`  Netz-Shelly: ${cfg.gridHost} (Typ: ${cfg.gridType})`);
  }
});
