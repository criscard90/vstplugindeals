/**
 * sw.js — service worker della PWA.
 *
 * Strategia:
 *  - shell dell'app (HTML, CSS, JS, icone): cache-first, così la PWA si apre
 *    istantaneamente e funziona offline;
 *  - dati dei deal: network-first con fallback in cache, perché una copia
 *    vecchia è comunque più utile di una lista vuota.
 */

const VERSION = 'v2.0.4';
const SHELL_CACHE = `plugin-deals-shell-${VERSION}`;
const DATA_CACHE = `plugin-deals-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './parser.js',
  './manifest.json',
  './deals.json',
  './icons/favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('plugin-deals-') && key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** Network-first: usa la rete, in caso di fallimento usa la copia in cache. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Solo risposte valide: un errore 502/403 del proxy non deve essere messo in cache.
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

/** Cache-first per i file statici, con aggiornamento silenzioso in background. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
      })
      .catch(() => { /* offline: si tiene la copia in cache */ });
    return cached;
  }
  return networkFirst(request, cacheName);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Navigazioni: prima la rete, poi la shell in cache (la PWA resta apribile offline).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Dati dei deal: richieste verso il worker o verso il file locale deals.json.
  if (url.origin !== self.location.origin || url.pathname.endsWith('/deals.json')) {
    event.respondWith(
      networkFirst(request, DATA_CACHE).catch(
        () =>
          new Response(JSON.stringify({ ok: false, error: 'Offline: nessuna copia dei dati salvata.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    return;
  }

  event.respondWith(cacheFirst(request, SHELL_CACHE));
});
