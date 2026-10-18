// Provedor de DEMONSTRAÇÃO — sem IA real. Gera pareceres determinísticos a partir das evidências e cálculos
// recebidos, para testar a interface e o fluxo. Toda decisão processada por ele é identificada como demonstração.
const fmtBRL = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const fmtPct = (v) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);

function topic(q) {
  const s = (q || '').toLowerCase();
  if (/desconto|promo|cupom|%/.test(s)) return 'discount';
  if (/cancel|churn|evas/.test(s)) return 'churn';
  if (/cobran|inadimpl|receb|aberto/.test(s)) return 'billing';
  if (/suporte|infra|capacidade|chamado|atendimento/.test(s)) return 'ops';
  if (/contribui|financeir|receita|lucr|margem/.test(s)) return 'finance';
  if (/melhoria|desenvolv|roadmap|planejamento/.test(s)) return 'product';
  return 'growth';
}

function index(input) {
  const metrics = {}; const calcs = []; const docs = []; const reasons = {}; const masterCfg = {};
  for (const ev of input.evidence || []) {
    if (ev.kind === 'metrics') {
      metrics[ev.product] = { ref: ev.ref, quality: ev.quality, ...ev.data.metrics };
      if (ev.data.cancel_reasons?.length) reasons[ev.product] = { ref: ev.ref, list: ev.data.cancel_reasons };
    } else if (ev.kind === 'calculation') calcs.push(ev);
    else if (ev.kind === 'knowledge') docs.push(ev);
    else if (ev.kind === 'master_config') (masterCfg[ev.data.product] = { ref: ev.ref, ...ev.data });
  }
  const calc = (formula, product) => calcs.find((c) => c.data.formula_code === formula && c.product === product);
  const policyDoc = docs.find((d) => d.data.rules?.max_discount_pct != null);
  return { metrics, calcs, docs, reasons, calc, policyDoc, masterCfg, products: Object.keys(metrics) };
}

const val = (m, code) => (m && m[code] && m[code].value != null ? Number(m[code].value) : null);

function requestedDiscount(q) {
  const m = /(\d{1,2}(?:[.,]\d+)?)\s*%/.exec(q || '');
  return m ? Number(m[1].replace(',', '.')) : 10;
}

function base(status = 'ready') {
  return { schema_version: '1.0', status, summary: '', findings: [], recommendation: '', alternatives: [], assumptions: [], risks: [], missing_data: [], questions_for_agents: [], calculation_requests: [] };
}

function pickFocusProduct(ix) {
  // Produto com mais testes e menor conversão (maior potencial de recuperação)
  let best = null;
  for (const p of ix.products) {
    const c = ix.calc('conversion_rate', p);
    if (!c?.data.available) continue;
    const conv = Number(c.data.result.conversion_pct);
    const trials = val(ix.metrics[p], 'cohort_trials') || 0;
    const score = trials * (100 - conv);
    if (!best || score > best.score) best = { p, conv, trials, score, ref: c.ref };
  }
  return best || (ix.products[0] ? { p: ix.products[0], conv: null, trials: null, ref: ix.metrics[ix.products[0]].ref } : null);
}

// ---------- Coordenador ----------
function plan(input) {
  const t = topic(input.task.decision_question);
  const type = input.task.decision_type;
  let agents;
  const enabled = (input.available_agents || []).map((a) => a.code);
  if (isMarketing(input.task.decision_question) && enabled.includes('marketing')) agents = ['marketing', 'commercial', 'operations'];
  else if (type === 'financeiro') agents = t === 'discount' ? ['commercial', 'financial'] : ['financial', 'commercial'];
  else if (type === 'operacional') agents = ['operations', 'commercial'];
  else if (type === 'comercial') agents = ['commercial', 'financial', 'operations'];
  else agents = ['commercial', 'financial', 'operations'];
  if (t === 'ops' && !agents.includes('operations')) agents.push('operations');
  const qs = {
    commercial: 'Avalie aquisição, conversão e cancelamento por produto e proponha a ação comercial prioritária com público, prazo e indicador.',
    financial: 'Avalie receita, contribuição e viabilidade financeira; verifique os limites da política comercial vigente.',
    operations: 'Avalie a capacidade de suporte e infraestrutura para absorver a demanda estimada e aponte gargalos.',
    marketing: 'Crie a proposta de publicação para o Instagram: objetivo, público, legenda, hashtags, briefing da imagem e horário.',
  };
  if (agents[0] === 'marketing') qs.commercial = 'Valide a oferta e a mensagem do post contra os planos e a política comercial; sugira público e chamada para ação.';
  const lead = agents[0];
  return {
    schema_version: '1.0',
    objective: input.task.decision_question,
    agents: agents.map((a) => ({ agent_code: a, question: qs[a] })),
    cross_review: agents.filter((a) => a !== lead).map((a) => ({ from_agent: lead, to_agent: a, reason: `Contraponto ${a === 'financial' ? 'financeiro (margem e limites)' : a === 'operations' ? 'operacional (capacidade e esforço)' : a === 'commercial' ? 'comercial (oferta e política)' : 'de marketing'} à proposta inicial` })),
    notes: 'Plano gerado pelo provedor de demonstração.',
  };
}

