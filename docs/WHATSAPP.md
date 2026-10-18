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

Referências: [Mensagens com botões](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) ·
[API de mensagens](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)
