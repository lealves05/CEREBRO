// Texto → fala natural em português do Brasil. Usado no navegador (todas as vozes) e nos testes.
// Converte valores em reais, porcentagens, datas e siglas para o jeito que uma pessoa fala, tira emojis e símbolos,
// e divide a resposta em frases (cada frase sai com a sua entonação e uma pausa curta, como numa conversa).

const UN = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CEM = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function ate999(n) {
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100); const r = n % 100; const parts = [];
  if (c) parts.push(CEM[c]);
  if (r) parts.push(r < 20 ? UN[r] : DEZ[Math.floor(r / 10)] + (r % 10 ? ` e ${UN[r % 10]}` : ''));
  return parts.join(' e ');
}

/** Número inteiro por extenso (até centenas de bilhões). */
export function extenso(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'zero';
  const grupos = [['bilhão', 'bilhões'], ['milhão', 'milhões'], ['mil', 'mil'], ['', '']];
  const vals = [Math.floor(n / 1e9) % 1000, Math.floor(n / 1e6) % 1000, Math.floor(n / 1e3) % 1000, n % 1000];
  const out = [];
  vals.forEach((v, i) => {
    if (!v) return;
    if (i === 2 && v === 1) { out.push('mil'); return; }
    out.push(`${ate999(v)}${grupos[i][0] ? ` ${v === 1 ? grupos[i][0] : grupos[i][1]}` : ''}`);
  });
  // "mil e quinhentos", "dois mil e trinta"; "um milhão, duzentos mil e cem"
  const last = vals[3];
  if (out.length > 1 && last && (last < 100 || last % 100 === 0)) return `${out.slice(0, -1).join(', ')} e ${out[out.length - 1]}`;
  return out.join(', ').replace(/, (?=[^,]*$)/, out.length > 1 && !last ? ' e ' : ' ');
}

const brNum = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));

function reais(raw) {
  const v = brNum(raw); if (!Number.isFinite(v)) return raw;
  const r = Math.floor(v); const c = Math.round((v - r) * 100);
  const big = r >= 1e6 && r % 1e6 === 0 ? ' de' : '';
  const pr = r ? `${extenso(r)}${big} ${r === 1 ? 'real' : 'reais'}` : '';
  const pc = c ? `${extenso(c)} ${c === 1 ? 'centavo' : 'centavos'}` : '';
  return [pr, pc].filter(Boolean).join(' e ') || 'zero reais';
}