// ---------- Comercial ----------
function commercialOpinion(input, ix) {
  const o = base();
  const t = topic(input.task.decision_question);
  const focus = pickFocusProduct(ix);
  for (const p of ix.products) {
    const m = ix.metrics[p];
    const s = val(m, 'active_subscriptions_at_period_start'); const e = val(m, 'active_subscriptions_at_period_end');
    const conv = ix.calc('conversion_rate', p); const churn = ix.calc('churn_rate', p);
    const parts = [];
    if (s != null && e != null) parts.push(`assinaturas ativas ${s} → ${e}`);
    if (conv?.data.available) parts.push(`conversão de testes ${fmtPct(conv.data.result.conversion_pct)}`);
    if (churn?.data.available) parts.push(`cancelamento ${fmtPct(churn.data.result.churn_pct)}`);
    if (parts.length) o.findings.push({ claim: `${p}: ${parts.join('; ')}.`, evidence_refs: [m.ref, conv?.ref, churn?.ref].filter(Boolean) });
    else { o.missing_data.push(`${p}: indicadores comerciais indisponíveis ou parciais`); o.status = 'partial'; }
  }
  if (!focus) { o.status = 'insufficient_data'; o.summary = 'Sem indicadores comerciais suficientes.'; return o; }
  const d = requestedDiscount(input.task.decision_question);
  if (t === 'discount') {
    o.summary = `Propor desconto de ${d}% no ${focus.p} focado em testes que não converteram, com prazo curto.`;
    o.recommendation = `Campanha de conversão no ${focus.p}: ${d}% de desconto por 3 meses para testes ativos há mais de 7 dias sem assinatura; meta de elevar a conversão de ${fmtPct(focus.conv)} para ${fmtPct((focus.conv || 0) + 6)}.`;
    o.assumptions.push('A conversão responde a incentivo de preço (hipótese a validar com grupo de controle).');
    o.questions_for_agents.push({ target_agent: 'financial', question: `Qual o impacto de ${d}% na contribuição por assinatura e qual volume adicional compensa a perda?` });
    o.questions_for_agents.push({ target_agent: 'operations', question: 'O suporte absorve cerca de 6 novas assinaturas no mês sem degradar a primeira resposta?' });
  } else if (t === 'churn') {
    const r = ix.reasons[focus.p] || Object.entries(ix.reasons)[0]?.[1];
    o.summary = 'Principais motivos de cancelamento identificados; propor investigação estruturada antes de incentivos.';
    if (r) o.findings.push({ claim: `Motivos declarados: ${r.list.map((x) => `${x.reason} (${x.share_pct}%)`).join(', ')}.`, evidence_refs: [r.ref] });
    o.recommendation = 'Entrevistar os clientes cancelados do período (roteiro de 5 perguntas) e criar pesquisa de saída obrigatória no fluxo de cancelamento.';
    o.missing_data.push('Motivos de cancelamento com amostra pequena; vários "não informado".');
  } else {
    o.summary = `Priorizar a conversão de testes do ${focus.p}, onde há o maior volume de testes não convertidos.`;
    o.recommendation = `1) Sequência de onboarding guiado nos 7 primeiros dias do teste do ${focus.p}; 2) contato ativo com testes no 10º dia; 3) depoimentos de clientes na página de planos. Indicador: conversão da coorte (meta +5 p.p. em 60 dias).`;
    o.alternatives.push(`Oferecer desconto temporário (${d}%) aos testes — depende de avaliação financeira.`);
    o.questions_for_agents.push({ target_agent: 'financial', question: 'Há orçamento para ações de baixo custo (onboarding e contato ativo) no trimestre?' });
    o.questions_for_agents.push({ target_agent: 'operations', question: 'O contato ativo com testes cabe na capacidade atual do atendimento?' });
  }
  o.alternatives.push('Manter o cenário atual e apenas medir a conversão por mais um ciclo.');
  o.risks.push('Efeito da ação sobre a conversão é estimativa, não resultado observado.');
  return o;
}

