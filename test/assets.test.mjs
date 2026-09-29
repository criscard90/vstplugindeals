/**
 * Test d'integrità: verifica che ogni file referenziato esista davvero.
 *
 * È il controllo che evita i due guasti più insidiosi in fase di deploy:
 *  - la service worker non si installa se un file della lista manca
 *    (cache.addAll() fallisce e l'intera app non parte offline);
 *  - manifest e HTML con percorsi sbagliati rompono l'installabilità.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

const read = (file) => readFileSync(join(root, file), 'utf8');

/* --- file elencati nella service worker --- */
const sw = read('sw.js');
const shellBlock = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
check('SHELL_ASSETS presente in sw.js', Boolean(shellBlock));
const shellAssets = [...(shellBlock?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('SHELL_ASSETS non vuoto', shellAssets.length > 0, `n=${shellAssets.length}`);

for (const asset of shellAssets) {
  if (asset === './') continue; // la root corrisponde a index.html
  check(`sw.js: esiste ${asset}`, existsSync(join(root, asset)));
}

/* --- icone dichiarate nel manifest --- */
const manifest = JSON.parse(read('manifest.json'));
const icons = [...(manifest.icons || []), ...(manifest.shortcuts || []).flatMap((s) => s.icons || [])];
check('manifest ha icone', icons.length > 0, `n=${icons.length}`);
for (const icon of icons) {
  check(`manifest: esiste ${icon.src}`, existsSync(join(root, icon.src)));
}
check('manifest dichiara una icona maskable', (manifest.icons || []).some((i) => (i.purpose || '').includes('maskable')));
check('manifest ha start_url e scope', Boolean(manifest.start_url && manifest.scope));

/* --- identità dell'app ---
 * Un id "nudo" come "/" risolve sulla root dell'origine: su origin condivisi
 * (es. *.github.io) crea un'identità ambigua e, se il browser ha un vecchio
 * record di installazione, l'utente vede "app già installata" anche dopo la
 * disinstallazione. L'id deve essere esplicito, same-origin e mai la root nuda. */
check('manifest dichiara un id', typeof manifest.id === 'string' && manifest.id.length > 0);
const manifestBase = 'https://example.test/vstdeals/manifest.json';
const idUrl = new URL(manifest.id, manifestBase);
const startUrlUrl = new URL(manifest.start_url, manifestBase);
check('manifest id same-origin con start_url', idUrl.origin === startUrlUrl.origin, idUrl.origin);
check(
  'manifest id non è la root nuda dell\'origine',
  !(idUrl.pathname === '/' && idUrl.search === ''),
  manifest.id
);

const html = read('index.html');

/* --- link al manifest: e' il requisito n.1 dell'installabilita' PWA ---
 * Un href vuoto o malformato (es. href=""manifest.json?) fa scaricare al
 * browser l'HTML della pagina come manifest: il parsing JSON fallisce e
 * Chrome rifiuta l'installazione con "Questa app non puo' essere installata".
 * La vecchia regex dei refs non intercettava href="" perche' la cattura
 * richiede almeno un carattere, quindi il guasto passava silenzioso. */
const manifestLink = html.match(/<link\s+rel="manifest"\s+href="([^"]*)"/);
check('index.html dichiara <link rel="manifest">', Boolean(manifestLink));
const manifestHref = (manifestLink?.[1] || '').trim();
check('href del manifest non vuoto', manifestHref.length > 0, JSON.stringify(manifestHref));
const manifestPath = manifestHref.split(/[?#]/)[0];
check(
  'href del manifest punta a un file esistente',
  manifestPath.length > 0 && existsSync(join(root, manifestPath)),
  manifestPath
);
check(
  'manifest linkato == manifest.json della root',
  manifestPath === 'manifest.json',
  manifestPath
);

/* --- risorse citate in index.html ---
 * La regex esclude anche "?": il manifest e' referenziato con una query
 * string di cache-busting (manifest.json?v=2.0.2) e existsSync non la tollera. */
const refs = [...html.matchAll(/(?:href|src)="([^"#:?]+)"/g)].map((m) => m[1]);
const localRefs = [...new Set(refs)].filter((r) => !r.startsWith('http') && !r.startsWith('data:'));
check('index.html ha risorse locali', localRefs.length > 0, localRefs.join(', '));
for (const ref of localRefs) {
  check(`index.html: esiste ${ref}`, existsSync(join(root, ref)));
}

/* --- nessuna dipendenza esterna residua --- */
check('index.html non usa CDN esterni', !/cdnjs|flaticon|googleapis/i.test(html));
check('manifest non usa CDN esterni', !/cdnjs|flaticon|googleapis/i.test(JSON.stringify(manifest)));

/* --- lo script principale è un module (i module non funzionano su file://) --- */
check('app.js caricato come module', /<script\s+type="module"\s+src="app\.js"/.test(html));

/* --- parser e worker non devono dipendere da moduli esterni --- */
for (const file of ['parser.js', 'app.js', 'worker.js', 'sw.js']) {
  const source = read(file);
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  const externals = imports.filter((i) => !i.startsWith('./') && !i.startsWith('node:'));
  check(`${file}: nessun import esterno`, externals.length === 0, externals.join(', '));
}

/* --- la lista host del worker deve essere restrittiva --- */
const worker = read('worker.js');
check('worker ha una allowlist di host', /ALLOWED_HOSTS\s*=\s*new Set/.test(worker));
check('worker manda User-Agent da browser', /'User-Agent':\s*\n?\s*'Mozilla/.test(worker));
check('worker gestisce la challenge anti-bot', /sgcaptcha|cf-browser-verification/.test(worker));
check('worker ha piu di una fonte dati', (worker.match(/name:\s*'/g) || []).length >= 2, 'SOURCES');
check('worker ripiega sul REST API', /wp-json\/wp\/v2\/posts/.test(worker));
check('worker usa entrambi i parser', /parseDeals/.test(worker) && /parsePosts/.test(worker));

/* --- gli id usati da app.js devono esistere davvero in index.html --- */
const app = read('app.js');
const wantedIds = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
const wantedSelectors = [...app.matchAll(/querySelector\('#([\w-]+)'\)/g)].map((m) => m[1]);
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

check('app.js dichiara gli id attesi', wantedIds.length >= 8, `n=${wantedIds.length}`);
for (const id of new Set([...wantedIds, ...wantedSelectors])) {
  check(`index.html: esiste l'id "${id}"`, htmlIds.has(id));
}

/* --- i selettori usati dentro le card devono corrispondere al markup creato --- */
for (const selector of ['.deal-status', '.btn-ignore', 'input[type="checkbox"]']) {
  check(
    `app.js crea "${selector}"`,
    app.includes(`querySelector('${selector}')`),
    ''
  );
}
check("app.js scrive il titolo con textContent (no innerHTML)", /title\.textContent = deal\.title/.test(app));
check('app.js non usa innerHTML', !/\.innerHTML\s*=/.test(app));

console.log(failures === 0 ? '\nINTEGRITÀ: TUTTI I CONTROLLI PASSATI' : `\nINTEGRITÀ: ${failures} CONTROLLI FALLITI`);
process.exit(failures === 0 ? 0 : 1);
