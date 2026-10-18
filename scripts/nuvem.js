// Publica a Central de Decisões no Cloudflare (Worker + Durable Object) e leva os dados do PC para a nuvem.
// Uso:  node scripts/nuvem.js publicar            (fluxo completo — chamado pelo PUBLICAR-CEREBRO-NUVEM.bat)
//       node scripts/nuvem.js exportar <arquivo>   (só gera o snapshot JSON do banco local)
//       node scripts/nuvem.js importar <url> <token> [arquivo]
//       node scripts/nuvem.js trazer [arquivo]          (mudança para a VPS: atualiza o Worker, congela a nuvem e baixa
//                                                       todos os dados para data/nuvem-export.json)
//       node scripts/nuvem.js descongelar             (desfaz o congelamento se a mudança for cancelada)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'nuvem.json');
const HOSTNAME = process.env.LORLER_HOSTNAME || 'cerebro.lorler.com.br';
const WRANGLER = 'wrangler@4.149.0';
const IS_WIN = process.platform === 'win32';

// Variáveis que só fazem sentido no PC ou já estão fixas no wrangler.jsonc (não viram segredo na nuvem)
const LOCAL_ONLY = new Set(['PORT', 'HOST', 'LORLER_DB_FILE', 'LORLER_WORKER_IN_PROCESS', 'LORLER_INBOX_DIR', 'LORLER_INBOX_INTERVAL_MS',
  'LORLER_CONNECTOR_ALLOW_LOCALHOST', 'LORLER_DEMO_FAST']);
const CONFIG_VARS = new Set(['LORLER_ENV', 'LORLER_COOKIE_SECURE', 'LORLER_TRUST_PROXY', 'LORLER_PUBLIC_URL', 'LORLER_DEMO_MODE']);

const c = { ok: (t) => console.log(`  \x1b[32m[ok]\x1b[0m ${t}`), warn: (t) => console.log(`  \x1b[33m[!]\x1b[0m ${t}`), step: (t) => console.log(`\n\x1b[36m== ${t} ==\x1b[0m`) };

function readEnvFile() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const dbPath = (env) => { const f = process.env.LORLER_DB_FILE || env.LORLER_DB_FILE; return f ? path.resolve(ROOT, f) : path.join(DATA, 'lorler.db'); };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };

/** Snapshot do banco local: todas as tabelas, na ordem em que foram criadas (respeita chaves estrangeiras). */
export function exportSnapshot(dbFile) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('BEGIN');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY rowid").all().map((r) => r.name);
    const tables = names.map((name) => ({
      name,
      rows: db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all().map((row) => {
        const o = {};
        for (const [k, v] of Object.entries(row)) o[k] = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? Number(v) : v;
        return o;
      }),
    }));
    db.exec('COMMIT');
    return { exported_at: new Date().toISOString(), source: os.hostname(), tables };
  } finally { db.close(); }
}