function commercialRevision(input, ix) {
  const prev = input.own_previous || {};
  const o = base();
  const t = topic(input.task.decision_question);
  const focus = pickFocusProduct(ix);
  const pol = ix.policyDoc?.data.rules;
  const d = requestedDiscount(input.task.decision_question);
  const challenges = input.challenges || [];
  const finCh = challenges.find((c) => c.agent === 'financial');
  const opsCh = challenges.find((c) => c.agent === 'operations');
  o.findings = (prev.findings || []).slice(0, 4);
  if (t === 'discount' && focus) {
    const allowed = pol ? Math.min(d, pol.approval_above_pct) : d;
    o.summary = `Proposta revisada após contrapontos: desconto de ${allowed}% (dentro do limite sem exceção), público restrito e medição com grupo de controle.`;
    o.recommendation = `Oferecer ${allowed}% por ${pol ? Math.min(2, pol.max_duration_months) : 2} meses apenas a testes do ${focus.p} com uso ativo (≥3 acessos), limitado a 30 ofertas, com 20% dos elegíveis como grupo de controle.`;
    if (d > allowed) o.alternatives.push(`Manter ${d}% como solicitado — exige aprovação adicional do owner pela política vigente.`);
    o.alternatives.push('Substituir desconto por 1 mês adicional de teste (sem impacto direto no preço).');
    o.assumptions.push('Limite de 30 ofertas mantém a demanda dentro da capacidade de suporte apontada pelo operacional.');
    if (pol) o.findings.push({ claim: `Política vigente: máximo ${pol.max_discount_pct}%, aprovação do owner acima de ${pol.approval_above_pct}%, duração até ${pol.max_duration_months} meses.`, evidence_refs: [ix.policyDoc.ref] });
  } else {
    o.summary = 'Proposta revisada: ações de baixo custo primeiro, escalonadas para respeitar a capacidade de atendimento.';
    o.recommendation = `${prev.recommendation || ''} Escalonar o contato ativo (máx. 10 testes/semana) e reavaliar em 30 dias.`.trim();
    o.alternatives = prev.alternatives || [];
  }
  if (finCh) o.assumptions.push(`Considerado contraponto financeiro: ${finCh.summary}`);
  if (opsCh) o.assumptions.push(`Considerado contraponto operacional: ${opsCh.summary}`);
  o.risks.push('Amostra pequena pode não permitir conclusão estatística em um ciclo.');
  o.missing_data = prev.missing_data || [];
  return o;
}

