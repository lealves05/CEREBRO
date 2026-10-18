// Agente de Marketing + vinculação e publicação no Instagram (API simulada — nenhuma chamada real é feita).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { orgA, createUser, login, stopServer, createDecision, q } from './helpers.js';
import { igHooks } from '../src/connectors/instagram.js';

createUser(orgA, 'owner@lorler.test', 'owner');
createUser(orgA, 'manager@lorler.test', 'manager');
after(() => stopServer());

const TOKEN = 'IGAA-token-de-teste-1234567890abcdef';
const calls = [];
let mode = 'ok';
const published = [];
igHooks.sleep = async () => {};
igHooks.fetch = async (url, opts = {}) => {
  const u = new URL(url); const path = u.pathname; const method = opts.method || 'GET';
  const body = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
  calls.push({ method, path });
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (path.endsWith('/access_token')) return json({ error: { message: 'token já é de longa duração' } }, 400);
  if (path.endsWith('/me')) return json(mode === 'personal' ? { user_id: '999', username: 'pessoal', account_type: 'PERSONAL' } : { user_id: '1784', username: 'lorler.sistemas', account_type: 'BUSINESS' });
  if (path.endsWith('/1784/media') && method === 'POST') { assert.equal(body.access_token, TOKEN); return json({ id: 'container-1' }); }
  if (path.endsWith('/1784/media') && method === 'GET') return json({ data: published.map((p) => ({ id: p.id, caption: p.caption, timestamp: new Date().toISOString(), permalink: `https://instagram.com/p/${p.id}` })) });
  if (path.endsWith('/container-1')) return json({ status_code: 'FINISHED' });
  if (path.endsWith('/1784/media_publish')) {
    if (mode === 'timeout') { published.push({ id: 'media-timeout', caption: lastCaption }); throw Object.assign(new Error('abort'), { name: 'AbortError' }); }
    published.push({ id: `media-${published.length + 1}`, caption: lastCaption });
    return json({ id: `media-${published.length}` });
  }
  if (path.includes('/media-')) return json({ permalink: `https://instagram.com/p/${path.split('/').pop()}` });
  if (path.endsWith('/content_publishing_limit')) return json({ data: [{ quota_usage: 0 }] });
  return json({ error: { message: `rota não simulada ${path}` } }, 404);
};
let lastCaption = '';
const origFetch = igHooks.fetch;
igHooks.fetch = async (url, opts = {}) => {
  if (opts.body) { const b = Object.fromEntries(new URLSearchParams(opts.body)); if (b.caption) lastCaption = b.caption; }
  return origFetch(url, opts);
};

async function marketingDecision(owner, text = 'Crie um post para o Instagram divulgando o ORBI') {
  const d = await createDecision(owner, text);
  const det = (await owner.call('GET', `/api/decisions/${d.decision_id}`)).body;
  return { d, det: det.current, decision: det.decision };
}

