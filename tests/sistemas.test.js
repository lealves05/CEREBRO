// Todos os sistemas LORLER no cérebro: organizações antigas recebem ANIBI e CIFREN sozinhas, com escopo para quem via tudo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgA, createUser, q } from './helpers.js';
import { ensureProducts, SYSTEM_CODES } from '../src/seed.js';

test('os seis sistemas estão cadastrados', () => {
  assert.deepEqual(SYSTEM_CODES, ['ORBI', 'TORVEN', 'RUSTEN', 'APOLVEN', 'ANIBI', 'CIFREN']);
  const codes = q.all('SELECT code FROM products WHERE organization_id = ? ORDER BY code', orgA).map((r) => r.code);
  assert.deepEqual(codes, ['ANIBI', 'APOLVEN', 'CIFREN', 'ORBI', 'RUSTEN', 'TORVEN']);
});

test('organização antiga: sistema novo entra sozinho, com escopo para owner e para quem via tudo, não para escopo parcial', () => {
  const owner = createUser(orgA, 'sist.owner@lorler.test', 'owner');
  const full = createUser(orgA, 'sist.full@lorler.test', 'analyst');
  const part = createUser(orgA, 'sist.part@lorler.test', 'analyst', { products: false });
  const mem = (u) => q.get('SELECT id FROM organization_members WHERE user_id = ?', u).id;
  const orbi = q.get("SELECT id FROM products WHERE organization_id = ? AND code = 'ORBI'", orgA).id;
  q.run("INSERT INTO member_product_scopes (id, organization_id, member_id, product_id, permission, source_scope_ref) VALUES ('t-part', ?, ?, ?, 'read_aggregate', NULL)", orgA, mem(part), orbi);
  // simula organização de antes: some o CIFREN
  const cif = q.get("SELECT id FROM products WHERE organization_id = ? AND code = 'CIFREN'", orgA).id;
  q.run('DELETE FROM member_product_scopes WHERE product_id = ?', cif);
  q.run('DELETE FROM integrations WHERE product_id = ?', cif);
  q.run('DELETE FROM products WHERE id = ?', cif);
  ensureProducts(orgA);
  const novo = q.get("SELECT id FROM products WHERE organization_id = ? AND code = 'CIFREN'", orgA);
  assert.ok(novo, 'CIFREN recriado');
  assert.ok(q.get('SELECT id FROM integrations WHERE product_id = ?', novo.id), 'integração pendente criada');
  const has = (u) => !!q.get('SELECT 1 FROM member_product_scopes WHERE member_id = ? AND product_id = ?', mem(u), novo.id);
  assert.equal(has(owner), true);
  assert.equal(has(full), true);
  assert.equal(has(part), false);
  ensureProducts(orgA);
  assert.equal(q.get("SELECT COUNT(*) AS c FROM products WHERE organization_id = ? AND code = 'CIFREN'", orgA).c, 1, 'idempotente');
});