// ---------- Financeiro ----------
function financialOpinion(input, ix, isChallenge) {
  const o = base();
  const t = topic(input.task.decision_question);
  const focus = pickFocusProduct(ix);
  let totalCash = 0; let totalInfra = 0; const refs = [];
  for (const p of ix.products) {
    const m = ix.metrics[p];
    const cash = val(m, 'cash_received_in_period'); const infra = val(m, 'infra_cost');
    const contrib = ix.calc('contribution', p);
    if (cash != null) totalCash += cash;
    if (infra != null) totalInfra += infra;
    if (contrib?.data.available) {
      o.findings.push({ claim: `${p}: recebido ${fmtBRL(cash)}; contribuição conhecida ${fmtBRL(contrib.data.result.contribution)} (margem ${fmtPct(contrib.data.result.margin_pct)}).`, evidence_refs: [m.ref, contrib.ref] });
      refs.push(contrib.ref);
    } else if (m) { o.missing_data.push(`${p}: custos variáveis indisponíveis — contribuição não calculada`); o.status = 'partial'; }
  }
  const scen = focus && ix.calc('discount_scenario', focus.p);
  if (t === 'discount' && scen?.data.available) {
    const r = scen.data.result;
    o.findings.push({ claim: `Com ${scen.data.inputs.discount_pct}% no ${focus.p}: preço ${fmtBRL(r.discounted_price)}, contribuição ${fmtBRL(r.contribution_before)} → ${fmtBRL(r.contribution_after)} (−${fmtPct(r.contribution_reduction_pct)}). Volume adicional de equilíbrio ≈ ${fmtPct(r.breakeven_extra_volume_pct)}.`, evidence_refs: [scen.ref] });
    o.summary = isChallenge
      ? `A proposta reduz a contribuição por assinatura em ${fmtPct(r.contribution_reduction_pct)}; só compensa se o volume crescer ≥ ${fmtPct(r.breakeven_extra_volume_pct)} no público atingido.`
      : `Desconto viável apenas com público restrito e prazo curto; redução de contribuição de ${fmtPct(r.contribution_reduction_pct)}.`;
    o.recommendation = 'Limitar o desconto ao público de testes (não à base atual) e definir teto de ofertas; medir com grupo de controle.';
    const pol = ix.policyDoc?.data.rules;
    if (pol) {
      const d = Number(scen.data.inputs.discount_pct);
      o.findings.push({ claim: `Política: teto ${pol.max_discount_pct}%, aprovação do owner acima de ${pol.approval_above_pct}%.`, evidence_refs: [ix.policyDoc.ref] });
      if (d > pol.max_discount_pct) o.risks.push(`Desconto de ${d}% excede o teto da política — bloqueado sem revisão formal da política.`);
      else if (d > pol.approval_above_pct) o.risks.push(`Desconto de ${d}% exige aprovação do owner.`);
    }
    o.questions_for_agents.push({ target_agent: 'commercial', question: 'É possível restringir a oferta a testes com uso ativo e limitar a quantidade de ofertas?' });
  } else {
    o.summary = `Receita recebida no período (produtos com dados): ${fmtBRL(totalCash)}; custos de infraestrutura conhecidos: ${fmtBRL(totalInfra)}.`;
    o.recommendation = isChallenge
      ? 'Priorizar ações de baixo custo; qualquer incentivo de preço deve passar por simulação antes da aprovação.'
      : 'Concentrar esforço no produto com maior contribuição absoluta e evitar gastos sem indicador de retorno.';
    const open = ix.products.map((p) => [p, val(ix.metrics[p], 'open_receivables')]).filter(([, v]) => v);
    if (open.length) o.findings.push({ claim: `Valores em aberto: ${open.map(([p, v]) => `${p} ${fmtBRL(v)}`).join('; ')}.`, evidence_refs: open.map(([p]) => ix.metrics[p].ref) });
    if (t === 'billing') o.recommendation = 'Revisar manualmente as pendências de cobrança acima de 30 dias antes de qualquer contato com cliente; nenhuma mensagem automática.';
  }
  o.missing_data.push('Custos fixos e rateio de pessoal não informados — contribuição não equivale a lucro.');
  o.assumptions.push('Valores em BRL; recebimentos no regime de caixa do período.');
  return o;
}

