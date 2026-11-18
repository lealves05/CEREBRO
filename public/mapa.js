// Mapa da empresa: o Cérebro como equipe de agentes por departamento, com as rotinas que rodam sozinhas,
// o que espera a sua aprovação e a atividade ao vivo. Atualiza sozinho a cada minuto.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'America/Sao_Paulo';
const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const COLORS = ['#111827', '#ef4444', '#ec4899', '#3b82f6', '#16a34a', '#f97316', '#8b5cf6', '#6366f1'];
const ICONS = {
  crm: '<path d="M16 11a4 4 0 1 0-8 0M4 20a8 8 0 0 1 16 0"/>', tarefas: '<path d="M9 11l3 3 8-8M4 12v7h16"/>', financeiro: '<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>',
  seguranca: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', traqueamento: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/>', educacao: '<path d="M3 9l9-5 9 5-9 5zM7 11v5c3 2 7 2 10 0v-5"/>',
  marketing: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6"/>', vault: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="12" cy="12" r="3"/>',
};
const JOB_ICON = { contatos: 'crm', caixa: 'financeiro', post: 'marketing', sites: 'seguranca', risco: 'educacao' };
const ico = (k, color) => `<span class="mp-ico" style="--c:${color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ICONS.vault}</svg></span>`;
const deptColor = (i) => COLORS[i % COLORS.length];

