# Aprovações pelo WhatsApp

## Como você usa
1. **Administração → WhatsApp para aprovações → Vincular meu WhatsApp**: o painel mostra `LORLER 123456`. Envie essa mensagem
   do seu celular para o número da LORLER. Isso prova que o número é seu.
2. Cadastre um **PIN** de 4 a 8 dígitos (pede sua senha).
3. Quando uma proposta precisar da sua aprovação, chega uma mensagem com o resumo, o código (ex.: `K7Q2P4`) e os botões
   **Aprovar · Rejeitar · Ver detalhes**. Também dá para digitar:
   - `APROVAR K7Q2P4` → o cérebro pede o PIN → envie o PIN → aprovado e executado, com o resultado na resposta
   - `REJEITAR K7Q2P4 motivo` · `REVISAR K7Q2P4 o que mudar` (os agentes refazem e mandam novo pedido)
   - `VER K7Q2P4` (conteúdo completo, riscos e divergências) · `PENDENTES` · `CANCELAR` · `AJUDA`

Regras: o código vale só para aquela versão da proposta (se ela mudar, o código expira); a confirmação por PIN vale 5 min;
3 PINs errados bloqueiam por 15 min; números não vinculados são ignorados; toda decisão vai para a auditoria com o canal.
O PIN substitui a confirmação de senha do painel; a aprovação passa pelas mesmas verificações (papel, versão, hash,
validade, política e revalidação no executor).

## Configuração (owner, uma vez)
1. Em https://developers.facebook.com crie (ou use) um app do tipo **Empresa** e adicione o produto **WhatsApp**.
   Use o número de teste da Meta ou registre o número da LORLER.
2. Gere um **token permanente** (usuário do sistema no Gerenciador de Negócios, permissões `whatsapp_business_messaging` e
   `whatsapp_business_management`).
3. No `.env` do cérebro:
   ```
   WHATSAPP_PHONE_NUMBER_ID=<ID do número>
   WHATSAPP_BUSINESS_NUMBER=55XXXXXXXXXXX
   LORLER_SECRET_WHATSAPP_TOKEN=<token permanente>
   LORLER_SECRET_WHATSAPP_APP_SECRET=<chave secreta do app>
   LORLER_SECRET_WHATSAPP_VERIFY_TOKEN=<uma frase longa qualquer>
   ```
4. Em WhatsApp → Configuração → **Webhook**: URL `https://cerebro.lorler.com.br/api/whatsapp/webhook` (aparece em
   Integrações), token de verificação = `LORLER_SECRET_WHATSAPP_VERIFY_TOKEN`; assine o campo **messages**.
   O webhook precisa de endereço público HTTPS — por isso a publicação (docs/ONLINE.md) vem antes.
5. **Modelo de mensagem (recomendado):** a Meta só deixa a empresa iniciar conversa fora da janela de 24 h com um modelo
   aprovado. Crie um modelo de categoria *Utilidade*, idioma pt_BR, corpo por exemplo:
   `Central de Decisões LORLER: aprovação pendente — {{1}} ({{2}}). Código {{3}}. Responda APROVAR {{3}} ou VER {{3}}.`
   e defina `WHATSAPP_TEMPLATE_APPROVAL=<nome do modelo>`. Sem modelo, os avisos só chegam se você tiver mandado alguma
   mensagem ao número nas últimas 24 h (o painel mostra o erro quando isso acontecer).

6. **Briefing diário (opcional):** em **WhatsApp** no painel, ligue o *Briefing diário* e escolha o horário (fuso da
   organização). O Cérebro manda receita, riscos e decisões pendentes uma vez por dia, até 3 h depois do horário escolhido
   (se o servidor estava desligado na hora, ele envia quando voltar dentro dessa janela). Para chegar mesmo sem conversa nas
   últimas 24 h, crie um segundo modelo *Utilidade* com **uma** variável, por exemplo `Briefing do Cérebro LORLER: {{1}}`,
   e defina `WHATSAPP_TEMPLATE_BRIEFING=<nome do modelo>`; o texto completo vem logo depois.

### Comandos

