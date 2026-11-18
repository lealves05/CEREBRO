// Service worker do Cérebro (app instalável no celular). Guarda só a "casca" do painel para abrir rápido;
// dados (/api) nunca ficam em cache — sempre vêm do servidor.
const CACHE = 'cerebro-casca-20261117a';
const CASCA = ['/', '/index.html', '/style.css', '/app.js', '/jarvis.js', '/marketing.js', '/mapa.js', '/neural.js', '/avatar.js', '/speech.js', '/hud.js', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/healthz') return;
  // rede primeiro (versão nova sempre), cache só se a internet cair
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/index.html'))));
});
