// Letzte Bewegung je Melder und je Kamera – zuverlässig:
//  • Zeitpunkt = Beginn der Bewegung (Melder geht auf „on“), nicht irgendeine Zustandsänderung
//  • übersteht Neustarts von Home Assistant/eufy-Brücke (Verlauf aus HA + eigene Datei)
//  • Kamera ↔ Melder über das gemeinsame Gerät in HA, sonst über den Namen
const fs = require('fs');
const path = require('path');
const { MOTION_CLASSES } = require('./ha');

const GENERIC = new Set(['kamera', 'camera', 'cam', 'eufy', 'eufycam', 'indoor', 'outdoor', 'innen', 'aussen',
  'außen', 'pro', 'security', 'video', 'doorbell', 'bewegung', 'motion', 'detected', 'erkannt', 'sensor', 'melder',
  'bewegungsmelder', 's', 'e', 'c']);
const norm = s => String(s || '').toLowerCase().replace(/[^a-zäöüß0-9]+/g, ' ').trim();
const tokens = s => norm(s).split(' ').filter(w => w.length > 1 && !GENERIC.has(w));

class MotionTracker {
  constructor({ ha, file, historyDays = 7 }) {
    this.ha = ha;
    this.file = file;
    this.historyDays = historyDays;
    this.last = {};          // Melder-ID → ISO-Zeit des letzten Bewegungsbeginns
    this.camMap = {};        // Kamera-ID → [Melder-IDs]
    this.mapSource = null;   // 'geraet' | 'name'
    this.ready = false;
    this.saveTimer = null;
    try { this.last = JSON.parse(fs.readFileSync(file, 'utf8')).last || {}; } catch { /* erster Start */ }

    ha.onChange((s, prev) => {
      if (!s.entity_id.startsWith('binary_sensor.') || s.state !== 'on') return;
      if (!MOTION_CLASSES.has(s.attributes?.device_class)) return;
      // „unavailable → on“ nach Neustart nur zählen, wenn HA den Wechsel wirklich jetzt sah
      const ts = s.last_changed || new Date().toISOString();
      if (prev.state === 'on') return;
      this.record(s.entity_id, ts);
    });
  }

  isMotion(id) { return MOTION_CLASSES.has(this.ha.get(id)?.attributes?.device_class); }

  record(id, iso) {
    if (!iso || (this.last[id] && Date.parse(this.last[id]) >= Date.parse(iso))) return;
    this.last[id] = iso;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ last: this.last }, null, 1));
    } catch (e) { console.warn('Bewegungen: Speichern fehlgeschlagen:', e.message); }
  }

  /** Letzte „on“-Zeiten aus dem HA-Verlauf holen (z. B. nach Neustart von Jarvis). */
  async seedFromHistory() {
    const ids = this.ha.motionSensors().map(m => m.id);
    if (!ids.length) return;
    const start = new Date(Date.now() - this.historyDays * 86400000).toISOString();
    const q = `filter_entity_id=${encodeURIComponent(ids.join(','))}&minimal_response&no_attributes&significant_changes_only=0`;
    const lists = await (await this.ha.request(`/history/period/${encodeURIComponent(start)}?${q}`, { signal: AbortSignal.timeout(30000) })).json();
    for (const list of lists || []) {
      const id = list?.[0]?.entity_id;
      if (!id) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].state !== 'on') continue;
        // Erster Eintrag kann ein schon laufender Zustand vom Periodenanfang sein – dann ist die Zeit ungenau
        if (i === 0 && Date.parse(list[i].last_changed) <= Date.parse(start) + 1000) break;
        this.record(id, list[i].last_changed);
        break;
      }
    }
  }

  /** Kamera → Melder über das gemeinsame Gerät (Template-API, braucht Admin-Token). */
  async mapByDevice() {
    const template = `{% for c in states.camera %}{% set d = device_id(c.entity_id) %}{{ c.entity_id }}={% if d %}{{ device_entities(d) | select('match', 'binary_sensor\\\\.') | join(',') }}{% endif %}\n{% endfor %}`;
    const txt = await (await this.ha.request('/template', { method: 'POST', body: JSON.stringify({ template }) })).text();
    const map = {};
    for (const line of txt.split('\n')) {
      const [cam, list] = line.trim().split('=');
      if (!cam?.startsWith('camera.')) continue;
      map[cam] = (list || '').split(',').map(x => x.trim()).filter(id => id && this.isMotion(id));
    }
    return map;
  }

  /** Ersatz: Melder, deren Name die wesentlichen Wörter des Kameranamens enthält. */
  mapByName() {
    const sensors = this.ha.motionSensors();
    const map = {};
    for (const cam of this.ha.byDomain('camera')) {
      const want = tokens(cam.name).length ? tokens(cam.name) : tokens(cam.id.split('.')[1].replace(/_/g, ' '));
      if (!want.length) { map[cam.id] = []; continue; }
      map[cam.id] = sensors.filter(s => {
        const have = new Set([...tokens(s.name), ...tokens(s.id.split('.')[1].replace(/_/g, ' '))]);
        return want.every(w => have.has(w));
      }).map(s => s.id);
    }
    return map;
  }

  async remap() {
    let map = null;
    try { map = await this.mapByDevice(); this.mapSource = 'geraet'; }
    catch (e) { console.warn('Bewegungen: Zuordnung über Geräte nicht möglich –', e.message, '– nutze Namen'); }
    const byName = this.mapByName();
    if (!map) { map = byName; this.mapSource = 'name'; }
    else for (const cam of Object.keys(byName)) if (!map[cam]?.length) map[cam] = byName[cam]; // Lücken per Name füllen
    this.camMap = map;
  }

  async init() {
    try { await this.seedFromHistory(); } catch (e) { console.warn('Bewegungen: Verlauf nicht lesbar –', e.message); }
    await this.remap();
    this.ready = true;
  }

  start() {
    let wasOk = false;
    setInterval(async () => {
      if (this.ha.ok && (!wasOk || !this.ready)) await this.init();   // Start und nach Wiederverbindung
      wasOk = this.ha.ok;
    }, 10000);
    setInterval(() => { if (this.ha.ok) this.remap(); }, 60 * 60000);
  }

  lastFor(id) { return this.last[id] || null; }

  forCamera(camId) {
    const ids = this.camMap[camId] || [];
    let at = null;
    for (const id of ids) if (this.last[id] && (!at || Date.parse(this.last[id]) > Date.parse(at))) at = this.last[id];
    return { sensors: ids, motionAt: at, motionActive: ids.some(id => this.ha.get(id)?.state === 'on') };
  }
}

module.exports = { MotionTracker };