// ---------- Operacional ----------
function operationsOpinion(input, ix, isChallenge) {
  const o = base();
  let worst = null;
  for (const p of ix.products) {
    const m = ix.metrics[p];
    const cap = ix.calc('capacity_check', p);
    const tpc = val(m, 'tickets_per_customer'); const inc = val(m, 'incidents');
    if (cap?.data.available) {
      const u = Number(cap.data.result.utilization_pct);
      o.findings.push({ claim: `${p}: ${tpc ?? '—'} chamados/cliente; utilização projetada do suporte ${fmtPct(u)}${inc ? `; ${inc} incidente(s)` : ''}.`, evidence_refs: [m.ref, cap.ref] });
      if (!worst || u > worst.u) worst = { p, u, ref: cap.ref };
    } else if (m) { o.missing_data.push(`${p}: capacidade ou chamados indisponíveis`); o.status = 'partial'; }
    const frh = m?.first_response_hours;
    if (frh && frh.quality !== 'complete') o.risks.push(`${p}: tempo de primeira resposta com cobertura parcial (${frh.note || 'monitoramento parcial'}).`);
  }
  if (!worst) { o.status = 'insufficient_data'; o.summary = 'Sem dados de suporte suficientes.'; return o; }
  const named = ix.products.find((p) => (input.task.decision_question || '').toUpperCase().includes(p));
  const namedCap = named && ix.calc('capacity_check', named);
  if (namedCap?.data.available) worst = { p: named, u: Number(namedCap.data.result.utilization_pct), ref: namedCap.ref };
  o.summary = worst.u > 90
    ? `${worst.p} está no limite da capacidade de suporte (${fmtPct(worst.u)} projetado); nova demanda precisa ser escalonada.`
    : `Capacidade de suporte comporta a demanda estimada; maior utilização no ${worst.p} (${fmtPct(worst.u)}).`;
  o.recommendation = isChallenge
    ? `Escalonar a ação (lotes semanais) e preparar artigos de ajuda antes do início; monitorar primeira resposta no ${worst.p}.`
    : `Investigar a alta taxa de chamados por cliente no ${worst.p} antes de acelerar aquisição.`;
  o.alternatives.push('Contratar atendimento temporário durante a campanha (exige aprovação de gasto).');
  o.missing_data.push('Monitoramento de infraestrutura parcial — não equivale a SLA.');
  o.questions_for_agents.push({ target_agent: 'commercial', question: 'Qual o volume máximo de novos clientes esperado por semana?' });
  return o;
}

export function isMasterTopic(q) { if (/desconto|cupom|instagram|\bpost\b/i.test(q || '')) return false; return /\bmaster\b|per[ií]odo de teste|teste gr[aá]tis|\btrial\b|car[eê]ncia|reajust|pre[çc]o do plano|\bplanos?\b/i.test(q || ''); }

