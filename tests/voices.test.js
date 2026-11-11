// Vozes do assistente: fala natural (texto → fala), motores neurais (OpenAI e ElevenLabs) e configurações.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { orgA, createUser, login, stopServer, startServer } from './helpers.js';
const raw = async (c, method, path, body) => fetch(`${await startServer()}${path}`, { method, headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrf }, body: JSON.stringify(body) });
import { speechText, sentences, extenso } from '../public/speech.js';

process.env.ELEVENLABS_API_KEY = 'el-test-key';
process.env.OPENAI_API_KEY = 'sk-test-key';
createUser(orgA, 'voz.owner@lorler.test', 'owner');
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.elevenlabs.io/v1/voices')) {
    calls.push({ u, opts });
    return new Response(JSON.stringify({ voices: [
      { voice_id: 'AbCdEfGh12345678', name: 'Rachel', labels: { gender: 'female', accent: 'american' }, category: 'premade' },
      { voice_id: 'PtBr1234567890ab', name: 'Ana', labels: { gender: 'female', accent: 'brazilian portuguese' }, category: 'professional' },
      { voice_id: 'bad id!', name: 'X' },
    ] }), { status: 200 });
  }
  if (u.startsWith('https://api.elevenlabs.io/v1/text-to-speech/') || u.startsWith('https://api.openai.com/v1/audio/speech')) {
    calls.push({ u, opts });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  return realFetch(url, opts);
};
after(() => { globalThis.fetch = realFetch; delete process.env.ELEVENLABS_API_KEY; delete process.env.OPENAI_API_KEY; stopServer(); });

test('fala natural: reais, porcentagens, datas, horas e nomes dos sistemas por extenso', () => {
  assert.equal(extenso(1500), 'mil e quinhentos');
  assert.equal(extenso(2030), 'dois mil e trinta');
  const t = speechText('O ORBI faturou R$ 12.345,67 em 11/11/2026, alta de 12,5% 🚀. Fecha às 14:30 — veja lorler.com.br');
  assert.match(t, /Órbi faturou doze mil trezentos e quarenta e cinco reais e sessenta e sete centavos/);
  assert.match(t, /onze de novembro de dois mil e vinte e seis/);
  assert.match(t, /doze vírgula cinco por cento/);
  assert.match(t, /quatorze horas e trinta/);
  assert.match(t, /Lórler ponto com ponto bê érre/);
  assert.ok(!/🚀|R\$|%/.test(t));
  assert.equal(speechText('R$ 1,00'), 'um real');
  assert.deepEqual(sentences('Certo. O mês foi bom, puxado pelo ORBI. Quer detalhes?'), ['Certo. O mês foi bom, puxado pelo ORBI.', 'Quer detalhes?']);
});

test('configuração de voz: motores, estilos e opções saneados', async () => {
  const c = await login('voz.owner@lorler.test');
  const g = await c.call('GET', '/api/assistant');
  assert.deepEqual(g.body.tts_engines, { openai: true, elevenlabs: true });
  assert.ok(g.body.options.openai_voices.includes('marin'));
  assert.ok(g.body.options.voice_styles.includes('calorosa'));
  assert.equal(g.body.settings.voice.fillers, true);
  const p = await c.call('PUT', '/api/assistant', { voice: { engine: 'elevenlabs', eleven_voice: 'PtBr1234567890ab', eleven_name: 'Ana<script>', style: 'calorosa', fillers: false, barge_in: false } });
  assert.equal(p.body.settings.voice.engine, 'elevenlabs');
  assert.equal(p.body.settings.voice.eleven_voice, 'PtBr1234567890ab');
  assert.ok(!p.body.settings.voice.eleven_name.includes('<'));
  assert.equal(p.body.settings.voice.fillers, false);
  const bad = await c.call('PUT', '/api/assistant', { voice: { engine: 'robo', eleven_voice: '../x', style: 'gritando' } });
  assert.equal(bad.body.settings.voice.engine, 'browser');
  assert.equal(bad.body.settings.voice.eleven_voice, '');
  assert.equal(bad.body.settings.voice.style, 'calorosa', 'mantém o estilo anterior');
});

test('ElevenLabs: lista as vozes (português primeiro) e fala sem expor a chave', async () => {
  const c = await login('voz.owner@lorler.test');
  const v = await c.call('GET', '/api/tts/voices');
  assert.equal(v.status, 200);
  assert.equal(v.body.voices.length, 2);
  assert.equal(v.body.voices[0].name, 'Ana');
  assert.equal(v.body.voices[0].pt, true);
  assert.ok(!JSON.stringify(v.body).includes('el-test-key'));
  const r = await raw(c, 'POST', '/api/tts', { text: 'Oi, tudo bem?', engine: 'elevenlabs', voice: 'PtBr1234567890ab', rate: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  const last = calls.at(-1);
  assert.match(last.u, /text-to-speech\/PtBr1234567890ab/);
  assert.equal(last.opts.headers['xi-api-key'], 'el-test-key');
  assert.equal(JSON.parse(last.opts.body).model_id, 'eleven_multilingual_v2');
});

test('OpenAI: a voz recebe o estilo e o jeito de falar como instrução', async () => {
  const c = await login('voz.owner@lorler.test');
  const r = await raw(c, 'POST', '/api/tts', { text: 'Boa notícia!', engine: 'openai', voice: 'marin', style: 'animada' });
  assert.equal(r.status, 200);
  const b = JSON.parse(calls.at(-1).opts.body);
  assert.equal(b.voice, 'marin');
  assert.match(b.instructions, /animado/);
  assert.match(b.instructions, /português do Brasil/);
});
