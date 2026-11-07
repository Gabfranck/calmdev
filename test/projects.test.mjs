// Phase 11, session S: the registry of Escadrille's projects (lib/projects.mjs). The picker lists the folders given
// to Escadrille (install.sh, « Ajouter un projet », the one-time migration of the projects that have a plan or a
// conversation), never every folder Claude Code knows. The library, the server on a spare port with a prepared base
// and a throwaway home, and install.sh launched from a project folder.
// The folders live under .escadrille/ of this worktree (never committed): /tmp is never a project (lib/projects.mjs
// ignored), and the sandbox's temp is under /tmp.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, statSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import * as reg from '../lib/projects.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
mkdirSync(path.join(ROOT, '.calmdev'), { recursive: true });
const BOX = realpathSync(mkdtempSync(path.join(ROOT, '.calmdev', 'test-projects-')));
after(() => rmSync(BOX, { recursive: true, force: true }));
const dir = (...p) => { const d = path.join(BOX, ...p); mkdirSync(d, { recursive: true }); return d; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

test('add: an existing folder only, absolute or ~/…, once; the file is the developer’s (0600)', () => {
  const file = path.join(dir('lib-add'), 'cfg', 'projects.json'); const app = dir('lib-add', 'app');
  writeFileSync(path.join(BOX, 'lib-add', 'a-file'), '');
  const err = (v) => { try { reg.add(v, { file, home: path.join(BOX, 'lib-add') }); return null; } catch (e) { return e.message; } };
  assert.equal(err('relative/path'), 'not-absolute'); assert.equal(err(''), 'not-absolute');
  assert.equal(err(path.join(BOX, 'nope')), 'not-found');
  assert.equal(err(path.join(BOX, 'lib-add', 'a-file')), 'not-a-folder');
  assert.equal(existsSync(file), false, 'a refusal writes nothing');
  const r = reg.add(app + '/', { file, via: 'install' });
  assert.equal(r.path, app); assert.equal(r.added, true);
  assert.equal(reg.add('~/app', { file, home: path.join(BOX, 'lib-add') }).added, false, '~ is the home; a second add changes nothing');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.projects.map((x) => [x.path, x.via]), [[app, 'install']]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('remove takes the line out of the list and nothing else', () => {
  const file = path.join(dir('lib-rm'), 'projects.json'); const app = dir('lib-rm', 'app'); writeFileSync(path.join(app, 'keep.txt'), 'x');
  reg.add(app, { file });
  assert.equal(reg.remove(app, { file }).removed, true);
  assert.deepEqual(reg.list(file), []);
  assert.ok(existsSync(path.join(app, 'keep.txt')), 'the folder and its files stay');
  assert.equal(reg.remove(app, { file }).removed, false);
});

test('the migration runs once: projects with a plan or a conversation enter, worktrees, /tmp and missing folders do not; a removal sticks', () => {
  const file = path.join(dir('lib-mig'), 'projects.json');
  const a = dir('lib-mig', 'alpha'); const b = dir('lib-mig', 'bravo'); const wt = dir('lib-mig', 'alpha', '.claude', 'worktrees', 'x-A');
  reg.add(b, { file, via: 'install' }); // install.sh wrote the file first: the migration still runs
  const r = reg.migrate([a, a, b, wt, '/tmp/whatever', path.join(BOX, 'gone'), null, 'relative'], { file });
  assert.equal(r.migrated, true);
  assert.deepEqual(reg.list(file).map((x) => [x.path, x.via]), [[b, 'install'], [a, 'migration']]);
  reg.remove(a, { file });
  assert.equal(reg.migrate([a], { file }).migrated, false, 'never twice');
  assert.deepEqual(reg.list(file).map((x) => x.path), [b], 'a project taken out does not come back');
});

test('suggestions: the folders Claude Code used lately, newest first, minus the list; completions under a typed path', () => {
  const home = dir('lib-sugg', 'home'); const file = path.join(BOX, 'lib-sugg', 'projects.json');
  const old = dir('lib-sugg', 'old'); const fresh = dir('lib-sugg', 'fresh'); const listed = dir('lib-sugg', 'listed'); const wt = dir('lib-sugg', 'fresh', '.claude', 'worktrees', 'w');
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [old]: {}, [fresh]: {}, [listed]: {}, [wt]: {}, [path.join(BOX, 'gone')]: {}, [home]: {} } }));
  const transcript = (p, t) => { const d = path.join(home, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(d, { recursive: true }); const f = path.join(d, 's.jsonl'); writeFileSync(f, '{}'); utimesSync(f, t, t); };
  transcript(old, new Date('2026-10-01')); transcript(fresh, new Date('2026-11-01'));
  reg.add(listed, { file });
  assert.deepEqual(reg.suggestions({ home, file }).map((s) => s.name), ['fresh', 'old']);
  dir('lib-sugg', 'Fable'); dir('lib-sugg', '.hidden');
  assert.deepEqual(reg.completions(path.join(BOX, 'lib-sugg', 'f')), [path.join(BOX, 'lib-sugg', 'Fable'), path.join(BOX, 'lib-sugg', 'fresh')]);
  assert.ok(!reg.completions(path.join(BOX, 'lib-sugg') + '/').some((p) => p.endsWith('.hidden')), 'no hidden folder');
  assert.deepEqual(reg.completions('nope'), []);
});

