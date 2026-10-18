// Trilha de auditoria — somente inclusão (triggers no banco bloqueiam UPDATE/DELETE).
// Nunca registrar segredos ou dados pessoais desnecessários em metadata.
import { insert, uuid, now } from '../db.js';

const SECRET_KEYS = /pass(word)?|secret|token|api[_-]?key|authorization|cookie/i;

function scrub(obj, depth = 0) {
  if (obj === null || typeof obj !== 'object' || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.test(k) ? '[removido]' : scrub(v, depth + 1);
  }
  return out;
}

export function audit({ orgId = null, actorType = 'system', actorId = null, event, objectType = null, objectId = null, requestId = null, metadata = {} }) {
  insert('audit_events', {
    id: uuid(),
    organization_id: orgId,
    actor_type: actorType,
    actor_id: actorId,
    event_type: event,
    object_type: objectType,
    object_id: objectId,
    request_id: requestId,
    metadata: scrub(metadata),
    created_at: now(),
  });
}
