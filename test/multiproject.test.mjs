// Phase 6, the server side of the multiproject and the memory (docs/multiproject.md), against the server on a
// spare port with a database prepared before it starts (plans written before phase 6, without a project), the
// fake claude as the planner, and throwaway project folders.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { isNetwork } from '../lib/planner.mjs';
import { titleFor } from '../lib/push.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = (name) => { const root = path.join(tmp('escadrille-mp-'), name); mkdirSync(path.join(root, 'app'), { recursive: true }); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

// Three projects: A has an escadrille, B is reached through a git worktree, C has a docs/decisions.md of 50 lines
const projA = repo('Alpha'); const projB = repo('Bravo'); const projC = repo('Charlie'); const projD = tmp('escadrille-mp-big-');
const wtB = path.join(projB, '.claude', 'worktrees', 'old-wt-A'); sh(projB, ['worktree', 'add', '-q', '-b', 'escadrille/old-wt/A', wtB]);
mkdirSync(path.join(projC, 'docs')); writeFileSync(path.join(projC, 'docs', 'decisions.md'), Array.from({ length: 50 }, (_, i) => `ligne ${i + 1}`).join('\n') + '\n');
writeFileSync(path.join(projD, 'x'), ''); mkdirSync(path.join(projD, 'docs')); writeFileSync(path.join(projD, 'docs', 'decisions.md'), Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join('\n'));

