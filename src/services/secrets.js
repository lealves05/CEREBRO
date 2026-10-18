// Criptografia de credenciais guardadas no banco (tokens do Instagram). AES-256-GCM.
// Chave: LORLER_ENCRYPTION_KEY (32 bytes em base64). Se ausente, é gerada uma vez em data/lorler.key
// (pasta privada, fora do controle de versão). Sem a chave, os tokens gravados não podem ser lidos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { platform } from '../platform.js';

let key = null;

function loadKey() {
  if (key) return key;
  if (config.encryptionKey) {
    const k = Buffer.from(config.encryptionKey, 'base64');
    if (k.length !== 32) throw new Error('LORLER_ENCRYPTION_KEY deve ter 32 bytes em base64.');
    key = k;
    return key;
  }
  if (platform.keyStore) {
    const saved = platform.keyStore.get();
    if (saved) key = Buffer.from(saved, 'base64');
    else { key = crypto.randomBytes(32); platform.keyStore.set(key.toString('base64')); }
    return key;
  }
  if (config.dbFile === ':memory:') { key = crypto.randomBytes(32); return key; }
  const file = path.join(path.dirname(config.dbFile), 'lorler.key');
  if (fs.existsSync(file)) key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  else {
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    console.log(`[segurança] Chave de criptografia gerada em ${file}. Faça backup junto com o banco (ou defina LORLER_ENCRYPTION_KEY).`);
  }
  return key;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload) {
  const [v, iv, tag, data] = String(payload).split('.');
  if (v !== 'v1') throw new Error('Formato de credencial desconhecido.');
  const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
