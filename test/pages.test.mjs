// Phase 6, the page side of the multiproject (docs/multiproject.md): the pages are served with ?project=, carry the
// picker, the groups and the memory entry, and public/projects.js turns the served JSON into one group per project
// (the current one first, open), keeps ?project= in links and renders memory lines. No browser: the HTML as served,
// the JSON as served, projects.js run in a vm.
import { freePort } from './free-port.mjs';
import { i18nInto } from './i18n-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const projA = path.join(tmp('escadrille-pages-'), 'Alpha'); const projB = path.join(tmp('escadrille-pages-'), 'Bravo');
for (const p of [projA, projB]) mkdirSync(p, { recursive: true });
mkdirSync(path.join(projA, 'docs')); writeFileSync(path.join(projA, 'docs', 'decisions.md'), '# Décisions\n\n- **2026-11-01 (06:10)** : les avatars restent en `PNG` 512\n');

const DB = path.join(tmp('escadrille-db-'), 'db.sqlite');
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: '/nulle/part' }, stdio: 'ignore' });
after(() => server.kill('SIGINT'));
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
const json = async (p) => JSON.parse((await get(p)).text);
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const enc = encodeURIComponent;

const P = (() => { const ctx = vm.createContext({ URLSearchParams }); vm.runInContext(readFileSync(path.join(HERE, '..', 'public', 'projects.js'), 'utf8'), ctx); return ctx.escadrilleProjects; })();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

test('the pages are served with ?project= and carry the picker, the groups and the memory', async () => {
  await until(async () => { try { return (await get('/api/plans')).status === 200; } catch { return false; } });
  const sess = (p) => ({ id: 'A', name: 'a', wave: 1, path: p, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' });
  for (const [id, p] of [['pa1', projA], ['pa2', projA], ['pb1', projB]]) assert.equal((await post('/api/plan', { id, title: id, project: p, waves: [{ n: 1, title: 'w' }], sessions: [sess(p)] })).ok, true, id);
  const db = new DatabaseSync(DB);
  const ins = db.prepare("insert into escadrilles (id, title, project, model, status, created, at) values (?, ?, ?, 'claude-opus-5-5', 'planned', ?, ?)");
  ins.run('ea', 'Alpha une', projA, '2026-11-01T05:00:00Z', '2026-11-01T05:00:00Z'); ins.run('eb', 'Bravo une', projB, '2099-01-01T06:00:00Z', '2099-01-01T06:00:00Z'); db.close();

  const home = await get('/?project=' + enc(projA));
  assert.equal(home.status, 200); assert.match(home.type, /text\/html/);
  for (const id of ['sidebar', 'crumb', 'crumbProj']) assert.match(home.text, new RegExp(`id="${id}"`), id);
  assert.match(home.text, /<script src="\/projects.js"><\/script>/); assert.match(home.text, /<script src="\/speech.js"><\/script>/); assert.match(home.text, /<script src="\/sidebar.js"><\/script>/);
  assert.equal(home.text.slice(home.text.indexOf("<body>"), home.text.indexOf("<script")).match(/class="btn primary/g), null, 'no primary in the shell: the one primary action of each screen is in its canvas');
  const memo = await get('/e/ea?project=' + enc(projA)); assert.equal(memo.status, 200);
  const plan = await get('/plan/pa1?project=' + enc(projA)); assert.equal(plan.status, 200); assert.match(plan.text, /<script src="\/projects.js"><\/script>/);
  const js = await get('/projects.js'); assert.equal(js.status, 200); assert.match(js.type, /javascript/);

  // the groups the home draws, from the JSON it reads
  const [escs, plans] = await Promise.all([json('/api/escadrilles'), json('/api/plans')]);
  const groups = P.group({ projects: [], escadrilles: escs, plans, current: projA });
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map((g) => [g.name, g.current, g.escadrilles.length, g.plans.length]))), [['Alpha', true, 1, 2], ['Bravo', false, 1, 1]], 'the current project first');
  assert.equal(groups[1].last, '2099-01-01T06:00:00.000Z', 'last movement: its newest escadrille or plan');
  assert.deepEqual((await json('/api/plans?project=' + enc(projB))).map((p) => p.id), ['pb1'], 'the plan page lists its project only');
  assert.equal((await json('/api/plan/pa1')).plan.project, projA, 'the plan page knows its project');

  // the current project: ?project=, else localStorage, else the last escadrille
  assert.equal(P.current({ search: '?project=' + enc(projB), stored: projA, escadrilles: escs }), projB);
  assert.equal(P.current({ search: '', stored: projA, escadrilles: escs }), projA);
  assert.equal(P.current({ search: '', stored: null, escadrilles: escs }), projB, 'the newest escadrille');
  assert.equal(P.withProject('/plan/x#flow', projA), `/plan/x?project=${enc(projA)}#flow`);
  assert.equal(P.withProject('/', null), '/');

  // the memory view: the file, its lines, dates and bold rendered
  const mem = await json('/api/memory?project=' + enc(projA));
  assert.equal(mem.file, path.join(projA, 'docs', 'decisions.md'));
  const line = mem.lines.find((l) => l.text.includes('avatars'));
  assert.equal(P.memoryLine(line.text, esc), '<time>2026-11-01 (06:10)</time> : les avatars restent en <code>PNG</code> 512');
  assert.equal(P.memoryLine('**Design** le 2026-10-30, <b>', esc), '<strong>Design</strong> le <time>2026-10-30</time>, &lt;b&gt;');
  assert.deepEqual(await json('/api/memory?project=' + enc(projB)), { file: null, lines: [], total: 0 }, 'no file: the page says the convention');
});

// Phase 7, the connectors (session B): the PR button of a finished session, the connectors in Accès, the Linear
// settings. The PR block of plan.html is run in a vm from the HTML as served; access.js too.
const FX = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'connectors.json'), 'utf8'));
const prCode = (html) => { const a = html.indexOf('// ---- the pull request'); const b = html.indexOf('// The thread:', a); assert.ok(a > 0 && b > a, 'the PR block is in plan.html'); return html.slice(a, b); };
const PR_URL = 'https://example.invalid/o/r/pull/12';

