/**
 * app.js — logica della PWA.
 *
 * Flusso dei dati, in ordine di affidabilita':
 *   1. cache locale (localStorage): mostra subito l'ultima lista buona;
 *   2. worker (JSON gia' parsato): la fonte primaria;
 *   3. proxy del worker + parser nel browser: piano di riserva;
 *   4. cache locale + avviso: se la rete e' morta non si perde nulla.
 *
 * Lo scraping vero e proprio avviene in worker.js; parser.js e' condiviso.
 */

import { parseDeals } from './parser.js';

const CONFIG = {
  // Worker da pubblicare con `npm run deploy` (sostituisce il vecchio proxy).
  workerUrl: 'https://vstdeals.ccmixmastering.workers.dev/',
  // Sorgite dei dati, usata dal piano di riserva via proxy.
  sourceUrl: 'https://www.audiopluginguy.com/deals/',
  storagePrefix: 'pd.',
  requestTimeoutMs: 20000,
  // Oltre questa eta' la copia in cache viene considerata "vecchia".
  cacheFreshMinutes: 60,
};

/* ------------------------------------------------------------------ stato */

const state = {
  deals: [],
  seen: readSet('seen'),
  redeemed: readSet('redeemed'),
  ignored: readSet('ignored'),
  filter: 'all',
  search: '',
  freeOnly: true,
  meta: null,
  loading: false,
};

const el = {};
const cardEls = new Map();

/* ------------------------------------------------------- storage sicuro */

function readSet(name) {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG.storagePrefix + name) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function writeSet(name, set) {
  try {
    localStorage.setItem(CONFIG.storagePrefix + name, JSON.stringify([...set]));
  } catch (error) {
    console.warn('Salvataggio su localStorage fallito', error);
  }
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG.storagePrefix + 'cache') || 'null');
    return raw && Array.isArray(raw.deals) && raw.deals.length ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    localStorage.setItem(CONFIG.storagePrefix + 'cache', JSON.stringify(payload));
  } catch (error) {
    console.warn('Cache non salvata', error);
  }
}

/* ------------------------------------------------------------------ rete */

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Piano 0: deals.json statico presente nel repository (aggiornato da GitHub Actions). */
async function fetchLocalDeals() {
  const url = './deals.json?t=' + Math.floor(Date.now() / 60000); // cache bust ogni minuto
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.ok || !Array.isArray(data.deals) || !data.deals.length) {
    throw new Error('deals.json locale non disponibile o non valido.');
  }
  return { deals: data.deals, meta: { ...data, source: 'audiopluginguy.com (deals.json)' } };
}

