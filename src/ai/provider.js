// Interface interna de provedores de IA (adaptador substituível).
// type ModelRequest = { agentCode, kind, instructions, input, schemaName, outputSchema, maxOutputTokens, timeoutMs, model }
// type ModelResponse = { status: 'ok'|'refused'|'invalid_output'|'error', output?, providerRequestId?, usage?: {inputTokens, outputTokens}, error? }
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../config.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { DemoAdapter } from './demo.js';
import { platform } from '../platform.js';

// Somente para testes automatizados: permite injetar um adaptador controlado.
export const providerRegistry = { override: null };

export function getProvider(name = config.ai.provider) {
  if (providerRegistry.override) return providerRegistry.override;
  switch (name) {
    case 'openai': return new OpenAIAdapter(config.ai);
    case 'anthropic': return new AnthropicAdapter(config.ai);
    default: return new DemoAdapter();
  }
}

export function modelFor(agentCode) {
  return config.ai.modelByAgent[agentCode] || config.ai.model || '';
}

// Preços nunca ficam no código: config/pricing.json (versionado pelo administrador).
export function priceUsage(model, usage) {
  try {
    const p = platform.pricing || JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pricing.json'), 'utf8'));
    const m = p.models?.[model];
    if (!m || !usage) return { amount: null, currency: null, version: p.pricing_version || null };
    const amount = (usage.inputTokens * m.input_per_million + usage.outputTokens * m.output_per_million) / 1e6;
    return { amount: amount.toFixed(6), currency: p.currency || 'USD', version: p.pricing_version };
  } catch {
    return { amount: null, currency: null, version: null };
  }
}

export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { return null; }
}
