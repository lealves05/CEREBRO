# Área Master — acesso do cérebro

A Área Master (central de assinaturas e cobrança da LORLER, API `/api/master` do ORBI) passa a ser a **principal fonte de dados**
das análises e um **alvo de mudanças aprovadas**.

## O que o cérebro lê (todas as análises com dados reais)
Por sistema (ORBI, TORVEN, RUSTEN, APOLVEN): empresas ativas, em teste, inadimplentes e suspensas; novos cadastros; novas
assinaturas e cancelamentos no período; conversão da coorte de teste; recebido no período; valores em aberto; MRR; planos e
preços; parâmetros comerciais (teste grátis, carência, aviso de vencimento, cadastros, suporte).
Tudo vira evidência rastreável (`master/<sistema>/metrics` e `master/<sistema>/config`). Listas acima de 500 registros e
situações sem histórico aparecem como **parciais**. Custos variáveis não existem no Master e ficam como dado ausente.

## O que o cérebro pode mudar (sempre com a sua aprovação — owner)
| Ação | Endpoint do Master | Limites da política |
|---|---|---|
| Parâmetros comerciais por sistema | `PUT /settings?product=` | teste: NONE/15/30/ilimitado · carência 0–60 · aviso 1–60 |
| Plano (preço, nome, ativo, usuários) | `PUT /plans/:id` | variação de preço até 30% por proposta |
| Parâmetros de um sistema | `PUT /products/:code/params` | chaves do manifesto do sistema |
| Prorrogar teste de uma empresa | `POST /tenants/:id/trial` | 1–60 dias |

Nunca: bloquear/liberar empresas, pagamentos, estornos, segredos dos sistemas, e-mail, exclusões.

Como funciona: os agentes discutem → o coordenador propõe **uma** mudança → o servidor grava o **valor atual** lido do Master
(não o que o modelo diz) e calcula o hash → você vê **antes → depois** e aprova (painel ou WhatsApp com PIN) → o executor
relê o Master; se o valor mudou desde a análise, **bloqueia**; senão aplica e o Master registra na auditoria dele com o
motivo “Central de Decisões LORLER · decisão xxxx · aprovado por …”. Mudanças vindas de análises de **demonstração** são
sempre bloqueadas.

Exemplos de pergunta: *“Devemos ampliar o período de teste grátis do ORBI na Área Master?”*, *“Vale aumentar a carência
do TORVEN?”*, *“Devemos reajustar o plano Essencial do RUSTEN?”*.

## Configuração (.env)
```
LORLER_MASTER_URL=https://master.lorler.com.br      # o mesmo endereço em que você abre o Master
LORLER_MASTER_USERNAME=cerebro
LORLER_SECRET_MASTER_PASSWORD=<senha>
LORLER_SECRET_MASTER_TOTP=                         # só se esse administrador tiver MFA (segredo base32)
```
Depois: **Integrações → Área Master → Testar conexão** e **Ver dados (30 dias)**.

### Administrador dedicado (recomendado)
O Master só tem o papel SUPER_ADMIN; criar um usuário só para o cérebro deixa a auditoria clara e permite revogar o acesso
sem mexer no seu. No SQL Editor do Supabase (projeto ORBI):
```sql
insert into platform_admins (username, name, password_hash, role, active, must_change_password)
values ('cerebro', 'Central de Decisões LORLER', extensions.crypt('TROQUE-ESTA-SENHA-1', extensions.gen_salt('bf', 10)), 'SUPER_ADMIN', true, false);
```
Para revogar: `update platform_admins set active = false where username = 'cerebro';`
As restrições sobre o que pode ser alterado ficam no motor de políticas do cérebro (**Regras e limites**).
