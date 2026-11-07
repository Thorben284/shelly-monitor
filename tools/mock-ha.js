// TESTDATEN – simuliert einen Home-Assistant-Server für Entwicklung und Vorführung.
// Alle Geräte, Namen und Bilder hier sind erfunden.
// Start:  node tools/mock-ha.js   → dann im Dashboard HA_URL=http://127.0.0.1:8124 HA_TOKEN=test
const express = require('express');
const app = express();
app.use(express.json());

const now = () => new Date().toISOString();
const ago = m => new Date(Date.now() - m * 60000).toISOString();
const S = (entity_id, state, attributes = {}, changed = now()) =>
  ({ entity_id, state, attributes, last_changed: changed, last_updated: changed });

const states = new Map([
  S('switch.heizstab', 'on', { friendly_name: 'Heizstab' }),
  S('switch.kaffeemaschine', 'off', { friendly_name: 'Kaffeemaschine' }),
  S('switch.gartenpumpe', 'off', { friendly_name: 'Gartenpumpe' }),
  S('switch.waschmaschine', 'on', { friendly_name: 'Waschmaschine Steckdose' }),
  S('switch.trockner', 'off', { friendly_name: 'Trockner Steckdose' }),
  S('switch.carport_licht', 'off', { friendly_name: 'Carport Licht' }),
  S('light.kueche', 'on', { friendly_name: 'Küche Deckenlicht' }),
  S('light.wohnzimmer_stehlampe', 'off', { friendly_name: 'Wohnzimmer Stehlampe' }),
  S('light.flur', 'off', { friendly_name: 'Flur' }),
  S('light.terrasse', 'off', { friendly_name: 'Terrasse Wandleuchte' }),
  S('vacuum.roborock', 'docked', { friendly_name: 'Roborock', battery_level: 100, status: 'Lädt' }),
  S('alarm_control_panel.homebase_3', 'disarmed', { friendly_name: 'HomeBase 3', code_format: null }),
  S('camera.einfahrt', 'idle', { friendly_name: 'Einfahrt' }),
  S('camera.haustuer', 'idle', { friendly_name: 'Haustür' }),
  S('camera.garten', 'idle', { friendly_name: 'Garten' }),
  S('camera.terrasse', 'idle', { friendly_name: 'Terrasse' }),
  S('binary_sensor.einfahrt_bewegung', 'off', { friendly_name: 'Einfahrt Bewegung', device_class: 'motion' }, ago(14)),
  S('binary_sensor.haustuer_bewegung', 'off', { friendly_name: 'Haustür Bewegung', device_class: 'motion' }, ago(52)),
  S('binary_sensor.garten_bewegung', 'off', { friendly_name: 'Garten Bewegung', device_class: 'motion' }, ago(190)),
  S('binary_sensor.flur_bewegungsmelder', 'off', { friendly_name: 'Flur Bewegungsmelder', device_class: 'motion' }, ago(6)),
  S('sensor.waschmaschine_leistung', '312', { friendly_name: 'Waschmaschine Leistung', unit_of_measurement: 'W', device_class: 'power' }),
  // Bosch über Home Connect (Zustände wie in der HA-Integration)
  S('sensor.waschmaschine_betriebszustand', 'run', { friendly_name: 'Waschmaschine Betriebszustand', device_class: 'enum' }, ago(38)),
  S('sensor.waschmaschine_endzeit', new Date(Date.now() + 47 * 60000).toISOString(), { friendly_name: 'Waschmaschine Endzeit', device_class: 'timestamp' }),
  S('sensor.wohnzimmer_temperatur', '21.4', { friendly_name: 'Wohnzimmer Temperatur', unit_of_measurement: '°C', device_class: 'temperature' }),
].map(s => [s.entity_id, s]));

const set = (id, state, extra) => {
  const s = states.get(id);
  states.set(id, { ...s, state, attributes: { ...s.attributes, ...extra }, last_changed: now(), last_updated: now() });
};

const auth = (req, res, next) => req.get('authorization') === 'Bearer test' ? next() : res.status(401).end();
app.use('/api', auth);


app.get('/api/states', (_q, res) => res.json([...states.values()]));

// Testhilfe: Zustand direkt setzen, z. B. POST /test/set {"entity_id":"sensor.waschmaschine_betriebszustand","state":"finished"}
app.post('/test/set', (req, res) => { set(req.body.entity_id, req.body.state); res.json(states.get(req.body.entity_id)); });

const SERVICES = {
  turn_on: () => 'on', turn_off: () => 'off', toggle: s => (s.state === 'on' ? 'off' : 'on'),
  start: () => 'cleaning', pause: () => 'paused', stop: () => 'idle', return_to_base: () => 'returning', locate: s => s.state,
  alarm_arm_away: () => 'armed_away', alarm_arm_home: () => 'armed_home', alarm_disarm: () => 'disarmed',
};
app.post('/api/services/:domain/:service', (req, res) => {
  const id = req.body?.entity_id;
  const s = states.get(id);
  const fn = SERVICES[req.params.service];
  if (!s || !fn) return res.status(400).json({ message: 'unbekannt' });
  set(id, fn(s));
  if (id === 'vacuum.roborock' && req.params.service === 'return_to_base') setTimeout(() => set(id, 'docked'), 8000);
  res.json([states.get(id)]);
});

// Testbild als SVG (deutlich als Testbild beschriftet)
const SCENES = {
  einfahrt: ['#2f3b2f', '#55624a', '#8a8f7c'], haustuer: ['#3a332c', '#6b5b4b', '#a38f74'],
  garten: ['#22352a', '#3f6a47', '#86a77a'], terrasse: ['#2c3138', '#56606c', '#9aa3ad'],
};
app.get('/api/camera_proxy/:id', (req, res) => {
  const key = req.params.id.split('.')[1];
  const [a, b, c] = SCENES[key] || SCENES.einfahrt;
  const t = new Date().toLocaleTimeString('de-DE');
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${a}"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/><path d="M0 250 L180 200 L640 230 L640 360 L0 360Z" fill="${b}"/>
<path d="M420 120 h120 v110 h-120z" fill="${a}" opacity=".7"/><path d="M60 160 h70 v80 h-70z" fill="${b}" opacity=".8"/>
<text x="16" y="30" fill="#fff" font-family="monospace" font-size="16" opacity=".85">TESTBILD ${key.toUpperCase()}  ${t}</text></svg>`);
});

// Leistung der Waschmaschine schwankt etwas
setInterval(() => {
  const s = states.get('sensor.waschmaschine_leistung');
  const v = states.get('switch.waschmaschine').state === 'on' ? Math.round(150 + Math.random() * 400) : 0;
  states.set(s.entity_id, { ...s, state: String(v) });
}, 3000);

app.listen(8124, () => console.log('Test-Home-Assistant (Testdaten) auf http://127.0.0.1:8124 – Token: test'));