test('a finished session that says « PR prête » offers « Ouvrir la PR » and says what goes out before', async () => {
  await until(async () => { try { return (await get('/api/plans')).status === 200; } catch { return false; } });
  const html = (await get('/plan/pa1')).text;
  for (const s of ['data-pr="open"', "'plan.openPr'", "'plan.opening'", 'data-pr="refresh"', "'plan.refresh'", '/pr`']) assert.ok(html.includes(s), s); // phase 9 I: the words are keys of public/i18n
  const plan = { ...FX.plan, project: '/p' }; const S = (id) => plan.sessions.find((s) => s.id === id); const X = (id) => ({ ...FX.state.find((x) => x.id === id), status: 'done', pr: null });
  const ctx = vm.createContext({ esc, andList: (a) => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' et ' + a[a.length - 1], data: { plan, state: [] }, render() {}, api: async () => ({}), load: async () => {}, planId: plan.id, encodeURIComponent });
  i18nInto(ctx); vm.runInContext(prCode(html) + ';globalThis.PR = { prBlock, prShort, prErr, prBusy, setLinear: (v) => { linearSettings = v; } };', ctx); const T = ctx.PR;
  const a = T.prBlock(S('A'), X('A'), true);
  assert.match(a, /class="btn primary" data-pr="open"[^>]*>Ouvrir la PR</, 'the primary action of the card');
  assert.match(a, /Pousse escadrille\/quick-wins\/A, ouvre la PR vers dev, passe ORC-88 en À revoir/);
  assert.match(T.prBlock(S('B'), X('B'), true), /passe ORC-91 et ORC-92 en À revoir/);
  T.setLinear({ key: false, state: 'À revoir' }); assert.match(T.prBlock(S('A'), X('A'), true), /ORC-88 ne bouge pas \(aucune clé Linear\)/, 'no key: the line says the ticket stays');
  T.setLinear({ key: true, state: 'In Review' }); assert.match(T.prBlock(S('A'), X('A'), true), /passe ORC-88 en In Review/, 'the state of the settings');
  assert.equal(T.prBlock(S('A'), { ...X('A'), summary: 'Fait : le minuteur.' }, true), '', 'no « PR prête », no button');
  assert.equal(T.prBlock(S('A'), { ...X('A'), status: 'waiting' }, true), '', 'a session still at work has no button');
  T.prBusy.add('A'); assert.match(T.prBlock(S('A'), X('A'), true), /disabled>Ouverture en cours…</); T.prBusy.delete('A');
  T.prErr.C = FX.fail.C;
  assert.match(T.prBlock(S('C'), X('C'), true), /<p class="pr-err" title="git push failed[^"]*">Le push a été refusé<\/p>/, 'a short line, the detail on hover');
  assert.equal(T.prShort('gh: To get started with GitHub CLI, please run: gh auth login'), 'gh n’est pas connecté');
  const done = T.prBlock(S('A'), { ...X('A'), pr: { url: PR_URL, number: 12, tickets: [{ identifier: 'ORC-88', state: 'À revoir', ok: true }, { identifier: 'ORC-92', ok: false, error: 'Entity not found' }] } }, true);
  assert.ok(done.includes(`<a href="${PR_URL}" target="_blank" rel="noopener">PR #12</a> ouverte · ORC-88 → À revoir · <span class="t-warn" title="Entity not found">ORC-92 non passé</span>`), done);
  assert.ok(!done.includes('data-pr="open"') && done.includes('data-pr="refresh"'), 'with a PR: the link and a folded Rafraîchir, no button');
});

