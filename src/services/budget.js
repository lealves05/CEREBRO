// Orçamento técnico (tokens de IA) com reserva transacional antes da execução e conciliação ao final.
// Orçamento empresarial (descontos/campanhas) é tratado pelo motor de políticas — são orçamentos separados.
import { q, insert, uuid, now, addMs, tx } from '../db.js';
import { errors } from '../lib/util.js';

function monthStart() { const d = new Date(); d.setUTCDate(1); d.setUTCHours(3, 0, 0, 0); return d.toISOString(); }

export function tokensCommitted(orgId) {
  const r = q.get(`SELECT
      COALESCE(SUM(CASE WHEN status = 'active' AND expires_at > ? THEN CAST(reserved_amount AS INTEGER) ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN CAST(actual_amount AS INTEGER) ELSE 0 END), 0) AS settled
    FROM budget_reservations WHERE organization_id = ? AND type = 'technical_tokens' AND created_at >= ?`, now(), orgId, monthStart());
  return { active: Number(r.active), settled: Number(r.settled) };
}

export function reserveTokens(orgId, runId, amount, monthlyBudget) {
  return tx(() => {
    const existing = q.get("SELECT id FROM budget_reservations WHERE run_id = ? AND type = 'technical_tokens' AND status = 'active'", runId);
    if (existing) return existing.id;
    const c = tokensCommitted(orgId);
    if (c.active + c.settled + amount > monthlyBudget) {
      throw errors.limit(`Orçamento técnico mensal insuficiente (${c.active + c.settled} de ${monthlyBudget} tokens comprometidos).`);
    }
    const id = uuid();
    insert('budget_reservations', { id, organization_id: orgId, run_id: runId, type: 'technical_tokens', reserved_amount: String(amount), actual_amount: '0', currency: 'tokens', status: 'active', expires_at: addMs(2 * 3600_000), created_at: now() });
    return id;
  });
}

export function settleTokens(runId) {
  const used = q.get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM usage_records WHERE run_id = ?', runId).t;
  q.run("UPDATE budget_reservations SET status = 'settled', actual_amount = ? WHERE run_id = ? AND type = 'technical_tokens' AND status = 'active'", String(used), runId);
  return used;
}

export function runTokensUsed(runId) {
  return q.get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM usage_records WHERE run_id = ?', runId).t;
}
