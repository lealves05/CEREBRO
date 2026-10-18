// Caixa de entrada de conhecimento: importa arquivos .md deixados em data/inbox/ (pelas rotinas agendadas do Claude)
// para a base de conhecimento (knowledge_documents/versions). Mesmo título + mesmo produto = nova versão do documento.
// Formato do arquivo:
//   ---
//   titulo: Radar diário de tendências
//   produto: GERAL            (GERAL ou código do produto: ORBI, RUSTEN, TORVEN, APOLVEN)
//   classificacao: internal   (public | internal | restricted)
//   validade_dias: 30
//   ---
//   conteúdo em markdown...
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { q, tx, insert, uuid, now } from '../db.js';
import { sha256 } from '../lib/util.js';
import { audit } from './audit.js';

export const INBOX_DIR = process.env.LORLER_INBOX_DIR || path.join(ROOT, 'data', 'inbox');
const MAX_CONTENT = 50000;

export function parseInboxFile(text) {
  const meta = {};
  let body = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    body = body.slice(m[0].length);
  }
  return { meta, body: body.trim() };
}

export function importInboxFile(file, orgId) {
  const { meta, body } = parseInboxFile(fs.readFileSync(file, 'utf8'));
  const title = String(meta.titulo || meta.title || path.basename(file, '.md')).slice(0, 200).trim();
  if (title.length < 3 || body.length < 10) throw new Error('Título ou conteúdo insuficiente.');
  const code = String(meta.produto || 'GERAL').toUpperCase();
  let productId = null;
  if (code !== 'GERAL') {
    const p = q.get('SELECT id FROM products WHERE organization_id = ? AND code = ?', orgId, code);
    if (!p) throw new Error(`Produto desconhecido: ${code}`);
    productId = p.id;
  }
  const classification = ['public', 'internal', 'restricted'].includes(meta.classificacao) ? meta.classificacao : 'internal';
  const days = Number(meta.validade_dias);
  const expires = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const content = body.length > MAX_CONTENT ? body.slice(0, MAX_CONTENT - 60) + '\n\n[conteúdo truncado na importação]' : body;
  return tx(() => {
    let doc = q.get(`SELECT * FROM knowledge_documents WHERE organization_id = ? AND title = ? AND status != 'archived'
      AND ((product_id IS NULL AND ? IS NULL) OR product_id = ?) ORDER BY created_at LIMIT 1`, orgId, title, productId, productId);
    if (!doc) {
      doc = { id: uuid(), organization_id: orgId, product_id: productId, title, classification, current_version_id: null, status: 'active', is_demo: 0, created_at: now() };
      insert('knowledge_documents', doc);
    }
    const prev = q.get('SELECT MAX(version) AS v FROM knowledge_versions WHERE document_id = ?', doc.id);
    const verId = uuid();
    insert('knowledge_versions', { id: verId, organization_id: orgId, document_id: doc.id, version: (prev?.v || 0) + 1, content, content_ref: null, checksum: sha256(content), effective_from: now(), expires_at: expires, approved_by: null, created_at: now() });
    q.run('UPDATE knowledge_documents SET current_version_id = ?, classification = ? WHERE id = ?', verId, classification, doc.id);
    audit({ orgId, actorType: 'service', actorId: 'inbox', event: 'knowledge.version_created', objectType: 'knowledge_document', objectId: doc.id, metadata: { source: 'inbox', file: path.basename(file) } });
    return { document_id: doc.id, title, version: (prev?.v || 0) + 1 };
  });
}

export function processInbox({ dir = INBOX_DIR, minAgeMs = 10000 } = {}) {
  if (!fs.existsSync(dir)) return [];
  const org = q.get('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  if (!org) return [];
  const results = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < minAgeMs) continue; // ainda sendo gravado
      const r = importInboxFile(file, org.id);
      fs.mkdirSync(path.join(dir, 'processados'), { recursive: true });
      fs.renameSync(file, path.join(dir, 'processados', name));
      results.push({ file: name, ok: true, ...r });
    } catch (e) {
      fs.mkdirSync(path.join(dir, 'erros'), { recursive: true });
      try { fs.renameSync(file, path.join(dir, 'erros', name)); fs.writeFileSync(path.join(dir, 'erros', name + '.erro.txt'), String(e.message)); } catch {}
      results.push({ file: name, ok: false, error: e.message });
    }
  }
  if (results.length) console.log(`[inbox] ${results.filter((r) => r.ok).length} importado(s), ${results.filter((r) => !r.ok).length} com erro`);
  return results;
}

export function startInboxWatcher(intervalMs = Number(process.env.LORLER_INBOX_INTERVAL_MS) || 120000) {
  const run = () => { try { processInbox(); } catch (e) { console.error('[inbox]', e.message); } };
  run();
  const t = setInterval(run, intervalMs);
  t.unref?.();
  return t;
}
