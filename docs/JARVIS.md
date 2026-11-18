# Cérebro no formato JARVIS

Quatro partes, um sistema: **motor** (o Cérebro + os agentes), **memória** (o cofre em markdown), **voz local**
(ouvidos + boca na VPS) e **o HUD** (uma tela com tudo). Mentalidade: fale, direcione, lembre, repita.

## 1. O HUD (`#/jarvis`, tela inicial)
Uma tela, sem abas:
- **Sinais vitais da VPS:** CPU, memória, disco e rede (atualiza a cada 4 s) + relógio e selo de acesso seguro.
- **Comandos rápidos:** falar, plano de hoje, lembrar, resumo da manhã, métricas, tendências, abrir cofre, encerrar o dia.
- **Núcleo:** o cérebro animado, a última fala e o botão **Segure para falar**.
- **Cofre:** total de notas, barras por pasta e as notas mais recentes (clique para abrir).
- **Agenda de hoje** (rotina), **Top 3** e **Áudio** (entrada/saída em uso).
- **Barra de status:** sistema ativo · voz local · TTS online · acesso seguro · dados atualizados · WhatsApp.

**Falar:** segure a **barra de espaço** (em qualquer tela, fora de campos de texto) ou o botão do microfone; solte para
enviar. O microfone sempre aberto ("Cérebro, …") continua valendo.

## 2. A memória (cofre)
"Se não está no cofre, não aconteceu." Cada pessoa tem o seu cofre, guardado no banco do servidor:

| Pasta | O que vai |
|---|---|
| `raw/` | tudo capturado: cada conversa do dia (voz, texto e WhatsApp) |
| `wiki/` | conhecimento refinado: `memorias.md` ("lembre que…") e uma nota por assunto (ORBI, RUSTEN, pessoas…) |
| `outputs/` | o que o Cérebro entrega: resumo da manhã, métricas, tendências |
| `diario/` | um arquivo por dia: top 3, anotações, encerramento, amanhã na fila e reflexão |

As notas se ligam por `[[links]]` (os nomes dos sistemas viram link sozinhos) — o grafo aparece em Cofre › grafo.
Antes de responder, a conversa consulta o cofre e manda as notas relevantes para a IA como `memoria_do_cofre`
(ela nunca inventa memória).

**Obsidian no PC:** HUD › Cofre › *Obsidian no PC* gera um token pessoal. No PC rode `SINCRONIZAR-COFRE.bat`:
ele cola o token na primeira vez, baixa o cofre para `D:\Programacao\Cofre-Cerebro`, instala o Obsidian (winget) se
faltar e abre a pasta. O que você editar no Obsidian volta para o Cérebro na próxima sincronização (dá para deixar
sincronizando a cada 60 s). Também há *exportar (.zip)*.

## 3. Habilidades (`skills/<nome>/SKILL.md`)
Só são acionadas quando o momento pede (gatilhos). Habilidade pequena, propósito gigante:
`metricas`, `caixa-de-entrada`, `tendencias`, `plano-de-hoje`, `cofre`, `encerrar-dia`. Ver `skills/README.md`.
O cálculo fica em `src/services/skills.js`; a IA só deixa a resposta natural.

## 4. Rotina do dia (um dia real)
| Horário | O que acontece |
|---|---|
| 07:00 | resumo da manhã → `outputs/resumo-*.md` e pergunta o top 3 |
| 09:00 | plano do dia → se faltar o top 3, pergunta (a resposta vai para o diário) |
| 14:00 | métricas → `outputs/metricas-*.md` |
| 19:00 | encerra o dia → diário (encerramento + amanhã na fila) e pergunta a reflexão |
| a qualquer hora | pergunte qualquer coisa — o cofre lembra |

Horários ajustáveis no HUD (Agenda › ajustar). Com o WhatsApp vinculado, cada etapa chega lá como mensagem e a sua
resposta (texto **ou áudio**) vai direto para o cofre.

## 5. Voz local (o áudio não sai da VPS)
- **Ouvidos:** Whisper (speaches / faster-whisper) em `127.0.0.1:8000`.
- **Boca:** Kokoro-82M (Kokoro-FastAPI) em `127.0.0.1:8880`, vozes pt-BR `pf_dora`, `pm_alex`, `pm_santa`.
- Instalação: **VPS-MENU › I** (roda `deploy/voz-local/instalar-voz-local.sh`: Docker, as duas imagens, o modelo do
  Whisper, teste de ponta a ponta e as variáveis `LORLER_STT_URL`, `LORLER_STT_MODEL`, `LORLER_TTS_LOCAL_URL` no
  `/etc/lorler/cerebro.env`). Precisa de ~3 GB de RAM livres e ~6 GB de disco (com pouca RAM ele usa o Whisper `base`).
- Depois: Assistente › Voz › **Voz local Kokoro** e **Ouvir: Whisper na VPS**.
- Sem a voz local instalada, tudo continua funcionando com a voz do navegador.

## 6. No celular
- Abra `https://cerebro.lorler.com.br` no Chrome (Android) ou Safari (iPhone) e use **Adicionar à tela inicial**:
  vira um app em tela cheia com o ícone do Cérebro, abrindo direto no HUD (botão grande de falar).
- **WhatsApp como canal de voz:** mande uma nota de voz para o número da LORLER → Whisper transcreve → o Cérebro
  responde **com áudio** (Kokoro). Desligável em Agenda › ajustar › "responder com áudio".

## Segurança
- Nada disso aprova ou executa ação: aprovação continua na tela (senha) ou no WhatsApp (PIN).
- Whisper e Kokoro só escutam em `127.0.0.1`. O token do cofre só lê/grava o cofre da própria pessoa e pode ser
  revogado. Caminhos de nota são validados (sem `../`).

## Mapa da empresa (#/mapa)

O Cérebro como equipe de agentes em 8 departamentos (CRM, Tarefas, Financeiro, Segurança, Traqueamento, Educação,
Marketing, Cofre), com números ao vivo da Área Master e do próprio Cérebro, "segundo cérebro" (conversas, reuniões,
notas, decisões, pendências), linha de frente (Atendente, Vendedor, Assistente pessoal), o que espera aprovação e a
atividade dos agentes. Rotinas autônomas (liga/desliga e "rodar agora" no mapa; avisam no WhatsApp do dono):
contatos novos 06:00 · caixa do dia 09:00 · post do dia 12:00 (dias úteis, com arte e código para aprovar) ·
sites no ar de hora em hora (avisa quando cai e quando volta) · clientes em risco segunda 10:30.
No WhatsApp: "mapa da empresa", "confere o caixa do dia", "roda o post do dia".
