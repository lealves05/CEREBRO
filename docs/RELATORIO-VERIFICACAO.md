# Relatório de verificação — Central de Decisões LORLER v0.1.0

Data: 05/10/2026 · Ambiente de verificação: Linux, Node 22.22, banco SQLite em memória/arquivo.

## Verificações executadas

`npm test` → **43 testes, 43 aprovados, 0 falhas.**

| Caso da seção 25 | Teste | Resultado |
|---|---|---|
| Usuário sem sessão | `usuário sem sessão não acessa…` | ✔ 401 |
| Usuário sem associação | `usuário sem associação…` | ✔ 403 |
| Analista tenta aprovar | `viewer não cria análise; analista não aprova` | ✔ 403 |
| Perfil tenta promover seu papel | `perfil não promove o próprio papel` | ✔ 403 |
| Organização A consulta objeto da B | `organização B não consulta…` | ✔ 404 (decisão, execução, busca de conhecimento, produto alheio) |
| Credencial privada no cliente | `credencial privada não aparece no cliente` | ✔ |
| Integração inexistente | `integração inexistente aparece pendente…` | ✔ `pending_setup` + `insufficient_data` |
| Indicador sem denominador | `indicador sem denominador válido…` | ✔ indisponível |
| Referência de evidência inventada | `referência… sinalizada sem suporte` | ✔ `[SEM SUPORTE]` + nota de validação |
| Documento com instrução maliciosa | `documento com instrução maliciosa…` | ✔ sem alteração de concessões/execução |
| JSON inválido do modelo | `JSON inválido do modelo…` | ✔ tentativas limitadas, falha controlada |
| Decisão entre várias áreas | `…revisão cruzada registrada…` | ✔ `challenge` + `revision` + `synthesis` |
| Especialistas discordam | idem | ✔ divergências preservadas na síntese |
| Limite de chamadas | `limite de chamadas encerra…` | ✔ resultado `partial` |
| Limite de custo concorrente | `orçamento técnico: reservas concorrentes…` | ✔ |
| Worker reinicia | `worker reinicia…` | ✔ retoma sem repetir coleta |
| Proposta fora da política | `proposta fora da política…` | ✔ `denied` |
| Aprovação desatualizada (política mudou) | `aprovação após mudança de política…` | ✔ executor bloqueia |
| Parâmetros mudam após aprovação | `parâmetros alterados…` | ✔ 409, sem execução |
| Acesso GET ao link | `acesso GET… não executa` | ✔ |
| Duas requisições de aprovação | `…dupla aprovação não gera dupla ação` | ✔ uma transição, uma tarefa |
| Timeout após ação externa | `timeout… estado incerto e conciliação` | ✔ `uncertain` → conciliado |
| Evento duplicado / replay / sem assinatura | `eventos externos…` | ✔ |
| Cancelamento antes da execução | `cancelamento antes da execução…` | ✔ |
| Auditoria | `auditoria é somente inclusão` | ✔ |
| Exemplo da seção 22 (R$ 99, 10%, custo R$ 25) | `cenário de desconto reproduz…` | ✔ 89,10 / 74,00 / 64,10 / 13,38% |
| Segurança do conector | `conector bloqueia…`, `contrato…`, `credencial inválida…` | ✔ |

### Agente de Marketing e Instagram (v0.2, API do Instagram simulada nos testes)

| Caso | Resultado |
|---|---|
| Pergunta de marketing aciona o Agente de Marketing, com contraponto do Comercial e do Operacional e revisão do post | ✔ |
| Proposta “Publicar no Instagram” exige owner; manager não aprova | ✔ |
| Aprovar sem imagem é bloqueado; edição do conteúdo gera nova versão e invalida o hash anterior; URL não HTTPS recusada | ✔ |
| Aprovado sem conta vinculada → executor bloqueia, nada é publicado; após vincular, “Executar agora” publica | ✔ |
| Conta pessoal recusada; token guardado criptografado e nunca enviado ao navegador | ✔ |
| Legenda publicada é exatamente a aprovada; segunda execução não republica | ✔ |
| Timeout na publicação → resultado incerto → conciliação encontra o post | ✔ |
| Retorno OAuth com `state` forjado não vincula conta | ✔ |

