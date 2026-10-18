// Barramento de eventos em memória para SSE. O estado oficial está no banco; a interface também consulta por polling,
// o que mantém o acompanhamento correto mesmo quando o worker roda em outro processo.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

export function emit(runId, event) {
  if (!runId) return;
  bus.emit(`run:${runId}`, { ...event, at: new Date().toISOString() });
  bus.emit('any', { runId, ...event });
}
