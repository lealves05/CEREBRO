// Backup consistente do banco SQLite (VACUUM INTO). Restauração: pare o servidor e substitua data/lorler.db pelo arquivo de backup.
import path from 'node:path';
import fs from 'node:fs';
import { openDb, getDb } from '../src/db.js';
import { ROOT } from '../src/config.js';

openDb();
const dir = path.join(ROOT, 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `lorler-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log('Backup criado em', file);
