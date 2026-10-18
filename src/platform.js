// Ganchos de plataforma: no Node vêm do sistema de arquivos; no Cloudflare Worker o ponto de entrada preenche
// estes campos (migrações embutidas no pacote, tabela de preços, guarda da chave de criptografia).
export const platform = {
  /** [{ name: '001_init.sql', sql: '...' }] — se nulo, db.js lê a pasta migrations/ */
  migrations: null,
  /** conteúdo de config/pricing.json — se nulo, provider.js lê o arquivo */
  pricing: null,
  /** guarda da chave de criptografia quando não há LORLER_ENCRYPTION_KEY nem disco: { get(): string|null, set(v) } */
  keyStore: null,
  /** agenda o processamento da fila (Cloudflare: alarme do Durable Object) */
  wake: null,
  /** mantém viva uma tarefa que continua depois da resposta HTTP (Cloudflare: ctx.waitUntil; Node: não precisa) */
  defer: null,
};
