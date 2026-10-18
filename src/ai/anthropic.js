// Adaptador Anthropic (Claude) — Messages API usando ferramenta obrigatória para saída estruturada.
// Conferir a documentação oficial vigente antes de produção: https://docs.claude.com
export class AnthropicAdapter {
  constructor(cfg) { this.cfg = cfg; this.name = 'anthropic'; }

  async validateConfiguration() {
    if (!this.cfg.anthropicKey) return { valid: false, reason: 'ANTHROPIC_API_KEY não definida no .env do servidor.' };
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
      const res = await fetch(`${this.cfg.anthropicBase}/messages`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'x-api-key': this.cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.instructions,
          messages: [{ role: 'user', content: JSON.stringify(req.input) }],
          tools: [{ name: req.schemaName, description: 'Registrar o parecer estruturado', input_schema: req.outputSchema }],
          tool_choice: { type: 'tool', name: req.schemaName },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'error', error: `Anthropic HTTP ${res.status}: ${data?.error?.message?.slice(0, 200) || 'erro'}` };
      const usage = data.usage ? { inputTokens: data.usage.input_tokens || 0, outputTokens: data.usage.output_tokens || 0 } : undefined;
      if (data.stop_reason === 'refusal') return { status: 'refused', usage, providerRequestId: data.id };
      if (data.stop_reason === 'max_tokens') return { status: 'invalid_output', usage, providerRequestId: data.id, error: 'Saída incompleta' };
      const tool = (data.content || []).find((c) => c.type === 'tool_use');
      if (!tool?.input) return { status: 'invalid_output', usage, providerRequestId: data.id, error: 'Sem saída estruturada' };
      return { status: 'ok', output: tool.input, usage, providerRequestId: data.id };
    } catch (e) {
      return { status: 'error', error: e.name === 'AbortError' ? 'Tempo limite do provedor excedido' : 'Falha de rede com o provedor' };
    } finally { clearTimeout(timer); }
  }
}
