// Sincroniza o cofre do Cérebro (JARVIS) com uma pasta do PC — abra a pasta no Obsidian como cofre.
//   node scripts/cofre-sync.js [--dir "D:\Programacao\Cofre-Cerebro"] [--url https://cerebro.lorler.com.br] [--watch]
// 1) manda para o Cérebro as notas que você editou no Obsidian desde a última sincronização;
// 2) baixa tudo o que o Cérebro escreveu (conversas, diário, resumos, memórias).
// O token pessoal fica em data/cofre-token.txt (gerado no painel: HUD › Cofre › "Obsidian no PC").
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const DIR = path.resolve(arg('dir', path.join(ROOT, '..', 'Cofre-Cerebro')));
const URL_BASE = (arg('url', process.env.LORLER_PUBLIC_URL || 'https://cerebro.lorler.com.br')).replace(/\/+$/, '');
const TOKEN_FILE = path.join(ROOT, 'data', 'cofre-token.txt');
const STATE = path.join(DIR, '.cerebro-sync.json');
const FOLDERS = ['raw', 'wiki', 'outputs', 'diario'];

async function token() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nPrimeira vez: no Cérebro abra o HUD › Cofre › "Obsidian no PC" e copie o token.');
  const t = (await rl.question('Cole o token aqui: ')).trim(); rl.close();
  if (!/^cv_[A-Za-z0-9_-]{20,80}$/.test(t)) throw new Error('Token inválido.');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, t);
  return t;
}

async function call(tok, method, p, body) {
  const r = await fetch(`${URL_BASE}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { try { fs.unlinkSync(TOKEN_FILE); } catch { /* */ } throw new Error('Token recusado. Gere um novo no painel e rode de novo.'); }
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

function localFiles() {
  const out = [];
  for (const f of FOLDERS) {
    const d = path.join(DIR, f); if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) if (name.endsWith('.md')) { const full = path.join(d, name); out.push({ rel: `${f}/${name}`, full, mtime: fs.statSync(full).mtimeMs }); }
  }
  return out;
}

async function syncOnce(tok) {
  fs.mkdirSync(DIR, { recursive: true });
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { last: 0 };
  // 1) sobe o que mudou no Obsidian
  const changed = localFiles().filter((f) => f.mtime > (st.last || 0) + 1500);
  let up = { created: 0, updated: 0 };
  if (changed.length && st.last) {
    for (let i = 0; i < changed.length; i += 100) {
      const r = await call(tok, 'POST', '/api/vault/sync/files', { files: changed.slice(i, i + 100).map((f) => ({ path: f.rel, content: fs.readFileSync(f.full, 'utf8'), mtime: new Date(f.mtime).toISOString() })) });
      up.created += r.created; up.updated += r.updated;
    }
  }
  // 2) baixa o cofre inteiro
  const { files } = await call(tok, 'GET', '/api/vault/sync/files');
  let down = 0;
  for (const f of files) {
    const full = path.join(DIR, ...f.path.split('/'));
    const prev = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (prev !== f.content) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, f.content); down++; }
    const t = new Date(f.updated_at); try { fs.utimesSync(full, t, t); } catch { /* */ }
  }
  fs.writeFileSync(STATE, JSON.stringify({ last: Date.now(), url: URL_BASE }, null, 2));
  console.log(`${new Date().toLocaleTimeString('pt-BR')}  enviadas ${up.created + up.updated} · baixadas ${down} · total ${files.length - 1} notas  →  ${DIR}`);
}

const tok = await token();
await syncOnce(tok);
if (process.argv.includes('--watch')) { console.log('Sincronizando a cada 60 s (feche a janela para parar)...'); setInterval(() => syncOnce(tok).catch((e) => console.error('Falha:', e.message)), 60_000); }
