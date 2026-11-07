// Home-Assistant-Anbindung: hält einen Zustands-Cache und meldet Änderungen.
// Der Zugriffsschlüssel verlässt nie den Server.
const { Readable } = require('stream');

// Nur diese Befehle dürfen ausgelöst werden – vom Dashboard, von Regeln und von der KI.
const ALLOWED_SERVICES = new Set([
  'switch.turn_on', 'switch.turn_off', 'switch.toggle',
  'light.turn_on', 'light.turn_off', 'light.toggle',
  'fan.turn_on', 'fan.turn_off',
  'vacuum.start', 'vacuum.pause', 'vacuum.stop', 'vacuum.return_to_base', 'vacuum.locate',
  'button.press',
  'alarm_control_panel.alarm_arm_away', 'alarm_control_panel.alarm_arm_home',
  'alarm_control_panel.alarm_disarm',
]);

const UI_DOMAINS = new Set(['switch', 'light', 'fan', 'vacuum', 'camera', 'binary_sensor',
  'sensor', 'alarm_control_panel', 'button']);

const MOTION_CLASSES = new Set(['motion', 'occupancy', 'presence']);

class HomeAssistant {
  constructor({ url, token, pollMs = 3000, hide = [] }) {
    this.url = (url || '').replace(/\/$/, '');
    this.token = token || '';
    this.enabled = !!(this.url && this.token);
    this.pollMs = pollMs;
    this.hide = hide.map(h => h.trim().toLowerCase()).filter(Boolean);
    this.states = new Map();
    this.ok = false;
    this.error = null;
    this.lastPoll = 0;
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }

  async request(path, opts = {}) {
    const res = await fetch(`${this.url}/api${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: opts.signal || AbortSignal.timeout(10000),
    });
    if (res.status === 401) throw new Error('Home Assistant lehnt den Zugriffsschlüssel ab (HA_TOKEN prüfen)');
    if (!res.ok) throw new Error(`Home Assistant antwortet mit HTTP ${res.status}`);
    return res;
  }

  async poll() {
    try {
      const list = await (await this.request('/states')).json();
      const first = this.states.size === 0;
      const seen = new Set();
      for (const s of list) {
        seen.add(s.entity_id);
        const prev = this.states.get(s.entity_id);
        this.states.set(s.entity_id, s);
        if (!first && prev && prev.state !== s.state) {
          for (const fn of this.listeners) {
            try { fn(s, prev); } catch (e) { console.warn('Jarvis-Regel:', e.message); }
          }
        }
      }
      for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
      this.ok = true;
      this.error = null;
    } catch (e) {
      if (this.ok || !this.error) console.warn('Home Assistant:', e.message);
      this.ok = false;
      this.error = e.message;
    }
    this.lastPoll = Date.now();
  }

  start() {
    if (!this.enabled) return;
    const loop = async () => { await this.poll(); setTimeout(loop, this.pollMs); };
    loop();
  }

  isHidden(id, name) {
    if (!this.hide.length) return false;
    const a = id.toLowerCase(), b = (name || '').toLowerCase();
    return this.hide.some(h => a.includes(h) || b.includes(h));
  }

  get(id) { return this.states.get(id) || null; }

  /** Kompakte, für die Oberfläche relevante Sicht auf alle Geräte. */
  entities() {
    const out = [];
    for (const s of this.states.values()) {
      const domain = s.entity_id.split('.')[0];
      if (!UI_DOMAINS.has(domain)) continue;
      const a = s.attributes || {};
      const name = a.friendly_name || s.entity_id;
      if (this.isHidden(s.entity_id, name)) continue;
      out.push({
        id: s.entity_id,
        domain,
        name,
        state: s.state,
        unit: a.unit_of_measurement || null,
        deviceClass: a.device_class || null,
        battery: a.battery_level ?? null,
        status: a.status ?? null,
        // Alarm: verlangt HA einen Code, kann das Dashboard nicht schalten
        codeRequired: domain === 'alarm_control_panel' ? !!a.code_format : undefined,
        changed: s.last_changed,
      });
    }
    out.sort((x, y) => x.name.localeCompare(y.name, 'de'));
    return out;
  }

  byDomain(domain) { return this.entities().filter(e => e.domain === domain); }

  motionSensors() {
    return this.entities().filter(e => e.domain === 'binary_sensor' && MOTION_CLASSES.has(e.deviceClass));
  }

  async call(domain, service, entityId) {
    if (!this.enabled) throw new Error('Home Assistant ist nicht eingerichtet');
    if (!ALLOWED_SERVICES.has(`${domain}.${service}`)) throw new Error('Dieser Befehl ist nicht freigegeben');
    if (typeof entityId !== 'string' || !entityId.startsWith(`${domain}.`)) throw new Error('Gerät passt nicht zum Befehl');
    if (!this.states.has(entityId)) throw new Error('Gerät ist Home Assistant nicht bekannt');
    await this.request(`/services/${domain}/${service}`, { method: 'POST', body: JSON.stringify({ entity_id: entityId }) });
    // Zustand kurz danach frisch holen, damit Oberfläche und Antwort stimmen
    await new Promise(r => setTimeout(r, 500));
    await this.poll();
  }

  async cameraImage(entityId) {
    const r = await this.request(`/camera_proxy/${entityId}`);
    return { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
  }

  /** MJPEG-Livebild durchreichen; endet, wenn der Browser die Verbindung schließt. */
  async cameraStream(entityId, res, req) {
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const r = await fetch(`${this.url}/api/camera_proxy_stream/${entityId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) throw new Error(`Livebild nicht verfügbar (HTTP ${r.status})`);
    res.set('Content-Type', r.headers.get('content-type') || 'multipart/x-mixed-replace');
    res.set('Cache-Control', 'no-store');
    Readable.fromWeb(r.body).on('error', () => {}).pipe(res);
  }
}

module.exports = { HomeAssistant, ALLOWED_SERVICES, MOTION_CLASSES };