test('pergunta de marketing aciona o Agente de Marketing com revisão cruzada e gera proposta de publicação', async () => {
  const owner = await login('owner@lorler.test');
  const { det } = await marketingDecision(owner);
  const agents = new Set(det.tasks.map((t) => t.agent_code));
  assert.ok(agents.has('marketing'));
  const mkOpinion = det.tasks.find((t) => t.agent_code === 'marketing' && t.kind === 'opinion');
  assert.ok(mkOpinion.output.content_draft.caption.length > 20);
  assert.ok(det.messages.some((m) => m.type === 'challenge' && m.recipient_code === 'marketing'));
  assert.ok(det.messages.some((m) => m.type === 'revision' && m.sender_code === 'marketing'));
  const p = det.proposals.at(-1);
  assert.equal(p.tool_code, 'publish_instagram_post');
  assert.equal(p.status, 'awaiting_approval');
  assert.match(p.parameters.caption, /#orbi/);
  assert.equal(p.parameters.image_url, '');
  const conteudo = p.evaluations[0].checks.find((c) => c.check === 'conteudo');
  assert.equal(conteudo.ok, false);
});

test('não aprova sem imagem; edição do conteúdo gera nova versão e invalida o hash anterior', async () => {
  const owner = await login('owner@lorler.test');
  const { det } = await marketingDecision(owner);
  const p1 = det.proposals.at(-1);
  const r0 = await owner.call('POST', `/api/actions/${p1.id}/approve`, { proposal_version: p1.version, payload_hash: p1.payload_hash });
  assert.equal(r0.status, 409);
  const manager = await login('manager@lorler.test');
  const rm = await manager.call('POST', `/api/actions/${p1.id}/revise-content`, { proposal_version: p1.version, image_url: 'https://cdn.exemplo.com/post.jpg' });
  assert.equal(rm.status, 200, 'manager pode editar conteúdo (aprovação continua exigindo owner)');
  const r1 = await owner.call('POST', `/api/actions/${p1.id}/approve`, { proposal_version: p1.version, payload_hash: p1.payload_hash });
  assert.equal(r1.status, 409, 'versão antiga não pode mais ser aprovada');
  const r2 = await owner.call('POST', `/api/actions/${p1.id}/revise-content`, { proposal_version: p1.version, image_url: 'http://inseguro.com/a.jpg' });
  assert.ok([400, 409].includes(r2.status));
  const v2 = q.get('SELECT * FROM action_proposals WHERE id = ?', rm.body.proposal_id);
  assert.equal(v2.version, p1.version + 1);
  assert.notEqual(v2.payload_hash, p1.payload_hash);
  const mgrApprove = await manager.call('POST', `/api/actions/${v2.id}/approve`, { proposal_version: v2.version, payload_hash: v2.payload_hash });
  assert.equal(mgrApprove.status, 403, 'publicação exige owner');
});

test('aprovada sem conta vinculada: executor bloqueia sem publicar', async () => {
  const owner = await login('owner@lorler.test');
  const { det } = await marketingDecision(owner);
  const p1 = det.proposals.at(-1);
  const v = (await owner.call('POST', `/api/actions/${p1.id}/revise-content`, { proposal_version: p1.version, image_url: 'https://cdn.exemplo.com/a.jpg' })).body;
  q.run("UPDATE sessions SET last_reauth_at = ?", new Date().toISOString());
  const r = await owner.call('POST', `/api/actions/${v.proposal_id}/approve`, { proposal_version: v.version, payload_hash: v.payload_hash });
  assert.equal(r.status, 200);
  assert.equal(r.body.execution.status, 'blocked');
  assert.ok(r.body.execution.reasons.some((x) => /não vinculada/.test(x)));
  assert.ok(!calls.some((c) => c.path.endsWith('/media_publish')));
});

test('conta pessoal é recusada; conta profissional é vinculada com token criptografado', async () => {
  const owner = await login('owner@lorler.test');
  q.run("UPDATE sessions SET last_reauth_at = ?", new Date().toISOString());
  mode = 'personal';
  const bad = await owner.call('POST', '/api/social/instagram/token', { access_token: TOKEN });
  assert.equal(bad.status, 400);
  mode = 'ok';
  const ok = await owner.call('POST', '/api/social/instagram/token', { access_token: TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.username, 'lorler.sistemas');
  const row = q.get("SELECT token_ciphertext FROM social_accounts WHERE organization_id = ?", orgA);
  assert.ok(!row.token_ciphertext.includes(TOKEN), 'token não fica em texto puro');
  const st = (await owner.call('GET', '/api/social/instagram')).body;
  assert.ok(!JSON.stringify(st).includes(TOKEN), 'token nunca vai ao navegador');
});

test('publica o conteúdo exato aprovado uma única vez (proposta bloqueada é executável após vincular)', async () => {
  const owner = await login('owner@lorler.test');
  const blocked = q.get("SELECT id FROM action_proposals WHERE tool_code = 'publish_instagram_post' AND status = 'approved' ORDER BY created_at DESC LIMIT 1");
  const r = await owner.call('POST', `/api/actions/${blocked.id}/execute`, {});
  assert.equal(r.body.status, 'succeeded');
  const p = q.get('SELECT parameters FROM action_proposals WHERE id = ?', blocked.id);
  assert.equal(lastCaption, JSON.parse(p.parameters).caption, 'legenda publicada = legenda aprovada');
  const again = await owner.call('POST', `/api/actions/${blocked.id}/execute`, {});
  assert.equal(again.status, 409);
  assert.equal(calls.filter((c) => c.path.endsWith('/media_publish')).length, 1);
});

test('timeout na publicação gera resultado incerto e a conciliação encontra o post', async () => {
  const owner = await login('owner@lorler.test');
  const { det } = await marketingDecision(owner, 'Crie um post para o Instagram divulgando o RUSTEN');
  const p1 = det.proposals.at(-1);
  const v = (await owner.call('POST', `/api/actions/${p1.id}/revise-content`, { proposal_version: p1.version, image_url: 'https://cdn.exemplo.com/b.jpg' })).body;
  q.run("UPDATE sessions SET last_reauth_at = ?", new Date().toISOString());
  mode = 'timeout';
  const r = await owner.call('POST', `/api/actions/${v.proposal_id}/approve`, { proposal_version: v.version, payload_hash: v.payload_hash });
  mode = 'ok';
  assert.equal(r.body.execution.status, 'uncertain');
  const rec = await owner.call('POST', `/api/actions/${v.proposal_id}/reconcile`, {});
  assert.equal(rec.body.status, 'succeeded');
  const ex = q.get('SELECT external_ref FROM action_executions WHERE action_proposal_id = ?', v.proposal_id);
  assert.equal(ex.external_ref, 'media-timeout');
});

test('retorno OAuth com state inválido não vincula conta', async () => {
  const { startServer } = await import('./helpers.js');
  const b = await startServer();
  const r = await fetch(`${b}/api/social/instagram/callback?code=abc&state=forjado`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /ig=erro/);
});
