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
// Melder am Kamera-Gerät, die Bewegung/Personen melden – auch ohne Geräteklasse „motion“
const MOTION_NAME = /motion|bewegung|person|human|mensch|erkannt|detected|ereignis|event|ring|klingel/i;

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
      if (s.state !== 'on' || prev.state === 'on') return;
      if (!this.tracked().has(s.entity_id)) return;
      this.record(s.entity_id, s.last_changed || new Date().toISOString());
    });
  }

  isMotion(id) { return MOTION_CLASSES.has(this.ha.get(id)?.attributes?.device_class); }

  /** Alle Melder, deren Bewegungen Jarvis mitschreibt. */
  tracked() {
    const set = new Set(this.ha.motionSensors().map(m => m.id));
    for (const ids of Object.values(this.camMap)) for (const id of ids) set.add(id);
    return set;
  }

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
  async seedFromHistory(minutes = this.historyDays * 1440) {
    const ids = [...this.tracked()];
    if (!ids.length) return;
    const start = new Date(Date.now() - minutes * 60000).toISOString();
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
      map[cam] = (list || '').split(',').map(x => x.trim()).filter(id => id && this.ha.get(id) &&
        (this.isMotion(id) || MOTION_NAME.test(`${id} ${this.ha.get(id).attributes?.friendly_name || ''}`)));
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
    await this.remap();
    try { await this.seedFromHistory(); } catch (e) { console.warn('Bewegungen: Verlauf nicht lesbar –', e.message); }
    this.ready = true;
  }

  start() {
    let wasOk = false;
    setInterval(async () => {
      if (this.ha.ok && (!wasOk || !this.ready)) await this.init();   // Start und nach Wiederverbindung
      wasOk = this.ha.ok;
    }, 10000);
    setInterval(() => { if (this.ha.ok) this.remap(); }, 60 * 60000);
    // Kurze Bewegungsimpulse (kürzer als die 3-s-Abfrage) aus dem Verlauf nachholen
    setInterval(() => {
      if (this.ha.ok && this.ready) this.seedFromHistory(15).catch(e => console.warn('Bewegungen:', e.message));
    }, 30000);
  }

  /** Diagnose: was Jarvis je Kamera sieht. */
  diagnose() {
    return {
      zuordnung: this.mapSource,
      kameras: this.ha.byDomain('camera').map(c => ({
        kamera: c.id, name: c.name,
        melder: (this.camMap[c.id] || []).map(id => {
          const s = this.ha.get(id);
          return { id, name: s?.attributes?.friendly_name, zustand: s?.state, geraeteklasse: s?.attributes?.device_class ?? null,
            ha_last_changed: s?.last_changed, jarvis_letzte_bewegung: this.last[id] || null };
        }),
      })),
      // Melder am Haus, die Jarvis NICHT als Bewegung zählt (Hinweis auf falsche Zuordnung)
      andere_binary_sensoren: [...this.ha.states.values()]
        .filter(s => s.entity_id.startsWith('binary_sensor.') && !this.tracked().has(s.entity_id))
        .map(s => ({ id: s.entity_id, name: s.attributes?.friendly_name, zustand: s.state, geraeteklasse: s.attributes?.device_class ?? null })),
    };
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
