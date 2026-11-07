// The connectors without session A (phase 7, session B; not a test): a proxy in front of a real worktree server that
// answers the routes of the contract with frozen data (test/fixtures/connectors.json) and passes everything else.
//   PORT=3093 ESCADRILLE_DB=$TMPDIR/b.sqlite ESCADRILLE_PLANS=$TMPDIR/plans node --no-warnings server.mjs
//   ESCADRILLE_DB=$TMPDIR/b.sqlite node --no-warnings test/fake-connectors.mjs 3092 http://127.0.0.1:3093
// It seeds one plan whose sessions are finished: A and B say « PR prête », C too but its push fails, D has its PR.
// Nothing goes out: the PR and the tickets are invented here. Prints the URLs to capture.
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.ESCADRILLE_DB; if (!DB) { console.log('fake-connectors: set ESCADRILLE_DB to the upstream server database'); process.exit(0); }
const PORT = Number(process.argv[2] || 3092); const UP = new URL(process.argv[3] || 'http://127.0.0.1:3093');
const FX = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'connectors.json'), 'utf8'));
const project = path.resolve(HERE, '..', '.escadrille', 'seed', 'Orchard'); mkdirSync(project, { recursive: true });

// the plan, through the API; the finished sessions straight into the database (as test/seed-multiproject.mjs does)
const plan = { ...FX.plan, project, sessions: FX.plan.sessions.map((s) => ({ ...s, path: project })) };
const up = (p, init) => fetch(new URL(p, UP), init).then((r) => r.json());
console.log('plan', (await up('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan) })).ok);
const db = new DatabaseSync(DB); const at = (m) => new Date(Date.now() - m * 60e3).toISOString();
const ins = db.prepare("insert or replace into sessions (plan, id, status, stops, health, why, claude, note, name, at, mode, worktree, usage, summary) values (?, ?, 'done', ?, 'ok', '', ?, '', ?, ?, 'page', ?, ?, ?)");
FX.state.forEach((x, i) => ins.run(plan.id, x.id, JSON.stringify(x.stops), x.claude, x.name, at(40 - i * 7), JSON.stringify({ ...x.worktree, cwd: project, path: project }), JSON.stringify(x.usage), x.summary));
db.close();

const prs = { ...FX.prs }; let linear = { ...FX.linear }; let n = 12;
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (req, res, raw) => { const r = http.request(new URL(req.url, UP), { method: req.method, headers: { ...req.headers, host: UP.host, ...(raw != null ? { 'content-length': Buffer.byteLength(raw) } : {}) } }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
  r.on('error', () => send(res, 502, { error: 'upstream' })); if (raw != null) r.end(raw); else req.pipe(r); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const m = url.pathname.match(/^\/api\/plan\/([^/]+)\/session\/([^/]+)\/pr$/);
  if (m) { const [id, sid] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])]; const k = id + '/' + sid; await wait(900);
    if (req.method === 'GET') return prs[k] ? send(res, 200, { state: 'OPEN', merged: false, url: prs[k].url, reviewDecision: 'REVIEW_REQUIRED' }) : send(res, 400, { error: 'no pull request for this session' });
    const fail = FX.fail[sid]; if (fail) return send(res, 400, { error: fail });
    const tickets = (plan.sessions.find((s) => s.id === sid)?.tickets || []).map((t) => (linear.key ? (FX.ticketFail[t] ? { identifier: t, state: null, ok: false, error: FX.ticketFail[t] } : { identifier: t, state: linear.state, ok: true, error: null }) : { identifier: t, state: null, ok: false, error: 'no Linear key' }));
    const number = n++; prs[k] = { url: `https://github.com/GabFranck/Orchard/pull/${number}`, number, at: new Date().toISOString(), tickets };
    return send(res, 200, { ok: true, pr: { url: prs[k].url, number }, tickets }); }
  if (url.pathname.startsWith('/api/plan/') && req.method === 'GET' && !url.pathname.slice(10).includes('/')) { const id = decodeURIComponent(url.pathname.slice(10)); const r = await up(req.url);
    if (r.state) for (const x of r.state) x.pr = prs[id + '/' + x.id] || null;
    if (r.plan && r.plan.id === plan.id) { r.plan.base ??= plan.base; for (const s of r.plan.sessions) s.tickets ??= plan.sessions.find((p) => p.id === s.id)?.tickets; } return send(res, 200, r); }
  if (url.pathname === '/api/project/settings') {
    if (req.method !== 'POST') { const r = await up(req.url); return send(res, 200, r.error ? r : { ...r, linear }); }
    const b = await body(req); if ('linearKey' in b) linear = { ...linear, key: !!b.linearKey }; if (b.linearState) linear = { ...linear, state: b.linearState }; delete b.linearKey; delete b.linearState;
    const r = await up('/api/project/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); if (r.settings) r.settings.linear = linear; return send(res, 200, r); }
  if (url.pathname === '/api/access') { const r = await up(req.url); r.extensions.connectors = FX.connectors.map((c) => (c.name === 'Linear' ? { ...c, ready: linear.key, key: linear.key } : c)); r.out = [...r.out, ...FX.out]; return send(res, 200, r); }
  pass(req, res);
}).listen(PORT, '127.0.0.1', () => { const q = '?project=' + encodeURIComponent(project);
  console.log(`la carte  http://localhost:${PORT}/plan/${plan.id}${q}#sessions`); console.log(`l'onglet  http://localhost:${PORT}/plan/${plan.id}${q}&tab=A#flow`);
  console.log(`Accès     http://localhost:${PORT}/${q}#acces-extensions`); console.log(`Réglages  http://localhost:${PORT}/${q}  (ouvrir #psettings)`); });
