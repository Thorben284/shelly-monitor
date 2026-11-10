// Befehle und Fragen ohne KI: feste Regeln für die häufigsten Sätze.
// Gibt null zurück, wenn kein Muster passt – dann übernimmt (falls eingerichtet) die KI.
const { fmtPower, fmtAgo, fmtClock, sentence, washerWarnText, washerDoneText } = require('./home');

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const FILLER = new Set(['bitte', 'jarvis', 'mal', 'mach', 'mache', 'schalte', 'schalt', 'den', 'die', 'das',
  'der', 'dem', 'im', 'in', 'am', 'an', 'vom', 'von', 'zum', 'zur', 'kannst', 'du', 'mir', 'doch', 'jetzt', 'sofort',
  'und', 'auch', 'noch', 'ein', 'eine', 'einen']);

const ON_WORDS = ['einschalten', 'anschalten', 'anmachen', 'aktivieren', 'an', 'ein'];
const OFF_WORDS = ['ausschalten', 'ausmachen', 'abschalten', 'deaktivieren', 'aus'];

const has = (t, re) => re.test(t);

class Commands {
  constructor({ ha, home }) {
    this.ha = ha;
    this.home = home;
  }

  /** Bestes Gerät zu einer Beschreibung finden; bei Gleichstand nachfragen. */
  findEntity(query, domains) {
    const q = norm(query).split(' ').filter(w => w && !FILLER.has(w));
    if (!q.length) return { none: true };
    const scored = this.ha.entities()
      .filter(e => domains.includes(e.domain) && e.state !== 'unavailable')
      .map(e => {
        const words = new Set([...norm(e.name).split(' '), ...norm(e.id.split('.')[1].replace(/_/g, ' ')).split(' ')]);
        let hit = 0;
        for (const w of q) if ([...words].some(x => x === w || (w.length > 3 && x.length > 2 && (x.includes(w) || w.startsWith(x))))) hit++;
        // „Licht“/„Lampe“ bevorzugt echte Lampen
        const lightHint = q.some(w => /licht|lampe|leuchte/.test(w)) && e.domain === 'light' ? 0.01 : 0;
        return { e, score: hit / q.length + lightHint, extra: words.size };
      })
      .filter(x => x.score >= 0.5)
      .sort((a, b) => b.score - a.score || a.extra - b.extra);
    if (!scored.length) return { none: true };
    const top = scored.filter(x => x.score === scored[0].score);
    if (top.length > 1 && top.length <= 4) return { ambiguous: top.map(x => x.e) };
    if (top.length > 4) return { tooMany: top.length };
    return { entity: top[0].e };
  }

