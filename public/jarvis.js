// ════════════════════════════════════════════════════════════════
// Jarvis – Startseite „Zuhause“: Konsole, Sprache, Hinweise, Geräte
// ════════════════════════════════════════════════════════════════
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
  };

  let cfg = { ha: false, ai: false, pinRequired: false };
  let pin = store.get('jarvis_pin', '');
  let lastHome = null;
  const busy = new Set();

  // ── Formatierung ────────────────────────────────────────────────
  const fmtW = w => {
    if (w == null || !Number.isFinite(w)) return '–';
    const a = Math.abs(w);
    return a >= 1000 ? (a / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' kW' : Math.round(a) + ' W';
  };
  const ago = iso => {
    if (!iso) return '';
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return 'jetzt';
    if (m < 60) return `vor ${m} Min.`;
    const h = Math.floor(m / 60);
    return h < 24 ? `vor ${h} Std.` : `vor ${Math.floor(h / 24)} T.`;
  };
  const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const icon = id => `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  // ── Server-Anfragen (mit PIN) ───────────────────────────────────
  function setPin(p) {
    pin = p;
    store.set('jarvis_pin', p);
    document.cookie = `jarvis_pin=${encodeURIComponent(p)}; path=/; max-age=31536000; SameSite=Strict`;
  }
  if (pin) setPin(pin);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-jarvis-pin': pin } : {}), ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      showPin(true);
      const e = new Error('PIN erforderlich'); e.pin = true; throw e;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  function showPin(on) {
    $('jv-pin').hidden = !on;
    if (on) $('jv-pin-input').focus({ preventScroll: true });
  }

  $('jv-pin-save').addEventListener('click', () => {
    const v = $('jv-pin-input').value.trim();
    if (!v) return;
    setPin(v);
    $('jv-pin-input').value = '';
    showPin(false);
    refresh();
  });
  $('jv-pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('jv-pin-save').click(); });

  // ── Vorlesen ────────────────────────────────────────────────────
  const speakBox = $('jv-speak');
  speakBox.checked = store.get('jarvis_speak') === '1';
  speakBox.addEventListener('change', () => store.set('jarvis_speak', speakBox.checked ? '1' : '0'));
  const canSpeak = 'speechSynthesis' in window;
  if (!canSpeak) speakBox.closest('label').hidden = true;

  function speak(text) {
    if (!canSpeak || !speakBox.checked || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    const v = speechSynthesis.getVoices().find(x => x.lang?.startsWith('de'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  // ── Konsole ─────────────────────────────────────────────────────
  const form = $('jv-form'), input = $('jv-input'), answer = $('jv-answer');

  async function ask(text) {
    text = text.trim();
    if (!text) return;
    form.classList.add('is-busy');
    answer.className = 'jv-answer is-thinking';
    answer.textContent = cfg.ai ? 'Jarvis denkt nach …' : 'Einen Moment …';
    try {
      const r = await api('/api/jarvis/ask', { method: 'POST', body: JSON.stringify({ text }) });
      const src = { regel: 'direkt', ki: 'KI' }[r.source];
      answer.className = 'jv-answer is-new' + (r.source === 'fehler' ? ' is-error' : '');
      answer.innerHTML = esc(r.reply) + (src ? `<span class="jv-src">${src}</span>` : '');
      speak(r.reply);
      if (r.action || r.actions?.length) refresh();
    } catch (e) {
      answer.className = 'jv-answer is-error';
      answer.textContent = e.pin ? 'Bitte zuerst die PIN eingeben.' : `Keine Verbindung zum Jarvis-Server (${e.message}).`;
    } finally {
      form.classList.remove('is-busy');
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    ask(t);
  });

  $('jv-chips').addEventListener('click', e => {
    const b = e.target.closest('.jv-chip');
    if (b) ask(b.textContent);
  });

  // ── Spracheingabe ───────────────────────────────────────────────
  const mic = $('jv-mic');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !window.isSecureContext) {
    mic.disabled = true;
    mic.title = !window.isSecureContext
      ? 'Spracheingabe braucht eine sichere Verbindung (HTTPS). Siehe Anleitung, Abschnitt Fernzugriff.'
      : 'Dieser Browser kann keine Spracheingabe (Chrome, Edge oder Safari verwenden).';
    mic.setAttribute('aria-label', mic.title);
  } else {
    let rec = null;
    mic.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'de-DE';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = '';
      rec.onstart = () => { mic.classList.add('is-listening'); mic.setAttribute('aria-label', 'Zuhören beenden'); input.placeholder = 'Ich höre zu …'; };
      rec.onresult = ev => {
        let interim = '';
        for (const r of ev.results) (r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript));
        input.value = finalText || interim;
      };
      rec.onerror = ev => {
        if (ev.error === 'not-allowed') answer.textContent = 'Mikrofon ist blockiert. Bitte im Browser erlauben.';
        else if (ev.error !== 'no-speech' && ev.error !== 'aborted') answer.textContent = `Spracheingabe: ${ev.error}`;
      };
      rec.onend = () => {
        mic.classList.remove('is-listening');
        mic.setAttribute('aria-label', 'Spracheingabe starten');
        input.placeholder = 'Frag Jarvis oder gib einen Befehl – z. B. „Heizstab aus“';
        rec = null;
        if (finalText) { input.value = ''; ask(finalText); }
      };
      rec.start();
    });
  }

  // ── Lagebild zeichnen ───────────────────────────────────────────
  function renderBriefing(b) {
    $('jv-greeting').textContent = b.greeting;
    const lines = $('jv-lines');
    lines.textContent = b.lines.join(' ');
    lines.classList.toggle('is-alert', b.lines.some(l => l.startsWith('Achtung')));
  }

  function renderEnergy(e) {
    $('je-pv').textContent = fmtW(e.pv);
    $('je-cons').textContent = fmtW(e.consumption);
    const g = $('je-grid-wrap');
    const exp = e.grid != null && e.grid < -20;
    g.dataset.tone = e.grid == null ? '' : exp ? 'aqua' : 'red';
    $('je-grid-label').textContent = e.grid == null ? 'Netz' : exp ? 'Einspeisung' : 'Netzbezug';
    $('je-grid').textContent = fmtW(e.grid);
    $('je-soc').textContent = e.soc != null ? Math.round(e.soc) + ' %' : '–';
    $('je-soc-wrap').classList.toggle('is-off', e.soc == null);
    $('je-heiz').textContent = e.heizstab != null ? (e.heizstab > 20 ? fmtW(e.heizstab) : 'aus') : '–';
    $('je-heiz-wrap').classList.toggle('is-off', !(e.heizstab > 20));
  }

  const ALARM_ON = new Set(['armed_away', 'armed_home', 'armed_night', 'armed_vacation', 'armed_custom_bypass']);

  function renderAlarm(a) {
    const pill = $('jv-alarm-state'), seg = $('jv-alarm-actions');
    if (!a) { pill.textContent = 'keine Alarmanlage'; pill.className = 'jv-pill'; seg.hidden = true; return; }
    seg.hidden = false;
    pill.textContent = `Alarm ${a.text}`;
    pill.className = 'jv-pill' + (a.state === 'triggered' ? ' is-alert' : ALARM_ON.has(a.state) ? ' is-armed' : '');
    const cur = { armed_away: 'alarm_arm_away', armed_home: 'alarm_arm_home', disarmed: 'alarm_disarm' }[a.state];
    seg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('is-on', b.dataset.alarm === cur);
      b.setAttribute('aria-pressed', b.dataset.alarm === cur);
      b.disabled = a.codeRequired || busy.has(a.id);
      b.title = a.codeRequired ? 'Diese Alarmanlage verlangt einen Code – bitte in der eufy-App schalten.' : '';
    });
    seg.dataset.entity = a.id;
  }

  // Kamerabilder: Kacheln einmal anlegen, Bilder nur nachladen
  let camStamp = 0;
  function renderCams(cams, motion, wallId, max) {
    const wall = $(wallId);
    const list = max ? cams.slice(0, max) : cams;
    const key = list.map(c => c.id).join(',');
    if (wall.dataset.key !== key) {
      wall.dataset.key = key;
      wall.innerHTML = list.length ? list.map(c => `
        <button type="button" class="cam-tile" data-cam="${esc(c.id)}" data-name="${esc(c.name)}" aria-label="${esc(c.name)} groß anzeigen">
          <img alt="" loading="lazy" decoding="async" />
          <span class="cam-tile-meta"><span class="cam-tile-name">${esc(c.name)}</span><span class="cam-tile-ago"></span></span>
        </button>`).join('')
        : `<p class="jv-empty">Keine Kameras in Home Assistant gefunden. Die eufy-Integration einrichten (Anleitung, Schritt 3).</p>`;
      if (list.length) setTimeout(refreshCamImages, 0);
    }
    const norm = s => s.toLowerCase().replace(/[^a-zäöüß0-9]+/g, ' ');
    wall.querySelectorAll('.cam-tile').forEach(tile => {
      const cam = list.find(c => c.id === tile.dataset.cam);
      // passenden Bewegungsmelder über den Namen finden (z. B. „Einfahrt“ ↔ „Einfahrt Bewegung“)
      const first = norm(cam?.name || '').split(' ')[0];
      const m = motion.find(x => first && norm(x.name).includes(first));
      tile.classList.toggle('is-motion', m?.state === 'on');
      tile.querySelector('.cam-tile-ago').textContent = m ? (m.state === 'on' ? 'Bewegung' : ago(m.changed)) : '';
    });
  }

  function refreshCamImages() {
    camStamp = Date.now();
    document.querySelectorAll('.tab-panel.active .cam-tile img').forEach(img => {
      const id = img.closest('.cam-tile').dataset.cam;
      const next = new Image();
      next.onload = () => { img.src = next.src; };
      next.onerror = () => { if (!img.src) img.closest('.cam-tile').classList.add('is-broken'); };
      next.src = `/api/ha/camera/${encodeURIComponent(id)}?t=${camStamp}`;
    });
  }

  function renderMotion(motion) {
    const sorted = [...motion].sort((a, b) => new Date(b.changed) - new Date(a.changed));
    $('jv-motion').innerHTML = sorted.map(m =>
      `<li class="${m.state === 'on' ? 'is-on' : ''}"><span>${esc(m.name)}</span><span class="ago">${m.state === 'on' ? 'Bewegung' : esc(ago(m.changed))}</span></li>`).join('');
  }

  function renderVacuums(vacs) {
    $('jv-vacuums').innerHTML = vacs.map(v => {
      const cls = v.state === 'cleaning' || v.state === 'returning' ? 'is-active' : v.state === 'error' ? 'is-warn' : '';
      const bat = v.battery != null ? ` · Akku ${v.battery} %` : '';
      const dis = busy.has(v.id) || v.state === 'unavailable' ? 'disabled' : '';
      const running = v.state === 'cleaning';
      return `<div class="jv-device ${cls}" data-entity="${esc(v.id)}">
        <div class="jv-device-top">${icon('robot')}<div>
          <div class="jv-device-name">${esc(v.name)}</div>
          <div class="jv-device-state"><b>${esc(v.text)}</b>${esc(bat)}${v.status && v.state === 'error' ? ' · ' + esc(v.status) : ''}</div>
        </div></div>
        <div class="jv-actions">
          <button type="button" class="jv-act" data-svc="${running ? 'pause' : 'start'}" ${dis}>${icon(running ? 'pause' : 'play')}${running ? 'Pause' : 'Start'}</button>
          <button type="button" class="jv-act" data-svc="return_to_base" ${dis}>${icon('dock')}Station</button>
          <button type="button" class="jv-act" data-svc="locate" ${dis}>${icon('locate')}Finden</button>
          <button type="button" class="jv-act" data-svc="stop" ${dis}>${icon('pause')}Stopp</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderWasher(w) {
    const box = $('jv-washer');
    if (!w.configured) {
      box.className = 'jv-device';
      box.innerHTML = `<div class="jv-device-top">${icon('washer')}<div><div class="jv-device-name">Waschmaschine</div>
        <p class="jv-empty">Noch nicht eingerichtet. Am einfachsten über einen messenden Zwischenstecker (z. B. Shelly Plug): seinen Leistungssensor als <code>WASCHMASCHINE_POWER_ENTITY</code> in die <code>.env</code> eintragen.</p></div></div>`;
      return;
    }
    const st = w.state || w.statusText || 'unbekannt';
    box.className = 'jv-device' + (w.state === 'läuft' ? ' is-active' : w.state === 'fertig' ? ' is-done' : '');
    const since = w.since ? (w.state === 'läuft' ? ` seit ${ago(w.since).replace('vor ', '')}` : ` · ${ago(w.since)}`) : '';
    const pw = w.power != null ? ` · ${fmtW(w.power)}` : '';
    box.innerHTML = `<div class="jv-device-top">${icon('washer')}<div><div class="jv-device-name">Waschmaschine</div>
      <div class="jv-device-state"><b>${esc(st)}</b>${esc(since)}${esc(pw)}</div></div></div>`;
  }

  function renderSwitches(list) {
    const ul = $('jv-switches');
    const q = $('jv-sw-filter').value.trim().toLowerCase();
    const shown = q ? list.filter(s => s.name.toLowerCase().includes(q)) : list;
    if (!list.length) { ul.innerHTML = '<li class="jv-empty">Keine schaltbaren Geräte gefunden.</li>'; return; }
    if (!shown.length) { ul.innerHTML = '<li class="jv-empty">Kein Schalter passt zum Filter.</li>'; return; }
    ul.innerHTML = shown.map(s => {
      const on = s.state === 'on';
      const na = s.state === 'unavailable';
      const kind = { light: 'Licht', fan: 'Lüfter' }[s.domain] || 'Schalter';
      return `<li><button type="button" class="jv-sw${busy.has(s.id) ? ' is-busy' : ''}" role="switch" aria-checked="${on}"
        data-entity="${esc(s.id)}" ${na ? 'disabled' : ''}>
        <span class="jv-sw-name">${esc(s.name)}<span class="jv-sw-sub">${na ? 'nicht erreichbar' : `${kind} · ${on ? 'an' : 'aus'}`}</span></span>
        <span class="jv-knob" aria-hidden="true"></span></button></li>`;
    }).join('');
  }

  // ── Schalten ────────────────────────────────────────────────────
  async function callService(entity, service) {
    const domain = entity.split('.')[0];
    busy.add(entity);
    if (lastHome) render(lastHome);
    try {
      await api(`/api/ha/service/${domain}/${service}`, { method: 'POST', body: JSON.stringify({ entity_id: entity }) });
    } catch (e) {
      if (!e.pin) toast({ level: 'warn', title: 'Schalten fehlgeschlagen', text: e.message });
    } finally {
      busy.delete(entity);
      refresh();
    }
  }

  $('jv-switches').addEventListener('click', e => {
    const b = e.target.closest('.jv-sw');
    if (!b || b.disabled || busy.has(b.dataset.entity)) return;
    const on = b.getAttribute('aria-checked') === 'true';
    b.setAttribute('aria-checked', String(!on)); // sofort sichtbar, Server bestätigt
    callService(b.dataset.entity, on ? 'turn_off' : 'turn_on');
  });
  $('jv-sw-filter').addEventListener('input', () => lastHome && renderSwitches(lastHome.switches));

  $('jv-vacuums').addEventListener('click', e => {
    const b = e.target.closest('.jv-act');
    if (b) callService(b.closest('.jv-device').dataset.entity, b.dataset.svc);
  });

  $('jv-alarm-actions').addEventListener('click', e => {
    const b = e.target.closest('.jv-seg-btn');
    if (!b || b.classList.contains('is-on')) return;
    const id = e.currentTarget.dataset.entity;
    if (b.dataset.alarm === 'alarm_disarm' && !confirm('Alarmanlage wirklich ausschalten?')) return;
    callService(id, b.dataset.alarm);
  });

  // ── Kamera groß ────────────────────────────────────────────────
  const dlg = $('jv-cam-dialog');
  let liveTimer = null;
  document.addEventListener('click', e => {
    const tile = e.target.closest('.cam-tile');
    if (!tile) return;
    const id = tile.dataset.cam;
    $('jv-cam-title').textContent = tile.dataset.name;
    const img = $('jv-cam-img');
    img.alt = `Kamerabild ${tile.dataset.name}`;
    $('jv-cam-note').textContent = 'Livebild wird geladen …';
    img.onerror = () => {
      // Kein Livestrom (z. B. Akku-Kamera im Ruhemodus) → Standbild alle 3 s
      img.onerror = null;
      $('jv-cam-note').textContent = 'Kein Livestrom verfügbar – Standbild, wird alle 3 Sekunden erneuert.';
      const tick = () => { img.src = `/api/ha/camera/${encodeURIComponent(id)}?t=${Date.now()}`; };
      tick();
      liveTimer = setInterval(tick, 3000);
    };
    img.onload = () => { if (!liveTimer) $('jv-cam-note').textContent = 'Livebild über Home Assistant.'; };
    img.src = `/api/ha/camera/${encodeURIComponent(id)}/live`;
    dlg.showModal();
  });
  const closeCam = () => { clearInterval(liveTimer); liveTimer = null; $('jv-cam-img').removeAttribute('src'); };
  $('jv-cam-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', closeCam);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // ── Hinweise (live) ─────────────────────────────────────────────
  const logEl = $('jv-log');
  function logItem(h, isNew) {
    return `<li data-level="${esc(h.level)}" class="${isNew ? 'is-new' : ''}"><time datetime="${esc(h.ts)}">${clock(h.ts)}</time>
      <div><b>${esc(h.title)}</b><span>${esc(h.text || '')}</span></div></li>`;
  }
  function renderLog(list) {
    logEl.innerHTML = list.length ? list.slice(0, 40).map(h => logItem(h)).join('')
      : '<li class="jv-empty" style="display:block">Noch keine Hinweise. Jarvis meldet hier Bewegungen, fertige Geräte, PV-Überschuss und Alarme.</li>';
  }

  function toast(h) {
    const el = document.createElement('div');
    el.className = 'jv-toast';
    el.dataset.level = h.level || 'info';
    el.innerHTML = `<b>${esc(h.title)}</b><span>${esc(h.text || '')}</span>`;
    $('jv-toasts').prepend(el);
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 300); }, h.level === 'alert' ? 15000 : 6000);
  }

  const notifyBtn = $('jv-notify-btn');
  const canNotify = 'Notification' in window && window.isSecureContext;
  if (canNotify && Notification.permission === 'default') notifyBtn.hidden = false;
  notifyBtn.addEventListener('click', async () => {
    await Notification.requestPermission();
    notifyBtn.hidden = true;
  });

  function onHinweis(h) {
    const empty = logEl.querySelector('.jv-empty');
    if (empty) empty.remove();
    logEl.insertAdjacentHTML('afterbegin', logItem(h, true));
    toast(h);
    if (h.level !== 'info' || h.kind === 'washer' || h.kind === 'vacuum') speak(`${h.title}. ${h.text || ''}`);
    if (canNotify && Notification.permission === 'granted' && document.hidden) {
      try { new Notification(h.title, { body: h.text || '', tag: `jarvis-${h.id}` }); } catch { /* manche Browser nur per Service Worker */ }
    }
    refresh();
  }

  function connectStream() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/jarvis/stream');
    es.addEventListener('hinweis', ev => { try { onHinweis(JSON.parse(ev.data)); } catch { /* ungültige Meldung */ } });
  }

  // ── Laden & Zeichnen ────────────────────────────────────────────
  function render(h) {
    renderBriefing(h.briefing);
    renderEnergy(h.energy);
    const haOk = h.ha.ok;
    const banner = $('jv-ha-banner');
    if (!h.ha.enabled) {
      banner.hidden = false;
      banner.className = 'banner info jv-banner';
      banner.innerHTML = 'Home Assistant ist noch nicht verbunden. Trage <code>HA_URL</code> und <code>HA_TOKEN</code> in die <code>.env</code> ein (Anleitung: <code>home-assistant/ANLEITUNG.md</code>).';
    } else if (!haOk) {
      banner.hidden = false;
      banner.className = 'banner error jv-banner';
      banner.textContent = `Home Assistant ist nicht erreichbar: ${h.ha.error || 'keine Antwort'}. Angezeigt wird der letzte bekannte Stand.`;
    } else banner.hidden = true;

    renderAlarm(h.alarm);
    renderCams(h.cameras, h.motion, 'jv-cams', 4);
    renderCams(h.cameras, h.motion, 'ha-cam-page');
    renderMotion(h.motion);
    renderVacuums(h.vacuums);
    renderWasher(h.washer);
    renderSwitches(h.switches);
    $('dot-ha').className = 'dot ' + (haOk ? 'ok' : h.ha.enabled ? 'err' : '');
  }

  async function refresh() {
    try {
      const h = await api('/api/jarvis/home');
      lastHome = h;
      render(h);
    } catch (e) {
      if (!e.pin) $('dot-ha').className = 'dot err';
    }
  }

  async function init() {
    try {
      cfg = await api('/api/jarvis/config');
    } catch { /* Server alt oder offline */ }
    $('dot-ki').className = 'dot ' + (cfg.ai ? 'ok' : '');
    $('dot-ki').parentElement.title = cfg.ai ? 'KI-Fragen aktiv' : 'KI nicht eingerichtet (ANTHROPIC_API_KEY)';
    if (cfg.ha) {
      // Kameras-Tab zeigt dann die Home-Assistant-Kameras statt der alten eufy-Cloud-Abfrage
      $('ha-cam-page').hidden = false;
      $('eufy-setup')?.remove();
      $('eufy-live')?.remove();
    }
    if (cfg.pinRequired && !pin) showPin(true);

    try { renderLog(await api('/api/jarvis/hinweise')); } catch { renderLog([]); }
    await refresh();
    connectStream();

    setInterval(() => { if (!document.hidden) refresh(); }, 4000);
    setInterval(() => { if (!document.hidden) refreshCamImages(); }, 15000);
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => setTimeout(refreshCamImages, 50)));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshCamImages(); } });
  }

  init();
})();
