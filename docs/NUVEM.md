# Cérebro na nuvem (Cloudflare) — sem depender do PC

O cérebro roda num **Cloudflare Worker** com um **Durable Object com SQLite**: o banco, a fila dos agentes e o painel
ficam no Cloudflare, no endereço `https://cerebro.lorler.com.br`. O PC pode ficar desligado.

## Por que Durable Object e não D1
O código do cérebro usa SQLite de forma síncrona (transações, fila, auditoria). O Durable Object com SQLite roda
exatamente essa linguagem SQL, de forma síncrona, com o banco dentro do próprio objeto e alarmes para tocar a fila.
Ele cabe no plano gratuito. O D1 exigiria reescrever todas as consultas para o modo assíncrono.

## Publicar (uma vez)
1. Dê dois cliques em **PUBLICAR-CEREBRO-NUVEM.bat** (aceite a permissão de administrador).
2. O script:
   - faz um backup da pasta em `..\BACKUP-Sistemas`;
   - abre o navegador para autorizar o Wrangler na sua conta Cloudflare (a mesma conta do domínio lorler.com.br);
   - publica o Worker num endereço de teste `*.workers.dev`;
   - grava as chaves do `.env` como **segredos criptografados** no Cloudflare. Isso inclui as chaves de IA, Área Master, WhatsApp, Instagram e a chave de criptografia `data\lorler.key`;
   - copia o banco do PC para a nuvem (uma única vez, com um código de importação gerado na hora).
3. Teste o endereço `workers.dev` mostrado (mesmo usuário e senha). Confirme com **S** para trocar `cerebro.lorler.com.br` para a nuvem.
4. Confirme com **S** para desligar o cérebro, o túnel e o vigia do PC.

Rodar o script de novo depois disso só republica o código e as chaves. Os dados não são copiados de novo.

## WhatsApp
O webhook continua em `https://cerebro.lorler.com.br/api/whatsapp/webhook`, então não precisa mudar nada na Meta.
Texto livre no número vinculado vira conversa natural, como uma pessoa da equipe:
- memória das últimas 24 h;
- "digitando…" e tiques azuis;
- respostas curtas.

Comandos continuam valendo:
- PENDENTES, VER, APROVAR (pede o PIN), REJEITAR, REVISAR, CANCELAR;
- AJUDA mostra a lista de comandos;
- "nova conversa" apaga a memória.

Se o cérebro sugerir uma análise, um "sim" abre a análise e ele avisa por lá quando a recomendação ficar pronta.
Para desligar a conversa e manter só os comandos, use a tela **Assistente**.

## Assistente (nome, avatar e voz)
Na tela **Assistente** (só o owner altera) você configura:
- nome, como ele te chama e o jeito de falar;
- avatar: núcleo, rosto digital, holograma, ondas ou foto, com as cores;
- voz: voz do aparelho (grátis) ou **voz neural** (OpenAI, gerada no servidor — exige `OPENAI_API_KEY`), mais velocidade e tom.

O avatar fica no canto da tela em todas as páginas. Clique para conversar por texto ou microfone. Ele mexe a boca conforme a fala.
A personalidade muda só o tom. As regras de segurança são as mesmas: aprovação só com senha (painel) ou PIN (WhatsApp).

## Limitações na nuvem
- A pasta `data\inbox` (rotinas que geram arquivos .md no PC) não é lida na nuvem. Para isso, use a base de conhecimento do painel.
- Voltar para o PC: `Enable-ScheduledTask` nas tarefas "LORLER Cerebro*" e remover a rota `cerebro.lorler.com.br/*` do Worker no painel do Cloudflare.
