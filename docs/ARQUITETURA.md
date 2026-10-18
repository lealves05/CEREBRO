# Arquitetura — mapeamento da especificação para a implementação

## Diagnóstico da stack (Etapa 1)

| Componente da especificação | Implementação | Observação |
|---|---|---|
| Interface administrativa | `public/` — SPA em JavaScript puro, CSP restritiva | Sem build; funciona em celular e desktop |
| API do cérebro | `src/server.js` + `src/api/routes.js` (Node `http`) | Sem dependências externas |
| Motor de orquestração | `src/orchestrator/engine.js` | Estado persistido em `runs`/`run_steps`, leases de 60 s |
| Provedor de IA | `src/ai/` — OpenAI (Responses API, json_schema strict), Anthropic (tool obrigatória), demonstração | Trocável por `LORLER_AI_PROVIDER` |
| Banco | SQLite embutido (`node:sqlite`) com migrations | Ver “Migração para PostgreSQL” |
| Conectores | `src/connectors/connectors.js` | Somente leitura, allowlist, HTTPS, validação de contrato |
| Motor de políticas | `src/services/policy.js` | Determinístico: `allow` / `require_approval` / `deny` |
| Executor | `src/services/actions.js` (`execute`) | Separado das ferramentas de análise; idempotência por chave |
| Automação externa | `POST /api/events/:source` com HMAC + anti-replay | n8n opcional |

## Fluxo de uma decisão

1. `POST /api/decisions` valida pergunta, produtos (escopo do usuário), período e cria `decisions` + `runs` (snapshot de agentes, modelos, ferramentas e política). Responde `202`.
2. O worker reivindica a execução (lease) e percorre etapas persistidas: `validate → budget → collect → plan → opinion:* → challenge:* → revision:* → synthesis → proposal`. Etapa concluída nunca é repetida após reinício.
3. **Coleta**: métricas por produto (integração real, ou demonstração marcada), cálculos determinísticos derivados (`conversion_rate`, `churn_rate`, `contribution`, `capacity_check`, `discount_scenario`) e documentos vigentes. Tudo vira `evidence_items` com `EV-n`, fonte, versão e checksum.
4. **Plano** do coordenador é validado contra o registro (agentes ativos, até 3 especialistas). Se envolver mais de uma área e o plano não trouxer revisão cruzada, o orquestrador a insere.
5. **Pareceres** independentes em paralelo (até 3). Perguntas entre agentes viram mensagens `question`.
6. **Revisão cruzada**: a proposta do agente líder vai aos revisores (`challenge`) e volta para `revision`. Nova rodada só se algum contraponto declarar dados insuficientes (máx. 2).
7. **Síntese** com diagnóstico, alternativas, divergências, riscos, dados ausentes e **uma** intenção de ação. Se o limite impedir a chamada, uma síntese parcial é montada sem modelo e sinalizada.
8. **Proposta**: o servidor normaliza parâmetros, calcula hash SHA-256 do JSON canônico, avalia a política e define o status (`awaiting_approval`, `denied`, `advisory` ou execução direta quando a política permitir).
9. **Aprovação** (POST autenticado + CSRF, versão + hash, papel exigido, reautenticação para ações críticas) → **executor** revalida tudo e executa com chave de idempotência; timeout vira `uncertain` e exige conciliação.

## Gateway de chamadas ao modelo

- Limite global de chamadas por execução (inclui novas tentativas), limite de tokens por execução e reserva mensal transacional de tokens.
- Saída validada no backend contra o esquema, mesmo com saída estruturada do provedor.
- Referências de evidência inexistentes são removidas e a afirmação recebe `[SEM SUPORTE]`.
- Cada agente recebe apenas as evidências compatíveis com suas ferramentas; o texto do prompt não amplia concessões.
- Conteúdo de documentos/pareceres é enviado como **dado**, com aviso explícito ao modelo.
- Pedidos de cálculo do modelo são executados pelo serviço determinístico e registrados como evidência.

## Segurança

- Sessão opaca em cookie `HttpOnly; SameSite=Strict` (banco guarda só o hash), CSRF por sessão, scrypt, bloqueio após 5 tentativas.
- Organização e papel sempre derivados da sessão; objetos de outra organização retornam 404.
- Ninguém altera o próprio papel; `approvals`, `action_executions`, `policy_evaluations`, `agent_tool_grants` e `audit_events` só são escritos pela API.
- Auditoria somente inclusão (triggers bloqueiam UPDATE/DELETE), com `request_id` e metadados sem segredos.
- Ações fora do MVP (pagamento, bloqueio, exclusão, produção) são forçadas a `deny` mesmo se alguém editar a política.

## Migração para PostgreSQL / Supabase

O SQL usa tipos simples (TEXT para UUID/datas ISO e decimais) para rodar sem instalação. Para produção multiusuário:
converter `migrations/001_init.sql` (TEXT→`uuid`/`timestamptz`/`numeric`, triggers em PL/pgSQL), criar políticas RLS por
`organization_id` (o backend já repete a autorização em todas as rotas) e trocar `src/db.js` por um cliente `pg`.
Os serviços usam apenas `q.get/all/run`, `insert` e `tx`, o que concentra a troca em um arquivo.
