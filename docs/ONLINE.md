# Colocar a Central online

A Central roda no seu PC e é publicada pela Cloudflare (Cloudflare Tunnel). Não precisa abrir portas no roteador.

## Agora, sem conta: `ONLINE-AGORA.bat`
Dê dois cliques. Ele configura o modo produção, instala o `cloudflared` (winget) se faltar, inicia a Central como tarefa do
Windows e abre um endereço `https://xxxx.trycloudflare.com`. O endereço muda a cada execução e vale enquanto a janela
estiver aberta — bom para testar no celular.

## Definitivo: `PUBLICAR-CEREBRO.bat` → https://cerebro.lorler.com.br
1. Pré-requisito: o domínio lorler.com.br usando os DNS da Cloudflare. **Hoje o Registro.br ainda aponta para
   a.auto.dns.br/b.auto.dns.br** — troque para `brit.ns.cloudflare.com` e `ken.ns.cloudflare.com` no painel do Registro.br
   (é a mesma pendência do ORBI/TORVEN/RUSTEN).
2. Dê dois cliques. Na primeira vez abre o navegador: entre na Cloudflare, escolha **lorler.com.br** e clique em Authorize.
3. O script cria o túnel `lorler-cerebro`, o registro DNS `cerebro.lorler.com.br`, e duas tarefas do Windows
   (“LORLER Cerebro” e “LORLER Cerebro Tunnel”) que iniciam sozinhas quando você entra no Windows e reiniciam se caírem.
4. Também grava `LORLER_PUBLIC_URL` e a URL de retorno do Instagram no `.env`.

O endereço fica no ar enquanto o PC estiver ligado e com sessão aberta. Para parar: `PARAR-CEREBRO.bat`.
Log do servidor: `data\server.log`. Backup: `npm run backup`.

## Segurança na internet
- Modo produção: cookies `Secure`, HSTS, IP real do visitante via Cloudflare para o limite de tentativas de login
  (5 por usuário, 20 por IP).
- Primeiro acesso exige o código de instalação mostrado na janela/log; não há usuário padrão.
- Ações sensíveis pedem sua senha novamente; publicações e mudanças no Master exigem aprovação do owner.

## Alternativa 24 h por dia
Para não depender do PC ligado, use um servidor com disco persistente (ex.: VPS ou Render com disco) e aponte
`cerebro.lorler.com.br` para ele. O `Dockerfile` desta pasta já serve para isso (banco em `/data`).
