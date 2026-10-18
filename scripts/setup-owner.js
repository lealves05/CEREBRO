// Criação segura do primeiro owner pelo terminal (alternativa ao código de instalação no painel).
// Não existe usuário/senha fixos no código. Uso: npm run setup:owner
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openDb, q, insert, uuid, now, tx } from '../src/db.js';
import { ensureSeed, addMember } from '../src/seed.js';
import { hashPassword } from '../src/auth/auth.js';
import { audit } from '../src/services/audit.js';

openDb();
const orgId = ensureSeed();
if (q.get("SELECT m.id FROM organization_members m WHERE m.role = 'owner' AND m.status = 'active' LIMIT 1")) {
  console.log('Já existe um owner ativo. Use o painel (Administração) para convidar novos membros.');
  process.exit(0);
}
const rl = readline.createInterface({ input: stdin, output: stdout });
const email = (await rl.question('E-mail do owner: ')).trim().toLowerCase();
const name = (await rl.question('Nome: ')).trim() || 'Owner';
console.log('Atenção: a senha ficará visível enquanto digita. Use no mínimo 10 caracteres com letras e números.');
const password = await rl.question('Senha: ');
rl.close();
try {
  const hash = hashPassword(password);
  const id = uuid();
  tx(() => {
    insert('users', { id, email, display_name: name, password_hash: hash, status: 'active', created_at: now() });
    addMember(orgId, id, 'owner');
    audit({ orgId, actorType: 'system', actorId: 'setup-cli', event: 'setup.owner_created', objectType: 'user', objectId: id });
  });
  console.log(`Owner ${email} criado. Inicie com: npm start`);
} catch (e) {
  console.error('Falha:', e.message);
  process.exit(1);
}
