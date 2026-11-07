// The defect of 6 November 18:30 (docs/backlog.md): « passe en autonome » typed in the Conversation started a planning
// that stayed in « À toi » with no way out. Checked: Abandonner stops the planning (status stopped) and it leaves
// « À toi »; a sentence that only names a setting (public/settingintent.js) creates no escadrille and offers the
// setting in one line; a real request still plans.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testEnv } from './test-env.mjs';
import { fakeClaude } from './fake-claude.mjs';
import { freePort } from './free-port.mjs';
import { i18nInto } from './i18n-env.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUB = path.join(HERE, '..', 'public');
const require = createRequire(import.meta.url);
const intent = require('../public/settingintent.js');
const todo = require('../public/todo.js');

const SETTINGS = ['passe en autonome', 'mode guidé', 'passe en surveillé', 'éteins la rafale', 'Passe en mode autonome.', 'mets en guidé stp', 'allume la rafale automatique'];
const IDEAS = ['ajoute un bouton d\'export', 'passe en autonome le module de paiement', 'rends le pilote autonome sur les tests', 'éteins la rafale quand le quota dépasse 80 %', 'autonome ?! pourquoi la session s\'arrête'];

test('the setting sentences are recognised, without a model; a real request is not', () => {
  assert.deepEqual(intent.detect('passe en autonome').body, { autonomy: { mode: 'autonome' } });
  assert.deepEqual(intent.detect('mode guidé').body, { autonomy: { mode: 'guide' } });
  assert.deepEqual(intent.detect('passe en surveillé').body, { autonomy: { mode: 'surveille' } });
  assert.deepEqual(intent.detect('éteins la rafale', { autoBurst: { on: true, minMarginPct: 40, maxHoursLeft: 6 } }).body, { autoBurst: { on: false, minMarginPct: 40, maxHoursLeft: 6 } }, 'the thresholds stay');
  for (const s of SETTINGS) assert.ok(intent.detect(s), s);
  for (const s of IDEAS) assert.equal(intent.detect(s), null, s);
});

// the home in a vm, as test/mainchat-home.test.mjs, with a document that keeps its listeners and an api that records
const home = () => {
  const calls = []; const listeners = {};
  const el = (extra = {}) => ({ appendChild() {}, classList: { toggle() {}, contains: () => false, remove() {} }, textContent: '', value: '', disabled: false, focus() {}, addEventListener() {}, dispatchEvent() {}, closest: () => null, dataset: {}, ...extra });
  const nodes = { text: el({ id: 'text' }), state: el({ id: 'state' }), send: el({ id: 'send' }) };
  const document = { head: el(), body: el(), createElement: () => el(), getElementById: (id) => nodes[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, activeElement: null, hidden: false, documentElement: el() };
  const window = { document, location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {}, state: null }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, innerWidth: 1440, queueMicrotask: (f) => f(), setInterval: () => 0, clearTimeout() {}, setTimeout: () => 0, requestAnimationFrame: () => 0, fetch: async () => ({ ok: false, json: async () => ({}) }) };
  window.window = window; Object.assign(window, { Promise, URLSearchParams, Date, console, JSON, Math, Number, String, Array, Object, Event: class {} });
  Object.assign(window, { escId: null, project: '/p/calmdev', meta: { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }], projects: [{ path: '/p/calmdev', name: 'calmdev' }] }, settings: null, render() {},
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), md: (s) => `<p>${s}</p>`,
    api: async (p, body) => { calls.push({ p, body }); return p === '/api/escadrille' ? { id: 'e1', title: 'x' } : p === '/api/project/settings' ? { ok: true, settings: { autonomy: body.autonomy } } : null; },
    fmt: (n) => String(n), canvas: el(), setupSpeech() {}, P: { name: (p) => (p ? p.split('/').pop() : ''), withProject: (h) => h } });
  i18nInto(window); for (const f of ['todo.js', 'settingintent.js', 'mainchat.js']) runInNewContext(readFileSync(path.join(PUB, f), 'utf8'), window);
  const m = window.escadrilleMain; m.set({ st: { project: '/p/calmdev', messages: [], more: false, total: 0 }, pilot: { on: false }, flow: { nodes: [], plans: [] }, reviews: [], escs: [] });
  const type = async (text) => { nodes.text.value = text; for (const f of listeners.keydown || []) f({ target: nodes.text, key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {}, stopImmediatePropagation() {} }); await new Promise((r) => setImmediate(r)); };
  const click = async (attrs) => { const b = el({ dataset: attrs }); for (const f of listeners.click || []) f({ target: { closest: (s) => (s === 'button' ? b : null) } }); await new Promise((r) => setImmediate(r)); };
  return { m, calls, type, click };
};