// ---- the server: a base with plans and conversations, a home where Claude Code knows one more folder
const P = dir('srv', 'with-plan'); const E = dir('srv', 'with-conversation'); const M = dir('srv', 'with-thread'); const X = dir('srv', 'claude-only');
const WT = dir('srv', 'with-plan', '.claude', 'worktrees', 'p-A');
const HOME = dir('srv', 'home'); writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ projects: { [P]: {}, [E]: {}, [X]: {} } }));
const DB = path.join(dir('srv', 'db'), 'db.sqlite');
{
  const db = new DatabaseSync(DB);
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text);
    create table main_messages (seq integer primary key autoincrement, project text not null, role text not null, text text not null, source text, uid text, data text, at text not null);`);
  const plan = (id) => JSON.stringify({ id, title: id, created: '2026-11-01T10:00:00Z', waves: [{ n: 1, title: 'w' }], sessions: [] });
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('p1', 'p1', '2026-11-01T10:00:00Z', plan('p1'), P);
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('p2', 'p2', '2026-11-01T09:00:00Z', plan('p2'), WT);
  db.prepare("insert into escadrilles (id, title, project, model, status, created, at) values ('e1', 'e1', ?, 'claude-opus-5-5', 'stopped', '2026-11-02T08:00:00Z', '2026-11-02T08:00:00Z')").run(E);
  db.prepare("insert into main_messages (project, role, text, at) values (?, 'dev', 'bonjour', '2026-10-30T08:00:00Z')").run(M);
  db.close();
}
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const none = () => mkdtempSync(path.join(BOX, 'none-'));
const server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_HOME: HOME, ESCADRILLE_PLANS: none(), ESCADRILLE_TRANSCRIPTS: none(), ESCADRILLE_SESSIONS: none(), ESCADRILLE_CLAUDE: '/usr/bin/false', ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_SECRETS: path.join(none(), 'secrets.json'), ESCADRILLE_PROJECTS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const call = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const ready = until(async () => { try { return (await fetch(BASE + '/api/models')).ok; } catch { return false; } });
const paths = async () => (await call('/api/projects')).body.projects.map((p) => p.path);

test('GET /api/projects: the migrated projects, the most recent first, never a folder Claude Code alone knows', async () => {
  await ready;
  const got = (await call('/api/projects')).body.projects;
  assert.deepEqual(got.map((p) => p.path), [E, P, M], err);
  assert.ok(!got.some((p) => p.path === X), 'a folder Claude Code knows is not a project of Escadrille');
  assert.deepEqual(got.map((p) => [p.name, p.plans, p.escadrilles]), [['with-conversation', 0, 1], ['with-plan', 1, 0], ['with-thread', 0, 0]]);
  assert.ok(existsSync(DB + '.projects.json'), 'a server on another base keeps its registry beside it, never in the developer’s ~/.config');
  assert.deepEqual((await call('/api/projects/suggestions')).body.suggestions.map((s) => s.path), [X], 'Claude Code’s folder is offered, not listed');
});

test('POST /api/projects adds a folder validated by the server; /remove takes it out, nothing deleted', async () => {
  await ready;
  assert.deepEqual([(await call('/api/projects', { path: 'relative' })).status, (await call('/api/projects', { path: 'relative' })).body.error], [400, 'not-absolute']);
  assert.equal((await call('/api/projects', { path: path.join(BOX, 'missing') })).body.error, 'not-found');
  const added = await call('/api/projects', { path: X });
  assert.equal(added.status, 200); assert.equal(added.body.path, X); assert.ok(added.body.projects.some((p) => p.path === X));
  assert.ok((await paths()).includes(X));
  assert.deepEqual((await call('/api/projects/suggestions')).body.suggestions, []);
  const removed = await call('/api/projects/remove', { path: E });
  assert.equal(removed.body.removed, true);
  assert.ok(!(await paths()).includes(E));
  assert.ok(existsSync(E), 'the folder stays');
  assert.equal((await call(`/api/escadrilles?project=${encodeURIComponent(E)}`)).body.length, 1, 'its conversation stays in the base');
  assert.deepEqual((await call(`/api/projects/dirs?prefix=${encodeURIComponent(path.join(BOX, 'srv', 'with-'))}`)).body.dirs, [E, P, M].sort());
});

// ---- install.sh, launched from a project folder; a listener on its port stops it before it starts a server
const fakeBin = () => { const b = dir('bin'); writeFileSync(path.join(b, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 }); writeFileSync(path.join(b, 'claude'), '#!/bin/sh\necho 2.1.316\n', { mode: 0o755 }); return b; };
const install = (cwd, file, port) => new Promise((resolve) => execFile('/bin/sh', [path.join(ROOT, 'install.sh'), '--no-open'], { cwd, env: { PATH: `${fakeBin()}:/usr/bin:/bin`, HOME: HOME, PORT: String(port), ESCADRILLE_PROJECTS: file } }, (e, out, errOut) => resolve({ code: e ? e.code : 0, out: out + errOut })));

test('install.sh adds the folder it is launched from, not the clone itself', async () => {
  const busy = createServer((q, s) => s.end('busy')); await new Promise((r) => busy.listen(0, '127.0.0.1', r)); const port = busy.address().port;
  try {
    const file = path.join(dir('install'), 'projects.json'); const app = dir('install', 'my-app');
    const r = await install(app, file, port);
    assert.match(r.out, /added .*my-app to Escadrille's projects/, r.out);
    assert.match(r.out, /already answers/, 'then stops at the busy port, before starting anything');
    assert.deepEqual(reg.read(file).projects.map((x) => [x.path, x.via]), [[app, 'install']]);
    const again = await install(ROOT, file, port);
    assert.doesNotMatch(again.out, /added|already one of/, 'from the clone: nothing added');
    assert.equal(reg.read(file).projects.length, 1);
  } finally { busy.close(); }
});
