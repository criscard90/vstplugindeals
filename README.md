# Plugin Deals — PWA

Offerte e plugin gratuiti per VST, raccolti con **scraping diretto** di
[Audio Plugin Deals](https://www.audiopluginguy.com/deals/).

## Perché è stato riscritto il backend

La versione precedente leggeva un feed JSON di terze parti:

```js
const FEED_URL = 'https://politepol.com/fd/wTw62jsUzOHO.json';   // → HTTP 404, scade
```

Quel servizio è gratuito ma ha una durata limitata: quando scade, la PWA
restituiva una lista vuota. Sostituirlo con un altro feed significherebbe
stesso problema tra qualche mese. Qui si scrapa **la pagina vera**, che non ha
scadenza.

Nota sui domini: `vstdeals.com` **non** è la fonte. Oggi è un sito WordPress
di default, vuoto, e `/category/free-plugins/` risponde 404. La fonte usata da
questo progetto — riotrovata nella cronologia git, dove compariva
`https://www.audiopluginguy.com/deals/` — è `audiopluginguy.com`.

## Architettura e Aggiornamento dei Dati

La PWA dispone ora di un doppio meccanismo di alimentazione:

### 1. GitHub Actions + `deals.json` (Attivo e autonomo al 100%)
Il repository contiene il file `deals.json` con tutti i deal estratti.
Una **GitHub Action** (`.github/workflows/update-deals.yml`) gira automaticamente **ogni ora, al minuto :07** (o manualmente dalla tab *Actions* di GitHub con il pulsante *Run workflow*):
- Esegue lo scraping con emulazione browser tramite `scripts/build-deals.mjs`.
- Estrae e verifica i deal con `npm test`.
- Se ci sono novità, aggiorna `deals.json` nel repository.
- La PWA carica `deals.json` istantaneamente, senza problemi di CORS, senza dipendere da server esterni e funzionando anche totalmente offline grazie al Service Worker.

> **Nota (aggiornamento 07/10/2026):** lo trigger `schedule` di GitHub è
> best-effort e in questo periodo salta la maggior parte degli scatti orari
> (confermato: ~18% delle run create dal 29/9, con ritardi di 1-8 ore). Per questo
> motivo la workflow va **ancora disparata ogni ora da un cron esterno** tramite
> l'API `workflow_dispatch`; lo `schedule` resta attivo come backup (il blocco
> `concurrency` rende innocue le doppie esecuzioni). Guida completa passo-passo:
> [`AGGIORNAMENTO-ESTERNO.md`](./AGGIORNAMENTO-ESTERNO.md).


### 2. Cloudflare Worker opzionale (`worker.js`)
Se vuoi abilitare il refresh in tempo reale direttamente dal pulsante "Aggiorna":
```bash
npm install          # installa wrangler
npm run deploy       # pubblica il worker su Cloudflare
```
Il worker scarica i deal con header browser e fa da fallback automatico sul REST API di WordPress. Se il worker non è ancora configurato, la PWA usa in trasparenza `deals.json` locale garantendo che l'app non mostri mai errori.

## Struttura

| File                          | Ruolo                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `parser.js`                   | funzione pura che estrae i deal dall'HTML (Worker + browser) |
| `worker.js`                   | scraping con header da browser, cache 30 min, JSON         |
| `app.js`                      | stato, rendering, filtri, ricerca, cache locale            |
| `sw.js`                       | service worker: shell in cache, dati network-first         |
| `styles.css` / `index.html`   | interfaccia (nessuna dipendenza esterna)                   |
| `manifest.json`               | metadati PWA                                              |
| `scripts/scrape.mjs`          | scarica la pagina reale in `/tmp/apg.html`                 |
| `scripts/generate-icons.py`   | genera le icone PNG senza librerie esterne                 |
| `test/`                       | test del parser e integrità dei file                       |

## Sviluppo locale

`app.js` è un ES module: va servito via HTTP, `file://` non funziona.

```bash
python3 -m http.server 8080
# poi apri http://localhost:8080
```

I dati arrivano dal Worker remoto; per provare il parsing in locale:

```bash
npm run scrape        # salva /tmp/apg.html
npm test              # test sulla fixture
node test/parser.test.mjs /tmp/apg.html   # test sulla pagina reale
```

## Note sui dati

La pagina contiene una tabella `#ultimate-plugin-deals-list` con 6 colonne:
descrizione, sconto massimo, scadenza, data di inserimento, URL e tag. Un deal
è considerato **gratuito** se vale almeno una di queste condizioni: sconto
`100%`, badge `FREEBIE`, tag `FREE`. La stessa offerta può comparire più volte
(sconto e poi freebie): le varianti vengono unite, così il flag "gratuito" non
si perde.

I segni (visto / riscattato / non mi interessa) stanno in `localStorage` e
usano la URL del deal come identificatore. Sono quindi **diversi** da quelli
della vecchia versione, basata sul feed: la lista parte azzerata. Il pulsante
"Azzera segni" cancella anche le vecchie chiavi.