function decimal(raw) {
  const [i, d] = String(raw).replace(/\./g, '').split(',');
  if (!d) return extenso(Number(i));
  return `${extenso(Number(i))} vírgula ${d.length <= 2 ? extenso(Number(d)) : d.split('').map((x) => UN[x]).join(' ')}`;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// pronúncia de nomes e siglas que as vozes costumam errar
const FIX = [
  [/\bORBI\b/gi, 'Órbi'], [/\bANIBI\b/gi, 'Aníbi'], [/\bTORVEN\b/gi, 'Tórven'], [/\bRUSTEN\b/gi, 'Rústen'], [/\bAPOLVEN\b/gi, 'Apólven'],
  [/\bCIFREN\b/gi, 'Cífren'], [/\bLORLER\b/gi, 'Lórler'], [/\bWhatsApp\b/gi, 'uótsápi'], [/\bPDV\b/g, 'pê dê vê'], [/\bDRE\b/g, 'dê érre é'],
  [/\bOS\b/g, 'ó ésse'], [/\bQR\b/g, 'quiú ár'], [/\bPix\b/gi, 'píks'], [/\bKPIs?\b/g, 'indicadores'], [/\bMRR\b/g, 'receita recorrente mensal'],
  [/\bNFC-e\b/gi, 'nota fiscal de consumidor'], [/\bNFS-e\b/gi, 'nota fiscal de serviço'], [/\bNF-e\b/gi, 'nota fiscal eletrônica'],
  [/\bCNPJ\b/g, 'cê ene pê jota'], [/\bCPF\b/g, 'cê pê éfe'], [/\bLGPD\b/g, 'éle gê pê dê'], [/\bIA\b/g, 'i á'], [/\bAPI\b/g, 'a pê i'],
  [/\bvs\.?\b/gi, 'contra'], [/\bobs\.?:?/gi, 'observação:'], [/\bp\/\b/gi, 'para'], [/\bq\b/g, 'que'], [/\bvc\b/gi, 'você'], [/\btb\b/gi, 'também'],
];

/** Converte o texto para o jeito falado. */
export function speechText(text) {
  let t = String(text || '');
  t = t.replace(/\[SEM SUPORTE\]/g, '')
    .replace(/https?:\/\/\S+/g, 'o link na tela')
    .replace(/\b([a-z0-9-]+)\.com\.br\b/gi, '$1 ponto com ponto bê érre')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*_~`#>|]/g, ' ')
    .replace(/\s*[→⇒➜]\s*/g, ', depois, ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\(([^)]{1,80})\)/g, ', $1,');
  for (const [a, b] of FIX) t = t.replace(a, b);
  // R$ 1.234,56 · R$ 2 mil · R$ 1,5 milhão
  t = t.replace(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s*(mil|milhão|milhões|bi|bilhão|bilhões)\b/gi, (_, n, u) => `${decimal(n)} ${u.toLowerCase() === 'bi' ? 'bilhões' : u.toLowerCase()} de reais`);
  t = t.replace(/R\$\s?(-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|-?\d+(?:,\d{1,2})?)/g, (_, n) => (n.startsWith('-') ? 'menos ' : '') + reais(n.replace('-', '')));
  // 12,5% · 30%
  t = t.replace(/(-?\d+(?:,\d+)?)\s?%/g, (_, n) => `${n.startsWith('-') ? 'menos ' : ''}${decimal(n.replace('-', ''))} por cento`);
  // datas 11/11/2026 e 11/11
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, d, mo, y) => (mo >= 1 && mo <= 12 ? `${d === '1' || d === '01' ? 'primeiro' : extenso(d)} de ${MESES[mo - 1]} de ${extenso(y)}` : m));
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (m, d, mo) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${d === '1' || d === '01' ? 'primeiro' : extenso(d)} de ${MESES[mo - 1]}` : m));
  // horas 14:30 · 9h · 9h30
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${extenso(h)} ${Number(h) === 1 ? 'hora' : 'horas'}${Number(m) ? ` e ${extenso(m)}` : ''}`);
  t = t.replace(/\b(\d{1,2})h(\d{2})?\b/g, (_, h, m) => `${extenso(h)} ${Number(h) === 1 ? 'hora' : 'horas'}${m && Number(m) ? ` e ${extenso(m)}` : ''}`);
  // 2x, 3º
  t = t.replace(/\b(\d+)\s?x\b/gi, (_, n) => `${extenso(n)} vezes`).replace(/\b1º\b/g, 'primeiro').replace(/\b2º\b/g, 'segundo').replace(/\b3º\b/g, 'terceiro');
  // números soltos: 1.234 · 12,5
  t = t.replace(/\b\d{1,3}(?:\.\d{3})+(?:,\d+)?\b|\b\d+,\d+\b/g, (n) => decimal(n));
  return t.replace(/\s+([,.!?;:])/g, '$1').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
}

/** Divide em frases curtas para falar uma de cada vez (máx. ~220 caracteres cada). */
export function sentences(text, max = 220) {
  const raw = String(text || '').split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of raw) {
    if (s.length <= max) { out.push(s); continue; }
    let cur = '';
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      if ((cur + ' ' + part).trim().length > max && cur) { out.push(cur.trim()); cur = part; } else cur = `${cur} ${part}`;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  // junta frases muito curtas ("Certo.") com a seguinte, para não picotar
  const merged = [];
  for (const s of out) { if (merged.length && merged[merged.length - 1].length < 18) merged[merged.length - 1] += ` ${s}`; else merged.push(s); }
  return merged;
}

// frases de "estou pensando", como uma pessoa faria (ditas só quando a resposta demora)
export const FILLERS = ['Deixa eu ver.', 'Hum, só um instante.', 'Boa pergunta, deixa eu olhar.', 'Já te falo.', 'Um segundinho.', 'Vou conferir aqui.'];
export const ACKS = ['Pois não?', 'Oi, pode falar.', 'Tô ouvindo.', 'Diga.'];
