// Phase 8 D, the pilot's log (docs/pilotlog.md): record and list on an in-memory base, then the two routes on a
// spare port, the LAN refused.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as pilotlog from '../lib/pilotlog.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

test('record keeps an action, the server builds its link, the line holds ten words and the rest is the why', () => {
  const db = new DatabaseSync(':memory:'); pilotlog.schema(db);
  const a = pilotlog.record(db, { project: '/p', planId: 'phase-8', sessionId: 'B', kind: 'answer', text: 'Répondu à B : garder le port 3078\nB demandait s’il pouvait changer de port ; la règle le fixe.' });
  assert.equal(a.text, 'Répondu à B : garder le port 3078');
  assert.equal(a.detail, 'B demandait s’il pouvait changer de port ; la règle le fixe.');
  assert.equal(a.href, '/plan/phase-8?project=%2Fp#s-B');
  assert.equal(pilotlog.record(db, { project: '/p', planId: 'phase-8', kind: 'launch', text: 'Lancé le plan' }).href, '/plan/phase-8?project=%2Fp');
  assert.equal(pilotlog.record(db, { project: '/p', kind: 'note', text: 'Une note, http://ailleurs.example' }).href, null, 'never a link read in the text');
  const long = pilotlog.record(db, { project: '/p', kind: 'note', text: 'un deux trois quatre cinq six sept huit neuf dix onze douze' });
  assert.equal(long.text, 'un deux trois quatre cinq six sept huit neuf dix…'); assert.equal(long.detail, '…onze douze');
  assert.throws(() => pilotlog.record(db, { project: '/p', kind: 'dance', text: 'x' }), /kind/);
  assert.throws(() => pilotlog.record(db, { project: '/p', kind: 'note', text: '  ' }), /vide/);
  assert.throws(() => pilotlog.record(db, { kind: 'note', text: 'x' }), /project/);
});

test('list pages newest first, per project', () => {
  const db = new DatabaseSync(':memory:'); pilotlog.schema(db);
  for (let i = 1; i <= 5; i++) pilotlog.record(db, { project: '/p', kind: 'note', text: 'action ' + i, at: `2026-11-01T08:0${i}:00Z` });
  pilotlog.record(db, { project: '/q', kind: 'note', text: 'ailleurs' });
  const p1 = pilotlog.list(db, { project: '/p', limit: 2 });
  assert.deepEqual(p1.actions.map((a) => a.text), ['action 5', 'action 4']); assert.equal(p1.more, true); assert.equal(p1.total, 5);
  const p2 = pilotlog.list(db, { project: '/p', limit: 10, before: p1.actions[1].seq });
  assert.deepEqual(p2.actions.map((a) => a.text), ['action 3', 'action 2', 'action 1']); assert.equal(p2.more, false);
  assert.deepEqual(Object.keys(p2.actions[0]).sort(), ['at', 'detail', 'href', 'kind', 'planId', 'seq', 'sessionId', 'text']);
});

