// The free display name of a project (docs/multiproject.md): the registry's optional `name`, its cleaning, the page's
// lookup with its fallback, and the route POST /api/projects/name. The route lives in server.mjs, which a session may
// not write (docs/correctif-server-nom-projet.md): its test runs once the route exists and is skipped before.
// The folders live under .escadrille/ of this worktree (never committed): /tmp is never a project.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as reg from '../lib/projects.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
mkdirSync(path.join(ROOT, '.escadrille'), { recursive: true });
const BOX = realpathSync(mkdtempSync(path.join(ROOT, '.escadrille', 'test-project-name-')));
after(() => rmSync(BOX, { recursive: true, force: true }));
const dir = (...p) => { const d = path.join(BOX, ...p); mkdirSync(d, { recursive: true }); return d; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

test('cleanName: edge spaces, control characters and 60 characters at most; nothing left means the folder', () => {
  assert.equal(reg.cleanName('  Acme · API  '), 'Acme · API');
  assert.equal(reg.cleanName('a\u0000b\nc\u007fd'), 'a b c d', 'a control character is a space, never kept');
  assert.equal(reg.cleanName('x'.repeat(100)).length, 60);
  assert.equal([...reg.cleanName('é'.repeat(80))].length, 60, 'counted in characters, not bytes');
  assert.equal(reg.cleanName('   \n\t '), '');
  assert.equal(reg.cleanName(null), '');
  assert.equal(reg.displayName({ path: '/a/b/api' }), 'api');
  assert.equal(reg.displayName({ path: '/a/b/api', name: '  ' }), 'api');
  assert.equal(reg.displayName({ path: '/a/b/api', name: 'Acme · API' }), 'Acme · API');
});

test('setName: an optional field, old files read as they are, the write stays atomic, the path stays the key', () => {
  const a = dir('one', 'api'); const b = dir('two', 'api');
  const file = path.join(BOX, 'reg', 'projects.json');
  mkdirSync(path.dirname(file), { recursive: true });
  // an old file, without any name and without a migration
  writeFileSync(file, JSON.stringify({ version: 1, migrated: '2026-11-01T00:00:00Z', projects: [{ path: a, added: 'x', via: 'app' }, { path: b, added: 'y', via: 'install' }] }));
  assert.deepEqual(reg.list(file).map((x) => reg.displayName(x)), ['api', 'api'], 'two homonymous folders, as before');
  const r = reg.setName(b, '  Acme · API ', { file });
  assert.deepEqual([r.path, r.name, r.custom], [b, 'Acme · API', true]);
  assert.deepEqual(reg.list(file).map((x) => [x.path, reg.displayName(x)]), [[a, 'api'], [b, 'Acme · API']]);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.migrated, '2026-11-01T00:00:00Z', 'the migration flag is kept');
  assert.deepEqual(saved.projects.map((x) => [x.added, x.via]), [['x', 'app'], ['y', 'install']], 'nothing else moves');
  assert.ok(!readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')), 'no temporary file left: write then rename');
  assert.equal(reg.setName(b, '   ', { file }).custom, false, 'an empty name gives the folder’s back');
  assert.ok(!('name' in reg.read(file).projects[1]), 'the field leaves the file');
  assert.equal(reg.setName(a, 'x'.repeat(90), { file }).name.length, 60);
  assert.throws(() => reg.setName(dir('three'), 'Nope', { file }), (e) => e.status === 404 && e.message === 'unknown-project');
  // add / remove keep the names of the others
  reg.add(dir('four', 'web'), { file });
  assert.equal(reg.displayName(reg.list(file).find((x) => x.path === a)), 'x'.repeat(60));
  reg.remove(dir('four', 'web'), { file });
  assert.equal(reg.displayName(reg.list(file).find((x) => x.path === a)), 'x'.repeat(60));
});

// The page's lookup (public/projects.js) run in a bare context: the folder while no list is loaded, then the free name
const page = (stored) => {
  const store = { ...(stored ? { 'escadrille.projectNames': JSON.stringify(stored) } : {}) };
  const ctx = { T: (k) => k, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, console };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'public', 'projects.js'), 'utf8'), ctx);
  return { P: ctx.escadrilleProjects, store };
};

