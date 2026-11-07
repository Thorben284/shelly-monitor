// Gemeinsame Sicht auf das Haus: Energie, Sicherheit, Geräte – in Daten und in Sätzen.

const ALARM_TEXT = {
  disarmed: 'aus', armed_away: 'scharf (abwesend)', armed_home: 'scharf (zuhause)',
  armed_night: 'scharf (Nacht)', armed_vacation: 'scharf (Urlaub)', armed_custom_bypass: 'scharf',
  arming: 'wird scharf geschaltet', disarming: 'wird entschärft', pending: 'Vorwarnung läuft',
  triggered: 'AUSGELÖST', unavailable: 'nicht erreichbar', unknown: 'unbekannt',
};

const VACUUM_TEXT = {
  cleaning: 'reinigt', docked: 'steht in der Ladestation', returning: 'fährt zur Ladestation',
  paused: 'ist pausiert', idle: 'wartet', error: 'meldet einen Fehler',
  unavailable: 'ist nicht erreichbar', unknown: 'meldet keinen Zustand',
};

function fmtPower(w) {
  if (w == null || !Number.isFinite(w)) return '–';
  const a = Math.abs(w);
  if (a >= 1000) return (a / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' kW';
  return Math.round(a) + ' W';
}

function fmtAgo(iso) {
  if (!iso) return null;
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  return `vor ${Math.floor(h / 24)} Tag${h >= 48 ? 'en' : ''}`;
}

/**
 * Waschmaschine erkennen: entweder über die Leistung einer Zwischenstecker-Messung
 * (z. B. Shelly Plug, markenunabhängig) oder über einen Status-Sensor der Hersteller-Integration.
 */
class Washer {
  constructor({ powerEntity, statusEntity, runW = 8, idleW = 4, idleMinutes = 3 }) {
    this.powerEntity = powerEntity || '';
    this.statusEntity = statusEntity || '';
    this.runW = runW;
    this.idleW = idleW;
    this.idleMs = idleMinutes * 60000;
    this.state = 'aus';       // aus | läuft | fertig
    this.since = null;
    this.aboveSince = null;
    this.belowSince = null;
    this.onDone = () => {};
  }

  get configured() { return !!(this.powerEntity || this.statusEntity); }

  tick(ha) {
    if (!this.powerEntity) return;
    const s = ha.get(this.powerEntity);
    const p = s ? parseFloat(s.state) : NaN;
    if (!Number.isFinite(p)) return;
    const now = Date.now();
    if (p > this.runW) {
      this.belowSince = null;
      this.aboveSince ??= now;
      if (this.state !== 'läuft' && now - this.aboveSince > 60000) { this.state = 'läuft'; this.since = now; }
    } else {
      this.aboveSince = null;
      if (p < this.idleW) this.belowSince ??= now; else this.belowSince = null;
      if (this.state === 'läuft' && this.belowSince && now - this.belowSince > this.idleMs) {
        const minutes = Math.round((now - this.since) / 60000);
        this.state = 'fertig'; this.since = now;
        this.onDone(minutes);
      }
      if (this.state === 'fertig' && now - this.since > 2 * 3600000) { this.state = 'aus'; this.since = now; }
    }
  }

  info(ha) {
    if (!this.configured) return { configured: false };
    const p = this.powerEntity ? parseFloat(ha.get(this.powerEntity)?.state) : NaN;
    const st = this.statusEntity ? ha.get(this.statusEntity) : null;
    // Anzeige sofort, Meldung „fertig“ erst nach stabiler Erkennung (siehe tick)
    const shown = this.powerEntity ? (this.state === 'aus' && p > this.runW ? 'läuft' : this.state) : null;
    return {
      configured: true,
      state: shown,
      since: shown === this.state && this.since ? new Date(this.since).toISOString() : null,
      power: Number.isFinite(p) ? p : null,
      statusText: st ? st.state : null,
    };
  }
}

class Home {
  constructor({ ha, getShelly, getVictron, washer }) {
    this.ha = ha;
    this.getShelly = getShelly;
    this.getVictron = getVictron;
    this.washer = new Washer(washer || {});
  }

  energy() {
    const s = this.getShelly() || {};
    const v = this.getVictron() || {};
    return {
      pv: s.pv ?? null,
      consumption: s.consumption ?? null,
      grid: s.grid ?? null,            // positiv = Bezug, negativ = Einspeisung
      heizstab: s.heizstab ?? null,
      soc: v.soc ?? null,
      batteryPower: v.batteryPower ?? null,
      simulated: !!s.simulated,
    };
  }

  alarm() {
    const a = this.ha.byDomain('alarm_control_panel')[0];
    return a ? { ...a, text: ALARM_TEXT[a.state] || a.state } : null;
  }

  vacuums() {
    return this.ha.byDomain('vacuum').map(v => ({ ...v, text: VACUUM_TEXT[v.state] || v.state }));
  }

  lastMotion() {
    const m = this.ha.motionSensors()
      .filter(e => e.changed && e.state !== 'unavailable')
      .sort((a, b) => new Date(b.changed) - new Date(a.changed))[0];
    return m ? { ...m, active: m.state === 'on', ago: fmtAgo(m.changed) } : null;
  }

  activeSwitches() {
    return this.ha.entities().filter(e => ['switch', 'light', 'fan'].includes(e.domain) && e.state === 'on');
  }

  /** Lagebild in ganzen Sätzen – für Startseite und Sprachausgabe. */
  briefing() {
    const h = new Date().getHours();
    const greeting = h < 5 ? 'Gute Nacht.' : h < 11 ? 'Guten Morgen.' : h < 18 ? 'Guten Tag.' : 'Guten Abend.';
    const lines = [];
    const e = this.energy();

    if (e.pv != null) {
      if (e.pv > 50) {
        let t = `Die PV liefert ${fmtPower(e.pv)}, das Haus braucht ${fmtPower(e.consumption)}`;
        if (e.grid != null && e.grid < -50) t += ` – ${fmtPower(e.grid)} gehen ins Netz`;
        else if (e.grid != null && e.grid > 50) t += ` – ${fmtPower(e.grid)} kommen aus dem Netz`;
        lines.push(t + '.');
      } else if (e.consumption != null) {
        lines.push(`Keine PV-Leistung, das Haus braucht ${fmtPower(e.consumption)}.`);
      }
    }
    if (e.soc != null) lines.push(`Der Akku steht bei ${Math.round(e.soc)} %.`);

    if (this.ha.ok) {
      const a = this.alarm();
      if (a) lines.push(a.state === 'triggered' ? 'Achtung: Der Alarm wurde ausgelöst!' : `Die Alarmanlage ist ${a.text}.`);
      const m = this.lastMotion();
      if (m) lines.push(m.active ? `Gerade Bewegung: ${m.name}.` : sentence(`Letzte Bewegung: ${m.name}, ${m.ago}`));
      for (const v of this.vacuums()) if (['cleaning', 'returning', 'error'].includes(v.state)) lines.push(`${v.name} ${v.text}.`);
      const w = this.washer.info(this.ha);
      if (w.state === 'läuft') lines.push(w.since ? sentence(`Die Waschmaschine läuft seit ${fmtAgo(w.since).replace('vor ', '')}`) : 'Die Waschmaschine läuft.');
      if (w.state === 'fertig') lines.push('Die Waschmaschine ist fertig.');
      const on = this.activeSwitches().length;
      if (on) lines.push(on === 1 ? 'Ein Gerät ist eingeschaltet.' : `${on} Geräte sind eingeschaltet.`);
    } else if (this.ha.enabled) {
      lines.push('Home Assistant ist gerade nicht erreichbar.');
    }
    return { greeting, lines };
  }

  /** Kompakter Zustand für die KI (nur was sie zum Antworten braucht). */
  snapshot() {
    const ents = this.ha.entities().filter(x => x.domain !== 'sensor' || ['W', 'kW', 'kWh', '°C', '%'].includes(x.unit));
    return {
      zeit: new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }),
      energie_watt: this.energy(),
      waschmaschine: this.washer.info(this.ha),
      geraete: ents.slice(0, 250).map(x => ({ id: x.id, name: x.name, zustand: x.state, einheit: x.unit || undefined })),
    };
  }
}

const sentence = t => /[.!?]$/.test(t) ? t : t + '.';

module.exports = { sentence, Home, fmtPower, fmtAgo, ALARM_TEXT, VACUUM_TEXT };
