// Systemcheck: prüft auf dem Pi alle angeschlossenen Systeme und erklärt Probleme auf Deutsch.
const fs = require('fs');
const path = require('path');

/** Laufende Jarvis-Version aus dem Git-Ordner lesen (ohne git-Programm). */
function gitVersion(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return { commit: head.slice(0, 7), branch: null };
    const ref = head.slice(5).trim();
    let sha = null;
    try { sha = fs.readFileSync(path.join(root, '.git', ref), 'utf8').trim(); }
    catch {
      const packed = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8');
      sha = packed.split('\n').find(l => l.endsWith(' ' + ref))?.split(' ')[0] || null;
    }
    return { commit: sha ? sha.slice(0, 7) : null, branch: ref.replace('refs/heads/', '') };
  } catch { return { commit: null, branch: null }; }
}

/** eufy-Brücke (eufy-security-ws) direkt fragen: Cloud- und Push-Verbindung. */
function askEufyBridge(url, timeoutMs = 6000) {
  return new Promise(resolve => {
    if (typeof WebSocket === 'undefined') {
      resolve({ error: `Node ${process.version} hat kein eingebautes WebSocket (ab Node 22 vorhanden)` });
      return;
    }
    const out = {};
    let ws;
    const done = r => { clearTimeout(timer); try { ws?.close(); } catch { /* egal */ } resolve(r); };
    const timer = setTimeout(() => done({ ...out, error: out.version ? 'Brücke antwortet nicht vollständig' : 'keine Antwort (läuft der Container eufy-security-ws?)' }), timeoutMs);
    try { ws = new WebSocket(url); } catch (e) { done({ error: e.message }); return; }
    ws.onerror = () => done({ error: `nicht erreichbar unter ${url}` });
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'version') {
        out.version = m.serverVersion;
        ws.send(JSON.stringify({ messageId: 'cloud', command: 'driver.is_connected' }));
        ws.send(JSON.stringify({ messageId: 'push', command: 'driver.is_push_connected' }));
      } else if (m.type === 'result') {
        if (m.messageId === 'cloud') out.cloud = m.success ? !!m.result?.connected : null;
        if (m.messageId === 'push') out.push = m.success ? !!m.result?.connected : null;
        if ('cloud' in out && 'push' in out) done(out);
      }
    };
  });
}

class SystemCheck {
  constructor({ root, cfg, ha, home, motion, discovery, assistant, getShelly, getVictron, pin, eufyUrl }) {
    Object.assign(this, { root, cfg, ha, home, motion, discovery, assistant, getShelly, getVictron, pin, eufyUrl });
  }

  async run() {
    const checks = [];
    const add = (bereich, status, text, hilfe = null) => checks.push({ bereich, status, text, hilfe });
    const ageMin = ts => ts ? Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 60000) : null;

    // Jarvis selbst
    const v = gitVersion(this.root);
    add('Jarvis', 'ok', `Version ${v.commit || 'unbekannt'}${v.branch ? ` (Branch ${v.branch})` : ''}, Node ${process.version}`,
      v.commit ? null : 'Version nicht lesbar – wurde Jarvis per git geholt?');

    // Shelly
    const s = this.getShelly();
    if (this.cfg.simulate) add('Shelly', 'warn', 'Simulationsmodus – keine echten Shelly-Werte', 'SHELLY_AUTH_KEY und PV-Zähler in .env eintragen');
    else if (s?.error) add('Shelly', 'warn', 'Mindestens ein PV-Zähler antwortet nicht', 'Shelly-Cloud bzw. Geräte-IDs prüfen');
    else add('Shelly', ageMin(s?.ts) <= 2 ? 'ok' : 'fail', `Letzte Werte vor ${ageMin(s?.ts)} Min.`);

    // Victron
    if (!this.cfg.hasVictron) add('Victron', 'info', 'nicht eingerichtet');
    else {
      const vc = this.getVictron();
      if (!vc) add('Victron', 'fail', 'Noch keine Daten von VRM', 'Zugangsdaten und Installations-ID prüfen');
      else add('Victron', vc.error || ageMin(vc.ts) > 5 ? 'warn' : 'ok', `Letzte Werte vor ${ageMin(vc.ts)} Min.${vc.error ? ', letzte Abfrage fehlgeschlagen' : ''}`);
    }

    // Home Assistant
    if (!this.ha.enabled) {
      add('Home Assistant', 'fail', 'nicht eingerichtet', 'HA_URL und HA_TOKEN in .env eintragen');
    } else if (!this.ha.ok) {
      add('Home Assistant', 'fail', `nicht erreichbar: ${this.ha.error || 'keine Antwort'}`, 'Läuft der Container homeassistant? Ist der Zugriffsschlüssel gültig?');
    } else {
      add('Home Assistant', 'ok', `erreichbar, ${this.ha.states.size} Entitäten`);
    }