  async run(text) {
    const t = norm(text);
    if (!t) return null;
    const words = t.split(' ');
    // Fragen dürfen nie etwas schalten („Ist der Alarm scharf?“)
    const question = /\?\s*$/.test(String(text)) ||
      /^(ist|sind|laeuft|laufen|wie|was|wo|wann|warum|hat|haben|welche|welcher|welches|steht|saugt)\b/.test(t);

    if (has(t, /^(hilfe|was kannst du|was geht|befehle)/)) return { reply: this.help() };

    if (has(t, /systemcheck|system check|systempruefung|diagnose|funktioniert alles|laeuft alles/) && this.systemCheck) {
      const r = await this.systemCheck.run();
      const bad = r.checks.filter(c => c.status === 'fail' || c.status === 'warn');
      if (!bad.length) return { reply: 'Systemcheck: Alles in Ordnung.', check: r };
      return { reply: `Systemcheck: ${bad.length} Punkt${bad.length === 1 ? '' : 'e'} offen. ` +
        bad.slice(0, 4).map(c => `${c.bereich}: ${c.text}.`).join(' ') + (bad.length > 4 ? ' Details unter „Systemcheck“.' : ''), check: r };
    }

    // ── Saugroboter ────────────────────────────────────────────────
    if (has(t, /\b(staub)?sauger\b|\broboter\b|\broborock\b|\bsaugen\b/)) {
      const v = this.home.vacuums()[0];
      if (!v) return { reply: 'Ich finde keinen Saugroboter in Home Assistant.' };
      let svc = null, msg = null;
      if (has(t, /nach hause|zurueck|station|basis|laden|dock/)) { svc = 'return_to_base'; msg = 'fährt zur Ladestation'; }
      else if (has(t, /\b(stopp?|stoppen|anhalten|halt|aus)\b/)) { svc = 'stop'; msg = 'hält an'; }
      else if (has(t, /pause|pausieren|warte/)) { svc = 'pause'; msg = 'pausiert'; }
      else if (has(t, /\bwo\b|finden|suchen|piepen/)) { svc = 'locate'; msg = 'meldet sich mit einem Ton'; }
      else if (has(t, /start|los|saugen|putzen|reinigen|\ban\b/)) { svc = 'start'; msg = 'startet die Reinigung'; }
      if (!svc || (question && svc !== 'locate')) {
        const bat = v.battery != null ? `, Akku ${v.battery} %` : '';
        return { reply: `${v.name} ${v.text}${bat}.` };
      }
      await this.ha.call('vacuum', svc, v.id);
      return { reply: `Okay, ${v.name} ${msg}.`, action: { entity: v.id, service: `vacuum.${svc}` } };
    }

    // ── Alarmanlage ────────────────────────────────────────────────
    if (has(t, /\balarm|alarmanlage|scharf/)) {
      const a = this.home.alarm();
      if (!a) return { reply: 'Ich finde keine Alarmanlage in Home Assistant.' };
      let svc = null, msg = null;
      if (has(t, /unscharf|entschaerf|\baus\b|deaktiv|ausschalten/)) { svc = 'alarm_disarm'; msg = 'ist entschärft'; }
      else if (has(t, /zuhause|nacht|home/)) { svc = 'alarm_arm_home'; msg = 'ist scharf (zuhause)'; }
      else if (has(t, /scharf|aktiv|\ban\b|\bein\b|abwesend|weg|einschalten/)) { svc = 'alarm_arm_away'; msg = 'ist scharf (abwesend)'; }
      if (!svc || question) return { reply: `Die Alarmanlage ist ${a.text}.` };
      if (a.codeRequired) return { reply: 'Die Alarmanlage verlangt einen Code. Bitte in der eufy-App oder in Home Assistant schalten.' };
      await this.ha.call('alarm_control_panel', svc, a.id);
      return { reply: `Okay, die Alarmanlage ${msg}.`, action: { entity: a.id, service: `alarm_control_panel.${svc}` } };
    }

    // ── Rollläden ──────────────────────────────────────────────────
    if (has(t, /rollladen|rolllaeden|rollo|jalousie|markise/)) {
      const svc = has(t, /\b(hoch|auf|oeffnen|oeffne|rauf)\b/) ? 'open_cover'
        : has(t, /\b(runter|zu|schliessen|schliesse|herunter)\b/) ? 'close_cover'
        : has(t, /stopp?|anhalten|halt/) ? 'stop_cover' : null;
      const rest = words.filter(w => !/^(rollladen|rolllaeden|rollo|rollos|jalousie|jalousien|markise|hoch|auf|oeffnen|oeffne|rauf|runter|zu|schliessen|schliesse|herunter|stopp?|anhalten|halt|ist|sind|steht|wie|offen|geschlossen|unten|oben)$/.test(w) && !FILLER.has(w));
      const covers = this.ha.byDomain('cover');
      if (!covers.length) return { reply: 'Ich finde keine Rollläden in Home Assistant.' };
      const found = rest.length ? this.findEntity(rest.join(' '), ['cover']) : (covers.length === 1 ? { entity: covers[0] } : { ambiguous: covers.slice(0, 4) });
      if (found.none && covers.length === 1) { found.entity = covers[0]; delete found.none; }
      if (found.ambiguous) return { reply: `Welcher Rollladen: ${found.ambiguous.map(e => e.name).join(', ')}?` };
      if (!found.entity) return { reply: 'Diesen Rollladen finde ich nicht.' };
      const e = found.entity;
      if (!svc || question) return { reply: `${e.name} ist ${({ open: 'offen', closed: 'geschlossen', opening: 'am Öffnen', closing: 'am Schließen' })[e.state] || e.state}${e.position != null ? ` (${e.position} %)` : ''}.` };
      await this.ha.call('cover', svc, e.id);
      return { reply: `Okay, ${e.name} ${({ open_cover: 'fährt hoch', close_cover: 'fährt runter', stop_cover: 'hält an' })[svc]}.`, action: { entity: e.id, service: `cover.${svc}` } };
    }

    // ── Schalten (Shelly, Licht …) ─────────────────────────────────
    const onIdx = Math.max(...ON_WORDS.map(w => words.lastIndexOf(w)));
    const offIdx = Math.max(...OFF_WORDS.map(w => words.lastIndexOf(w)));
    const toggle = words.includes('umschalten');
    if (onIdx >= 0 || offIdx >= 0 || toggle) {
      const turnOn = onIdx > offIdx;
      const rest = words.filter((w, i) => i !== onIdx && i !== offIdx && w !== 'umschalten');
      const found = this.findEntity(rest.join(' '), ['switch', 'light', 'fan']);
      if (found.entity && question) {
        const e = found.entity;
        return { reply: `${e.name} ist ${e.state === 'on' ? 'eingeschaltet' : e.state === 'off' ? 'ausgeschaltet' : e.state}.` };
      }
      if (found.entity) {
        const e = found.entity;
        const svc = toggle ? 'toggle' : turnOn ? 'turn_on' : 'turn_off';
        await this.ha.call(e.domain, svc, e.id);
        const was = toggle ? 'umgeschaltet' : turnOn ? 'eingeschaltet' : 'ausgeschaltet';
        return { reply: `Okay, ${e.name} ist ${was}.`, action: { entity: e.id, service: `${e.domain}.${svc}` } };
      }
      if (found.ambiguous) return { reply: `Welches meinst du: ${found.ambiguous.map(e => e.name).join(', ')}?` };
      // kein Gerät erkannt → vielleicht eine Frage, weiter unten oder KI
    }

    // ── Fragen ─────────────────────────────────────────────────────
    if (has(t, /status|lage|ueberblick|bericht|was ist los|alles (ok|in ordnung|gut)|zusammenfassung/)) {
      const b = this.home.briefing();
      return { reply: [b.greeting, ...b.lines].join(' ') };
    }

    if (has(t, /waschmaschine|waesche|waschen/)) {
      const w = this.home.washer.info(this.ha);
      if (!w.configured) return { reply: 'Die Waschmaschine ist noch nicht eingerichtet (Anleitung, Abschnitt 5).' };
      if (w.state === 'läuft') {
        const end = w.endsAt ? `, fertig um ${fmtClock(w.endsAt)} Uhr` : w.since ? ` seit ${fmtAgo(w.since).replace('vor ', '').replace(/\.$/, '')}` : '';
        const pw = w.power != null && !w.raw ? ` und zieht gerade ${fmtPower(w.power)}` : '';
        return { reply: `Die Waschmaschine läuft${end}${pw}.` };
      }
      if (w.state === 'fertig') return { reply: washerDoneText(w) };
      if (w.level === 'warn') return { reply: `${washerWarnText(w)} Bitte an der Maschine nachsehen.` };
      return { reply: `Die Waschmaschine ist ${w.state}.` };
    }

    if (has(t, /akku|batterie|speicher/)) {
      const e = this.home.energy();
      if (e.soc == null) return { reply: 'Ich habe gerade keinen Akkustand von Victron.' };
      const dir = e.batteryPower > 30 ? `, er lädt mit ${fmtPower(e.batteryPower)}` : e.batteryPower < -30 ? `, er gibt ${fmtPower(e.batteryPower)} ab` : '';
      return { reply: `Der Akku steht bei ${Math.round(e.soc)} %${dir}.` };
    }

    if (has(t, /\bpv\b|solar|sonne|erzeug|einspeis|ueberschuss|strom|verbrauch|netz/)) {
      const e = this.home.energy();
      if (e.pv == null) return { reply: 'Ich habe gerade keine Energiewerte.' };
      let r = `Die PV liefert ${fmtPower(e.pv)}, das Haus braucht ${fmtPower(e.consumption)}.`;
      if (e.grid < -50) r += ` ${fmtPower(e.grid)} gehen ins Netz.`;
      else if (e.grid > 50) r += ` ${fmtPower(e.grid)} kommen aus dem Netz.`;
      if (e.soc != null) r += ` Akku ${Math.round(e.soc)} %.`;
      return { reply: r };
    }

    if (has(t, /bewegung|kamera|einbruch|sicherheit|wer war|jemand/)) {
      const m = this.home.lastMotion();
      const a = this.home.alarm();
      const parts = [];
      if (a) parts.push(`Die Alarmanlage ist ${a.text}.`);
      parts.push(m ? (m.active ? `Gerade Bewegung: ${m.name}.` : sentence(`Letzte Bewegung: ${m.name}, ${m.ago}`)) : this.ha.motionSensors().length ? 'Mir ist keine Bewegung bekannt.' : 'Keine Bewegungsmelder gefunden.');
      return { reply: parts.join(' ') };
    }

    if (has(t, /was (ist|laeuft) (an|alles)|welche geraete|was ist eingeschaltet/)) {
      const on = this.home.activeSwitches();
      if (!on.length) return { reply: 'Gerade ist nichts eingeschaltet.' };
      return { reply: `Eingeschaltet: ${on.map(e => e.name).join(', ')}.` };
    }

    return null;
  }

  help() {
    return 'Zum Beispiel: „Status“, „Wie viel PV?“, „Heizstab aus“, „Licht Küche an“, „Sauger starten“, ' +
      '„Sauger nach Hause“, „Alarm scharf“, „Rollladen Küche runter“, „Ist die Waschmaschine fertig?“.';
  }
}

module.exports = { Commands, norm };
