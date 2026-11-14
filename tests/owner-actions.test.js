// Acesso total do dono pelo WhatsApp/voz: atalhos, ações do Master com SIM e a IA escolhendo ações.
import './env-master.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const FILA = fs.mkdtempSync(path.join(os.tmpdir(), 'fila-own-'));
process.env.LORLER_SOCIAL_FILA = FILA;
const { orgA, createUser, stopServer } = await import('./helpers.js');
const owner = await import('../src/services/owner-actions.js');
const ownerId = createUser(orgA, 'own.owner@lorler.test', 'owner');
after(() => { stopServer(); fs.rmSync(FILA, { recursive: true, force: true }); });
const ctx = { orgId: orgA, userId: ownerId, role: 'owner', channel: 'whatsapp', productIds: null };

test('atalhos: o pedido do Leandro vira conferência das redes e criação de post', () => {
  assert.equal(owner.quickIntent('verifique a conexão com as redes sociais se ja esta disponivel para publicarmos')?.nome, 'redes_status');
  assert.equal(owner.quickIntent('verifique a conexão com as redes sociais se ja esta disponivel para publicarmos e se conseguirmos gerar um post')?.nome, 'redes_e_post');
  assert.equal(owner.quickIntent('gere um post para o instagram sobre o ORBI')?.nome, 'criar_post');
  assert.equal(owner.quickIntent('quero postar no linkedin amanhã')?.nome, 'criar_post');
  assert.equal(owner.quickIntent('empresas em teste')?.args.filtro, 'teste');
  assert.equal(owner.quickIntent('bom dia'), null);
});

test('redes: lê o status.json do publicador', async () => {
  fs.writeFileSync(path.join(FILA, 'status.json'), JSON.stringify({ rodou_em: new Date().toISOString(), credenciais: true, drive: false, redes: ['facebook', 'instagram'] }));
  const r = await owner.perform(ctx, 'redes_status', {});
  assert.match(r.reply, /Prontas para publicar: Facebook, Instagram/i);
  assert.match(r.reply, /Faltam: TikTok, LinkedIn/i);
});

test('o pedido completo: confere as redes e já deixa um post pronto com código de aprovação', async () => {
  const r = await owner.perform(ctx, 'redes_e_post', {}, 'verifique a conexão com as redes sociais e gere um post');
  assert.match(r.reply, /Prontas para publicar/);
  assert.match(r.reply, /Deixei pronto/);
  assert.match(r.reply, /APROVAR M[A-Z0-9]{5}/);
});

test('mudança no Master pede SIM e só executa depois', async () => {
  const calls = [];
  owner.hooks.master = async (p, o = {}) => { calls.push([p, o.method || 'GET', o.body]); if (p.startsWith('/tenants?q=')) return [{ id: '11111111-1111-1111-1111-111111111111', name: 'Ateliê Bela', product: 'orbi', status: 'TRIAL' }]; return { ok: true }; };
  const ask = await owner.perform(ctx, 'empresa_prorrogar_teste', { empresa: 'Ateliê Bela', dias: 15 });
  assert.match(ask.reply, /Confirma prorrogar o teste de Ateliê Bela por 15 dias/);
  assert.equal(calls.length, 0);
  const done = await owner.confirmPending(ctx, 'sim');
  assert.match(done.reply, /prorrogado por 15 dias/);
  assert.deepEqual(calls.at(-1), ['/tenants/11111111-1111-1111-1111-111111111111/trial', 'POST', { action: 'extend', days: 15, reason: 'Pedido do dono pelo Cérebro' }]);
  await owner.perform(ctx, 'empresa_bloquear', { empresa: 'Ateliê Bela' });
  assert.match((await owner.confirmPending(ctx, 'não')).reply, /não fiz nada/);
  assert.equal(await owner.confirmPending(ctx, 'sim'), null);
});

test('leitura do Master sai na hora', async () => {
  owner.hooks.master = async () => [{ id: 'x', name: 'Oficina do Zé', product: 'torven', status: 'TRIAL', trial_type: '15_DAYS', trial_ends_at: '2026-11-20T12:00:00Z', plan_name: 'Essencial' }];
  const r = await owner.perform(ctx, 'empresas', { filtro: 'teste' });
  assert.match(r.reply, /Oficina do Zé \(TORVEN\) — em teste, Essencial, teste até 20\/11\/2026/);
});

test('imagem promocional: gera a arte, guarda e deixa o post pronto com código', async () => {
  assert.equal(owner.quickIntent('vc consegue gerar uma imagem prmocional do orbi?')?.nome, 'gerar_imagem');
  assert.equal(owner.quickIntent('faz uma arte do torven')?.args.sistema, 'TORVEN');
  const promo = await import('../src/services/promo-image.js');
  promo.imgHooks.fetch = async () => new Response('x', { status: 404 });
  const svg = promo.buildSvg({ sistema: 'ORBI', titulo: 'Sua agenda mora no WhatsApp?', apoio: 'Tudo num lugar só', cta: 'Teste grátis' });
  assert.match(svg, /<svg[^>]+1080/); assert.match(svg, /Sua agenda/);
  const r = await owner.perform({ ...ctx, channel: 'voz' }, 'gerar_imagem', { sistema: 'ORBI' });
  if (/Não consegui montar/.test(r.reply)) return; // sem rsvg-convert e sem internet neste ambiente
  assert.match(r.reply, /Arte pronta: https?:\/\/.+\/api\/public\/midia\/[a-f0-9]{32}\.png/);
  assert.match(r.reply, /APROVAR M[A-Z0-9]{5}/);
});

test('quem não é dono não usa o atalho', () => { assert.equal(owner.isOwner({ ...ctx, role: 'analyst' }), false); });
