// Phase 7, session S: the review page (public/review.html) is served at /review/:id, /review?plan=&session= and
// /review (the queue), carries GitHub's « Files changed » vocabulary in French and the burnout line; the home has
// its « À relire » line and a session card its « Relire » link. No browser: the HTML as served. The fixture keeps
// the shape R announces (docs/review.md on R's branch).
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-review-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-review-plans-'), ESCADRILLE_CLAUDE: '/nulle/part' }, stdio: 'ignore' });
after(() => server.kill('SIGINT'));
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
const ready = async () => { for (let i = 0; i < 150; i++) { try { if ((await get('/')).status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 60)); } throw new Error('server did not start'); };

test('the review page is served on its three addresses', async () => {
  await ready();
  for (const p of ['/review/0123abcd', '/review?plan=p1&session=S', '/review']) {
    const r = await get(p); assert.equal(r.status, 200, p); assert.match(r.type, /text\/html/, p); assert.match(r.text, /<title data-i18n="rev.title"><\/title>/, p);
  }
});

test('the page carries GitHub’s form in French, the burnout line and the keys', async () => {
  const { text } = await get('/review/0123abcd');
  for (const id of ['finish', 'finishPanel', 'canvas', 'crumb']) assert.match(text, new RegExp(`id="${id}"`), id);
  // phase 9 I: the words live in public/i18n/fr.json; the page names their keys
  const fr = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', 'fr.json'), 'utf8'));
  const said = (s) => { const k = Object.keys(fr).find((x) => typeof fr[x] === 'string' && fr[x] === s && text.includes(`'${x}'`)); assert.ok(k, s); };
  for (const s of ['Terminer la revue', 'Commenter', 'Approuver', 'Demander des changements', 'Envoyer la revue', 'Fichiers modifiés', 'Côte à côte', 'Ajouter un commentaire', 'Annuler', 'Charger le diff', 'Vu', 'À regarder d’abord', '{a} / {b} vus']) said(s);
  assert.ok(text.indexOf('value="comment"') < text.indexOf('value="approve"') && text.indexOf('value="approve"') < text.indexOf('value="changes"'), 'GitHub’s order: comment, approve, request changes');
  for (const sel of ['class="tree"', 'class="plus"', 'data-viewed', 'data-load', 'data-resolve', 'class="calm"', 'role="progressbar"']) assert.ok(text.includes(sel), sel);
  for (const k of ["e.key === 'j'", "e.key === 'v'", "e.key === 'c'"]) assert.ok(text.includes(k), k);
  for (const route of ['/api/review/', '/api/reviews', '/api/architecture/delta', '/viewed', '/submit', '/comment', '/decide', '/raw?path=']) assert.ok(text.includes(route), route);
  // the other kinds (Dev, 09:20): images, docs, plans, stop answers, each ending on Accepter · Refuser · Relancer (retryMax)
  for (const s of ['Accepter', 'Refuser…', 'Relancer', 'Envoyer le refus', 'Relances épuisées : à toi', 'Avant', 'Après', 'Voir le rendu']) said(s);
  for (const s of ["'rev.k.'", "'stop', 'image', 'doc', 'plan'", 'retryMax ?? 2']) assert.ok(text.includes(s), s);
  for (const k of ["'image'", "'doc'", "'plan'", "kind === 'stop'"]) assert.ok(text.includes(k), k);
  assert.equal(text.slice(text.indexOf('<body>'), text.indexOf('<script')).match(/class="btn primary/g), null, 'the one primary action is drawn in the canvas');
  assert.match(text, /\/ 400 \* 60/, 'reading time: lines not generated, 400 an hour');
});

test('the home has its reviews line in « Ce qui t\'attend », the session card its « Relire » link', async () => {
  // phase 9 B: the home is the Conversation (public/mainchat.js); the reviews are one line of « Ce qui t'attend »
  const home = (await get('/')).text; assert.ok(home.includes('<script src="/mainchat.js"></script>'), 'home loads the Conversation');
  const mc = readFileSync(path.join(HERE, '..', 'public', 'mainchat.js'), 'utf8'); assert.ok(mc.includes("'/api/reviews'"), 'the Conversation reads the queue'); assert.ok(mc.includes("T('main.todo.review'"), 'the reviews line (one per review, phase 11 X)');
  const plan = readFileSync(path.join(HERE, '..', 'public', 'plan.html'), 'utf8'); assert.match(plan, /href="\/review\?plan=\$\{encodeURIComponent\(data\.plan\.id\)\}&session=\$\{encodeURIComponent\(s\.id\)\}">\$\{esc\(T\('plan\.review'\)\)\}<\/a>/);
});

test('the fixture keeps the shape R announces', () => {
  const r = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'review-small.json'), 'utf8'));
  for (const k of ['id', 'repo', 'base', 'head', 'headSha', 'level', 'files', 'comments', 'verdict', 'prereview']) assert.ok(k in r, k);
  assert.match(r.id, /^[0-9a-f]{40}$/);
  for (const f of r.files) { assert.ok(['added', 'modified', 'deleted', 'renamed'].includes(f.status), f.path); assert.equal(typeof f.generated, 'boolean');
    let a = 0, d = 0; for (const h of f.hunks) { assert.match(h.header, /^@@ /); for (const l of h.lines) { assert.ok(['ctx', 'add', 'del'].includes(l.kind)); if (l.kind === 'add') a++; if (l.kind === 'del') d++; } }
    assert.deepEqual([a, d], [f.additions, f.deletions], f.path); }
});