// ---------- Marketing ----------
export function isMarketing(q) { return /instagram|post\b|posts\b|publica|marketing|divulga|rede social|redes sociais/i.test(q || ''); }
const PITCH = {
  ORBI: { segment: 'salões de beleza e barbearias', line: 'Agenda online, caixa e comissões do seu salão ou barbearia em um só lugar.', tags: ['salaodebeleza', 'barbearia', 'agendaonline', 'gestaodesalao', 'empreendedorismo'] },
  TORVEN: { segment: 'oficinas, serralherias e assistências técnicas', line: 'Ordens de serviço, orçamentos e histórico de reparos da sua oficina organizados do primeiro contato à entrega.', tags: ['serralheria', 'soldagem', 'assistenciatecnica', 'ordemdeservico', 'oficina'] },
  RUSTEN: { segment: 'bares e restaurantes', line: 'Pedidos, comandas e caixa do seu bar ou restaurante na palma da mão — menos fila, mais giro de mesa.', tags: ['restaurante', 'bar', 'gestaoderestaurante', 'pdv', 'foodservice'] },
  APOLVEN: { segment: 'pequenos negócios', line: 'Gestão simples para o dia a dia do seu negócio.', tags: ['gestao', 'pequenasempresas', 'empreendedorismo'] },
};
function mkProduct(input, ix) {
  const q = (input.task.decision_question || '').toUpperCase();
  return Object.keys(PITCH).find((p) => q.includes(p)) || ix.products[0] || 'ORBI';
}
function marketingOpinion(input, ix) {
  const o = base();
  const p = mkProduct(input, ix); const pitch = PITCH[p] || PITCH.APOLVEN;
  const conv = ix.calc('conversion_rate', p);
  if (conv?.data.available) o.findings.push({ claim: `${p}: conversão de testes em ${fmtPct(conv.data.result.conversion_pct)} — o post deve levar ao teste grátis.`, evidence_refs: [conv.ref] });
  const price = ix.docs.find((d) => /planos e preços/i.test(d.data.title || ''));
  if (price) o.findings.push({ claim: 'Planos e preços vigentes consultados para não divulgar condição diferente.', evidence_refs: [price.ref] });
  const caption = `${pitch.line}\n\nCom o ${p} você acompanha tudo pelo celular, sem planilhas e sem papel.\n\n👉 Teste grátis: link na bio.`;
  o.summary = `Post de feed para ${pitch.segment} levando ao teste grátis do ${p}, sem citar números internos nem descontos.`;
  o.recommendation = `Publicar 1 post no feed do Instagram do ${p} (imagem única) em dia útil à noite, com chamada para o teste grátis.`;
  o.alternatives.push('Carrossel com 3 telas do sistema (exige produção de mais imagens).', 'Reels curto de 15 s mostrando a agenda/pedidos (maior alcance, maior esforço).');
  o.assumptions.push('Público-alvo segue os horários de maior atividade no fim do dia.', 'A imagem será produzida pela equipe a partir do briefing.');
  o.risks.push('Aumento de cadastros pode pressionar o suporte em horário comercial.');
  o.questions_for_agents.push({ target_agent: 'commercial', question: 'A chamada para teste grátis está alinhada aos planos vigentes? Podemos mencionar alguma condição?' });
  o.questions_for_agents.push({ target_agent: 'operations', question: 'O suporte absorve novos testes gerados pelo post nesta semana?' });
  o.content_draft = {
    channel: 'instagram_feed', objective: `Gerar cadastros no teste grátis do ${p}`, audience: `Donos e gestores de ${pitch.segment}`,
    caption, hashtags: [p.toLowerCase(), ...pitch.tags, 'lorler'].slice(0, 8), call_to_action: 'Teste grátis — link na bio',
    image_brief: `Foto/mockup de celular exibindo a tela principal do ${p} sobre bancada de ${pitch.segment.split(',')[0]}; logotipo ${p} no canto; texto curto “Gestão na palma da mão”. Formato 1080×1350 (4:5), JPEG.`,
    suggested_time: 'Terça ou quinta, entre 19h e 20h',
  };
  return o;
}
function commercialChallenge(input, ix) {
  const o = base();
  const prop = input.proposal_under_review || {};
  const pol = ix.policyDoc?.data.rules;
  const draft = prop.content_draft || {};
  o.summary = 'Oferta alinhada ao teste grátis; incluir menção aos planos sem fixar preço no post e evitar superlativos.';
  if (pol) o.findings.push({ claim: `Política comercial: descontos só até ${pol.max_discount_pct}% com aprovação acima de ${pol.approval_above_pct}% — o post não deve anunciar desconto.`, evidence_refs: [ix.policyDoc.ref] });
  if (/\d+\s*%/.test(draft.caption || '')) o.risks.push('Legenda cita percentual de desconto — remover ou submeter à política comercial.');
  o.recommendation = 'Manter a chamada “teste grátis”, acrescentar “planos a partir do essencial” sem valores e direcionar para o link da bio com UTM do Instagram.';
  o.assumptions.push('Preços podem mudar; post sem valores evita divergência.');
  return o;
}
function marketingRevision(input, ix) {
  const prev = input.own_previous || {};
  const o = base();
  const d = { ...(prev.content_draft || {}) };
  const opsCh = (input.challenges || []).find((c) => c.agent === 'operations');
  const comCh = (input.challenges || []).find((c) => c.agent === 'commercial');
  const lines = String(d.caption || '').replace(/\n\n👉.*$/s, '');
  d.caption = `${lines}\n\nPlanos que cabem no seu negócio — conheça na bio.\n👉 Teste grátis, sem cartão. Atendimento em horário comercial.`;
  if (opsCh) d.suggested_time = `${d.suggested_time || 'Terça, 19h'} — um post por semana enquanto o suporte estiver próximo do limite`;
  o.findings = (prev.findings || []).slice(0, 3);
  o.summary = 'Conteúdo revisado: sem valores ou descontos, com expectativa de atendimento clara e ritmo de publicação compatível com o suporte.';
  o.recommendation = `Publicar o post revisado no feed (${d.suggested_time}).`;
  if (comCh) o.assumptions.push(`Considerado contraponto comercial: ${comCh.summary}`);
  if (opsCh) o.assumptions.push(`Considerado contraponto operacional: ${opsCh.summary}`);
  o.alternatives = prev.alternatives || [];
  o.risks = ['Resultado de alcance e cadastros é estimativa.', ...(prev.risks || [])].slice(0, 4);
  o.content_draft = d;
  return o;
}