### Área Master e WhatsApp (v0.3, APIs simuladas nos testes)

| Caso | Resultado |
|---|---|
| Análise real lê a Área Master (métricas + planos + parâmetros) e propõe mudança com o valor anterior lido pelo servidor | ✔ |
| Aprovação aplica a mudança (PUT no Master); valor alterado por fora antes da execução → bloqueio sem escrita | ✔ |
| Mudança no Master a partir de análise de demonstração → negada | ✔ |
| Senha errada do Master identificada (auth) sem expor a senha | ✔ |
| WhatsApp: verificação do webhook, assinatura obrigatória, número desconhecido ignorado | ✔ |
| Vínculo pelo próprio número (LORLER 123456), PIN previsível recusado | ✔ |
| Pedido com botões → Aprovar → PIN errado não aprova → PIN certo aprova e executa; código reutilizado recusado | ✔ |
| Rejeição por mensagem; reentrega da mesma mensagem deduplicada | ✔ |

Estrutura da API do Master conferida no código publicado da função `orbi-api` (rotas `/api/master/*`, login de
administrador com token Bearer de 120 min). **Nenhuma escrita foi feita no Master real** nesta entrega.

Verificações manuais adicionais:
- Fluxo completo pelo navegador (instalação → login → pergunta → câmara de agentes ao vivo → aprovação → tarefa interna criada) com capturas de tela em 1440 px e 390 px.
- Conector real contra o servidor de exemplo (`scripts/mock-produto.js`): teste de conexão `connected`, análise em modo real com evidência `integration` (não demo).

## Não verificado / pendente

| Item | Situação |
|---|---|
| **Integração real com ORBI, TORVEN, RUSTEN e APOLVEN** | **Pendente** — os produtos ainda não expõem `/lorler/v1/metrics`. O critério de MVP “consultar pelo menos uma fonte real autorizada” só é atendido após implementar esse endpoint em um produto. |
| **Publicação real no Instagram** | Fluxo testado contra API simulada. A chamada real depende do seu app da Meta/token; endpoints conforme documentação pública (v24.0). Faça um primeiro post de teste. |
| Área Master real | Leitura e escrita testadas contra API simulada fiel às rotas do Master; falta configurar o administrador e testar a conexão. |
| WhatsApp real | Depende do app da Meta, token e webhook público; envio/recebimento testados com API simulada. |
| Publicação online | Scripts `ONLINE-AGORA.bat` / `PUBLICAR-CEREBRO.bat`. O domínio lorler.com.br ainda não usa os DNS da Cloudflare (Registro.br pendente). |
| Chamadas reais à OpenAI/Anthropic | Adaptadores implementados conforme as APIs conhecidas, **não executados** (sem chave neste ambiente). Validar sintaxe e modelos na documentação vigente antes do uso. |
| Execução no Windows | Código sem dependências nativas; não foi executado no seu PC por mim — rode `npm test` aí. |
| PostgreSQL/Supabase com RLS | Não implementado; banco local SQLite. Caminho descrito em `ARQUITETURA.md`. |
| Restauração de backup | Procedimento documentado; não testado automaticamente. |
| Agendamentos/n8n | Somente a recepção autenticada de eventos; nenhuma rotina criada. |
| Embeddings | Busca textual simples com autorização (volume atual não justifica embeddings). |
| Envio de mensagens, campanhas, alteração de preço | Sem executor (fora do MVP). Aprovação registrada; aplicação manual pelo fluxo do produto. |
| Recuperação de senha por e-mail | Não implementada; owner pode redefinir via novo convite. |

## Limitações conhecidas
- O provedor de **demonstração** gera pareceres por regras fixas — serve para testar fluxo e interface, não para decidir.
- Proteção contra força bruta mantida em memória (reinicia com o servidor).
- Reconhecimento de voz depende do navegador (Chrome/Edge) e envia o áudio ao serviço de voz do navegador.
- A concordância entre agentes não comprova correção; o relatório sempre lista premissas e dados ausentes.