// The database as phase 5 left it: plans without a project column
const DB = path.join(tmp('escadrille-db-'), 'db.sqlite');
{
  const db = new DatabaseSync(DB);
  db.exec(`create table plans (id text primary key, title text, created text, json text);
    create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, worktree text, primary key (plan, id));
    create table escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text);`);
  const plan = (id, p) => JSON.stringify({ id, title: id, created: '2026-10-30T10:00:00Z', waves: [{ n: 1, title: 'w' }], sessions: [{ id: 'A', name: 'a', wave: 1, path: p, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' }] });
  db.prepare('insert into plans values (?, ?, ?, ?)').run('old-e', 'old-e', '2026-10-30T10:00:00Z', plan('old-e', '/nulle/part'));
  db.prepare('insert into plans values (?, ?, ?, ?)').run('old-wt', 'old-wt', '2026-10-30T11:00:00Z', plan('old-wt', path.join(wtB, 'app')));
  db.prepare("insert into escadrilles (id, title, project, model, plan_id, status, created, at) values ('e1', 'e1', ?, 'claude-opus-5-5', 'old-e', 'stopped', '2026-10-30', '2026-10-30')").run(projA);
  for (const [planId, p] of [['old-e', path.join(projA, '.claude', 'worktrees', 'x')], ['old-wt', wtB]]) {
    mkdirSync(p, { recursive: true });
    db.prepare("insert into sessions (plan, id, status, stops, health, why, claude, note, name, at, worktree) values (?, 'A', 'waiting', '[]', 'ok', '', '', '', 'a', '2026-10-30', ?)").run(planId, JSON.stringify({ path: p, cwd: p, branch: 'b', merged: false }));
  }
  db.close();
}

const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_TEST_REMOTE: '1', ESCADRILLE_SECRETS: path.join(tmp('escadrille-secrets-'), 'secrets.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const call = async (p, { body, remote, token } = {}) => { const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(remote ? { 'x-escadrille-remote': '1' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const get = async (p) => (await call(p)).body;
const q = (p) => encodeURIComponent(p);
const ready = until(async () => { try { await get('/api/plans'); return true; } catch { return false; } });

test('the migration gives a project to the plans written before phase 6, and ?project= filters every list', async () => {
  await ready;
  const plans = await get('/api/plans');
  assert.deepEqual(plans.map((p) => [p.id, p.project]), [['old-wt', projB], ['old-e', projA]], 'by the escadrille, by the git root of a worktree');
  assert.equal((await get('/api/plan/old-e')).plan.project, projA);
  assert.deepEqual((await get(`/api/plans?project=${q(projA)}`)).map((p) => p.id), ['old-e']);
  assert.deepEqual((await get(`/api/plans?project=${q(projB)}`)).map((p) => p.id), ['old-wt']);
  assert.deepEqual((await get(`/api/escadrilles?project=${q(projA)}`)).map((e) => e.id), ['e1']);
  assert.deepEqual(await get(`/api/escadrilles?project=${q(projB)}`), []);
  const run = await get('/api/running');
  assert.deepEqual(run.ours.map((o) => [o.kind, o.plan, o.project]).sort(), [['worktree', 'old-e', projA], ['worktree', 'old-wt', projB]]);
  const runB = await get(`/api/running?project=${q(projB)}`);
  assert.deepEqual(runB.ours.map((o) => o.plan), ['old-wt']); assert.ok(Array.isArray(runB.others), 'others stays whole');
  const a = (await get('/api/projects')).projects.find((p) => p.path === projA);
  // The server leaves out folders under /tmp (knownProjects): where the system temp is there (the session sandbox,
  // TMPDIR=/tmp/claude-…), the project cannot be listed, and the rule itself is what is asserted
  if (/^(\/private)?\/tmp(\/|$)/.test(projA)) assert.equal(a, undefined, 'a project under /tmp is left out of the list');
  else assert.deepEqual({ name: a.name, escadrilles: a.escadrilles, plans: a.plans }, { name: 'Alpha', escadrilles: 1, plans: 1 });
  // the phone: its plans say their project, ?project= filters them
  const code = (await call('/api/pair/code', { body: {} })).body.code;
  const token = (await call('/api/pair', { body: { code, name: 'tel' }, remote: true })).body.token;
  const home = await call(`/api/phone?project=${q(projB)}`, { remote: true, token });
  assert.equal(home.status, 200); assert.deepEqual(home.body.plans.map((p) => [p.id, p.project]), [['old-wt', projB]]);
  assert.equal((await call(`/api/memory?project=${q(projA)}`, { remote: true, token })).status, 403, 'the memory is the Mac’s');
  assert.equal((await call(`/api/project/settings?project=${q(projA)}`, { remote: true, token })).status, 403, 'the settings are the Mac’s');
});

const noAutonomy = ({ autonomy, ...rest }) => rest; // its own tests: test/autonomy.test.mjs
test('the settings of a project: defaults, partial writes, validation, and a plan filled from them, then left alone', async () => {
  await ready;
  assert.deepEqual(noAutonomy(await get(`/api/project/settings?project=${q(projC)}`)), { project: projC, game: true, qa: true, budget: 5, network: [], model: null, addDirs: [], parallel: null, autoBurst: null, environment: { set: false, accounts: [] }, review: 'guided', retryMax: 2, linear: { key: false, state: 'À revoir', sync: false }, stored: [] });
  assert.equal((await get(`/api/project/settings?project=${q(projA)}`)).model, 'claude-opus-5-5', 'the last model chosen for the project');
  assert.equal((await call('/api/project/settings?project=relative')).status, 400);
  let r = await call('/api/project/settings', { body: { project: projC, budget: 2 } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.settings.stored, ['budget']);
  r = await call('/api/project/settings', { body: { project: projC, network: ['API.github.com'], addDirs: [projD], model: 'claude-sonnet-5-5' } });
  assert.deepEqual(noAutonomy(r.body.settings), { project: projC, game: true, qa: true, budget: 2, network: [{ host: 'api.github.com', scope: 'both' }], model: 'claude-sonnet-5-5', addDirs: [projD], parallel: null, autoBurst: null, environment: { set: false, accounts: [] }, review: 'guided', retryMax: 2, linear: { key: false, state: 'À revoir', sync: false }, stored: ['budget', 'network', 'model', 'addDirs'] }, 'budget kept');
  for (const bad of [{ budget: -1 }, { budget: 'x' }, { network: ['http://x.io'] }, { model: 'gpt' }, { addDirs: ['rel/ative'] }, { addDirs: ['/nulle/part'] }, { addDirs: 'x' }]) assert.equal((await call('/api/project/settings', { body: { project: projC, ...bad } })).status, 400, JSON.stringify(bad));
  assert.equal((await call('/api/project/settings', { body: { budget: 1 } })).status, 400, 'project missing');
  // a plan written now: what it lacks comes from the settings; what it says stays
  const sess = { name: 's', path: path.join(projC, 'app'), model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' };
  assert.equal((await call('/api/plan', { body: { id: 'neuf', title: 'Neuf', sessions: [{ id: 'A', ...sess }, { id: 'B', ...sess, budget: 1 }] } })).status, 200);
  let plan = (await get('/api/plan/neuf')).plan;
  // the project's domains are not copied into the plan any more: its network only announces (lib/domains.mjs)
  assert.deepEqual([plan.project, plan.network, plan.addDirs, plan.sessions.map((s) => s.budget)], [projC, [], [projD], [2, 1]]);
  assert.deepEqual((await get(`/api/plans?project=${q(projC)}`)).map((p) => p.id), ['neuf']);
  // a setting changed afterwards does not touch the written plan; null brings a field back to its default
  await call('/api/project/settings', { body: { project: projC, budget: 9, network: null } });
  plan = (await get('/api/plan/neuf')).plan;
  assert.deepEqual([plan.network, plan.sessions.map((s) => s.budget)], [[], [2, 1]]);
  const st = await get(`/api/project/settings?project=${q(projC)}`); assert.deepEqual([st.budget, st.network, st.stored], [9, [], ['budget', 'model', 'addDirs']]);
});

test('the memory: .escadrille/memoire.md created, docs/decisions.md when it exists, 2000 lines at most, bad lines refused', async () => {
  await ready;
  assert.deepEqual(await get(`/api/memory?project=${q(projA)}`), { file: null, lines: [], total: 0 });
  let r = await call('/api/memory', { body: { project: projA, line: '  Les avatars restent en PNG 512  ' } });
  const file = path.join(projA, '.calmdev', 'memoire.md');
  assert.deepEqual(r.body, { ok: true, file });
  assert.match(readFileSync(file, 'utf8'), /^- \*\*\d{4}-\d\d-\d\d \(\d\d:\d\d\)\*\* : Les avatars restent en PNG 512\n$/);
  await call('/api/memory', { body: { project: projA, line: 'deuxième' } });
  r = await get(`/api/memory?project=${q(projA)}`);
  assert.equal(r.file, file); assert.equal(r.total, 2); assert.deepEqual(r.lines.map((l) => l.n), [1, 2]); assert.match(r.lines[1].text, / : deuxième$/);
  for (const line of ['', '   ', 'a\nb', 'a\rb', 'x'.repeat(2001), 42]) assert.equal((await call('/api/memory', { body: { project: projA, line } })).status, 400, JSON.stringify(line));
  // docs/decisions.md wins when it exists
  r = await call('/api/memory', { body: { project: projC, line: 'Décision : tout en local' } });
  assert.equal(r.body.file, path.join(projC, 'docs', 'decisions.md'));
  r = await get(`/api/memory?project=${q(projC)}`); assert.equal(r.total, 51); assert.match(r.lines.at(-1).text, /Décision : tout en local$/);
  assert.ok(!existsSync(path.join(projC, '.calmdev', 'memoire.md')));
  // a big file: the last 2000 lines with their true numbers, total says the real count; a file without a final newline gets one before the new line
  r = await get(`/api/memory?project=${q(projD)}`);
  assert.deepEqual([r.lines.length, r.total, r.lines[0], r.lines.at(-1)], [2000, 2500, { n: 501, text: 'l501' }, { n: 2500, text: 'l2500' }]);
  await call('/api/memory', { body: { project: projD, line: 'fin' } });
  assert.match(readFileSync(path.join(projD, 'docs', 'decisions.md'), 'utf8'), /\nl2500\n- \*\*.*\*\* : fin\n$/);
});

test('the planner gets the last 40 lines of the memory, nothing without a file; the escadrille takes the project’s model', async () => {
  await ready;
  const promptOf = async (project) => until(() => { try { const a = JSON.parse(readFileSync(path.join(fake.dir, 'args.json'), 'utf8')); const sp = a[a.indexOf('--append-system-prompt') + 1]; return sp && sp.includes(`Projet : ${project}\n`) ? { args: a, sp } : null; } catch { return null; } });
  const proj = repo('Delta'); // no memory at all
  let r = await call('/api/escadrille', { body: { project: proj, model: 'claude-sonnet-5-5', idea: 'Une idée' } });
  assert.equal(r.status, 200);
  assert.ok(!(await promptOf(proj)).sp.includes('## La mémoire du projet'));
  // projC: its model comes from its settings (no model sent), its 51-line decisions.md gives lines 12 to 51
  r = await call('/api/escadrille', { body: { project: projC, idea: 'Une autre idée' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await get(`/api/escadrille/${r.body.id}`)).escadrille.model, 'claude-sonnet-5-5');
  const { args, sp } = await promptOf(projC);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  const mem = sp.slice(sp.indexOf('## La mémoire du projet')).split('\n\n## Les ressources du projet')[0]; // the resources follow (docs/resources.md)
  assert.ok(mem.startsWith(`## La mémoire du projet\n\nFichier : ${path.join(projC, 'docs', 'decisions.md')}\nligne 12\n`), mem.slice(0, 200));
  assert.ok(!/^ligne 11$/m.test(mem)); assert.match(mem, /Décision : tout en local$/);
  assert.equal(mem.split('\n').length, 3 + 40);
  // no model anywhere: the default of the list (Opus 5.5), no longer a refusal; an unknown one is still refused
  r = await call('/api/escadrille', { body: { project: projD, idea: 'x' } }); assert.equal(r.status, 200);
  assert.equal((await get(`/api/escadrille/${r.body.id}`)).escadrille.model, 'claude-opus-5-5');
  assert.equal((await call('/api/escadrille', { body: { project: projD, model: 'gpt-9', idea: 'x' } })).status, 400);
});

test('isNetwork: a curl to localhost whose JSON body names files stays local; a quoted host still asks', () => {
  const mem = `curl -s -X POST localhost:3078/api/memory -H 'content-type: application/json' -d '{"project":"${USERS}/dev/Dev/x","line":"voir docs/decisions.md et server.mjs"}'`;
  assert.equal(isNetwork('Bash', { command: mem }), false);
  assert.equal(isNetwork('Bash', { command: `curl -s http://127.0.0.1:3078/api/memory -d "{\\"line\\":\\"lib/push.mjs\\"}"` }), false);
  for (const command of [`curl 'evil.com'`, `curl "https://x.io/a"`, `curl localhost -d '{"a":1}' && curl evil.com`, `curl -d '{"line":"x y"}' https://api.example.com/m`]) assert.equal(isNetwork('Bash', { command }), true, command);
});

test('the push title starts with the project’s short name, the text alone without a project', () => {
  assert.equal(titleFor('Orchard', 'B attend ta réponse'), 'Orchard · B attend ta réponse');
  assert.equal(titleFor(null, 'B attend ta réponse'), 'B attend ta réponse');
  assert.ok(!err.includes('TypeError'), err);
});
