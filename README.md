# LORLER · Central de Decisões

Cérebro multiagente para decisões de gestão da LORLER (ORBI, TORVEN, RUSTEN e APOLVEN).
Um **Coordenador** distribui a pergunta para os agentes **Financeiro**, **Comercial**, **Operacional** e **Marketing**
(com dados da **Área Master**),
promove **revisão cruzada** (proposta → contrapontos → revisão), consolida um relatório com evidências
e registra uma proposta de ação que só é executada depois do **motor de políticas** e da **aprovação humana**.

Interface no estilo HUD holográfico: núcleo animado, agentes em órbita trocando mensagens ao vivo,
comando por voz e respostas faladas em português (Chrome ou Edge).

> Implementado a partir de `Cerebro_Multiagente_LORLER_Passo_a_Passo_Vibecode.md`.
> Veja o que foi verificado e o que está pendente em [`docs/RELATORIO-VERIFICACAO.md`](docs/RELATORIO-VERIFICACAO.md).

## Requisitos

- Node.js **22.13 ou superior** (testado no Node 22; o Node 24 instalado no seu PC atende).
- Nenhuma dependência externa (`npm install` não é necessário). O banco é SQLite embutido no Node.

## Como iniciar (Windows)

1. Dê dois cliques em **`iniciar.bat`** (ou rode `npm start` nesta pasta).
   Na primeira vez ele copia `.env.example` para `.env`.
2. O console mostra um **CÓDIGO DE INSTALAÇÃO**. Abra http://127.0.0.1:3700, informe o código
   e crie o primeiro **owner** (não existe usuário ou senha padrão).
   Alternativa pelo terminal: `npm run setup:owner`.
3. Faça login e pergunte ao núcleo, por exemplo:
   *“Podemos oferecer 12% de desconto para aumentar a conversão?”*
   *“Quais ações devem ser priorizadas para aumentar as assinaturas?”*

Sem chave de IA, o sistema roda com o **provedor de demonstração** (pareceres determinísticos a partir
dos dados) e com **dados fictícios** — ambos sinalizados em amarelo na tela.

## Ligar a IA real

No `.env`:

```
LORLER_AI_PROVIDER=openai        # ou anthropic
LORLER_AI_MODEL=<modelo escolhido na documentação oficial vigente>
OPENAI_API_KEY=<sua chave>       # ou ANTHROPIC_API_KEY
```

Modelos por agente: `LORLER_AI_MODEL_COORDINATOR`, `..._FINANCIAL`, `..._COMMERCIAL`, `..._OPERATIONS`.
Preços para cálculo de custo: `config/pricing.json` (sem preço configurado, o custo fica em branco).

## Ligar os produtos (dados reais)

Cada produto precisa expor `GET /lorler/v1/metrics` (contrato em [`docs/CONECTORES.md`](docs/CONECTORES.md)).
Depois: cadastre o host em `LORLER_CONNECTOR_ALLOWED_HOSTS`, a credencial em `LORLER_SECRET_<PRODUTO>`,
a URL em **Integrações** e clique em **Testar conexão**. Para experimentar localmente:
`node scripts/mock-produto.js ORBI 4001` (servidor de exemplo com valores fictícios).

## Marketing e Instagram

Peça, por exemplo, *“Crie um post para o Instagram divulgando o ORBI”*. O Agente de Marketing redige legenda, hashtags,
briefing da imagem e horário; Comercial e Operacional revisam; você vê a prévia, informa a imagem e aprova.
Vincule a conta profissional em **Integrações → Instagram** (login do Instagram ou token de acesso).
Passo a passo em [`docs/INSTAGRAM.md`](docs/INSTAGRAM.md).

## Área Master

O cérebro lê assinaturas, cobranças, planos e parâmetros de todos os sistemas na Área Master e pode **propor mudanças**
(teste grátis, carência, aviso, planos, prorrogação de teste) que só são aplicadas com a sua aprovação. Veja [`docs/AREA-MASTER.md`](docs/AREA-MASTER.md).

## Aprovações pelo WhatsApp

Receba os pedidos com botões Aprovar/Rejeitar/Ver; aprovar pede seu PIN. Veja [`docs/WHATSAPP.md`](docs/WHATSAPP.md).

## Online

`ONLINE-AGORA.bat` (endereço temporário) ou `PUBLICAR-CEREBRO.bat` (https://cerebro.lorler.com.br). Veja [`docs/ONLINE.md`](docs/ONLINE.md).

## Comandos

| Comando | Função |
|---|---|
| `npm start` | Servidor + worker no mesmo processo |
| `npm run worker` | Worker separado (com `LORLER_WORKER_IN_PROCESS=false`) |
| `npm run setup:owner` | Cria o primeiro owner pelo terminal |
| `npm run backup` | Backup consistente do banco em `backups/` |
| `npm test` | 43 testes de aceitação e unidade |

## Estrutura

```
src/
  server.js, worker.js         servidor HTTP e worker
  api/routes.js                rotas da API (seção 18)
  auth/                        sessões, senhas (scrypt), CSRF, papéis e escopos
  orchestrator/engine.js       fila, leases, etapas persistidas, revisão cruzada, síntese
  ai/                          adaptadores OpenAI, Anthropic e demonstração; esquemas de saída
  agents/prompts.js            instruções versionadas dos agentes (seção 17) e política inicial
  services/                    políticas, propostas/aprovações/executor, cálculos, orçamento, auditoria
  connectors/                  conectores de leitura e dados de demonstração
migrations/                    SQL versionado (+ reversão)
public/                        painel HUD (HTML/CSS/JS sem dependências)
tests/                         cenários de aceitação
docs/                          arquitetura, conectores, operação, relatório de verificação
```
