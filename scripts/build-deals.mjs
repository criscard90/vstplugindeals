/**
 * scripts/build-deals.mjs — scarica i deal da AudioPluginGuy e genera deals.json.
 * Può essere eseguito localmente o dentro una GitHub Action periodica.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDeals, parsePosts } from '../parser.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEALS_URL = 'https://www.audiopluginguy.com/deals/';
const POSTS_API_URL =
  'https://www.audiopluginguy.com/wp-json/wp/v2/posts?per_page=40&_fields=id,date,link,slug,title,content';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function curl(url) {
  try {
    return execFileSync(
      'curl',
      [
        '-s',
        '-m',
        '45',
        '-L',
        '--compressed',
        '-A',
        UA,
        '-H',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H',
        'Accept-Language: en-US,en;q=0.9',
        url,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (err) {
    console.warn(`Errore curl su ${url}:`, err.message);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Pausa tra i tentativi: errori transitori e challenge WAF/Cloudflare spesso
// passano al tentativo successivo.
const RETRY_DELAY_MS = 10000;

let result = null;

// 1. Prova la pagina principale dei deal (fino a 3 tentativi)
console.log('Download da:', DEALS_URL);
for (let attempt = 1; attempt <= 3 && !result; attempt++) {
  const html = curl(DEALS_URL);
  if (html && html.includes('ultimate-plugin-deals-list')) {
    const parsed = parseDeals(html);
    if (parsed.deals.length > 0) {
      result = {
        ok: true,
        source: 'audiopluginguy.com/deals',
        sourceUrl: DEALS_URL,
        fetchedAt: new Date().toISOString(),
        stats: parsed.stats,
        deals: parsed.deals,
      };
      console.log(`Estratti ${parsed.deals.length} deal dalla tabella (${parsed.stats.free} gratuiti).`);
    }
  }
  if (!result && attempt < 3) {
    console.warn(`Tentativo ${attempt}/3 senza risultato (pagina assente o bloccata), riprovo tra ${RETRY_DELAY_MS / 1000}s...`);
    await sleep(RETRY_DELAY_MS);
  }
}

// 2. Se fallisce, prova il REST API di WordPress (fino a 2 tentativi)
if (!result) {
  console.log('Provo il fallback REST API:', POSTS_API_URL);
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    const postsRaw = curl(POSTS_API_URL);
    if (postsRaw) {
      try {
        const posts = JSON.parse(postsRaw);
        const parsed = parsePosts(posts);
        if (parsed.deals.length > 0) {
          result = {
            ok: true,
            source: 'audiopluginguy.com/wp-json',
            sourceUrl: POSTS_API_URL,
            fetchedAt: new Date().toISOString(),
            stats: parsed.stats,
            deals: parsed.deals,
          };
          console.log(`Estratti ${parsed.deals.length} deal dal REST API (${parsed.stats.free} gratuiti).`);
        }
      } catch (e) {
        console.warn(`Errore parsing JSON dei post (tentativo ${attempt}/2): ${e.message}`);
      }
    }
    if (!result && attempt < 2) {
      console.warn(`Fallback tentativo ${attempt}/2 fallito, riprovo tra ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// 3. Salvataggio
const outPath = join(root, 'deals.json');
if (result) {
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('deals.json generato con successo!');
} else {
  if (existsSync(outPath)) {
    console.warn('Scraping fallito ma deals.json esistente preservato.');
  } else {
    console.error('Scraping fallito e nessun deals.json precedente.');
    process.exit(1);
  }
}