test('Accès lists each connector, amber when ready, and the hosts reached on a click only; no button', async () => {
  const ctx = vm.createContext({ window: {} }); i18nInto(ctx); vm.runInContext(readFileSync(path.join(HERE, '..', 'public', 'access.js'), 'utf8'), ctx);
  const access = { at: '2026-11-01T09:00:00Z', server: { host: '127.0.0.1', port: 3078, lan: false, devices: [], push: { active: false, service: 'exp.host', tokens: 0, key: false } },
    sessions: { sandbox: { enabled: true, failIfUnavailable: true, writes: 'au worktree', localBinding: true }, unreadable: { count: 0, denyRead: [], readRules: [] }, env: { stripped: [] }, tools: { planner: [], sessions: [] }, denied: [], network: { plans: [], setting: [] }, addDirs: [], outside: { allowed: 0, denied: 0, pending: 0, plans: [], list: [] } },
    extensions: { connectors: FX.connectors.map((c, i) => (i ? { ...c, ready: false } : c)), plugins: [], mcp: [], files: [] }, out: FX.out, closed: [], summary: { level: { server: 'green', sessions: 'green', extensions: 'amber', out: 'amber' } } };
  const html = ctx.window.escadrilleAccess.view(access);
  assert.match(html, /<b class="t-warn">GitHub prêt<\/b> · Linear pas prêt/, 'the summary names each connector');
  assert.match(html, /<span class="acc-dot warn" aria-hidden="true"><\/span><b>GitHub<\/b> <span class="t-warn">prêt<\/span> · pousse la branche/);
  assert.match(html, /<span class="acc-dot " aria-hidden="true"><\/span><b>Linear<\/b> <span class="acc-muted">pas prêt<\/span>/, 'grey when not ready');
  assert.match(html, /api.github.com, api.linear.app<\/b> sur clic seulement/);
  assert.match(html, /Rien ne sort seul ; api.github.com, api.linear.app sur clic seulement/, 'the finding: nothing leaves on its own');
  assert.ok(!/<button/.test(html), 'the page reads, no button');
});

test('the project settings: a Linear key field in password, never filled, and a default state', async () => {
  const html = (await get('/?project=' + enc(projA))).text;
  const field = html.match(/<input[^>]*name="linearKey"[^>]*>/); assert.ok(field, 'the key field');
  assert.match(field[0], /type="password"/); assert.match(field[0], /autocomplete="off"/); assert.ok(!/value=/.test(field[0]), 'never a value in the HTML');
  for (const s of ["T('set.linearKey')", "T('set.keyStored')", `data-linear="replace">\${esc(T('set.replace'))}`, `data-linear="clear">\${esc(T('set.erase'))}`, "T('set.linearState')", "T('set.keyWhere')", 'data-block="plans"', 'data-block="linear"']) assert.ok(html.includes(s), s);
  // the sync (docs/connectors.md, « La synchro »): one checkbox, shown with a key only, checked unless the setting says false, sent only when it changes
  assert.ok(html.includes(`const syncRow = L.key ? \`<label class="check"><input type="checkbox" name="linearSync" \${L.sync !== false ? 'checked' : ''}>`), 'the sync checkbox with a key');
  assert.ok(html.includes("if (sync && s.linear && sync.checked !== (s.linear.sync !== false)) body.linearSync = sync.checked;"), 'sent on a change only');
  assert.ok(html.includes(`name="linearState" value="\${esc(L.state || T('set.linearDefault'))}"`), 'À revoir visible by default');
});
