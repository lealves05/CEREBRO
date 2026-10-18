# Agente de Marketing e Instagram

## Como funciona

1. Pergunte, por exemplo: **“Crie um post para o Instagram divulgando o ORBI”** (as palavras *Instagram, post, publicar, marketing, divulgar* acionam o Agente de Marketing).
2. O **Agente de Marketing** cria objetivo, público, legenda, hashtags (máx. 30), briefing da imagem e horário sugerido.
3. **Revisão cruzada**: o Comercial confere a oferta contra os planos e a política de descontos; o Operacional avalia se o suporte aguenta a demanda. O Marketing revisa o post.
4. O Coordenador registra a proposta **Publicar no Instagram** com o conteúdo exato. A política exige aprovação do **owner**.
5. Na aba **Aprovação**, você vê a prévia do post, pode **editar legenda, hashtags e informar a URL da imagem** (cada edição gera nova versão com novo hash) e então **Aprovar**.
6. O executor revalida tudo (política, hash, conta vinculada, limite diário) e publica: cria o contêiner de mídia, aguarda o processamento e chama `media_publish`. O link do post aparece em **Resultado**.

Se a resposta do Instagram não chegar (timeout), o status fica **Resultado incerto** e o botão **Conciliar** procura o post nas publicações recentes antes de qualquer nova tentativa — nunca há republicação automática.

## Requisitos da conta

- Conta do Instagram **profissional** (Empresa ou Criador de conteúdo). Contas pessoais são recusadas.
- A imagem precisa estar em **URL pública HTTPS** (JPEG; recomendado 1080×1350, proporção 4:5). O sistema não gera nem hospeda imagens.
- Legenda até 2.200 caracteres, até 30 hashtags. Limite configurável de posts por 24 h (`max_posts_per_day`, padrão 3) em **Regras e limites**.

## Opção A — Vincular pelo login do Instagram (recomendado)

1. Em https://developers.facebook.com crie um app do tipo **Empresa** e adicione o produto **Instagram** → *API com login do Instagram*.
2. Permissões: `instagram_business_basic` e `instagram_business_content_publish`.
3. Em *Configurações do login do Instagram (OAuth)*, cadastre a URL de redirecionamento — precisa ser **HTTPS**:
   `https://SEU-ENDERECO/api/social/instagram/callback`
   (para testar no PC, use um túnel HTTPS — ex.: Cloudflare Tunnel — apontando para `http://127.0.0.1:3700`, ou publique a Central em um subdomínio de lorler.com.br).
4. No `.env`:
   ```
   INSTAGRAM_APP_ID=<ID do app do Instagram>
   INSTAGRAM_APP_SECRET=<chave secreta do app do Instagram>
   INSTAGRAM_REDIRECT_URI=https://SEU-ENDERECO/api/social/instagram/callback
   ```
5. Reinicie e acesse **Integrações → Instagram → Vincular minha conta do Instagram**. Faça login, autorize, e você volta ao painel com a conta vinculada.
   Enquanto o app estiver em modo de desenvolvimento, sua conta precisa estar adicionada como testadora no app.

## Opção B — Colar token de acesso

No painel do app da Meta (Instagram → *Gerar token de acesso*), gere um token para sua conta profissional e cole em
**Integrações → Instagram → Colar token de acesso** (pede sua senha). Com `INSTAGRAM_APP_SECRET` definido, o token é trocado
automaticamente por um de longa duração (~60 dias) e renovado ao clicar em **Verificar** quando estiver perto de vencer.

## Segurança

- O token é verificado na API, guardado **criptografado (AES-256-GCM)** no banco e nunca volta ao navegador nem ao modelo de IA.
  A chave fica em `LORLER_ENCRYPTION_KEY` ou em `data/lorler.key` (faça backup junto com o banco).
- Só o **owner** vincula/desvincula a conta e aprova publicações (com autenticação reforçada).
- O retorno do OAuth usa `state` de uso único (10 min) vinculado ao owner que iniciou.
- O agente não publica: ele só redige. A publicação passa pelo motor de políticas e pela aprovação do conteúdo exato.
- Para impedir publicações a partir de análises de demonstração, defina `"allow_demo_decisions": false` em `tools.publish_instagram_post` (Regras e limites).

## Referências

- Meta — Instagram Platform: https://developers.facebook.com/docs/instagram-platform
- Publicação de conteúdo: https://developers.facebook.com/docs/instagram-platform/content-publishing
Confira a versão vigente da API (`INSTAGRAM_API_VERSION`) antes de usar em produção.
