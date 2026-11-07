// The logic of the click robot, apart from the browser (phase 10, session F): which pages and views to visit, how a
// defect is worded and deduplicated, what the exit code is. Pure functions, tested in test/click-robot.test.mjs; the
// browser and the throwaway server are in click-robot.mjs.
import path from 'node:path';

export const LANGS = ['fr', 'en'];
export const VIEWPORTS = [[1440, 900], [390, 844]];
export const MAX_CLICKS_PER_PAGE = 40;

// The elements worth a click: the content of the page (not the sidebar, which every page shares and one page clicks).
export const CLICKABLE = [
  'main button:visible', 'main a[href]:visible', 'main summary:visible', 'main [role=tab]:visible', 'main input[type=checkbox]:visible',
  '.sheet button:visible', '.sheet summary:visible', '.sheet [role=tab]:visible', '#content button:visible',
].join(', ');

// Pages that need a project, with the views the single-page screens hold behind a hash.
const PROJECT_PAGES = ['/', '/#memoire', '/#acces', '/#rafale', '/#pilote', '/#phone', '/resources', '/flow', '/review', '/architecture', '/learning', '/backlog', '/replies.html', '/comm', '/signaler.html?ecran=Flot'];
const EMPTY_PAGES = ['/', '/flow', '/review'];
const BARE_PAGES = ['/design-system.html', '/entry.html', '/'];

// A page with ?project= in its query, whatever its hash or existing query.
export const withQuery = (url, params) => {
  const [rest, hash] = url.split('#');
  const [p, query] = rest.split('?');
  const qs = [...(query ? [query] : []), ...params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)].join('&');
  return `${p}${qs ? '?' + qs : ''}${hash ? '#' + hash : ''}`;
};

// planIds: the ids the seeded server lists (GET /api/plans), so no plan name is written here.
export const pageList = ({ seedDir, projects = ['Carnet', 'Vide'], planIds = [] }) => {
  const [full, empty] = projects.map((n) => path.join(seedDir, n));
  const list = [];
  if (full) {
    for (const p of PROJECT_PAGES) list.push(withQuery(p, [['project', full]]));
    for (const id of planIds) list.push(withQuery(`/plan/${id}`, [['project', full]]));
  }
  if (empty) for (const p of EMPTY_PAGES) list.push(withQuery(p, [['project', empty]]));
  return [...list, ...BARE_PAGES];
};

// The URL of one visit: the language goes first in the query, before any other parameter, the hash stays last.
export const visitUrl = (page, lang) => {
  const [rest, hash] = page.split('#');
  return `${rest.includes('?') ? rest.replace('?', `?lang=${lang}&`) : `${rest}?lang=${lang}`}${hash ? '#' + hash : ''}`;
};
export const visits = (pages, { langs = LANGS, viewports = VIEWPORTS } = {}) => {
  const out = [];
  for (const lang of langs) for (const [w, h] of viewports) for (const page of pages) out.push({ url: visitUrl(page, lang), page, lang, width: w, height: h });
  return out;
};
export const whereOf = (v) => `${v.page.split('?')[0]}${v.page.includes('#') ? '#' + v.page.split('#')[1] : ''} [${v.lang} ${v.width}]`;

// Console messages that come from the robot itself (the blocked non-GET requests), not from the app.
const NOISE = /net::ERR_FAILED|Failed to fetch|aborted|ERR_ABORTED/i;
export const isNoise = (text) => NOISE.test(text);

const clip = (s, n) => String(s).replace(/\s+/g, ' ').slice(0, n);
export const defect = ({ where, action = 'chargement', kind, detail = '' }) => `${where} · ${action} · ${kind}${detail ? ' ' + clip(detail, 150) : ''}`;
export const pageError = (where, action, err) => defect({ where, action, kind: 'PAGEERROR', detail: String(err).split('\n')[0] });
export const consoleError = (where, action, text) => (isNoise(text) ? null : defect({ where, action, kind: 'CONSOLE', detail: text }));
// One line of the trace (--keep or --trace): where, what the page did, its detail; for reading why a page closed.
export const traceLine = (where, event, detail = '') => `· ${where} · ${event}${detail ? ' ' + clip(detail, 200) : ''}`;
export const httpError =(where, action, { status, method = 'GET', url }, base = '') => (status >= 400 && method === 'GET' ? defect({ where, action, kind: 'HTTP', detail: `${status} ${String(url).replace(base, '').slice(0, 100)}` }) : null);

// A dead button (Dev, 2026-11-03 19:45: « ne jamais montrer un bouton qui ne marche pas »): a click that makes no request
// (even one the robot aborts), no change in the DOM, no navigation and no message (console, dialog, window.open, clipboard).
// A checkbox is never dead: its own tick is the answer. fx: { requests, mutations, navigated, messages }
export const isDeadClick = (fx, el = {}) => {
  if (!fx || (el.tag === 'input' && /^(checkbox|radio)$/.test(el.type || ''))) return false;
  return !(fx.requests > 0 || fx.mutations > 0 || fx.navigated || fx.messages > 0);
};
// One line, without the language and the width: the same dead button at two widths is one line
export const deadButton = (where, label) => `BOUTON MORT ${String(where).replace(/\s*\[[^\]]*\]\s*$/, '')} ${clip(label || '(sans texte)', 60)}`;

// The report: counts, defects deduplicated (the same line seen twice is one), sorted; exit code 1 when there is one.
export const report = ({ clicks = 0, visited = 0, skipped = 0, defects = [] }) => {
  const unique = [...new Set(defects.filter(Boolean))].sort();
  const head = `${visited} pages, ${clicks} clics, ${skipped} refusés`;
  return { unique, text: `${head}\n${unique.length ? unique.join('\n') : 'aucun défaut'}`, code: unique.length ? 1 : 0 };
};

// Command line. --port (default: a free one), --seed-dir, --browser, --only <text> (pages containing it), --langs fr,en,
// --keep (leave the server running, and trace), --trace (print what each page does), --base <url> (use a server already there).
export const parseArgs = (argv) => {
  const o = { port: null, seedDir: null, browser: null, only: null, langs: null, keep: false, trace: false, base: null, help: false, max: MAX_CLICKS_PER_PAGE };
  const take = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${name} wants a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { o.port = Number(take(i++, a)); if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port wants 1-65535'); }
    else if (a === '--seed-dir') o.seedDir = take(i++, a);
    else if (a === '--browser') o.browser = take(i++, a);
    else if (a === '--only') o.only = take(i++, a);
    else if (a === '--base') o.base = take(i++, a).replace(/\/$/, '');
    else if (a === '--max') { o.max = Number(take(i++, a)); if (!Number.isInteger(o.max) || o.max < 1) throw new Error('--max wants a positive number'); }
    else if (a === '--langs') { o.langs = take(i++, a).split(',').map((s) => s.trim()).filter(Boolean); if (!o.langs.length || o.langs.some((l) => !LANGS.includes(l))) throw new Error(`--langs wants ${LANGS.join(',')}`); }
    else if (a === '--keep') o.keep = true;
    else if (a === '--trace') o.trace = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
};
export const USAGE = `node scripts/click-robot.mjs [--port N] [--seed-dir DIR] [--browser PATH] [--only TEXT] [--langs fr,en] [--max N] [--base URL] [--keep] [--trace]
Starts a seeded throwaway server (claude disabled), clicks every safe button of every page in two languages and two widths, prints the defects, exits 1 if any.`;