test('the page posts every decision to a route the server serves (/decide existed only in the page)', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../public/review.html', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  for (const m of page.matchAll(/\/api\/review\/\$\{[^}]+\}\/([a-z]+)/g)) assert.ok(server.includes(`seg[3] === '${m[1]}'`), `the server answers /api/review/:id/${m[1]}`);
});

// Phase 11, G (Dev approved a review and « rien ne s'est passé »): after « Envoyer la revue », the decision bar becomes the
// answer: the verdict's pill, what happened, the next review still to read (primary, focused), else the way back to the list
test('after « Envoyer la revue »: the verdict, then the next review to read or the list', async () => {
  const src = readFileSync(path.join(HERE, '..', 'public', 'review.html'), 'utf8');
  const part = src.slice(src.indexOf('const listHref'), src.indexOf('const sentBar'));
  const ctx = { esc: (s) => String(s), T: (k, v) => (v && v.t !== undefined ? `${k}:${v.t}` : k), VERDICTS: { approve: ['Approuvée', 'pos'] }, R: { id: 'me', project: '/p' } };
  ctx.window = ctx; runInNewContext(readFileSync(path.join(HERE, '..', 'public', 'projects.js'), 'utf8'), ctx);
  runInNewContext(part + '; this.sentHtml = sentHtml; this.nextOf = nextOf;', ctx);
  const list = [{ id: 'me' }, { id: 'done', verdict: { verdict: 'approve', stale: false } }, { id: 'next', title: 'B · Écran' }];
  assert.equal(ctx.nextOf(list, 'me').id, 'next', 'not itself, not one already read');
  const h = ctx.sentHtml('approve', 'Approuvée.', ctx.nextOf(list, 'me'));
  assert.match(h, /role="status"/); assert.match(h, /class="pill pos">Approuvée</);
  assert.match(h, /class="btn primary" id="rvNext" href="\/review\/next\?project=%2Fp">rev.nextReview:B · Écran</); assert.match(h, /href="\/review\?project=%2Fp">rev.backList</);
  assert.match(ctx.sentHtml('approve', 'x', ctx.nextOf([{ id: 'me' }], 'me')), /class="btn primary" id="rvNext" href="\/review\?project=%2Fp">rev.backList</, 'nothing left: back to the list');
  assert.ok(src.includes("await sentBar(verdict, said)"), 'the submit ends on the bar');
  assert.ok(src.includes('PJ.toReview(all)') && src.includes("rev.readN"), 'the queue: « À relire », then « Relues » folded');
  assert.ok(readFileSync(path.join(HERE, '..', 'public', 'sidebar.js'), 'utf8').includes('toReview(rvs)'), 'the bar’s count leaves the read ones out');
});
