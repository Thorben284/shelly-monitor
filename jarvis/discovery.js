// Geräteprüfung: vergleicht regelmäßig (Standard 60 Min.) die Geräte in Home Assistant
// mit dem bekannten Stand und meldet neue oder entfernte Geräte als Hinweis.
// Neue Geräte erscheinen automatisch in der Oberfläche; die Prüfung macht sie sichtbar.
const fs = require('fs');
const path = require('path');

const TYPE_DE = {
  switch: 'Schalter', light: 'Licht', fan: 'Lüfter', vacuum: 'Saugroboter', camera: 'Kamera',
  binary_sensor: 'Melder', sensor: 'Sensor', alarm_control_panel: 'Alarmanlage', button: 'Taste',
  cover: 'Rollladen', climate: 'Thermostat', lock: 'Schloss', media_player: 'Medien',
  water_heater: 'Warmwasser', update: 'Update', select: 'Auswahl', number: 'Einstellwert',
};
// Nebensächliches zählt mit, wird aber nicht einzeln genannt
const MINOR = new Set(['sensor', 'binary_sensor', 'button', 'update', 'select', 'number', 'event', 'text', 'image']);
const NEW_FOR_MS = 24 * 3600000;

class Discovery {
  constructor({ ha, notifier, file, intervalMin = 60 }) {
    this.ha = ha;
    this.notifier = notifier;
    this.file = file;
    this.intervalMs = Math.max(5, intervalMin) * 60000;
    this.known = null;       // Set der bekannten Entity-IDs
    this.newSince = {};      // id → Zeitpunkt der Erkennung
    this.names = {};         // id → Name (für Meldungen über entfernte Geräte)
    this.lastRun = null;
    this.nextRun = null;
    this.lastResult = null;
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.known = new Set(d.known || []);
      this.newSince = d.newSince || {};
      this.names = d.names || {};
    } catch { this.known = null; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ known: [...this.known].sort(), newSince: this.newSince, names: this.names }, null, 1));
    } catch (e) { console.warn('Geräteprüfung: Speichern fehlgeschlagen:', e.message); }
  }

  nameOf(id) { return this.ha.get(id)?.attributes?.friendly_name || id; }

  run() {
    this.lastRun = new Date().toISOString();
    this.nextRun = new Date(Date.now() + this.intervalMs).toISOString();
    if (!this.ha.ok) { this.lastResult = { ok: false, text: 'Home Assistant nicht erreichbar' }; return this.lastResult; }

    const current = new Set([...this.ha.states.keys()].filter(id => !this.ha.isHidden(id, this.nameOf(id))));
    const now = Date.now();
    for (const [id, ts] of Object.entries(this.newSince)) if (now - Date.parse(ts) > NEW_FOR_MS) delete this.newSince[id];

    // Erster Lauf: alles Vorhandene gilt als bekannt – keine Flut an Meldungen
    if (!this.known) {
      this.known = current;
      this.names = Object.fromEntries([...current].map(id => [id, this.nameOf(id)]));
      this.save();
      this.lastResult = { ok: true, added: 0, removed: 0, text: `${current.size} Geräte/Werte erfasst (erster Lauf)` };
      return this.lastResult;
    }

    const added = [...current].filter(id => !this.known.has(id));
    const removed = [...this.known].filter(id => !current.has(id));

    if (added.length) {
      for (const id of added) this.newSince[id] = this.lastRun;
      const main = added.filter(id => !MINOR.has(id.split('.')[0]));
      const minor = added.length - main.length;
      const names = main.slice(0, 6).map(id => `${this.nameOf(id)} (${TYPE_DE[id.split('.')[0]] || id.split('.')[0]})`);
      if (main.length > 6) names.push(`und ${main.length - 6} weitere`);
      const tail = minor ? `${names.length ? ' – dazu ' : ''}${minor} Messwert${minor === 1 ? '' : 'e'}/Melder` : '';
      this.notifier.push({
        kind: 'discovery', level: 'info',
        title: main.length ? `${main.length} neue${main.length === 1 ? 's Gerät' : ' Geräte'} erkannt` : 'Neue Messwerte erkannt',
        text: names.join(', ') + tail + (added.length === 1 ? '. Ist in Jarvis eingebunden.' : '. Sind in Jarvis eingebunden.'),
      });
    }
    for (const id of removed) delete this.newSince[id];
    if (removed.length) {
      this.notifier.push({
        kind: 'discovery', level: 'warn',
        title: `${removed.length} Gerät${removed.length === 1 ? '' : 'e'} nicht mehr in Home Assistant`,
        text: removed.slice(0, 6).map(id => this.names[id] || id).join(', ') + (removed.length > 6 ? ' …' : ''),
      });
    }

    this.known = current;
    this.names = Object.fromEntries([...current].map(id => [id, this.nameOf(id)]));
    this.save();
    this.lastResult = { ok: true, added: added.length, removed: removed.length,
      text: added.length || removed.length ? `${added.length} neu, ${removed.length} entfernt` : 'keine Änderungen' };
    return this.lastResult;
  }

  isNew(id) { return !!this.newSince[id]; }

  status() {
    return { lastRun: this.lastRun, nextRun: this.nextRun, intervalMin: this.intervalMs / 60000, result: this.lastResult };
  }

  start() {
    // erster Lauf, sobald Home Assistant geantwortet hat
    const first = setInterval(() => { if (this.ha.ok) { clearInterval(first); this.run(); } }, 5000);
    setInterval(() => this.run(), this.intervalMs);
  }
}

module.exports = { Discovery, TYPE_DE };
