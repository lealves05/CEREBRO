# Operação

## Instalação e primeiro owner
- `npm start` → o console imprime o **código de instalação** enquanto não houver usuário. O painel pede esse código.
- Alternativa: `npm run setup:owner`.
- Demais membros: **Administração → Convidar membro** (senha temporária exibida uma única vez; o usuário troca em “Minha senha”).
- Autenticação reforçada (senha novamente, janela de 15 min) para: publicar política, criar versão de agente, gerenciar membros e aprovar ações que exigem owner (exceto tarefa interna).

## Papéis
| Papel | Pode |
|---|---|
| owner | tudo, incluindo políticas, membros, integrações, auditoria e pausa |
| manager | criar análises, aprovar propostas cuja política inclua `manager`, manter conhecimento |
| analyst | criar análises e consultar |
| viewer | consultar relatórios concluídos/pendentes |

## Backup e restauração
- `npm run backup` → `backups/lorler-<data>.db` (VACUUM INTO, consistente com o servidor rodando).
- Restaurar: pare o servidor, substitua `data/lorler.db` pelo backup (apague `lorler.db-wal` e `lorler.db-shm`), inicie.
- Execuções interrompidas retomam pelas etapas persistidas; ações externas nunca são repetidas só porque o worker reiniciou.

## Pausa de emergência
**Administração → Pausar novas execuções e ações**: bloqueia novas análises, cancela execuções no próximo ponto de controle e impede o executor.

## Worker separado
`.env`: `LORLER_WORKER_IN_PROCESS=false`; terminal 1 `npm start`, terminal 2 `npm run worker`. Fechar o navegador nunca cancela análises.

## Eventos externos (n8n)
`POST /api/events/<origem>` com cabeçalhos:
- `X-Lorler-Timestamp`: epoch em segundos (janela de 300 s)
- `X-Lorler-Event-Id`: identificador único (repetição é deduplicada)
- `X-Lorler-Signature`: `hex(HMAC_SHA256(segredo, "<timestamp>.<event_id>." + corpo_bruto))`
Segredo em `LORLER_EVENTS_HMAC_SECRET`. Nenhuma rotina agendada é criada automaticamente.

## Produção
- `LORLER_ENV=production`, `LORLER_DEMO_MODE=false`, `LORLER_COOKIE_SECURE=true`, atrás de HTTPS (proxy reverso).
- `HOST=127.0.0.1` por padrão: exponha somente via proxy.
- Defina retenção da pasta `backups/` e teste a restauração periodicamente.