test('a setting sentence starts no planning and offers the setting in one line; its button saves it', async () => {
  for (const s of ['passe en autonome', 'mode guidé', 'passe en surveillé', 'éteins la rafale']) {
    const h = home(); await h.type(s);
    assert.equal(h.calls.filter((c) => c.p === '/api/escadrille').length, 0, s + ': nothing sent to the planner');
    assert.match(h.m.view().replace(/&#39;/g, "'"), /class="mc-offer" role="status"><span class="t">(Passer calmdev en (Autonome|Guidé|Surveillé) \?|Éteindre la rafale automatique de calmdev \?)<\/span><button type="button" class="btn" data-offer>/, s);
  }
  const h = home(); await h.type('passe en autonome'); await h.click({ offer: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), { p: '/api/project/settings', body: { project: '/p/calmdev', autonomy: { mode: 'autonome' } } });
  assert.ok(!/mc-offer/.test(h.m.view()), 'the line leaves once the setting is saved');
  assert.equal((h.m.view().match(/class="btn primary"/g) || []).length, 1, 'one primary action');
});

test('a real request still plans; « Planifier quand même » plans the setting sentence', async () => {
  const posts = (h) => h.calls.filter((c) => c.body).map((c) => c.p);
  let h = home(); await h.type('ajoute un bouton d\'export');
  assert.deepEqual(posts(h), ['/api/escadrille']); assert.equal(h.calls[0].body.idea, 'ajoute un bouton d\'export');
  h = home(); await h.type('passe en autonome'); await h.click({ offerPlan: '' });
  assert.deepEqual(posts(h), ['/api/escadrille']);
});

const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const fake = fakeClaude(); const none = tmp('escadrille-aban-none-'); const DB = path.join(tmp('escadrille-aban-db-'), 'db.sqlite');
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-aban-plans-'), ESCADRILLE_TRANSCRIPTS: none, ESCADRILLE_SESSIONS: none, ESCADRILLE_CLAUDE: fake.file }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill('SIGINT'));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };

test('Abandonner: the planning is stopped in /api/escadrilles and leaves « À toi »', async () => {
  await until(async () => { try { return (await fetch(BASE + '/api/plans')).status === 200; } catch { return false; } });
  const project = tmp('escadrille-aban-proj-');
  // the planning of 6 November as it stood: waiting for an answer, its process gone (seeded: no planner turn to wait for)
  const at = new Date().toISOString(); const e = { body: { id: 'passe-en-autonome-418e' } };
  const db = new DatabaseSync(DB); db.prepare('insert into escadrilles (id, title, project, model, status, created, at) values (?, ?, ?, ?, ?, ?, ?)').run(e.body.id, 'passe en autonome', project, 'claude-opus-5-5', 'waiting', at, at); db.close();
  const escs = async () => (await fetch(BASE + '/api/escadrilles?project=' + encodeURIComponent(project))).json();
  const aToi = async () => todo.items({ escs: await escs() }).filter((x) => x.kind === 'planning').map((x) => x.id);
  assert.deepEqual(await aToi(), [e.body.id], 'the waiting planning is in « À toi »');
  assert.deepEqual((await post(`/api/escadrille/${e.body.id}/stop`)).body, { ok: true });
  assert.equal((await escs()).find((x) => x.id === e.body.id).status, 'stopped');
  assert.deepEqual(await aToi(), [], 'gone from « À toi » at once');
});

test('the « À toi » line of a planning carries Abandonner next to Répondre', () => {
  const h = home(); h.m.set({ escs: [{ id: 'passe-en-autonome-418e', title: 'passe en autonome', status: 'waiting' }] });
  const lines = h.m.waiting();
  assert.match(lines[0].act, /data-abandon="passe-en-autonome-418e">Abandonner<\/button><a class="btn" href="\/e\/passe-en-autonome-418e">Répondre<\/a>/);
});
