// Tela Marketing: agenda das redes (Instagram, Facebook, TikTok, LinkedIn), planos com anúncio e ações comerciais,
// aprovação (senha) e situação do publicador da VPS. A mesma coisa dá para fazer conversando (WhatsApp ou voz).
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NET = { instagram: ['Instagram', '#e1306c'], facebook: ['Facebook', '#4e8cff'], tiktok: ['TikTok', '#2dd4bf'], linkedin: ['LinkedIn', '#7aa2ff'] };
const KIND = { post: 'Post', anuncio: 'Anúncio', acao: 'Ação comercial' };
const ST_CLASS = { rascunho: 'neutral', aguardando_aprovacao: 'warn', aprovado: 'info', na_fila: 'info', publicado: 'ok', parcial: 'warn', erro: 'danger', cancelado: 'neutral', concluido: 'ok' };
const LIMIT = { instagram: 2200, facebook: 60000, tiktok: 2200, linkedin: 3000 };
const SYSTEMS = ['ORBI', 'TORVEN', 'RUSTEN', 'APOLVEN', 'ANIBI', 'CIFREN'];
const TZ = 'America/Sao_Paulo';
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).reduce((a, x) => ({ ...a, [x.type]: x.value }), {}); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const fromInput = (v) => (v ? new Date(`${v}:00-03:00`).toISOString() : null);
const pill = (s, label) => `<span class="st ${ST_CLASS[s] || 'neutral'}">${esc(label || s)}</span>`;
const netDots = (nets) => (nets || []).map((n) => `<i class="mk-dot" style="--c:${NET[n]?.[1] || '#8da2c8'}" title="${esc(NET[n]?.[0] || n)}"></i>`).join('');

