# Contrato dos conectores (ORBI, TORVEN, RUSTEN, APOLVEN)

As integrações são **somente leitura** e agregadas. Nenhuma alteração nos produtos foi feita; cada produto
precisa ganhar este endpoint em uma entrega própria, preservando seus fluxos atuais.

## Requisição

```
GET {URL_DO_PRODUTO}/lorler/v1/metrics?start=2026-09-01T03:00:00.000Z&end_exclusive=2026-10-01T03:00:00.000Z&timezone=America/Sao_Paulo
Authorization: Bearer <credencial de leitura>
Accept: application/json
```

- HTTPS obrigatório; o host precisa estar em `LORLER_CONNECTOR_ALLOWED_HOSTS`.
- Hosts que resolvem para rede interna/metadados são bloqueados; redirecionamentos são recusados.
- Timeout `LORLER_CONNECTOR_TIMEOUT_MS` (15 s) e tamanho máximo `LORLER_CONNECTOR_MAX_BYTES` (1 MB).
- A credencial fica no `.env` do servidor LORLER (`LORLER_SECRET_ORBI` etc.); o banco guarda apenas o nome (`secret_ref`).
- O produto deve aplicar o escopo do token no próprio servidor (somente dados agregados da LORLER).

## Resposta (schema 1.0)

```json
{
  "schema_version": "1.0",
  "product_code": "ORBI",
  "period": { "start": "...", "end_exclusive": "...", "timezone": "America/Sao_Paulo" },
  "fetched_at": "2026-10-05T10:00:00Z",
  "currency": "BRL",
  "metrics": [
    { "code": "active_subscriptions_at_period_end", "value": "100", "unit": "subscriptions",
      "definition_version": "1.0", "quality": "complete", "source_ref": "aggregate/subscriptions" }
  ],
  "cancel_reasons": [ { "reason": "Preço", "share_pct": "33" } ],
  "limitations": []
}
```

Regras validadas pelo conector: `schema_version = 1.0`, `product_code` igual ao produto, período igual ao
solicitado, moeda BRL, `value` como **texto decimal ou null** (nunca número), `quality` ∈
`complete | partial | stale | unavailable`. Valor desconhecido → `null` + `unavailable` (nunca zero presumido).

## Indicadores usados pelos agentes

| Código | Unidade | Uso |
|---|---|---|
| `active_subscriptions_at_period_start` / `_end` | assinaturas | crescimento, base do cancelamento |
| `new_subscriptions`, `cancellations` | assinaturas | aquisição e churn (base: clientes) |
| `cohort_trials`, `cohort_trial_subscriptions` | testes / assinaturas | conversão da coorte |
| `plan_price_main`, `variable_cost_per_subscription` | dinheiro | simulação de desconto e contribuição |
| `cash_received_in_period`, `open_receivables` | dinheiro | caixa e valores em aberto |
| `support_tickets`, `tickets_per_customer`, `support_capacity_monthly` | chamados | capacidade de suporte |
| `first_response_hours`, `incidents`, `error_rate_pct`, `infra_cost` | diversos | operação e custos |

Indicadores extras são aceitos e repassados aos agentes como dados.

## Erros identificados separadamente

| Situação | Tipo | Status da integração |
|---|---|---|
| URL/credencial ausente | `config` | `pending_setup` |
| HTTP 401 | `auth` | `error` |
| HTTP 403 | `forbidden` | `error` |
| Timeout / rede / 5xx | `unavailable` | `error` |
| JSON inválido ou fora do contrato | `contract` | `error` |
| Host não permitido | `blocked` | (recusado ao salvar) |

A integração só passa a `connected` após uma consulta real bem-sucedida em **Testar conexão**.

## Teste local

```
node scripts/mock-produto.js ORBI 4001
# .env (somente desenvolvimento):
LORLER_CONNECTOR_ALLOW_LOCALHOST=true
LORLER_SECRET_ORBI=token-local
```
Em Integrações, URL `http://localhost:4001` → Testar conexão. O mock devolve valores fictícios; não conta como integração real.
