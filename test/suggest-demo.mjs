// The bench of the guessed reply (not a test): until server.mjs carries docs/suggest-server.diff, the two composers
// cannot be seen with a guess on the real pages. This serves public/, /i18n.js, the real route of lib/suggest.mjs on
// a seeded throwaway base (test/seed-suggest.mjs) and test/fixtures/suggest-demo.html, the two composers with the
// app's own markup and CSS. Nothing of server.mjs runs.
//   PORT=3150 ESCADRILLE_DB=.escadrille/seed/suggest.sqlite node --no-warnings test/suggest-demo.mjs
//   then /suggest-demo.html (?theme=dark, ?lang=en)
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as suggest from '../lib/suggest.mjs';
import * as i18n from '../lib/i18n.mjs';
import { seed } from './seed-suggest.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DB = path.resolve(process.env.ESCADRILLE_DB || path.join(ROOT, '.escadrille', 'seed', 'suggest.sqlite'));
await mkdir(path.dirname(DB), { recursive: true });
const db = new DatabaseSync(DB); const project = path.join(path.dirname(DB), 'Mots'); await mkdir(project, { recursive: true });
seed(db, project);
const planOf = (id) => { const r = db.prepare('select json from plans where id = ?').get(id); return r && JSON.parse(r.json); };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, ko) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ko(e); } }); });
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (await suggest.route(req, res, url, { db, json, readBody, projectArg: (v) => v || project, planOf })) return;
    if (url.pathname === '/i18n.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(i18n.bundle()); }
    if (url.pathname === '/api/demo') return json(res, 200, { project, rows: db.prepare('select kind, suggestion, sent, outcome from suggest_replies order by seq desc limit 5').all() });
    const file = url.pathname === '/suggest-demo.html' ? path.join(ROOT, 'test', 'fixtures', 'suggest-demo.html') : path.join(ROOT, 'public', path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file); res.writeHead(200, { 'content-type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.PORT) || 3150, '127.0.0.1', () => console.log(`suggest-demo: http://127.0.0.1:${server.address().port}/suggest-demo.html · projet ${project}`));