    // eufy-Brücke
    const eufy = await askEufyBridge(this.eufyUrl);
    if (eufy.error) add('eufy-Brücke', 'fail', eufy.error, 'Container eufy-security-ws prüfen: docker logs eufy-security-ws');
    else {
      add('eufy-Brücke', eufy.cloud ? 'ok' : 'fail', `Version ${eufy.version}, eufy-Cloud ${eufy.cloud ? 'verbunden' : 'NICHT verbunden'}`,
        eufy.cloud ? null : 'Zugangsdaten in home-assistant/eufy.env prüfen; evtl. Bestätigungscode/Captcha nötig (docker logs eufy-security-ws)');
      add('eufy-Bewegungsmeldungen', eufy.push ? 'ok' : 'fail',
        eufy.push ? 'Benachrichtigungsdienst verbunden – Bewegungen kommen an' : 'Benachrichtigungsdienst NICHT verbunden – Bewegungen werden nicht gemeldet',
        eufy.push ? null : 'In der eufy-App beim Konto der Brücke Benachrichtigungen erlauben; Brücke neu starten: docker restart eufy-security-ws');
    }

    if (this.ha.ok) {
      // Kameras und Bewegungsmelder
      const cams = this.ha.byDomain('camera');
      add('Kamera-Zuordnung', this.motion.mapSource === 'geraet' ? 'ok' : 'warn',
        this.motion.mapSource === 'geraet' ? 'über Geräte in Home Assistant' : 'nur über Namen (Zugriffsschlüssel ist kein Administrator)',
        this.motion.mapSource === 'geraet' ? null : 'Zugriffsschlüssel mit einem Administrator-Konto erstellen');
      for (const c of cams) {
        const m = this.motion.forCamera(c.id);
        const states = m.sensors.map(id => this.ha.get(id)?.state);
        const name = c.name.replace(/^kamera\s+/i, "");
        if (!m.sensors.length) add(`Kamera ${name}`, 'warn', 'kein Bewegungsmelder zugeordnet', 'In HA prüfen, ob die Kamera Melder wie „Motion detected“ hat (evtl. deaktiviert)');
        else if (states.every(st => st === 'unavailable' || st === undefined)) add(`Kamera ${name}`, 'fail', 'Bewegungsmelder in HA „nicht verfügbar“', 'eufy-Integration in HA neu laden');
        else {
          const ago = m.motionAt ? ageMin(m.motionAt) : null;
          const t = m.motionAt ? (ago < 60 ? `vor ${ago} Min.` : ago < 2880 ? `vor ${Math.round(ago / 60)} Std.` : `vor ${Math.round(ago / 1440)} Tagen`) : 'keine bekannt';
          add(`Kamera ${name}`, 'ok', `${m.sensors.length} Melder, letzte Bewegung ${t}${m.motionActive ? ' (gerade aktiv)' : ''}`);
        }
      }
      if (!cams.length) add('Kameras', 'warn', 'keine Kameras in Home Assistant', 'eufy-Integration in HA einrichten (Anleitung, Schritt 3)');

      // Geräte
      const vac = this.home.vacuums();
      add('Saugroboter', vac.length ? (vac.some(x => x.state === 'unavailable') ? 'warn' : 'ok') : 'info',
        vac.length ? vac.map(x => `${x.name}: ${x.text}`).join(', ') : 'keiner in Home Assistant', vac.length ? null : 'Roborock-Integration in HA hinzufügen');
      const w = this.home.washer.info(this.ha);
      add('Waschmaschine', w.configured ? (w.state === 'nicht erreichbar' || w.state === 'unbekannt' ? 'warn' : 'ok') : 'info',
        w.configured ? `Zustand: ${w.state}` : 'nicht eingerichtet', w.configured ? null : 'Home Connect einrichten (Anleitung, Abschnitt 5)');
      const al = this.home.alarm();
      add('Alarmanlage', al ? 'ok' : 'info', al ? `${al.name}: ${al.text}${al.codeRequired ? ' (verlangt Code)' : ''}` : 'keine in Home Assistant');
      const d = this.discovery.status();
      add('Geräteprüfung', d.lastRun ? 'ok' : 'warn', d.lastRun ? `zuletzt ${new Date(d.lastRun).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}: ${d.result?.text}` : 'noch nicht gelaufen');
    }

    add('KI-Fragen', this.assistant.enabled ? 'ok' : 'info', this.assistant.enabled ? `aktiv (${this.assistant.model})` : 'aus (kein ANTHROPIC_API_KEY)');
    add('PIN-Schutz', this.pin ? 'ok' : 'warn', this.pin ? 'aktiv' : 'aus – jeder im WLAN kann schalten und Kameras sehen', this.pin ? null : 'JARVIS_PIN in .env setzen');

    const order = { fail: 0, warn: 1, info: 2, ok: 3 };
    return {
      zeit: new Date().toISOString(),
      gesamt: checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok',
      checks: checks.sort((a, b) => order[a.status] - order[b.status]),
    };
  }
}

module.exports = { SystemCheck, gitVersion, askEufyBridge };
