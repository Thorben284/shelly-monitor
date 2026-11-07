// „Hinweise von selbst“: Regeln beobachten Home Assistant und Energiewerte
// und schicken Meldungen per Server-Sent Events an alle offenen Oberflächen.
const { MOTION_CLASSES } = require('./ha');
const { fmtPower } = require('./home');

class Notifier {
  constructor({ ha, home, surplusW = 1500 }) {
    this.ha = ha;
    this.home = home;
    this.surplusW = surplusW;
    this.log = [];
    this.clients = new Set();
    this.throttle = new Map();
    this.seq = 0;
    this.surplus = { since: null, belowSince: null, announced: false };
    this.lowBattery = false;

    ha.onChange((s, prev) => this.onHaChange(s, prev));
    home.washer.onDone = minutes => this.push({
      kind: 'washer', level: 'info', title: 'Waschmaschine fertig',
      text: minutes > 0 ? `Nach ${minutes} Minuten. Die Wäsche kann raus.` : 'Die Wäsche kann raus.',
    });
  }

  push({ kind, level = 'info', title, text, entity = null, throttleKey = null, throttleMs = 0 }) {
    if (throttleKey) {
      const last = this.throttle.get(throttleKey) || 0;
      if (Date.now() - last < throttleMs) return;
      this.throttle.set(throttleKey, Date.now());
    }
    const evt = { id: ++this.seq, ts: new Date().toISOString(), kind, level, title, text, entity };
    this.log.unshift(evt);
    if (this.log.length > 100) this.log.pop();
    const data = `id: ${evt.id}\nevent: hinweis\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  onHaChange(s, prev) {
    const domain = s.entity_id.split('.')[0];
    const a = s.attributes || {};
    const name = a.friendly_name || s.entity_id;
    if (this.ha.isHidden(s.entity_id, name)) return;
    if (prev.state === 'unavailable' || prev.state === 'unknown') return; // Neustart, kein echtes Ereignis

    if (domain === 'binary_sensor' && MOTION_CLASSES.has(a.device_class) && s.state === 'on') {
      this.push({ kind: 'motion', level: 'info', title: 'Bewegung erkannt', text: name, entity: s.entity_id,
        throttleKey: s.entity_id, throttleMs: 3 * 60000 });
    }

    if (domain === 'alarm_control_panel') {
      if (s.state === 'triggered') {
        this.push({ kind: 'alarm', level: 'alert', title: 'Alarm ausgelöst', text: name, entity: s.entity_id });
      } else if (['disarmed', 'armed_away', 'armed_home', 'armed_night'].includes(s.state)) {
        const t = { disarmed: 'entschärft', armed_away: 'scharf (abwesend)', armed_home: 'scharf (zuhause)', armed_night: 'scharf (Nacht)' }[s.state];
        this.push({ kind: 'alarm', level: 'info', title: `Alarmanlage ${t}`, text: name, entity: s.entity_id });
      }
    }

    if (domain === 'vacuum') {
      if (s.state === 'error') {
        this.push({ kind: 'vacuum', level: 'warn', title: `${name} braucht Hilfe`, text: a.status || 'Der Roboter meldet einen Fehler.', entity: s.entity_id });
      } else if (prev.state === 'cleaning' && ['docked', 'returning'].includes(s.state)) {
        this.push({ kind: 'vacuum', level: 'info', title: `${name} ist fertig`, text: 'Reinigung beendet.', entity: s.entity_id,
          throttleKey: s.entity_id + ':done', throttleMs: 10 * 60000 });
      }
    }

    if (this.home.washer.statusEntity === s.entity_id && /fertig|finish|end|complete|done/i.test(s.state)) {
      this.push({ kind: 'washer', level: 'info', title: 'Waschmaschine fertig', text: 'Die Wäsche kann raus.',
        throttleKey: 'washer', throttleMs: 30 * 60000 });
    }
  }

  /** Wird regelmäßig aufgerufen (Energie-Regeln und Waschmaschine). */
  tick() {
    this.home.washer.tick(this.ha);
    const e = this.home.energy();
    if (e.simulated) return;
    const now = Date.now();

    // PV-Überschuss: mindestens 5 Min. über der Schwelle eingespeist
    const export_ = e.grid != null ? -e.grid : 0;
    const su = this.surplus;
    if (export_ > this.surplusW) {
      su.belowSince = null;
      su.since ??= now;
      if (!su.announced && now - su.since > 5 * 60000) {
        su.announced = true;
        this.push({ kind: 'energy', level: 'info', title: `PV-Überschuss ${fmtPower(export_)}`,
          text: 'Guter Zeitpunkt für Waschmaschine, Spülmaschine oder Heizstab.' });
      }
    } else {
      su.since = null;
      if (export_ < this.surplusW / 3) {
        su.belowSince ??= now;
        if (now - su.belowSince > 15 * 60000) su.announced = false;
      }
    }

    if (e.soc != null) {
      if (!this.lowBattery && e.soc < 15) {
        this.lowBattery = true;
        this.push({ kind: 'energy', level: 'warn', title: `Akku nur noch ${Math.round(e.soc)} %`, text: 'Ab jetzt kommt der Strom aus dem Netz.' });
      } else if (this.lowBattery && e.soc > 25) this.lowBattery = false;
    }
  }

  start() { setInterval(() => this.tick(), 5000); }

  attach(req, res) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }
}

module.exports = { Notifier };
