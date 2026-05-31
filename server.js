require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const cfg = {
  pvHost:      process.env.PV_SHELLY_HOST      || '',
  pvGen:       parseInt(process.env.PV_SHELLY_GEN      || '1'),
  pvChannel:   parseInt(process.env.PV_SHELLY_CHANNEL  || '0'),
  gridHost:    process.env.GRID_SHELLY_HOST    || '',
  gridGen:     parseInt(process.env.GRID_SHELLY_GEN    || '1'),
  gridChannel: parseInt(process.env.GRID_SHELLY_CHANNEL || '0'),
  pollMs:      parseInt(process.env.POLL_INTERVAL      || '5000'),
  port:        parseInt(process.env.PORT               || '3000'),
  simulate:    process.env.SIMULATE === 'true' || !process.env.PV_SHELLY_HOST,
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

async function readMeter(host, gen, channel) {
  if (!host) return null;
  try {
    if (gen >= 2) {
      const json = await fetchJson(`http://${host}/rpc/EM.GetStatus?id=${channel}`);
      return json.act_power ?? null;
    } else {
      const json = await fetchJson(`http://${host}/status`);
      // Shelly EM/3EM: emeters[n].power  |  Shelly 1PM: meters[n].power
      return json.emeters?.[channel]?.power ?? json.meters?.[channel]?.power ?? null;
    }
  } catch (e) {
    console.warn(`Meter-Fehler (${host}): ${e.message}`);
    return null;
  }
}

// Simuliert eine realistische Solar-Kurve + Hausverbrauch
function simulate() {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  // Sinuskurve: Sonnenaufgang 6 Uhr, Peak 13 Uhr, Untergang 20 Uhr
  const solarFactor = Math.max(0, Math.sin(Math.PI * (hour - 6) / 14));
  const pv = Math.max(0, Math.round(solarFactor * 4800 + (Math.random() - 0.5) * 150));
  // Gelegentliche Verbrauchsspitzen (Wasserkocher, Waschmaschine usw.)
  const spike = Math.random() < 0.03 ? 800 + Math.random() * 1500 : 0;
  const consumption = Math.round(280 + Math.random() * 200 + spike);
  return { pv, consumption };
}

let current = { pv: 0, grid: 0, consumption: 0, ts: Date.now(), error: false };

async function poll() {
  if (cfg.simulate) {
    const { pv, consumption } = simulate();
    // grid: positiv = Netzbezug, negativ = Einspeisung
    const grid = consumption - pv;
    current = { pv, grid, consumption, ts: Date.now(), error: false, simulated: true };
  } else {
    const [pvRaw, gridRaw] = await Promise.all([
      readMeter(cfg.pvHost, cfg.pvGen, cfg.pvChannel),
      readMeter(cfg.gridHost, cfg.gridGen, cfg.gridChannel),
    ]);
    const pv = Math.max(0, pvRaw ?? 0);
    const grid = gridRaw ?? 0;
    // Hausverbrauch = PV-Erzeugung + Netzbezug (grid negativ bei Einspeisung)
    const consumption = Math.max(0, pv + grid);
    current = { pv, grid, consumption, ts: Date.now(), error: pvRaw === null };
  }

  history.push({ ...current });
  if (history.length > HISTORY_LEN) history.shift();
}

poll();
setInterval(poll, cfg.pollMs);

app.get('/api/data', (_req, res) => {
  res.json({
    current,
    // Letzten 72 Punkte = 6 Minuten bei 5-s-Intervall
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
    console.log(`  PV-Shelly:   ${cfg.pvHost} (Gen${cfg.pvGen}, Kanal ${cfg.pvChannel})`);
    if (cfg.gridHost)
      console.log(`  Netz-Shelly: ${cfg.gridHost} (Gen${cfg.gridGen}, Kanal ${cfg.gridChannel})`);
  }
});
