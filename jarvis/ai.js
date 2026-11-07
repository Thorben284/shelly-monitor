// KI-Fragen über die Claude API. Nur aktiv, wenn ANTHROPIC_API_KEY gesetzt ist.
// Die KI sieht einen Zustands-Schnappschuss und darf nur freigegebene Befehle auslösen.
const Anthropic = require('@anthropic-ai/sdk').default;
const { ALLOWED_SERVICES } = require('./ha');

// Modelle, die den serverseitigen Ersatz bei Ablehnung unterstützen
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

const SYSTEM = `Du bist Jarvis, der Hausassistent einer Familie in Deutschland.
Du antwortest auf Deutsch, kurz und gesprochen-natürlich: meist ein bis drei Sätze, keine Aufzählungen, kein Markdown.
Deine Antwort wird oft vorgelesen. Zahlen rundest du sinnvoll (z. B. „3,2 Kilowatt“).

Du bekommst bei jeder Frage den aktuellen Zustand des Hauses als JSON. Nutze nur diese Daten; was dort fehlt, weißt du nicht – sag das ehrlich.
Energie: "grid" positiv heißt Strombezug aus dem Netz, negativ heißt Einspeisung. Leistungen sind in Watt.

Geräte schaltest du ausschließlich mit dem Werkzeug control_device und nur, wenn der Nutzer es eindeutig verlangt.
Bei Mehrdeutigkeit fragst du nach, statt zu raten. Die Alarmanlage entschärfst du nur auf ausdrückliche Bitte.
Nach einem Schaltbefehl bestätigst du in einem kurzen Satz, was du getan hast.`;

const TOOLS = [{
  name: 'control_device',
  description: 'Schaltet ein Gerät in Home Assistant. Nur für Geräte-IDs aus dem Zustands-JSON verwenden.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['entity_id', 'service'],
    properties: {
      entity_id: { type: 'string', description: 'Geräte-ID, z. B. switch.heizstab' },
      service: { type: 'string', enum: [...ALLOWED_SERVICES].map(s => s.split('.')[1]).filter((v, i, a) => a.indexOf(v) === i),
        description: 'Aktion, passend zur Domäne der Geräte-ID (z. B. turn_on, turn_off, start, return_to_base, alarm_arm_away)' },
    },
  },
}];

class Assistant {
  constructor({ apiKey, model, ha, home }) {
    this.enabled = !!apiKey;
    this.model = model || 'claude-opus-5-5';
    this.ha = ha;
    this.home = home;
    this.recent = []; // letzte Wortwechsel als Klartext (Kontext für Rückfragen)
    if (this.enabled) this.client = new Anthropic({ apiKey, timeout: 45000, maxRetries: 1 });
  }

  async ask(question) {
    if (!this.enabled) return null;
    const actions = [];
    if (this.lastAt && Date.now() - this.lastAt > 15 * 60000) this.recent = [];
    this.lastAt = Date.now();
    const context = this.recent.length
      ? `Letzte Unterhaltung:\n${this.recent.map(r => `Nutzer: ${r.q}\nJarvis: ${r.a}`).join('\n')}\n\n`
      : '';
    const messages = [{
      role: 'user',
      content: `${context}Zustand des Hauses:\n${JSON.stringify(this.home.snapshot())}\n\nFrage: ${question}`,
    }];

    const params = {
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      tools: TOOLS,
      output_config: { effort: 'low' },
    };
    if (FALLBACK_MODELS.has(this.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    let reply = '';
    for (let round = 0; round < 4; round++) {
      let res;
      try {
        res = await this.client.beta.messages.create({ ...params, messages });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) return { reply: 'Der KI-Schlüssel wird abgelehnt. Bitte ANTHROPIC_API_KEY prüfen.', source: 'ki' };
        if (e instanceof Anthropic.RateLimitError) return { reply: 'Die KI ist gerade ausgelastet. Versuch es gleich noch einmal.', source: 'ki' };
        if (e instanceof Anthropic.APIError) return { reply: `Die KI antwortet nicht (Fehler ${e.status ?? 'Verbindung'}).`, source: 'ki' };
        throw e;
      }

      if (res.stop_reason === 'refusal') return { reply: 'Dabei kann ich nicht helfen.', source: 'ki', actions };

      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (text) reply = text;
      if (res.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: res.content });
      const results = [];
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue;
        let out;
        try {
          const input = typeof b.input === 'string' ? JSON.parse(b.input) : b.input;
          const domain = String(input.entity_id || '').split('.')[0];
          await this.ha.call(domain, input.service, input.entity_id);
          actions.push({ entity: input.entity_id, service: `${domain}.${input.service}` });
          out = { content: 'Ausgeführt.' };
        } catch (e) {
          out = { content: `Fehler: ${e.message}`, is_error: true };
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, ...out });
      }
      messages.push({ role: 'user', content: results });
    }

    reply ||= 'Erledigt.';
    this.recent.push({ q: question, a: reply });
    if (this.recent.length > 3) this.recent.shift();
    return { reply, source: 'ki', actions };
  }
}

module.exports = { Assistant };