export async function postSnapshot(baseUrl, token, snap) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/admin/import-snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-import-token': token }, body: JSON.stringify(snap),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---------- Wrangler (ferramenta oficial da Cloudflare) ----------
// Não usa o "npx" do sistema: em alguns PCs o npm global fica corrompido (erro "Cannot find module './inventory.js'").
// Procura um npm que funcione (o que vem junto com o Node.js tem prioridade), instala o Wrangler dentro da pasta
// tools\wrangler do projeto e roda direto com o node — sem shell.
const WRANGLER_DIR = path.join(ROOT, 'tools', 'wrangler');
const WRANGLER_BIN = path.join(WRANGLER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let wranglerBin = null;

function npmCandidates() {
  const nodeDir = path.dirname(process.execPath);
  const list = [
    { nome: 'npm do Node.js', cli: path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js') },
    { nome: 'npm global', cli: process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : '' },
    { nome: 'npm do sistema', cli: path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') },
  ];
  return list.filter((c) => c.cli && fs.existsSync(c.cli));
}
const npmWorks = (cli) => { const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

function repairGlobalNpm(good) {
  const broken = npmCandidates().find((x) => x.nome === 'npm global' && !npmWorks(x.cli));
  if (!broken || !good) return;
  c.warn('O npm global deste PC está corrompido (por isso o "npx" falhava). Reinstalando…');
  const r = spawnSync(process.execPath, [good.cli, 'install', '-g', `npm@${good.versao}`, '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit' });
  if (r.status === 0 && npmWorks(broken.cli)) c.ok(`npm global reparado (versão ${good.versao})`);
  else c.warn('Não consegui reparar o npm global — sem problema, a publicação usa o npm do Node.js.');
}

function ensureWrangler() {
  if (wranglerBin) return wranglerBin;
  if (fs.existsSync(WRANGLER_BIN)) return (wranglerBin = WRANGLER_BIN);
  let good = null;
  for (const cand of npmCandidates()) { const v = npmWorks(cand.cli); if (v) { good = { ...cand, versao: v }; break; } }
  if (!good) throw new Error('Nenhum npm funcionando neste PC. Reinstale o Node.js 22 LTS (https://nodejs.org) e rode de novo.');
  c.ok(`Usando ${good.nome} ${good.versao}`);
  repairGlobalNpm(good);
  c.warn('Instalando o Wrangler (ferramenta da Cloudflare) na pasta tools\\wrangler — só na primeira vez, leva 1 a 2 minutos…');
  fs.mkdirSync(WRANGLER_DIR, { recursive: true });
  if (!fs.existsSync(path.join(WRANGLER_DIR, 'package.json'))) fs.writeFileSync(path.join(WRANGLER_DIR, 'package.json'), JSON.stringify({ name: 'lorler-wrangler', private: true }, null, 2));
  const r = spawnSync(process.execPath, [good.cli, 'install', WRANGLER, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: WRANGLER_DIR, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(WRANGLER_BIN)) throw new Error('Falha ao instalar o Wrangler. Verifique a internet e rode de novo (detalhes acima).');
  c.ok('Wrangler instalado');
  return (wranglerBin = WRANGLER_BIN);
}

function wrangler(args, { capture = false, input, env } = {}) {
  const bin = ensureWrangler();
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: ROOT, encoding: 'utf8', input,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function waitHealthy(baseUrl, { tries = 40, wantCloud = true } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, { cache: 'no-store' });
      if (res.ok && (!wantCloud || res.headers.get('x-lorler-runtime') === 'cloudflare')) return true;
    } catch { /* DNS do workers.dev pode levar alguns segundos */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function deployArgs(env, withRoute) {
  const demo = String(env.LORLER_DEMO_MODE ?? 'true').toLowerCase() === 'false' ? 'false' : 'true';
  const a = ['deploy', '--var', `LORLER_DEMO_MODE:${demo}`, '--var', `LORLER_PUBLIC_URL:https://${HOSTNAME}`];
  if (withRoute) a.push('--route', `${HOSTNAME}/*`);
  return a;
}

function deploy(env, withRoute) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorler-wr-'));
  const r = wrangler(deployArgs(env, withRoute), { env: { WRANGLER_OUTPUT_FILE_DIRECTORY: outDir } });
  let urls = [];
  try {
    for (const f of fs.readdirSync(outDir)) {
      for (const line of fs.readFileSync(path.join(outDir, f), 'utf8').split('\n')) {
        try { const j = JSON.parse(line); if (j.type === 'deploy' && Array.isArray(j.targets)) urls.push(...j.targets); } catch { /* */ }
      }
    }
  } catch { /* */ }
  fs.rmSync(outDir, { recursive: true, force: true });
  if (r.code !== 0) throw new Error('A publicação no Cloudflare falhou (veja as mensagens acima).');
  return urls.find((u) => /workers\.dev/.test(u)) || null;
}

function buildSecrets(env, state) {
  const s = {};
  for (const [k, v] of Object.entries(env)) if (v && !LOCAL_ONLY.has(k) && !CONFIG_VARS.has(k)) s[k] = v;
  if (!s.LORLER_ENCRYPTION_KEY) {
    const keyFile = path.join(DATA, 'lorler.key');
    if (fs.existsSync(keyFile)) s.LORLER_ENCRYPTION_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  }
  if (!s.LORLER_ENCRYPTION_KEY) {
    // O PC ainda não guardou nenhum token criptografado (a chave só é criada no primeiro uso):
    // gera a chave agora e grava em data\\lorler.key, para o PC e a nuvem usarem a mesma.
    const keyFile = path.join(DATA, 'lorler.key');
    const key = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
    s.LORLER_ENCRYPTION_KEY = key;
    c.ok('Chave de criptografia criada em data\\lorler.key (o PC ainda não tinha nenhum dado criptografado)');
  }
  s.LORLER_IMPORT_TOKEN = state.importToken || crypto.randomBytes(24).toString('base64url');
  s.LORLER_SETUP_TOKEN = crypto.randomBytes(18).toString('base64url');
  return s;
}

function powershell(cmd) {
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

async function publicar() {
  const env = readEnvFile();
  const state = readState();
  if (state.frozenAt) throw new Error(`O cérebro foi levado para a VPS em ${state.frozenAt}: publicar na nuvem de novo tiraria cerebro.lorler.com.br da VPS. Se a mudança foi cancelada, rode antes: node scripts\\nuvem.js descongelar`);
  const dbFile = dbPath(env);

  c.step('Ferramenta da Cloudflare');
  ensureWrangler();
  c.step('Conta Cloudflare');
  let who = wrangler(['whoami'], { capture: true });
  if (who.code !== 0 || /not authenticated|You are not/i.test(who.out)) {
    c.warn('Vai abrir o navegador para você autorizar o Wrangler na sua conta Cloudflare (a mesma do domínio lorler.com.br).');
    if (wrangler(['login']).code !== 0) throw new Error('Login no Cloudflare não concluído.');
    who = wrangler(['whoami'], { capture: true });
  }
  c.ok('Conectado ao Cloudflare');

  c.step('Publicando o cérebro (Worker + banco SQLite em Durable Object)');
  let url = deploy(env, !!state.routed);
  if (!url) url = state.workersDev || null;
  if (!url) {
    url = await ask('  Cole aqui o endereço *.workers.dev mostrado acima (ex.: https://cerebro-lorler.SEU.workers.dev): ');
  }
  url = url.replace(/\/+$/, '');
  state.workersDev = url; saveState(state);
  c.ok(`No ar em ${url}`);

  c.step('Enviando chaves e credenciais como segredos (criptografados no Cloudflare)');
  const secrets = buildSecrets(env, state);
  const secFile = path.join(DATA, `.nuvem-segredos-${process.pid}.json`);
  fs.writeFileSync(secFile, JSON.stringify(secrets), { mode: 0o600 });
  try {
    const r = wrangler(['secret', 'bulk', secFile]);
    if (r.code !== 0) throw new Error('Falha ao gravar os segredos.');
  } finally { fs.rmSync(secFile, { force: true }); }
  state.importToken = secrets.LORLER_IMPORT_TOKEN; saveState(state);
  c.ok(`${Object.keys(secrets).length} segredos gravados`);

  c.step('Aguardando a nuvem responder');
  // depois da troca, o endereço oficial é o que importa; o workers.dev fica como reserva
  const alvos = state.routed ? [`https://${HOSTNAME}`, url] : [url];
  let ok = false;
  for (const alvo of alvos) { if (await waitHealthy(alvo, { tries: 20 })) { ok = true; c.ok(`Respondendo em ${alvo}`); break; } }
  if (!ok) throw new Error(`A nuvem não respondeu em ${alvos.join(' nem em ')}. Tente rodar de novo em alguns minutos.`);

  if (!state.importedAt) {
    c.step('Copiando os dados do PC para a nuvem');
    if (!fs.existsSync(dbFile)) throw new Error(`Banco local não encontrado em ${dbFile}`);
    const snap = exportSnapshot(dbFile);
    const total = snap.tables.reduce((a, t) => a + t.rows.length, 0);
    c.ok(`${snap.tables.length} tabelas, ${total} registros lidos do PC`);
    const r = await postSnapshot(url, secrets.LORLER_IMPORT_TOKEN, snap);
    if (r.status === 409) c.warn('A nuvem já tinha recebido os dados antes — mantendo o que está lá.');
    else if (r.status !== 200) throw new Error(`Importação recusada (${r.status}): ${r.body?.error || 'erro desconhecido'}`);
    else c.ok(`Dados importados (${r.body.users} usuário(s))`);
    state.importedAt = new Date().toISOString(); saveState(state);
  } else c.ok(`Dados já foram copiados em ${state.importedAt} — não copia de novo`);

  if (!state.routed) {
    c.step(`Apontando ${HOSTNAME} para a nuvem`);
    console.log(`  Teste agora no navegador: ${url}  (entre com o mesmo usuário e senha de sempre).`);
    const go = await ask(`  Tudo certo? Trocar ${HOSTNAME} para a nuvem agora? (S/N) `);
    if (!/^s/i.test(go)) { c.warn('Parado antes da troca. Rode o PUBLICAR-CEREBRO-NUVEM.bat de novo quando quiser concluir.'); return; }
    deploy(env, true);
    state.routed = true; saveState(state);
    if (await waitHealthy(`https://${HOSTNAME}`, { tries: 30 })) c.ok(`https://${HOSTNAME} agora é servido pela nuvem`);
    else c.warn(`https://${HOSTNAME} ainda não respondeu pela nuvem — a propagação pode levar alguns minutos.`);
  }

  if (IS_WIN) {
    c.step('Cérebro do PC');
    const off = await ask('  Desligar o cérebro e o túnel deste PC (não são mais necessários)? (S/N) ');
    if (/^s/i.test(off)) {
      powershell("foreach ($t in 'LORLER Cerebro Vigia','LORLER Cerebro Tunnel','LORLER Cerebro') { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue; Disable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null }; " +
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\\\/]server\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " +
        "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -match 'lorler-cerebro|cloudflared\\.yml' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }");
      c.ok('Tarefas do PC paradas e desativadas (para voltar: Enable-ScheduledTask nas tarefas "LORLER Cerebro*")');
    } else c.warn('O cérebro do PC continua ligado, mas o endereço público já aponta para a nuvem.');
  }

  console.log(`\n  \x1b[32mPronto!\x1b[0m Acesse https://${HOSTNAME} de qualquer lugar — o PC pode ficar desligado.`);
  console.log(`  Webhook do WhatsApp (Meta): https://${HOSTNAME}/api/whatsapp/webhook (mesmo endereço de antes).`);
}


// ---------- mudança para a VPS ----------
// 1) publica esta versão do Worker (traz a saída de dados), mantendo cerebro.lorler.com.br na nuvem enquanto ele ainda
//    estiver lá; 2) baixa todas as tabelas e CONGELA a nuvem (gravações recusadas com 503, fila parada), para nada ser
//    gravado na nuvem depois da cópia; 3) grava data/nuvem-export.json (só neste PC; vai para a VPS pelo VPS-MENU › C).
async function trazer(destino) {
  const env = readEnvFile();
  const state = readState();
  if (!state.importToken || !state.workersDev) throw new Error('Este PC não tem os dados da publicação na nuvem (data\\nuvem.json). Rode no PC que publicou o cérebro.');
  c.step('Ferramenta da Cloudflare');
  ensureWrangler();
  let who = wrangler(['whoami'], { capture: true });
  if (who.code !== 0 || /not authenticated|You are not/i.test(who.out)) {
    c.warn('Vai abrir o navegador para você autorizar o Wrangler na sua conta Cloudflare.');
    if (wrangler(['login']).code !== 0) throw new Error('Login no Cloudflare não concluído.');
  }
  // o endereço oficial ainda chega na nuvem? (depois da virada para a VPS, NÃO devolve a rota para a nuvem)
  let naNuvem = false;
  try { const r = await fetch(`https://${HOSTNAME}/healthz`, { cache: 'no-store' }); naNuvem = r.headers.get('x-lorler-runtime') === 'cloudflare'; } catch { /* */ }
  c.step(`Atualizando o Worker da nuvem (saída de dados)${naNuvem ? '' : ' — sem a rota, o endereço oficial já não está na nuvem'}`);
  deploy(env, naNuvem);
  const base = state.workersDev.replace(/\/+$/, '');
  if (!(await waitHealthy(base, { tries: 20 }))) throw new Error(`A nuvem não respondeu em ${base}/healthz.`);
  c.step('Baixando os dados e congelando a nuvem');
  let res = null;
  for (let i = 0; i < 10; i++) {
    res = await fetch(`${base}/api/admin/export-snapshot?congelar=1`, { headers: { 'x-import-token': state.importToken }, cache: 'no-store' }).catch(() => null);
    if (res && res.status !== 404) break; // 404: a versão nova ainda está se espalhando pela Cloudflare
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res || res.status !== 200) throw new Error(`A nuvem recusou a saída de dados (HTTP ${res ? res.status : 'sem resposta'}).`);
  const snap = await res.json();
  if (!Array.isArray(snap.tables)) throw new Error('Resposta da nuvem sem as tabelas.');
  const file = path.resolve(ROOT, destino || path.join('data', 'nuvem-export.json'));
  fs.writeFileSync(file, JSON.stringify(snap), { mode: 0o600 });
  const total = snap.tables.reduce((a, t) => a + t.rows.length, 0);
  const users = snap.tables.find((t) => t.name === 'users')?.rows.length ?? 0;
  c.ok(`${snap.tables.length} tabelas, ${total} registros (${users} usuário(s)) em ${file}`);
  c.ok(`Nuvem congelada desde ${snap.frozen_at} (só leitura). Para desfazer: node scripts\\nuvem.js descongelar`);
  state.exportedAt = snap.exported_at; state.frozenAt = snap.frozen_at; saveState(state);
  console.log('\n  Próximo passo: o VPS-MENU › C leva este arquivo, o .env e a chave para a VPS e liga o cérebro lá (se você veio por ele, ele continua sozinho).');
}

async function descongelar() {
  const state = readState();
  if (!state.importToken || !state.workersDev) throw new Error('Sem data\\nuvem.json neste PC.');
  const r = await fetch(`${state.workersDev.replace(/\/+$/, '')}/api/admin/unfreeze`, { method: 'POST', headers: { 'x-import-token': state.importToken } });
  if (r.status !== 200) throw new Error(`A nuvem recusou (HTTP ${r.status}).`);
  delete state.frozenAt; saveState(state);
  c.ok('Nuvem descongelada: volta a gravar normalmente.');
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'exportar') {
    const env = readEnvFile();
    const snap = exportSnapshot(dbPath(env));
    fs.writeFileSync(args[0] || 'snapshot.json', JSON.stringify(snap));
    console.log('Snapshot gravado:', args[0] || 'snapshot.json', snap.tables.map((t) => `${t.name}=${t.rows.length}`).join(' '));
  } else if (cmd === 'importar') {
    const [url, token, file] = args;
    const env = readEnvFile();
    const snap = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : exportSnapshot(dbPath(env));
    const r = await postSnapshot(url, token, snap);
    console.log(r.status, JSON.stringify(r.body));
    if (r.status !== 200) process.exitCode = 1;
  } else if (cmd === 'publicar') {
    await publicar();
  } else if (cmd === 'trazer') {
    await trazer(args[0]);
  } else if (cmd === 'descongelar') {
    await descongelar();
  } else {
    console.log('Uso: node scripts/nuvem.js publicar | exportar <arquivo> | importar <url> <token> [arquivo] | trazer [arquivo] | descongelar');
  }
} catch (e) {
  console.error(`\n  \x1b[31m[ERRO]\x1b[0m ${e.message}`);
  try { fs.appendFileSync(path.join(DATA, 'publicar-nuvem.log'), `[${new Date().toISOString()}] ${e.stack}\n`); } catch { /* */ }
  process.exitCode = 1;
}
