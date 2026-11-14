// Rotas do Marketing: agenda de posts, planos (campanhas), anúncios, ações comerciais, mídia e aprovação.
import { requirePerm } from '../auth/authz.js';
import { requireRecentAuth } from '../auth/auth.js';
import { errors, clampText } from '../lib/util.js';
import * as mkt from '../services/marketing.js';
import * as meeting from '../services/meeting.js';
import { notifySubmission } from '../services/whatsapp-approvals.js';
import * as support from '../services/support-agent.js';

export function registerMarketingRoutes(router) {
  router.get('/api/mkt/overview', ({ ctx, url }) => {
    requirePerm(ctx, 'view');
    const from = url.searchParams.get('from') || new Date(Date.now() - 7 * 86400_000).toISOString();
    const to = url.searchParams.get('to') || new Date(Date.now() + 35 * 86400_000).toISOString();
    return {
      items: mkt.listItems(ctx, { from, to }), unscheduled: mkt.listItems(ctx, { status: 'rascunho' }).filter((i) => !i.scheduled_at),
      campaigns: mkt.listCampaigns(ctx), pending: mkt.pendingApproval(ctx), publisher: mkt.publisherStatus(),
      networks: mkt.NETWORK_LABEL, library: mkt.library().map((x) => ({ id: x.id, sistema: x.sistema, tema: x.tema, feed: x.feed, story: x.story, video: x.video })),
    };
  });
  router.get('/api/mkt/items/:id', ({ ctx, params }) => { requirePerm(ctx, 'view'); return mkt.getItem(ctx, params.id); });
  router.post('/api/mkt/items', ({ ctx, body }) => { requirePerm(ctx, 'create_decision'); return mkt.createItem(ctx, body || {}, { source: 'painel' }); }, { bigBody: true });
  router.put('/api/mkt/items/:id', ({ ctx, params, body }) => { requirePerm(ctx, 'create_decision'); return mkt.updateItem(ctx, params.id, body || {}); }, { bigBody: true });
  router.post('/api/mkt/items/:id/cancel', ({ ctx, params }) => { requirePerm(ctx, 'create_decision'); return mkt.cancel(ctx, params.id); });
  router.post('/api/mkt/draft', ({ ctx, body }) => { requirePerm(ctx, 'view'); return mkt.draftTexts({ product: String(body?.product || '').toUpperCase() || null, topic: clampText(String(body?.topic || ''), 200), offer: clampText(String(body?.offer || ''), 200), libIndex: Number(body?.lib_index) || 0 }); });
  router.post('/api/mkt/plan', ({ ctx, body }) => { requirePerm(ctx, 'create_decision'); return mkt.planCampaign(ctx, body || {}, { source: 'painel' }); });
  router.get('/api/mkt/campaigns/:id', ({ ctx, params }) => { requirePerm(ctx, 'view'); return mkt.getCampaign(ctx, params.id); });

  router.post('/api/mkt/submit', async ({ ctx, body }) => {
    requirePerm(ctx, 'create_decision');
    const r = mkt.submit(ctx, { item_id: body?.item_id || null, campaign_id: body?.campaign_id || null });
    const txt = r.campaign
      ? `🗂️ *Plano para aprovar:* ${clampText(r.campaign.name, 70)}\n${mkt.summarizeCampaign(r.campaign)}\n\nResponda *APROVAR ${r.code}* e o seu PIN para eu agendar tudo.`
      : `📣 *Post para aprovar:* ${clampText(r.item.title, 70)} — ${mkt.fmtWhen(r.item.scheduled_at)} no ${r.item.networks.map((n) => mkt.NETWORK_LABEL[n]).join(' e ')}\n\nResponda *APROVAR ${r.code}* e o seu PIN.`;
    const sent = await notifySubmission(ctx, txt);
    return { code: r.code, whatsapp: sent, item: r.item || null, campaign: r.campaign || null };
  });
  // aprovar no painel: permissão de aprovador + senha confirmada há pouco (o navegador pede a senha sozinho)
  router.post('/api/mkt/approve', ({ ctx, body }) => {
    requirePerm(ctx, 'approve');
    requireRecentAuth(ctx.session);
    if (!body?.item_id && !body?.campaign_id) throw errors.invalid('Informe o post ou o plano.');
    return mkt.approve(ctx, { item_id: body.item_id || null, campaign_id: body.campaign_id || null, via: 'painel' });
  });

  // mídia (foto/vídeo) enviada pelo painel → link público usado pelas redes
  router.post('/api/mkt/media', ({ ctx, body }) => {
    requirePerm(ctx, 'create_decision');
    const b64 = String(body?.data || '');
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw errors.invalid('Arquivo inválido.');
    return mkt.saveMedia(ctx, Buffer.from(b64, 'base64'), body?.mime, body?.filename);
  }, { maxBody: 23 * 1024 * 1024 });
  router.get('/api/public/midia/:file', ({ params, res }) => {
    const m = mkt.readMedia(params.file);
    if (!m) throw errors.notFound();
    res.writeHead(200, { 'Content-Type': m.mime, 'Content-Length': m.bytes, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.end(Buffer.from(m.data));
    return null;
  }, { public: true });

  // reunião pelo painel (a mesma da conversa): estado atual
  router.get('/api/mkt/meeting', ({ ctx }) => { requirePerm(ctx, 'view'); const m = meeting.active(ctx); return m ? { id: m.id, step: m.step, campaign_id: m.campaign_id, channel: m.channel } : { id: null }; });

  // agente de suporte no número público + número pessoal do dono
  router.get('/api/support-agent', ({ ctx }) => { requirePerm(ctx, 'view'); return support.publicView(ctx); });
  router.put('/api/support-agent', ({ ctx, body }) => { requirePerm(ctx, 'manage_integrations'); return support.saveSettings(ctx, body || {}); });
  router.post('/api/support-agent/my-number', ({ ctx, body }) => { requirePerm(ctx, 'manage_integrations'); requireRecentAuth(ctx.session); return support.setMyNumber(ctx, body?.number); });
}