// ---------- Síntese ----------
function synthesis(input, ix) {
  const t = topic(input.task.decision_question);
  const ops = input.peer_opinions || [];
  const final = [...ops].reverse().find((x) => (x.agent === 'commercial' || x.agent === 'marketing') && x.kind === 'revision') || ops.find((x) => x.agent === 'marketing' || x.agent === 'commercial') || ops[0] || {};
  const focus = pickFocusProduct(ix);
  const pol = ix.policyDoc?.data.rules;
  const d = requestedDiscount(input.task.decision_question);
  const allowed = pol ? Math.min(d, pol.approval_above_pct) : d;
  const relevant = ops.flatMap((x) => (x.findings || []).slice(0, 2)).slice(0, 6);
  const missing = [...new Set(ops.flatMap((x) => x.missing_data || []))].slice(0, 6);
  const risks = [...new Set(ops.flatMap((x) => x.risks || []))].slice(0, 6);
  const divergences = [];
  if (t === 'discount' && d > allowed) divergences.push(`Comercial iniciou com ${d}%; financeiro e política limitam a ${allowed}% sem aprovação extra.`);
  const opsOp = ops.find((x) => x.agent === 'operations');
  if (opsOp && /limite/.test(opsOp.summary || '')) divergences.push(`Operacional alerta capacidade no limite; comercial aceitou escalonar, mas o risco permanece.`);
  if (!divergences.length) divergences.push('Sem divergência material; concordância entre agentes não comprova a correção da proposta.');

  let action;
  const mq = input.task.decision_question || '';
  const mProd = (ix.products.find((p) => mq.toUpperCase().includes(p)) || focus?.p || ix.products[0] || '').toLowerCase();
  const mc = ix.masterCfg[mProd];
  if (mc && isMasterTopic(mq)) {
    let tool; let params; let title;
    if (/carência|carencia/i.test(mq)) { tool = 'master_update_settings'; params = { product: mProd, values: { grace_days: Number(mc.settings.grace_days ?? 5) + 2 } }; title = `Ampliar carência do ${mProd.toUpperCase()} para ${params.values.grace_days} dias`; }
    else if (/teste|trial/i.test(mq)) { const next = mc.settings.trial_default === '30_DAYS' ? '15_DAYS' : '30_DAYS'; tool = 'master_update_settings'; params = { product: mProd, values: { trial_default: next } }; title = `Teste grátis do ${mProd.toUpperCase()}: ${next === '30_DAYS' ? '30 dias' : '15 dias'}`; }
    else { const pl = mc.plans.find((x) => x.active) || mc.plans[0]; const np = Math.round(Number(pl.monthly_price) * 1.05 * 100) / 100; tool = 'master_update_plan'; params = { product: mProd, plan_id: pl.id, changes: { monthly_price: np } }; title = `Reajustar plano ${pl.name} do ${mProd.toUpperCase()} para R$ ${np.toFixed(2).replace('.', ',')}`; }
    action = { tool_code: tool, title, description: `Mudança proposta na Área Master após análise dos agentes. ${final.recommendation || ''}`.trim(), product_code: mProd.toUpperCase(), target: `Área Master · ${mProd.toUpperCase()}`, parameters_json: JSON.stringify(params), max_amount: '0.00', due_in_days: 7 };
    relevant.push({ claim: `Configuração atual da Área Master (${mProd.toUpperCase()}): teste ${mc.settings.trial_default}, carência ${mc.settings.grace_days} dias, plano principal R$ ${mc.plans[0]?.monthly_price}.`, evidence_refs: [mc.ref] });
  }
  const mkFinal = [...ops].reverse().find((x) => x.agent === 'marketing' && x.content_draft);
  if (action) { /* mudança na Área Master já definida */ } else if (isMarketing(input.task.decision_question) && mkFinal) {
    const dr = mkFinal.content_draft;
    action = {
      tool_code: 'publish_instagram_post',
      title: `Post no Instagram — ${dr.objective || 'divulgação'}`,
      description: mkFinal.recommendation || '',
      product_code: mkProduct(input, ix),
      target: `Feed do Instagram vinculado · público: ${dr.audience || '—'}`,
      parameters_json: JSON.stringify({ caption: dr.caption, hashtags: dr.hashtags, image_url: '', image_brief: dr.image_brief, suggested_time: dr.suggested_time, call_to_action: dr.call_to_action }),
      max_amount: '0.00',
      due_in_days: 7,
    };
  } else if (t === 'discount' && focus) {
    action = {
      tool_code: 'change_price_or_discount',
      title: `Desconto de ${allowed}% para testes ativos do ${focus.p}`,
      description: final.recommendation || '',
      product_code: focus.p,
      target: `Testes ativos do ${focus.p} com ≥3 acessos (máx. 30 ofertas)`,
      parameters_json: JSON.stringify({ discount_pct: allowed, duration_months: 2, max_offers: 30, control_group_pct: 20 }),
      max_amount: '0.00',
      due_in_days: 14,
    };
  } else {
    action = {
      tool_code: 'create_internal_task',
      title: t === 'churn' ? 'Investigar motivos de cancelamento do período' : `Plano de conversão de testes — ${focus?.p || 'produtos'}`,
      description: final.recommendation || 'Executar as ações priorizadas pelo relatório.',
      product_code: focus?.p || '',
      target: 'Equipe LORLER',
      parameters_json: JSON.stringify({ priority: 'alta', checklist: (final.recommendation || '').split(/\d\)\s*/).filter(Boolean).slice(0, 5) }),
      max_amount: '0.00',
      due_in_days: 14,
    };
  }
  return {
    schema_version: '1.0',
    status: missing.length > 3 ? 'partial' : 'ready',
    problem: input.task.decision_question,
    diagnosis: Object.values(Object.fromEntries(ops.map((x) => [x.agent, x]))).map((x) => `${x.agent_name || x.agent}: ${x.summary}`).join(' '),
    proposal: final.recommendation || 'Sem proposta consolidada.',
    alternatives: [...new Set(ops.flatMap((x) => x.alternatives || []))].slice(0, 4),
    relevant_data: relevant,
    assumptions: [...new Set(ops.flatMap((x) => x.assumptions || []))].slice(0, 5),
    divergences,
    risks,
    missing_data: missing,
    next_steps: ['Aprovar ou ajustar a proposta pelo responsável competente.', 'Definir indicador e data de revisão do resultado.', 'Completar os dados ausentes listados.'],
    approver_hint: action.tool_code.startsWith('master_') ? 'owner (alteração na Área Master)' : action.tool_code === 'publish_instagram_post' ? 'owner (publicação externa)' : t === 'discount' ? 'owner (alteração comercial)' : 'owner ou manager',
    action_proposal: action,
  };
}