export async function viewMapa(c, { api, toast, fail, state }) {
  let data;
  const load = async () => { data = await api('GET', '/api/mapa'); render(); };
  const render = () => {
    const sc = data.segundo_cerebro;
    const idx = Object.fromEntries(data.departamentos.map((d, i) => [d.id, i]));
    c.innerHTML = `<div class="mp">
      <div class="mp-top">
        <div><span class="mp-kicker">ESTRUTURA DE IA</span><h2>O mapa da empresa</h2><p class="small muted">Os agentes do Cérebro trabalhando por departamento. As rotinas rodam sozinhas; o que muda alguma coisa espera a sua aprovação.</p></div>
        <div class="mp-icons">${data.departamentos.map((d, i) => ico(d.id, deptColor(i))).join('')}</div>
      </div>

      <div class="mp-row3">
        <div class="mp-card"><div class="mp-cap">FONTES</div>${data.fontes.map((f) => `<div class="mp-line"><i class="mp-led ${f.ok ? 'on' : ''}"></i><b>${esc(f.nome)}</b><span>${esc(f.info)}</span></div>`).join('')}</div>
        <div class="mp-card"><div class="mp-cap">VOCÊ</div>
          <div class="mp-line"><i class="mp-led ${data.voce.whatsapp ? 'on' : ''}"></i><b>WhatsApp</b><span>${data.voce.whatsapp ? esc(data.voce.numero) : 'não vinculado'}</span></div>
          <div class="mp-line"><i class="mp-led on"></i><b>HUD e voz</b><span>neste painel</span></div>
          <p class="small muted" style="margin:8px 0 0">Peça qualquer coisa no WhatsApp: "mapa da empresa", "caixa do dia", "gere o post do dia".</p></div>
        <div class="mp-card dark"><div class="mp-cap">SEGUNDO CÉREBRO</div>
          <div class="mp-stats"><span>conversas lidas <b>${sc.conversas}</b></span><span>reuniões <b>${sc.reunioes}</b></span><span>notas no cofre <b>${sc.notas}</b></span><span>decisões anotadas <b>${sc.decisoes}</b></span><span>pendências <b>${sc.pendencias}</b></span></div></div>
      </div>

      <div class="mp-team"><b>Equipe LORLER [IA]</b><span><em>${data.equipe.agentes}</em> agentes · ${data.equipe.times} times · trabalhando 24 h</span></div>

      <div class="mp-grid">${data.departamentos.map((d, i) => `<div class="mp-dept">
        <div class="mp-dh"><small>${esc(d.n)}</small><b>${esc(d.name)}</b><span>${esc(d.verb)}</span></div>
        ${d.agents.slice(0, 4).map((a) => `<div class="mp-agent">${ico(d.id, deptColor(i))}<span>${esc(a)}</span></div>`).join('')}
        <div class="mp-kpi" style="--c:${deptColor(i)}">${esc(d.kpi || '')}</div>
      </div>`).join('')}</div>

      <div class="mp-row3 b">
        <div class="mp-card"><div class="mp-cap">ROTINAS DE HOJE</div>
          <div class="mp-jobs">${data.rotinas.map((r) => `<div class="mp-job ${r.enabled ? '' : 'off'}" title="${esc(r.last_result || '')}">
            ${ico(JOB_ICON[r.job], deptColor(idx[r.dept] ?? 0))}<b>${esc(r.label)}</b><small>${esc(r.when)}${r.done_today ? ' · ✓ feito' : ''}</small>
            <div class="row"><label class="switch sm"><input type="checkbox" data-job="${esc(r.job)}" ${r.enabled ? 'checked' : ''} aria-label="Ligar ${esc(r.label)}"><span></span></label>
            <button class="btn sm ghost" data-run="${esc(r.job)}">Rodar agora</button></div></div>`).join('')}</div></div>
        <div class="mp-card"><div class="mp-cap">LINHA DE FRENTE</div>${data.linha_de_frente.map((l, i) => `<div class="mp-line"><i class="mp-led ${l.ok ? 'on' : ''}"></i><b style="color:${['#f97316', '#3b82f6', '#ef4444'][i]}">${esc(l.nome)}</b><span>${esc(l.info)}</span></div>`).join('')}</div>
        <div class="mp-card"><div class="mp-cap">PARA APROVAR</div>${data.para_aprovar.length ? data.para_aprovar.map((p) => `<a class="mp-line link" href="${p.href}"><b>${esc(p.tipo)}</b><span>${esc(p.titulo)}${p.codigo ? ` · <code>${esc(p.codigo)}</code>` : ''}</span></a>`).join('') : '<p class="small muted">Nada esperando você. 🎉</p>'}
          ${data.para_aprovar.some((p) => p.codigo) ? '<p class="small muted" style="margin-top:6px">No WhatsApp: APROVAR código PIN.</p>' : ''}</div>
      </div>

      <div class="mp-term"><div class="mp-dots"><i></i><i></i><i></i></div>
        ${data.atividade.length ? data.atividade.map((a) => `<div><span class="t">${hhmm(a.created_at)}</span> <b>${esc(a.agent)}</b> <span>${esc(a.text)}</span></div>`).join('') : '<div class="muted">A atividade dos agentes aparece aqui assim que as rotinas rodarem.</div>'}
      </div>
      <p class="small muted">Atualizado às ${hhmm(data.gerado_em)} · atualiza sozinho a cada minuto.</p>
    </div>`;
    $$('[data-job]', c).forEach((el) => { el.onchange = async () => { try { await api('PUT', `/api/mapa/rotinas/${el.dataset.job}`, { enabled: el.checked }); toast(el.checked ? 'Rotina ligada.' : 'Rotina desligada.'); } catch (e) { fail(e); el.checked = !el.checked; } }; });
    $$('[data-run]', c).forEach((b) => { b.onclick = async () => { b.disabled = true; b.textContent = 'Rodando…'; try { const r = await api('POST', `/api/mapa/rotinas/${b.dataset.run}/rodar`); toast(r.text.replace(/\*/g, '').slice(0, 220)); await load(); } catch (e) { fail(e); b.disabled = false; b.textContent = 'Rodar agora'; } }; });
  };
  await load();
  const t = setInterval(() => { if (document.contains(c)) load().catch(() => {}); else clearInterval(t); }, 60_000);
  state?.cleanup?.push(() => clearInterval(t));
}