test('P.name: the folder before any list, the server’s name once loaded, the device’s name when the server has none', () => {
  const { P, store } = page();
  assert.equal(P.name('/a/b/api'), 'api', 'list not loaded yet: the last segment, as today');
  assert.equal(P.name(null), 'projects.none');
  P.setNames([{ path: '/a/b/api', name: 'Acme · API' }, { path: '/c/web', name: 'web' }]);
  assert.equal(P.name('/a/b/api'), 'Acme · API');
  assert.equal(P.name('/c/web'), 'web', 'a name that is only the folder is no free name');
  assert.equal(P.name('/z/other'), 'other', 'a project the list does not know: the folder');
  // the fallback: kept on the device while the route is missing
  assert.equal(P.setLocal('/z/other', '  Autre  '), 'Autre');
  assert.equal(P.name('/z/other'), 'Autre');
  assert.deepEqual(JSON.parse(store['escadrille.projectNames']), { '/z/other': 'Autre' });
  P.setNames([{ path: '/z/other', name: 'Serveur' }]);
  assert.equal(P.name('/z/other'), 'Serveur', 'the server’s name wins over the device’s');
  P.setLocal('/z/other', '');
  P.setNames([]);
  assert.equal(P.name('/z/other'), 'other', 'cleared: back to the folder');
  assert.equal(page({ '/q/r/s': 'Gardé' }).P.name('/q/r/s'), 'Gardé', 'the device’s names survive a reload');
  assert.equal(page().P.clean('a'.repeat(99)).length, 60);
});

test('group() uses the name too: two homonymous folders tell apart', () => {
  const { P } = page();
  P.setNames([{ path: '/a/api', name: 'Acme · API' }, { path: '/b/api', name: 'api' }]);
  const g = P.group({ projects: [{ path: '/a/api' }, { path: '/b/api' }], escadrilles: [{ project: '/b/api', at: '2026-11-02T10:00:00Z' }], current: '/a/api' });
  assert.deepEqual(Array.from(g, (x) => x.name), ['Acme · API', 'api']); // Array.from: the vm's arrays are of another realm
});

// ---- the route, once server.mjs has it (docs/correctif-server-nom-projet.md)
const HAS_ROUTE = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8').includes('/api/projects/name');
test('POST /api/projects/name: a name per project, GET /api/projects returns it, an empty one gives the folder back', { skip: HAS_ROUTE ? false : 'server.mjs has no /api/projects/name yet (docs/correctif-server-nom-projet.md)' }, async () => {
  const A = dir('srv', 'one', 'api'); const B = dir('srv', 'two', 'api');
  const file = path.join(BOX, 'srv-projects.json');
  writeFileSync(file, JSON.stringify({ version: 1, migrated: '2026-11-01T00:00:00Z', projects: [{ path: A, added: '2026-11-01T00:00:00Z', via: 'app' }, { path: B, added: '2026-11-01T00:00:01Z', via: 'app' }] }));
  const DB = path.join(BOX, 'srv.sqlite'); new DatabaseSync(DB).close();
  const none = () => mkdtempSync(path.join(BOX, 'none-'));
  const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_HOME: dir('home'), ESCADRILLE_PLANS: none(), ESCADRILLE_TRANSCRIPTS: none(), ESCADRILLE_SESSIONS: none(), ESCADRILLE_CLAUDE: '/usr/bin/false', ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_SECRETS: path.join(none(), 'secrets.json'), ESCADRILLE_PROJECTS: file }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await until(async () => { try { return (await fetch(BASE + '/api/models')).ok; } catch { return false; } });
    const call = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
    const names = async () => (await call('/api/projects')).body.projects.map((p) => [p.path, p.name]);
    assert.deepEqual((await names()).map((x) => x[1]), ['api', 'api'], 'no name yet: the folder, as today');
    const r = await call('/api/projects/name', { path: B, name: '  Acme · API ' });
    assert.equal(r.status, 200); assert.equal(r.body.name, 'Acme · API');
    assert.deepEqual(Object.fromEntries(await names()), { [A]: 'api', [B]: 'Acme · API' });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects.find((p) => p.path === B).name, 'Acme · API');
    assert.equal((await call('/api/projects/name', { path: B, name: 'x'.repeat(90) })).body.name.length, 60);
    assert.equal((await call('/api/projects/name', { path: B, name: '' })).body.name, 'api');
    assert.deepEqual((await names()).map((x) => x[1]), ['api', 'api']);
    const unknown = await call('/api/projects/name', { path: path.join(BOX, 'nowhere'), name: 'X' });
    assert.deepEqual([unknown.status, unknown.body.error], [404, 'unknown-project']);
    assert.equal((await call('/api/projects/name', { path: 'relative', name: 'X' })).status >= 400, true);
  } finally { server.kill('SIGINT'); }
});