export class DemoAdapter {
  constructor() { this.name = 'demo'; }
  async validateConfiguration() { return { valid: true, reason: 'Provedor de demonstração (sem IA real).' }; }
  async analyze(req) {
    if (process.env.LORLER_DEMO_FAST !== '1') await new Promise((r) => setTimeout(r, 350 + Math.floor(Math.random() * 500))); // ritmo visual da demonstração
    const input = req.input; const ix = index(input); const k = input.task.kind;
    let output;
    if (req.agentCode === 'coordinator') output = k === 'plan' ? plan(input) : synthesis(input, ix);
    else if (req.agentCode === 'commercial') output = k === 'revision' ? commercialRevision(input, ix) : k === 'challenge' ? commercialChallenge(input, ix) : commercialOpinion(input, ix);
    else if (req.agentCode === 'marketing') output = k === 'revision' ? marketingRevision(input, ix) : marketingOpinion(input, ix);
    else if (req.agentCode === 'financial') output = financialOpinion(input, ix, k === 'challenge');
    else if (req.agentCode === 'operations') output = operationsOpinion(input, ix, k === 'challenge');
    else return { status: 'error', error: 'Agente desconhecido para o provedor de demonstração.' };
    const outTokens = JSON.stringify(output).length / 4 | 0;
    return { status: 'ok', output, providerRequestId: `demo-${Date.now().toString(36)}`, usage: { inputTokens: JSON.stringify(input).length / 4 | 0, outputTokens: outTokens } };
  }
}