/** Piano 1: il worker restituisce gia' il JSON dei deal. */
async function fetchFromWorker(force) {
  const url = new URL(CONFIG.workerUrl);
  if (force) url.searchParams.set('refresh', '1');

  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => null);

  if (!data) throw new Error(`Risposta non JSON dal worker (HTTP ${response.status}).`);
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Il worker ha risposto HTTP ${response.status}.`);
  }
  if (!Array.isArray(data.deals) || !data.deals.length) {
    throw new Error('Il worker non ha restituito alcun deal.');
  }
  return { deals: data.deals, meta: data };
}

/** Piano 2: si scarica l'HTML dal worker e si parsa qui nel browser. */
async function fetchViaProxy() {
  const url = CONFIG.workerUrl + '?url=' + encodeURIComponent(CONFIG.sourceUrl);
  const response = await fetchWithTimeout(url, { headers: { Accept: 'text/html' } });

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json()).error || '';
    } catch { /* la risposta non era JSON: si usa il solo status */ }
    throw new Error(`Proxy HTTP ${response.status}${detail ? ': ' + detail : ''}.`);
  }

  const html = await response.text();
  const { deals, stats } = parseDeals(html);
  if (!deals.length) throw new Error('HTML ricevuto dal proxy ma nessun deal riconosciuto.');
  return { deals, meta: { source: '', stats, fetchedAt: new Date().toISOString() } };
}

/* ------------------------------------------------------------- rendering */

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Etichetta dell'ultimo aggiornamento in ora italiana (Europe/Rome), indipendentemente
 * dal fuso del visitatore: "oggi alle 01:04", "ieri alle 23:10", "28 set alle 16:42".
 */
function updatedAtLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Rome',
  });
  // Confronto dei giorni in fuso italiano tramite chiave YYYY-MM-DD.
  const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  const thatDay = dayKey(date);
  if (thatDay === dayKey(new Date())) return `oggi alle ${time}`;
  if (thatDay === dayKey(new Date(Date.now() - 86400000))) return `ieri alle ${time}`;
  const day = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' });
  return `${day} alle ${time}`;
}

/** Una sola fonte di verita' per l'etichetta di stato (era duplicata in 3 punti). */
function statusLabel(id) {
  if (state.ignored.has(id)) return 'NON INTERESSA';
  if (state.redeemed.has(id)) return 'RISCATTATO';
  if (state.seen.has(id)) return 'VISTO';
  return 'GRATUITO';
}

function applyDealClasses(card, id) {
  card.classList.toggle('card-seen', state.seen.has(id));
  card.classList.toggle('card-redeemed', state.redeemed.has(id));
  card.classList.toggle('card-ignored', state.ignored.has(id));
  const label = card.querySelector('.deal-status');
  if (label) label.textContent = statusLabel(id);
}

function buildCard(deal) {
  const card = document.createElement('article');
  card.className = 'deal-card';
  card.dataset.id = deal.id;

  const status = document.createElement('div');
  status.className = 'deal-status developer';
  status.textContent = statusLabel(deal.id);

  const title = document.createElement('h2');
  title.className = 'deal-title';
  title.textContent = deal.title; // textContent: il dato scrapato non viene mai iniettato come HTML

  const meta = document.createElement('div');
  meta.className = 'deal-meta';

  if (deal.developer) {
    const dev = document.createElement('span');
    dev.className = 'deal-developer';
    dev.textContent = deal.developer;
    meta.appendChild(dev);
  }
  if (deal.discount != null) {
    const disc = document.createElement('span');
    disc.className = 'pill pill-discount';
    disc.textContent = deal.free ? 'GRATUITO' : `-${deal.discount}%`;
    meta.appendChild(disc);
  }
  for (const badge of deal.badges || []) {
    if (badge.kind === 'freebie' || badge.kind === 'default') continue;
    const span = document.createElement('span');
    span.className = `pill pill-${badge.kind}`;
    span.textContent = badge.label.replace(/^[^\p{L}\p{N}]+/u, '');
    meta.appendChild(span);
  }
  if (deal.ends) {
    const ends = document.createElement('span');
    ends.className = 'deal-date';
    ends.textContent = `scade ${formatDate(deal.ends)}`;
    meta.appendChild(ends);
  }
  if (deal.dateAdded) {
    const added = document.createElement('span');
    added.className = 'deal-date';
    added.textContent = `inserito ${formatDate(deal.dateAdded)}`;
    meta.appendChild(added);
  }

  const actions = document.createElement('div');
  actions.className = 'deal-actions';

  const href = safeUrl(deal.url);
  if (href) {
    const link = document.createElement('a');
    link.className = 'btn-get';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'RISCATTA';
    link.addEventListener('click', () => {
      state.seen.add(deal.id);
      writeSet('seen', state.seen);
      applyDealClasses(card, deal.id);
      updateCounts();
    });
    actions.appendChild(link);
  }

  const redeemedLabel = document.createElement('label');
  redeemedLabel.className = 'check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.redeemed.has(deal.id);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.redeemed.add(deal.id);
    else state.redeemed.delete(deal.id);
    writeSet('redeemed', state.redeemed);
    applyDealClasses(card, deal.id);
    applyVisibility();
    updateCounts();
  });
  const checkText = document.createElement('span');
  checkText.textContent = 'Riscattato';
  redeemedLabel.append(checkbox, checkText);
  actions.appendChild(redeemedLabel);

  // "Non mi interessa" e' reversibile: prima poteva solo essere impostato.
  const ignore = document.createElement('button');
  ignore.type = 'button';
  ignore.className = 'btn-ignore';
  ignore.textContent = 'Non mi interessa';
  ignore.addEventListener('click', () => {
    if (state.ignored.has(deal.id)) {
      state.ignored.delete(deal.id);
    } else {
      state.ignored.add(deal.id);
    }
    writeSet('ignored', state.ignored);
    applyDealClasses(card, deal.id);
    ignore.textContent = state.ignored.has(deal.id) ? 'Ripristina' : 'Non mi interessa';
    applyVisibility();
    updateCounts();
  });
  if (state.ignored.has(deal.id)) ignore.textContent = 'Ripristina';
  actions.appendChild(ignore);

  card.append(status, title, meta, actions);
  return card;
}

/* --------------------------------------------------------------- visibilità */

/**
 * Un unico punto che decide se una card è visibile.
 * Prima ricerca e filtri scrivevano entrambi su `style.display`: il secondo
 * annullava il primo, e digitando nella ricerca si perdevano i filtri attivi.
 */
function dealPasses(deal) {
  if (state.freeOnly && !deal.free) return false;
  if (!matchesSearch(deal)) return false;

  const ignored = state.ignored.has(deal.id);
  const redeemed = state.redeemed.has(deal.id);

  switch (state.filter) {
    case 'unredeemed': return !redeemed && !ignored;
    case 'seen': return state.seen.has(deal.id) && !redeemed && !ignored;
    case 'redeemed': return redeemed;
    case 'ignored': return ignored;
    default: return !ignored;
  }
}

function applyVisibility() {
  for (const deal of state.deals) {
    const card = cardEls.get(deal.id);
    if (card) card.hidden = !dealPasses(deal);
  }
  const visible = state.deals.filter(dealPasses).length;
  el.empty.hidden = visible > 0 || !state.deals.length;
  el.empty.textContent = state.deals.length
    ? 'Nessun deal corrisponde a ricerca e filtri.'
    : 'Nessun deal disponibile al momento.';
  return visible;
}

/** Contatori accanto ai filtri: quanti deal ci sono davvero in ogni vista. */
function updateCounts() {
  const base = state.deals.filter((d) => (!state.freeOnly || d.free) && matchesSearch(d));
  const counts = {
    all: base.filter((d) => !state.ignored.has(d.id)).length,
    unredeemed: base.filter((d) => !state.redeemed.has(d.id) && !state.ignored.has(d.id)).length,
    seen: base.filter((d) => state.seen.has(d.id) && !state.redeemed.has(d.id) && !state.ignored.has(d.id)).length,
    redeemed: base.filter((d) => state.redeemed.has(d.id)).length,
    ignored: base.filter((d) => state.ignored.has(d.id)).length,
  };
  for (const button of el.filters) {
    const n = counts[button.dataset.filter];
    const label = counts[button.dataset.filter] !== undefined ? n : 0;
    button.textContent = `${button.dataset.label} (${label})`;
  }
  const visible = applyVisibility();
  el.summary.textContent = state.deals.length
    ? `${visible} mostrati su ${state.deals.length} · ${state.deals.filter((d) => d.free).length} gratuiti`
    : '';
}

function matchesSearch(deal) {
  if (!state.search) return true;
  const haystack = (deal.title + ' ' + deal.developer + ' ' + (deal.tags || []).join(' ')).toLowerCase();
  return haystack.includes(state.search);
}

function renderList() {
  el.list.replaceChildren();
  cardEls.clear();
  const fragment = document.createDocumentFragment();
  for (const deal of state.deals) {
    const card = buildCard(deal);
    cardEls.set(deal.id, card);
    fragment.appendChild(card);
  }
  el.list.appendChild(fragment);
  updateCounts();
}

/* ------------------------------------------------------------------ stato UI */

function setStatus(text, tone = 'info') {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
  el.status.hidden = !text;
}

function describeMeta(meta) {
  if (!meta) return '';
  const when = meta.fetchedAt ? updatedAtLabel(meta.fetchedAt) : 'sconosciuto';
  const total = state.deals.length;
  const free = state.deals.filter((d) => d.free).length;
  const where = meta.source || CONFIG.sourceUrl;
  return `${where} · ${total} deal (${free} gratuiti) · aggiornato ${when}`;
}

/* -------------------------------------------------------------- caricamento */

async function loadDeals({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  el.refresh.disabled = true;
  el.loader.hidden = false;
  setStatus('Aggiornamento in corso…', 'info');

  // 1) mostra subito l'ultima lista buona, senza aspettare la rete
  if (!state.deals.length) {
    const cached = readCache();
    if (cached) {
      state.deals = cached.deals;
      state.meta = cached;
      renderList();
      setStatus(`Dati dalla cache locale · ${describeMeta(cached)}`, 'warn');
    }
  }

  const errors = [];
  let payload = null;

  // Se l'utente non ha cliccato esplicitamente "Aggiorna", prova prima deals.json (istantaneo e sempre disponibile)
  if (!force) {
    try {
      payload = await fetchLocalDeals();
    } catch (e) {
      errors.push(`locale: ${e.message}`);
    }
  }

  // Se forzato o se il file locale non è bastato, prova il worker e il proxy
  if (!payload) {
    try {
      payload = await fetchFromWorker(force);
    } catch (primary) {
      errors.push(`worker: ${primary.message}`);
      try {
        payload = await fetchViaProxy();
      } catch (fallback) {
        errors.push(`proxy: ${fallback.message}`);
        // Se anche il worker/proxy fallisce ma abbiamo deals.json, usiamo quello
        if (force) {
          try {
            payload = await fetchLocalDeals();
          } catch (e) {
            errors.push(`locale: ${e.message}`);
          }
        }
      }
    }
  }

  state.loading = false;
  el.refresh.disabled = false;
  el.loader.hidden = true;

  if (payload) {
    state.deals = payload.deals;
    state.meta = payload.meta;
    writeCache({ ...payload.meta, deals: payload.deals, savedAt: Date.now() });
    renderList();
    const stale = payload.meta && payload.meta.stale;
    setStatus(
      (stale ? '⚠ ' : '') + describeMeta(payload.meta) + (payload.meta.warning ? ` — ${payload.meta.warning}` : ''),
      stale || payload.meta.fromCache ? 'warn' : 'ok'
    );
    el.error.hidden = true;
    return;
  }

  // Tutte le strade sono chiuse: meglio la cache che una pagina vuota.
  if (state.deals.length) {
    setStatus('Aggiornamento non riuscito, mostro gli ultimi dati salvati. ' + errors.join(' · '), 'warn');
    el.error.hidden = true;
    return;
  }

  el.error.hidden = false;
  el.error.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = 'Impossibile caricare i deal';
  const detail = document.createElement('p');
  detail.textContent = errors.join(' · ');
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Il worker va pubblicato con `npm run deploy`. Finche non lo aggiorni, il vecchio proxy restituisce una pagina anti-bot e lo scraping non funziona.';
  el.error.append(title, detail, hint);
  setStatus('');
}

/* ----------------------------------------------------------------- eventi */

function wireEvents() {
  let searchTimer = null;
  el.search.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value.trim().toLowerCase();
    searchTimer = setTimeout(() => {
      state.search = value;
      updateCounts();
    }, 120);
  });

  el.filters.forEach((button) => {
    button.addEventListener('click', () => {
      el.filters.forEach((b) => b.classList.toggle('active', b === button));
      state.filter = button.dataset.filter;
      updateCounts();
    });
  });

  el.freeOnly.addEventListener('change', (event) => {
    state.freeOnly = event.target.checked;
    updateCounts();
  });

  el.refresh.addEventListener('click', () => loadDeals({ force: true }));

  el.reset.addEventListener('click', () => {
    const ok = confirm('Cancellare tutti i segni: visti, riscattati e "non mi interessa"?');
    if (!ok) return;
    for (const key of ['seen', 'redeemed', 'ignored']) {
      localStorage.removeItem(CONFIG.storagePrefix + key);
      state[key] = new Set();
    }
    // Chiavi della vecchia versione (basate sul feed ormai morto).
    for (const legacy of ['seenDeals', 'redeemedDeals', 'ignoredDeals']) localStorage.removeItem(legacy);
    for (const deal of state.deals) {
      const card = cardEls.get(deal.id);
      if (card) {
        const checkbox = card.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = false;
        applyDealClasses(card, deal.id);
        const ignore = card.querySelector('.btn-ignore');
        if (ignore) ignore.textContent = 'Non mi interessa';
      }
    }
    updateCounts();
    setStatus('Segni azzerati.', 'ok');
  });

  window.addEventListener('online', () => loadDeals({ force: false }));
  window.addEventListener('offline', () => setStatus('Sei offline: mostro gli ultimi dati salvati.', 'warn'));
}

function cacheIsStale(meta) {
  if (!meta || !meta.savedAt) return true;
  return (Date.now() - meta.savedAt) / 60000 > CONFIG.cacheFreshMinutes;
}

/** Shortcut del manifest: ./?filtro=gratuiti (o uno degli altri filtri). */
function applyUrlFilter() {
  const requested = new URLSearchParams(location.search).get('filtro');
  if (!requested) return;

  if (requested === 'gratuiti' || requested === 'free') {
    state.freeOnly = true;
    el.freeOnly.checked = true;
  } else {
    const button = el.filters.find((b) => b.dataset.filter === requested);
    if (button) {
      el.filters.forEach((b) => b.classList.toggle('active', b === button));
      state.filter = requested;
    }
  }
}

async function init() {
  Object.assign(el, {
    list: document.getElementById('deals'),
    search: document.getElementById('search'),
    filters: [...document.querySelectorAll('#filters button')],
    freeOnly: document.getElementById('free-only'),
    refresh: document.getElementById('refresh'),
    reset: document.getElementById('reset'),
    status: document.getElementById('status'),
    summary: document.getElementById('summary'),
    loader: document.getElementById('loader'),
    empty: document.getElementById('empty'),
    error: document.getElementById('error'),
  });

  wireEvents();
  applyUrlFilter();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW non registrata', e));
    });
  }

  // La cache locale e' un fallback: con dati freschi si chiede comunque il worker.
  await loadDeals({ force: cacheIsStale(readCache()) });
}

init();
