# Cérebro na VPS LORLER

Desde 18/10/2026 o cérebro roda na **mesma VPS dos sistemas** (ORBI, TORVEN, RUSTEN, APOLVEN), no lugar do Worker
`cerebro-lorler` + Durable Object da Cloudflare. Os endereços não mudam: `https://cerebro.lorler.com.br`, webhook do
WhatsApp `https://cerebro.lorler.com.br/api/whatsapp/webhook`, retorno do Instagram `…/api/social/instagram/callback`.

| | Onde |
|---|---|
| Código | este repositório (`CEREBRO`, branch `cloudflare`) em `/opt/lorler/cerebro`; a VPS confere a cada 5 min, faz backup do banco, atualiza e volta sozinha se a versão nova não subir |
| Banco | `/var/lib/lorler/cerebro/lorler.db` (SQLite do Node) + `lorler.key` (criptografia dos tokens) + `inbox/` |
| Configuração | `/etc/lorler/cerebro.env` = o `.env` do PC sem o que só vale no PC, mais `HOST=127.0.0.1`, `PORT=3700`, `LORLER_ENV=production`, cookies seguros e IP real pela Cloudflare |
| Serviço | `lorler-cerebro` (systemd, usuário `lorler`), só em `127.0.0.1:3700`; o `lorler-edge` repassa `cerebro.lorler.com.br` e `cerebro-vps.lorler.com.br` |
| Backup | junto do backup diário cifrado da VPS (banco + chave) e git no Google Drive (pasta CEREBRO) |

## Mudança (uma vez): VPS-MENU › C
1. No PC, `node scripts/nuvem.js trazer` (o menu chama): publica esta versão do Worker, baixa **todas** as tabelas do
   Durable Object para `data/nuvem-export.json` e **congela** a nuvem (gravações recusadas com 503 e fila parada) — nada é
   gravado na nuvem depois da cópia; a Meta repete a entrega do WhatsApp e ela chega no servidor novo.
2. O menu leva `.env`, `data/lorler.key` e o snapshot para a VPS; `lorler-cerebro instalar` baixa este repositório,
   monta o banco com `scripts/importar-snapshot.js`, liga o serviço e abre `https://cerebro-vps.lorler.com.br` para teste.
3. Testado, `lorler-cerebro dominio`: você tira a rota `cerebro.lorler.com.br/*` do Worker no painel da Cloudflare e o
   script põe o domínio no túnel da VPS.

Desfazer antes do passo 3: `node scripts/nuvem.js descongelar` (a nuvem volta a gravar). Depois da mudança o
`PUBLICAR-CEREBRO-NUVEM.bat` se recusa a publicar (tiraria o domínio da VPS).

## Master oculto
Com o Master oculto (`lorler-master-oculto`), quem chega pela internet sem o passe recebe "não atendido". O cérebro fala
com o Master pela internet, então a VPS grava o passe em `LORLER_MASTER_PORTA` (`/etc/lorler/cerebro.env`) e o conector
envia o cookie `lorler_porta` em cada chamada. Trocar o link secreto atualiza o passe e reinicia o cérebro sozinho.