const PROJ = tmp('escadrille-pilotlog-');
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: '/bin/false', ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_TEST_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const call = async (p, body, headers = {}) => { const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const ready = until(async () => { try { return (await call('/api/plans')).status === 200; } catch { return false; } });

test('POST /api/pilot/log writes from the Mac, GET reads it back with the link, the LAN gets nothing', async () => {
  await ready;
  const r = await call('/api/pilot/log', { project: PROJ, kind: 'merge', text: 'Fusionné D dans main', plan: 'phase-8', session: 'D' });
  assert.equal(r.status, 200, err); assert.equal(r.body.action.kind, 'merge');
  assert.equal((await call('/api/pilot/log', { project: PROJ, kind: 'nope', text: 'x' })).status, 400);
  assert.equal((await call('/api/pilot/log', { project: '/nulle/part', kind: 'note', text: 'x' })).status, 400);
  const g = (await call('/api/pilot/log?project=' + encodeURIComponent(PROJ))).body;
  assert.equal(g.actions.length, 1); assert.equal(g.more, false);
  assert.equal(g.actions[0].href, `/plan/phase-8?project=${encodeURIComponent(PROJ)}#s-D`);
  assert.equal((await call('/api/pilot/log?project=' + encodeURIComponent(PROJ), undefined, { 'x-escadrille-remote': '1' })).status, 401, 'never to the LAN without a token');
  const { code } = (await call('/api/pair/code', {})).body;
  const token = (await call('/api/pair', { code, name: 'tel' }, { 'x-escadrille-remote': '1' })).body.token; assert.ok(token);
  const lan = { 'x-escadrille-remote': '1', authorization: 'Bearer ' + token };
  assert.equal((await call('/api/pilot/log', { project: PROJ, kind: 'note', text: 'x' }, lan)).status, 403, 'the Mac only');
  assert.equal((await call('/api/pilot/log?project=' + encodeURIComponent(PROJ), undefined, lan)).status, 403);
});

// The screen, without a browser: pilotlog.js wraps a stand-in for mainchat.js's window.escadrilleMain
test('the screen: rows by day, the verb once, the chip links the session, the why opens; the folded line under the thread', async () => {
  const { readFileSync } = await import('node:fs'); const vm = await import('node:vm');
  const actions = [
    { seq: 3, kind: 'answer', text: 'Répondu à B : garder le port 3078', detail: 'La règle fixe 3078.', planId: 'p8', sessionId: 'B', at: '2026-11-01T08:46:00Z', href: '/plan/p8?project=%2Fp#s-B' },
    { seq: 2, kind: 'memory', text: 'la décision « Le flot du produit »', detail: '', planId: null, sessionId: null, at: '2026-11-01T08:20:00Z', href: null },
    { seq: 1, kind: 'launch', text: 'Lancé la phase 7', detail: '', planId: 'p7', sessionId: null, at: '2026-10-31T21:40:00Z', href: '/plan/p7?project=%2Fp' },
  ];
  const listeners = {}; const crumb = { textContent: '' }; let canvas = '';
  const ctx = { escId: null, project: '/p', meta: null, location: { hash: '#conversation' },
    esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), fmt: String,
    P: { name: () => 'p', withProject: (u, p) => u + '?project=' + encodeURIComponent(p) },
    api: async () => ({ actions, more: false, total: 3 }), EventSource: class { addEventListener() {} close() {} },
    document: { head: { appendChild() {} }, createElement: () => ({}), addEventListener: (k, f) => { listeners[k] = f; }, getElementById: (id) => (id === 'crumb' ? crumb : null), querySelector: () => null } };
  ctx.window = ctx; ctx.render = () => { canvas = ctx.window.escadrilleMain.view(); };
  ctx.escadrilleMain = { is: () => ctx.location.hash === '#conversation', view: () => '<div class="mc-thread"></div><div id="mainEnd"></div><form id="mainForm"></form>', title: () => 'Conversation' };
  vm.createContext(ctx); (await import('./i18n-env.mjs')).i18nInto(ctx); vm.runInContext(readFileSync(path.join(HERE, '..', 'public', 'pilotlog.js'), 'utf8'), ctx);
  const wait = () => new Promise((r) => setTimeout(r, 10));
  ctx.render(); await wait(); ctx.render();
  assert.match(canvas, /mc-thread"><\/div><p class="pl-fold" id="plFold"><a href="\/\?project=%2Fp#pilote" data-jk>Le pilote · <span class="pl-n">3<\/span> actions<\/a><\/p><div id="mainEnd">/, 'the folded line sits under the thread');
  ctx.location.hash = '#pilote'; ctx.render();
  assert.equal(crumb.textContent, 'Pilote'); // phase 9: the screen is titled « Pilote », the folded line keeps « Le pilote »
  assert.ok(canvas.includes('<h1>Pilote</h1>') && canvas.includes('id="plPilot"'), 'the title and the switch in the title row');
  assert.equal((canvas.match(/class="pl-day"/g) || []).length, 2, 'grouped by day');
  assert.ok(canvas.includes('<b>Répondu</b> à B : garder le port 3078'), 'the verb said once');
  assert.ok(canvas.includes('<b>Noté</b> la décision'), 'the verb of the kind in front of the line');
  assert.ok(canvas.includes('<a class="pl-chip" href="/plan/p8?project=%2Fp#s-B"'), 'the chip links the session');
  assert.ok(canvas.includes('>Plan</a>'), 'a plan without session gets its own chip');
  assert.ok(!canvas.includes('pl-why'), 'the why is folded');
  listeners.click({ target: { closest: () => ({ dataset: { why: '3' } }) } });
  assert.ok(canvas.includes('<p class="pl-why" id="plw-3">La règle fixe 3078.</p>'), 'the why opens on a click');
});
