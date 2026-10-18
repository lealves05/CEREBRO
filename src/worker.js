// Worker separado (opcional): execute com LORLER_WORKER_IN_PROCESS=false no servidor e `npm run worker` em outro terminal.
// Fechar o painel ou reiniciar o servidor não cancela análises: o estado está no banco e os leases são recuperados.
import { openDb } from './db.js';
import { ensureSeed } from './seed.js';
import { startWorker } from './orchestrator/engine.js';

openDb();
ensureSeed();
startWorker({ concurrency: 2 });