export async function viewMarketing(c, { api, toast, fail, modal, state }) {
  let data = await api('GET', '/api/mkt/overview');
  const render = () => {
    const pub = data.publisher || {};
    const pend = [...data.pending.campaigns.map((x) => ({ t: 'c', ...x })), ...data.pending.items.map((x) => ({ t: 'i', ...x }))];
    const start = new Date(); start.setHours(12, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return dayKey(d.toISOString()); });
    const byDay = {}; for (const it of data.items) { if (!it.scheduled_at || it.status === 'cancelado') continue; (byDay[dayKey(it.scheduled_at)] ||= []).push(it); }
    c.innerHTML = `<div class="mk">
      <section class="panel mk-head">
        <div><h2>Marketing</h2><p class="small muted">Posts no Instagram, Facebook, TikTok e LinkedIn, anúncios e ações comerciais. Nada sai sem a sua aprovação; depois de aprovado, o publicador da VPS publica sozinho no horário.</p></div>
        <div class="row"><button class="btn primary" id="mk-new">+ Nova publicação</button><button class="btn" id="mk-plan">Planejar campanha</button><button class="btn ghost" id="mk-meet">Reunião por voz</button></div>
        <div class="mk-pub ${pub.online ? 'ok' : 'off'}">
          <b>Publicador da VPS:</b> ${pub.online ? `online (última rodada há ${pub.minutos} min)` : pub.nunca_rodou ? 'ainda não ligado ao Cérebro' : `sem notícia há ${pub.minutos} min`}
          · Redes conectadas: ${(pub.redes || []).length ? pub.redes.map((r) => esc(NET[r]?.[0] || r)).join(', ') : 'nenhuma ainda'}
          ${pub.online && (pub.redes || []).length < 4 ? '<span class="small muted"> — conecte as que faltam no PUBLICADOR.bat › 1</span>' : ''}
          <div class="small muted">No WhatsApp: diga <b>reunião de marketing</b> para montar um plano comigo, mande foto/vídeo para usar nos posts e aprove com <b>APROVAR código</b> + PIN.</div>
        </div>
      </section>
      ${pend.length ? `<section class="panel"><h3>Esperando sua aprovação</h3><div class="mk-pend">${pend.map((p) => `<div class="mk-prow"><div><b>${p.t === 'c' ? '🗂️ Plano' : '📣 Post'}: ${esc(p.name || p.title)}</b><span class="small muted">${p.t === 'c' ? `${p.items} itens · ${esc(p.start_date.split('-').reverse().join('/'))} a ${esc(p.end_date.split('-').reverse().join('/'))}` : `${esc(new Date(p.scheduled_at).toLocaleString('pt-BR', { timeZone: TZ }))} ${netDots(p.networks)}`} · código ${esc(p.wa_code || '')}</span></div><div class="row"><button class="btn sm" data-${p.t === 'c' ? 'camp' : 'item'}="${p.id}">ver</button><button class="btn sm ok" data-approve-${p.t}="${p.id}">Aprovar</button></div></div>`).join('')}</div></section>` : ''}
      <section class="panel"><h3>Próximas 2 semanas</h3>
        <div class="mk-cal">${days.map((d) => { const dt = new Date(`${d}T12:00:00-03:00`); const list = (byDay[d] || []).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)); return `<div class="mk-day ${d === dayKey(new Date().toISOString()) ? 'today' : ''}"><div class="mk-dh"><b>${dt.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: TZ }).replace('.', '')}</b><span>${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: TZ })}</span></div>${list.map((it) => `<button class="mk-chip k-${it.kind} s-${it.status}" data-item="${it.id}" title="${esc(it.title)} — ${esc(it.status_label)}"><span class="mono">${it.kind === 'acao' ? '🤝' : it.kind === 'anuncio' ? '💰' : hhmm(it.scheduled_at)}</span>${netDots(it.networks)}<span class="mk-ct">${esc(it.title)}</span>${it.issues.length ? '<em>⚠</em>' : ''}</button>`).join('') || '<span class="mk-empty">—</span>'}</div>`; }).join('')}</div>
      </section>
      <section class="panel"><h3>Planos (campanhas)</h3>${data.campaigns.length ? `<table class="tbl"><thead><tr><th>Plano</th><th>Período</th><th>Itens</th><th>Anúncio</th><th>Situação</th></tr></thead><tbody>${data.campaigns.map((x) => `<tr data-camp="${x.id}" class="clickable"><td>${esc(x.name)}</td><td>${esc(x.start_date.split('-').reverse().join('/'))} – ${esc(x.end_date.split('-').reverse().join('/'))}</td><td>${x.items}</td><td>${x.budget_cents ? esc(x.budget) : '—'}</td><td>${pill(x.status === 'ativa' ? 'publicado' : x.wa_code ? 'aguardando_aprovacao' : 'rascunho', x.status === 'ativa' ? 'aprovado' : x.wa_code ? 'aguardando aprovação' : x.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Nenhum plano ainda. Clique em "Planejar campanha" ou, no WhatsApp, diga "reunião de marketing".</p>'}</section>
    </div>`;
  };
  const reload = async () => { data = await api('GET', '/api/mkt/overview'); render(); };
  render();

  const approve = async (body) => {
    try {
      const r = await api('POST', '/api/mkt/approve', body);
      toast(`Aprovado: ${r.queued.length} post(s) na fila, ${r.ready_ads.length} anúncio(s) pronto(s), ${r.tasks.length} tarefa(s).${r.skipped.length ? ` ${r.skipped.length} com pendência.` : ''}`);
      if (r.skipped.length) modal(`<h2>Ficou de fora</h2><ul>${r.skipped.map((s) => `<li><b>${esc(s.title)}</b>: ${esc(s.issues.join(' '))}</li>`).join('')}</ul><div class="row"><button class="btn" data-close>Ok</button></div>`, (m, close) => { $$('[data-close]', m).forEach((b) => { b.onclick = close; }); });
      reload();
    } catch (e) { fail(e); }
  };

  c.addEventListener('click', async (e) => {
    const t = e.target.closest('button, tr'); if (!t) return;
    if (t.id === 'mk-new') return itemModal(null);
    if (t.id === 'mk-plan') return planModal();
    if (t.id === 'mk-meet') { state.prefill = 'reunião de marketing'; location.hash = '#/jarvis'; setTimeout(() => state.dockSend?.('reunião de marketing', { spoken: true, quiet: true }), 900); return; }
    if (t.dataset.approveC) return approve({ campaign_id: t.dataset.approveC });
    if (t.dataset.approveI) return approve({ item_id: t.dataset.approveI });
    if (t.dataset.item) return itemModal(t.dataset.item);
    if (t.dataset.camp) return campModal(t.dataset.camp);
  });

  // ---------- item (post / anúncio / ação) ----------
  async function itemModal(id) {
    let it = id ? await api('GET', `/api/mkt/items/${id}`) : { kind: 'post', title: '', networks: ['instagram', 'facebook'], text: '', texts: {}, media_url: '', media_kind: '', scheduled_at: new Date(Date.now() + 86400_000).toISOString().slice(0, 10) + 'T21:30:00.000Z', status: 'rascunho', issues: [] };
    const editable = ['rascunho', 'aguardando_aprovacao', 'aprovado', 'erro'].includes(it.status);
    modal(`<div class="mk-item"><header class="row" style="justify-content:space-between"><h2>${it.id ? esc(KIND[it.kind]) : 'Nova publicação'}</h2>${it.id ? pill(it.status, it.status_label) : ''}</header>
      <form id="mf" class="grid">
        ${it.id ? '' : `<label class="field">Tipo<select name="kind"><option value="post">Post</option><option value="anuncio">Anúncio (pacote para subir)</option><option value="acao">Ação comercial</option></select></label>`}
        <label class="field">Título<input name="title" value="${esc(it.title)}" maxlength="140" ${editable ? '' : 'disabled'}></label>
        <div class="field">Redes<div class="row">${Object.entries(NET).map(([k, [l]]) => `<label class="chip ${it.networks.includes(k) ? 'on' : ''}"><input type="checkbox" name="net" value="${k}" ${it.networks.includes(k) ? 'checked' : ''} ${editable ? '' : 'disabled'}>${l}</label>`).join('')}</div></div>
        <label class="field">Data e hora (Brasília)<input type="datetime-local" name="when" value="${localInput(it.scheduled_at)}" ${editable ? '' : 'disabled'}></label>
        ${!it.id ? `<div class="field">Gerar texto<div class="row"><select id="mg-sys"><option value="">LORLER</option>${SYSTEMS.map((s) => `<option>${s}</option>`).join('')}</select><input id="mg-topic" placeholder="tema (vazio = biblioteca pronta)" style="flex:1;min-width:140px"><button type="button" class="btn sm" id="mg-go">gerar</button></div></div>` : ''}
        <label class="field">Texto padrão<textarea name="text" rows="5" ${editable ? '' : 'disabled'}>${esc(it.text)}</textarea></label>
        <details ${Object.keys(it.texts || {}).length ? 'open' : ''}><summary class="small">Texto próprio por rede</summary>${Object.entries(NET).map(([k, [l]]) => `<label class="field">${l} <span class="mono small" data-cnt="${k}"></span><textarea name="t_${k}" rows="3" ${editable ? '' : 'disabled'}>${esc((it.texts || {})[k] || '')}</textarea></label>`).join('')}</details>
        <div class="field">Mídia (imagem ou vídeo)<div class="row"><input name="media" value="${esc(it.media_url)}" placeholder="https://… (link público)" style="flex:1;min-width:160px" ${editable ? '' : 'disabled'}>${editable ? '<label class="btn sm">enviar arquivo<input type="file" id="mf-file" accept="image/jpeg,image/png,image/webp,video/mp4" hidden></label><button type="button" class="btn sm ghost" id="mf-lib">biblioteca</button>' : ''}</div>
          <div id="mf-prev" class="mk-prev">${it.media_url ? (it.media_kind === 'video' ? `<video src="${esc(it.media_url)}" muted controls preload="metadata"></video>` : `<img src="${esc(it.media_url)}" alt="">`) : ''}</div></div>
        ${it.kind === 'anuncio' ? `<div class="mk-ad"><h3>Pacote do anúncio</h3><table class="tbl">${Object.entries(it.ad || {}).map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>${esc(v)}</td></tr>`).join('')}</table><p class="small muted">O Cérebro não ativa gasto: suba este anúncio no gerenciador da rede (Meta, TikTok ou LinkedIn) e você controla o pagamento.</p></div>` : ''}
        ${it.kind === 'acao' ? `<div class="mk-ad"><h3>Passos</h3><ol>${(it.action?.passos || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ol><p class="small muted">Aprovada, vira tarefa interna.</p></div>` : ''}
        ${it.result?.redes ? `<div class="mk-ad"><h3>Resultado</h3>${Object.entries(it.result.redes).map(([k, r]) => `<div>${r.situacao === 'publicado' ? '✅' : r.erro ? '❌' : '⏳'} ${esc(NET[k]?.[0] || k)} ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">abrir</a>` : esc(r.erro || r.situacao)}</div>`).join('')}</div>` : ''}
        <div class="err" id="mf-err">${(it.issues || []).map(esc).join('<br>')}</div>
        <div class="row">${editable ? '<button class="btn primary">Salvar</button>' : ''}${it.id && editable ? '<button type="button" class="btn" id="mf-sub">Enviar p/ aprovação</button><button type="button" class="btn ok" id="mf-app">Aprovar e agendar</button>' : ''}${it.id && !['publicado', 'cancelado', 'concluido'].includes(it.status) ? '<button type="button" class="btn ghost danger" id="mf-can">Cancelar</button>' : ''}<button type="button" class="btn ghost" data-close>Fechar</button></div>
      </form></div>`, (m, close) => {
      m.firstElementChild?.classList.add('wide');
      $$('[data-close]', m).forEach((b) => { b.onclick = close; });
      const f = $('#mf', m);
      const counts = () => { for (const k of Object.keys(NET)) { const el = $(`[data-cnt="${k}"]`, m); const v = f[`t_${k}`].value || f.text.value; if (el) el.textContent = `${v.length}/${LIMIT[k]}`; el?.classList.toggle('over', v.length > LIMIT[k]); } };
      f.oninput = counts; counts();
      $$('.chip input', m).forEach((i) => { i.onchange = () => i.closest('.chip').classList.toggle('on', i.checked); });
      const setMedia = (url, kind) => { f.media.value = url; f.dataset.kind = kind || ''; $('#mf-prev', m).innerHTML = url ? (kind === 'video' || /\.mp4/.test(url) ? `<video src="${esc(url)}" muted controls preload="metadata"></video>` : `<img src="${esc(url)}" alt="">`) : ''; };
      $('#mg-go', m)?.addEventListener('click', async () => { try { const d = await api('POST', '/api/mkt/draft', { product: $('#mg-sys', m).value, topic: $('#mg-topic', m).value }); f.title.value = d.title; f.text.value = d.text; for (const k of Object.keys(NET)) f[`t_${k}`].value = d.texts[k] || ''; if (d.media_url) setMedia(d.media_url, d.media_kind); $('details', m).open = true; counts(); } catch (e) { fail(e); } });
      $('#mf-file', m)?.addEventListener('change', async (ev) => {
        const file = ev.target.files[0]; if (!file) return;
        if (file.size > 16 * 1024 * 1024) { toast('Arquivo maior que 16 MB.', true); return; }
        $('#mf-err', m).textContent = 'Enviando…';
        try { const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(file); }); const r = await api('POST', '/api/mkt/media', { data: b64, mime: file.type, filename: file.name }); setMedia(r.url, r.kind); $('#mf-err', m).textContent = ''; } catch (e2) { $('#mf-err', m).textContent = e2.message; }
      });
      $('#mf-lib', m)?.addEventListener('click', () => {
        const box = $('#mf-prev', m);
        box.innerHTML = `<div class="mk-lib">${data.library.map((x) => `<div class="mk-li"><img src="${esc(x.feed)}" alt="" loading="lazy"><span class="small">${esc(x.sistema)} · ${esc(x.tema)}</span><div class="row"><button type="button" class="btn sm" data-lib="${esc(x.feed)}" data-k="imagem">imagem</button><button type="button" class="btn sm" data-lib="${esc(x.video)}" data-k="video">vídeo</button></div></div>`).join('')}</div>`;
        box.onclick = (ev) => { const b = ev.target.closest('[data-lib]'); if (b) { setMedia(b.dataset.lib, b.dataset.k); box.onclick = null; } };
      });
      const body = () => ({ kind: f.kind?.value || it.kind, title: f.title.value, networks: $$('input[name=net]:checked', m).map((x) => x.value), scheduled_at: fromInput(f.when.value), text: f.text.value, texts: Object.fromEntries(Object.keys(NET).map((k) => [k, f[`t_${k}`].value]).filter(([, v]) => v.trim())), media_url: f.media.value.trim(), media_kind: f.dataset.kind || (/\.(mp4|mov)(\?|$)/i.test(f.media.value) ? 'video' : f.media.value ? 'imagem' : '') });
      f.onsubmit = async (ev) => { ev.preventDefault(); try { it = it.id ? await api('PUT', `/api/mkt/items/${it.id}`, body()) : await api('POST', '/api/mkt/items', body()); toast(it.issues.length ? `Salvo, com pendência: ${it.issues[0]}` : 'Salvo.'); close(); reload(); if (!id) itemModal(it.id); } catch (e2) { $('#mf-err', m).textContent = e2.message; } };
      $('#mf-sub', m)?.addEventListener('click', async () => { try { await api('PUT', `/api/mkt/items/${it.id}`, body()); const r = await api('POST', '/api/mkt/submit', { item_id: it.id }); toast(`Enviado para aprovação (código ${r.code})${r.whatsapp ? ' — avisei no WhatsApp' : ''}.`); close(); reload(); } catch (e2) { fail(e2); } });
      $('#mf-app', m)?.addEventListener('click', async () => { try { await api('PUT', `/api/mkt/items/${it.id}`, body()); close(); await approve({ item_id: it.id }); } catch (e2) { fail(e2); } });
      $('#mf-can', m)?.addEventListener('click', async () => { if (!confirm('Cancelar este item? Se já estiver na fila, ele sai da fila e não é publicado.')) return; try { await api('POST', `/api/mkt/items/${it.id}/cancel`, {}); toast('Cancelado.'); close(); reload(); } catch (e2) { fail(e2); } });
    });
  }

  // ---------- plano (campanha) ----------
  function planModal() {
    const t = new Date(); t.setDate(t.getDate() + 1); const s = t.toISOString().slice(0, 10); const e2 = new Date(t); e2.setDate(e2.getDate() + 13);
    modal(`<h2>Planejar campanha</h2><p class="small muted">Eu monto os posts (com texto de cada rede e mídia da biblioteca), o anúncio (se tiver verba) e as ações comerciais. Você revisa e aprova.</p>
      <form id="pf" class="grid">
        <label class="field">Objetivo<select name="objective"><option value="vendas">Vender mais</option><option value="leads">Novos contatos (leads)</option><option value="reconhecimento">Divulgar a marca</option><option value="engajamento">Engajamento</option><option value="reativacao">Reativar clientes</option></select></label>
        <label class="field">Sistema<select name="product_code"><option value="">LORLER (geral)</option>${SYSTEMS.map((x) => `<option>${x}</option>`).join('')}</select></label>
        <label class="field">Oferta (opcional)<input name="offer" placeholder="ex.: 30 dias grátis"></label>
        <label class="field">Público (opcional)<input name="audience" placeholder="ex.: donos de barbearia em Campinas"></label>
        <div class="grid g2"><label class="field">Início<input type="date" name="start_date" value="${s}"></label><label class="field">Fim<input type="date" name="end_date" value="${e2.toISOString().slice(0, 10)}"></label></div>
        <div class="grid g2"><label class="field">Verba do anúncio (R$, 0 = sem)<input type="number" name="budget" min="0" step="10" value="0"></label><label class="field">Posts por semana<input type="number" name="ppw" min="1" max="7" value="3"></label></div>
        <div class="field">Redes<div class="row">${Object.entries(NET).map(([k, [l]]) => `<label class="chip on"><input type="checkbox" name="net" value="${k}" checked>${l}</label>`).join('')}</div></div>
        <div class="err" id="pf-err"></div>
        <div class="row"><button class="btn primary">Montar plano</button><button type="button" class="btn ghost" data-close>Cancelar</button></div></form>`, (m, close) => {
      $$('[data-close]', m).forEach((b) => { b.onclick = close; });
      $$('.chip input', m).forEach((i) => { i.onchange = () => i.closest('.chip').classList.toggle('on', i.checked); });
      $('#pf', m).onsubmit = async (ev) => {
        ev.preventDefault(); const f = ev.target;
        try { const r = await api('POST', '/api/mkt/plan', { objective: f.objective.value, product_code: f.product_code.value, offer: f.offer.value, audience: f.audience.value, start_date: f.start_date.value, end_date: f.end_date.value, budget_cents: Math.round(Number(f.budget.value || 0) * 100), posts_per_week: Number(f.ppw.value), networks: $$('input[name=net]:checked', m).map((x) => x.value) }); close(); await reload(); campModal(r.id); } catch (e3) { $('#pf-err', m).textContent = e3.message; }
      };
    });
  }

  async function campModal(id) {
    const cp = await api('GET', `/api/mkt/campaigns/${id}`);
    const open = cp.items.filter((i) => ['rascunho', 'aguardando_aprovacao', 'erro'].includes(i.status));
    modal(`<h2>${esc(cp.name)}</h2><p class="small muted">${esc(cp.start_date.split('-').reverse().join('/'))} a ${esc(cp.end_date.split('-').reverse().join('/'))} · ${cp.networks.map((n) => esc(NET[n]?.[0] || n)).join(', ')}${cp.budget_cents ? ` · anúncio ${esc(cp.budget)}` : ''}${cp.offer ? ` · oferta: ${esc(cp.offer)}` : ''}</p>
      <table class="tbl mk-tbl"><thead><tr><th>#</th><th>Quando</th><th>O quê</th><th>Redes</th><th>Situação</th></tr></thead><tbody>${cp.items.map((it, i) => `<tr data-item="${it.id}" class="clickable"><td>${i + 1}</td><td>${it.kind === 'acao' ? 'início' : esc(new Date(it.scheduled_at).toLocaleString('pt-BR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td><td>${esc(KIND[it.kind])}: ${esc(it.title)}${it.issues.length ? ` <span class="st warn" title="${esc(it.issues.join(' '))}">pendência</span>` : ''}</td><td>${netDots(it.networks)}</td><td>${pill(it.status, it.status_label)}</td></tr>`).join('')}</tbody></table>
      <div class="row" style="margin-top:12px">${open.length ? `<button class="btn" id="cp-sub">Enviar p/ aprovação${cp.wa_code ? ` (${esc(cp.wa_code)})` : ''}</button><button class="btn ok" id="cp-app">Aprovar tudo e agendar</button>` : ''}<button class="btn ghost" data-close>Fechar</button></div>`, (m, close) => {
      m.firstElementChild?.classList.add('wide');
      $$('[data-close]', m).forEach((b) => { b.onclick = close; });
      $$('tr[data-item]', m).forEach((tr) => { tr.onclick = () => { close(); itemModal(tr.dataset.item); }; });
      $('#cp-sub', m)?.addEventListener('click', async () => { try { const r = await api('POST', '/api/mkt/submit', { campaign_id: cp.id }); toast(`Plano enviado para aprovação (código ${r.code})${r.whatsapp ? ' — mandei no seu WhatsApp' : ''}.`); close(); reload(); } catch (e) { fail(e); } });
      $('#cp-app', m)?.addEventListener('click', async () => { close(); await approve({ campaign_id: cp.id }); });
    });
  }
}
