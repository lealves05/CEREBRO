// Adaptador OpenAI — Responses API com saída estruturada (json_schema strict).
// Conferir a documentação oficial vigente antes de produção: https://developers.openai.com/api/docs/guides/structured-outputs
import { extractJson } from './provider.js';

export class OpenAIAdapter {
  constructor(cfg) { this.cfg = cfg; this.name = 'openai'; }

  async validateConfiguration() {
    if (!this.cfg.openaiKey) return { valid: false, reason: 'OPENAI_API_KEY não definida no .env do servidor.' };
    if (!this.cfg.model && !Object.values(this.cfg.modelByAgent).some(Boolean)) return { valid: false, reason: 'Defina LORLER_AI_MODEL (ou o modelo por agente).' };
    return { valid: true };
  }

  async analyze(req) {
    const v = await this.validateConfiguration();
    if (!v.valid) return { status: 'error', error: v.reason };
    if (!req.model) return { status: 'error', error: 'Modelo não configurado para este agente.' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs || this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.openaiBase}/responses`, {
        method: 'POST',
        signal: ac.signal,
        headers: { Authorization: `Bearer ${this.cfg.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          instructions: req.instructions,
          input: JSON.stringify(req.input),
          max_output_tokens: req.maxOutputTokens,
          store: false,
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.outputSchema, strict: true } },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'error', error: `OpenAI HTTP ${res.status}: ${data?.error?.message?.slice(0, 200) || 'erro'}` };
      const usage = data.usage ? { inputTokens: data.usage.input_tokens || 0, outputTokens: data.usage.output_tokens || 0 } : undefined;
      const content = (data.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
      if (content.some((c) => c.type === 'refusal')) return { status: 'refused', usage, providerRequestId: data.id };
      if (data.status === 'incomplete') return { status: 'invalid_output', usage, providerRequestId: data.id, error: 'Saída incompleta' };
      const text = content.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      const output = extractJson(text);
      if (!output) return { status: 'invalid_output', usage, providerRequestId: data.id, error: 'JSON inválido' };
      return { status: 'ok', output, usage, providerRequestId: data.id };
    } catch (e) {
      return { status: 'error', error: e.name === 'AbortError' ? 'Tempo limite do provedor excedido' : 'Falha de rede com o provedor' };
    } finally { clearTimeout(timer); }
  }
}