| Mensagem | O que faz |
|---|---|
| `RESUMO` | Briefing do dia na hora |
| `RADAR` | Saúde, receita, ativas, cancelamentos e atrasos de cada sistema |
| `PENDENTES` | Aprovações aguardando você |
| `VER código` · `APROVAR código` · `REVISAR código o que mudar` · `REJEITAR código motivo` | Decidir pelo celular (aprovar sempre pede o PIN) |
| `APROVAR código` (marketing) | Pede o PIN; depois do PIN certo, por 30 min, `APROVAR código` aprova direto |
| `APROVAR TUDO` (`… AGENDADO`) | Aprova todos os posts e planos que esperam, com um PIN só |
| `TENTAR DE NOVO` · `TENTAR código` | Publica de novo só as redes que não saíram (o post já foi aprovado: sem PIN). `APROVAR código` de um post com erro faz o mesmo |
| `VÍDEOS` | Lista os vídeos prontos da biblioteca; "posta o vídeo do TORVEN laudos" prepara o post (Reels, Facebook e YouTube Shorts) |
| "como corrigir o instagram" | Passo a passo conforme o motivo (falta permissão no app da Meta ou Instagram não vinculado à Página) |
| texto livre | Conversa com o Cérebro (se *Conversa livre* estiver ligada) |

#### Publicação: Instagram e vídeos
- O publicador da VPS procura o Instagram pela Página a cada tentativa. Se não achar, o post fica **esperando ajuste**
  (⏸️) e é tentado de novo a cada 10 min por até 3 dias: corrigido o vínculo ou a permissão, ele sai sozinho.
  O aviso no WhatsApp diz qual dos dois falta.
- Vídeos prontos ficam em `/var/lib/lorler/cerebro/videos` (enviados pelo `ENVIAR-VIDEOS-CEREBRO.bat`, que o
  `LIGAR-PUBLICADOR-CEREBRO.bat` também chama). Legendas: `mensagens-whatsapp.txt` (`[arquivo.mp4]` + texto).
  Link público com Range: `/api/public/video/<arquivo>.mp4`; o publicador lê o arquivo direto do disco
  (`midia_arquivo`) e envia o Reels ao Instagram por upload direto.
- O post do dia (Mapa da empresa) alterna: arte nova num dia, vídeo da biblioteca no outro.

Referências: [Mensagens com botões](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) ·
[API de mensagens](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)

## WhatsApp da LORLER pelo QR Code no Master (sem a Cloud API da Meta)

Sem as variáveis da Cloud API (`WHATSAPP_PHONE_NUMBER_ID`, token, chave secreta), o Cérebro conversa pelo WhatsApp da
LORLER conectado no **Master › Configurações › WhatsApp do suporte**, pelo QR Code (o mesmo "aparelho conectado" que as
empresas usam nos sistemas):

1. No Master, clique em **Gerar QR Code** e leia com o celular da LORLER (WhatsApp › Aparelhos conectados › Conectar um aparelho).
2. Ainda no Master, cadastre **Meu número pessoal** (pede o 2FA). Os clientes que chamam o número da LORLER recebem só
   respostas técnicas sobre os sistemas; o seu número pessoal vai para o Cérebro, sem restrição.
3. No Cérebro, a Área Master precisa estar ligada (Integrações). O Cérebro busca as suas mensagens no Master com espera
   longa (~15 s) e responde por ele. Na primeira mensagem, o número é vinculado sozinho ao proprietário (quando há um só);
   se não, cadastre em **WhatsApp › Seu número pessoal**.

Pelo Master passam texto, notas de voz (o Whisper da VPS transcreve e eu respondo com a voz local), fotos e vídeos (vão
para os posts do marketing). Botões viram "Responda: *APROVAR código* · *REJEITAR código* · *VER código*".
`LORLER_WA_VIA_MASTER=off` desliga a ponte.

Posts aprovados: o `lorler-publicador` da VPS lê `social-fila/saida` a cada 5 min (sem passar pelo Drive), publica na
hora marcada e devolve `resultados/` e `status.json` (redes conectadas). Instalar/atualizar: `LIGAR-PUBLICADOR-CEREBRO.bat`.
