// A fake server for the review page (public/review.html) while R's routes are not merged: it serves public/
// and answers the review routes of docs/review.md (R's branch) from a fixture, keeping comments, viewed files
// and the verdict in memory. Usage:
//   node test/review-fake.mjs [fixture.json]        (default: test/fixtures/review-small.json), PORT=3098
// The fixture's sibling <name>-architecture.json, if any, answers GET /api/architecture/delta (Y's shape).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.env.NODE_TEST_CONTEXT) process.exit(0); // a script run by hand, not a test: node --test picks every .mjs under test/

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUB = path.join(HERE, '..', 'public');
const file = path.resolve(process.argv[2] || path.join(HERE, 'fixtures', 'review-small.json'));
const review = JSON.parse(readFileSync(file, 'utf8'));
const archFile = file.replace(/\.json$/, '-architecture.json');
const arch = existsSync(archFile) ? JSON.parse(readFileSync(archFile, 'utf8')) : null;
review.comments ||= []; let nextId = review.comments.reduce((m, c) => Math.max(m, c.id), 0) + 1;
const decided = new Map();
const RAW = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
// the other kinds (proposed to R, kind: 'stop' | 'image'), in the order R sorts: what blocks first
const imgs = review.files.filter((f) => /\.(png|jpe?g)$/i.test(f.path) && f.status !== 'deleted').slice(0, 6).map((f) => ({ src: `/api/review/${review.id}/raw?path=${encodeURIComponent(f.path)}&side=new`, label: f.path.split('/').pop() }));
const QUEUE = [
  { kind: 'stop', id: 'stop-plan7-Y-1', plan: 'Phase 7', session: 'Y', title: 'Arrêt 1 : la carte de l’architecture d’Escadrille', summary: 'Fait : lib/architecture.mjs, la carte en SVG fait main, le delta par plan.\nReste : la carte d’Orchard et le delta de release/r01.', text: 'Regarde http://127.0.0.1:3100/architecture', retries: 0, retryMax: 2 },
  ...(imgs.length ? [{ kind: 'image', id: 'bench-phase6', plan: 'Phase 6', session: 'F', title: 'Captures avant / après du polish', images: imgs, retries: 2, retryMax: 2 }] : []),
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const summary = () => { const fs = review.files.filter((f) => !f.generated); return { id: review.id, title: review.title, head: review.head, base: review.base, level: review.level, plan: review.plan || null, session: review.session || null, files: review.files.length, additions: fs.reduce((a, f) => a + f.additions, 0), deletions: fs.reduce((a, f) => a + f.deletions, 0), viewed: review.files.filter((f) => f.viewed).length, comments: review.comments.filter((c) => !c.resolved).length, verdict: review.verdict, waitingSince: '2026-11-01T09:05:00Z' }; };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  if (req.method === 'GET' && p === '/api/reviews') return send(res, 200, { reviews: [...QUEUE.map((x) => ({ ...x, ...(decided.get(x.id) || {}) })), summary()] });
  if (req.method === 'GET' && (p === '/api/review' || p === `/api/review/${review.id}`)) return send(res, 200, review);
  if (req.method === 'GET' && p === `/api/review/${review.id}/file`) { const f = review.files.find((x) => x.path === url.searchParams.get('path')); return f ? send(res, 200, f) : send(res, 404, { error: 'unknown file' }); }
  if (req.method === 'GET' && p === '/api/architecture/delta') return arch ? send(res, 200, arch) : send(res, 404, { error: 'no delta' });
  if (req.method === 'GET' && p === `/api/review/${review.id}/raw`) { // proposed to R: the file at head (side=new) or at base (side=old)
    const ref = url.searchParams.get('side') === 'old' ? (review.baseSha || review.base) : review.headSha;
    try { const buf = execFileSync('/usr/bin/git', [...(process.env.REVIEW_GIT_DIR ? ['--git-dir', process.env.REVIEW_GIT_DIR] : ['-C', review.repo]), 'show', `${ref}:${url.searchParams.get('path')}`], { maxBuffer: 1 << 26 }); res.writeHead(200, { 'content-type': RAW[path.extname(url.searchParams.get('path')).toLowerCase()] || 'text/plain; charset=utf-8' }); return res.end(buf); } catch { return send(res, 404, { error: 'no such file at ' + ref }); } }
  const dm = p.match(/^\/api\/review\/([^/]+)\/decide$/); // proposed to R: accept | reject (reason) | retry (capped by retryMax) | reopen
  if (req.method === 'POST' && dm) { const b = await body(req); const key = dm[1] === review.id ? b.path : dm[1]; const d = decided.get(key) || { retries: QUEUE.find((x) => x.id === key)?.retries || 0 };
    if (b.action === 'reject' && !b.reason) return send(res, 400, { error: 'reason required' });
    if (b.action === 'retry') { if (d.retries >= 2) return send(res, 409, { error: 'retryMax reached', retries: d.retries }); d.retries++; }
    d.decision = ['accept', 'reject'].includes(b.action) ? b.action : null; decided.set(key, d); return send(res, 200, { ok: true, retries: d.retries, sent: b.action !== 'accept' }); }
  const m = p.match(/^\/api\/review\/([^/]+)\/(comment|viewed|submit)(?:\/(\d+)\/resolve)?$/);
  if (req.method === 'POST' && m && m[1] === review.id) {
    const b = await body(req);
    if (m[2] === 'comment' && m[3]) { const c = review.comments.find((x) => x.id === +m[3]); if (c) c.resolved = true; return send(res, 200, { ok: true }); }
    if (m[2] === 'comment') { if (!b.body || !b.path) return send(res, 400, { error: 'path and body required' }); const c = { id: nextId++, review: review.id, path: b.path, side: b.side, line: b.line, body: b.body, author: 'dev', at: new Date().toISOString(), resolved: false }; review.comments.push(c); return send(res, 200, { ok: true, comment: c }); }
    if (m[2] === 'viewed') { const f = review.files.find((x) => x.path === b.path); if (f) f.viewed = !!b.viewed; return send(res, 200, { ok: true }); }
    if (m[2] === 'submit') { if (!['comment', 'approve', 'changes'].includes(b.verdict)) return send(res, 400, { error: 'verdict' }); review.verdict = { verdict: b.verdict, body: b.body || '', at: new Date().toISOString() }; return send(res, 200, { ok: true, sent: b.verdict !== 'approve' && !!review.session }); }
  }
  const rel = p === '/' ? 'index.html' : p.startsWith('/review') ? 'review.html' : p.startsWith('/plan/') ? 'plan.html' : p.slice(1);
  const full = path.join(PUB, path.normalize(rel));
  if (!full.startsWith(PUB) || !existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' }); res.end(readFileSync(full));
}).listen(+(process.env.PORT || 3098), '127.0.0.1', () => console.log(`review fake on http://127.0.0.1:${process.env.PORT || 3098}/review/${review.id}`));
