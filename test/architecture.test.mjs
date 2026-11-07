// The architecture map (docs/architecture.md), on a throwaway repository: main and a feature branch that adds a
// module, a route, a table and an import; the map read without a checkout, the delta, the caps, the HTTP routes.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapOf, deltaOf, architectureDelta, moduleOf, moduleIds, aliasesOf, routesOf, tablesOf, importsOf, MAX_BYTES } from '../lib/architecture.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const put = (root, file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };

const SERVER_MAIN = `import { createServer } from 'node:http';
import { db } from './lib/db.mjs';
createServer((req, res) => {
  if (url.pathname === '/api/users' && req.method === 'GET') return list();
  if (url.pathname === '/health') return ok();
});
`;
const repo = (() => {
  const root = tmp('escadrille-arch-');
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  put(root, 'server.mjs', SERVER_MAIN);
  put(root, 'lib/db.mjs', "export const db = 1;\nconst q = 'create table if not exists users (id integer)';\n");
  put(root, 'test/a.test.mjs', "import { db } from '../lib/db.mjs';\nimport '../server.mjs';\n");
  put(root, 'package.json', JSON.stringify({ name: 'x', dependencies: { express: '^4' }, devDependencies: { vitest: '1' } }));
  put(root, 'logo.png', 'not code');
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  sh(root, ['checkout', '-q', '-b', 'feature']);
  put(root, 'lib/review/index.mjs', "import { db } from '../db.mjs';\nexport const review = () => db;\n");
  put(root, 'server.mjs', SERVER_MAIN.replace("import { db } from './lib/db.mjs';", "import { db } from './lib/db.mjs';\nimport { review } from './lib/review/index.mjs';").replace("  if (url.pathname === '/health')", "  if (url.pathname === '/api/review' && req.method === 'POST') return review();\n  if (url.pathname === '/health')"));
  put(root, 'lib/db.mjs', "export const db = 1;\nconst q = 'create table if not exists users (id integer)';\nconst r = 'CREATE TABLE reviews (id integer)';\n");
  put(root, 'package.json', JSON.stringify({ name: 'x', dependencies: { express: '^4', zod: '3' }, devDependencies: { vitest: '1' } }));
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'feature']);
  sh(root, ['checkout', '-q', 'main']);
  return root;
})();

test('mapOf reads modules, roles, edges, routes, tables and deps at a ref', async () => {
  const m = await mapOf(repo, 'main');
  assert.equal(m.sha, sh(repo, ['rev-parse', 'main']));
  assert.deepEqual(m.modules.map((x) => [x.id, x.role]), [['.', 'routes'], ['lib', 'lib'], ['test', 'tests']]);
  assert.equal(m.modules.find((x) => x.id === '.').entry, 'server.mjs');
  assert.ok(!m.modules.some((x) => x.files.includes('logo.png')), 'binaries are not read');
  assert.deepEqual(m.edges.map((e) => [e.from, e.to, e.count]), [['.', 'lib', 1], ['test', '.', 1], ['test', 'lib', 1]]);
  assert.deepEqual(m.routes.map((r) => `${r.method} ${r.path} ${r.kind}`), ['GET /api/users node', '* /health node']);
  assert.deepEqual(m.tables.map((t) => [t.name, t.module]), [['users', 'lib']]);
  assert.deepEqual(m.deps.map((d) => [d.name, d.dev]), [['express', false], ['vitest', true]]);
  assert.equal(await mapOf(repo, 'main'), m, 'cached by sha');
});

test('a branch is read without a checkout', async () => {
  assert.equal(sh(repo, ['branch', '--show-current']), 'main');
  const m = await mapOf(repo, 'feature');
  assert.ok(m.modules.some((x) => x.id === 'lib/review'));
  assert.ok(m.routes.some((r) => r.method === 'POST' && r.path === '/api/review'));
  await assert.rejects(mapOf(repo, 'nope'), /ref inconnue/);
  await assert.rejects(mapOf(tmp('nogit-')), /pas un dépôt git/);
});

test('deltaOf says what the branch adds and touches, in three French lines', async () => {
  const d = await deltaOf(repo, 'main', 'feature');
  assert.deepEqual(d.added.modules, ['lib/review']);
  assert.deepEqual(d.added.routes.map((r) => `${r.method} ${r.path}`), ['POST /api/review']);
  assert.deepEqual(d.added.tables.map((t) => t.name), ['reviews']);
  assert.deepEqual(d.added.edges.map((e) => `${e.from}>${e.to}`).sort(), ['.>lib/review', 'lib/review>lib']);
  assert.deepEqual(d.added.deps.map((x) => x.name), ['zod']);
  assert.deepEqual(d.removed, { modules: [], edges: [], routes: [], tables: [], deps: [] });
  assert.deepEqual(d.changedModules.map((c) => c.id).sort(), ['.', 'lib', 'lib/review']);
  assert.equal(d.summary.length, 3);
  assert.equal(d.summary[0], 'Ce plan ajoute 1 route, 1 table, 1 module, touche 3 modules.');
  assert.match(d.summary[1], /module lib\/review/);
  assert.match(d.summary[2], /Rien de retiré\. Nouvelle dépendance : zod\./);
  const back = await deltaOf(repo, 'feature', 'main');
  assert.equal(back.summary[0], 'Ce plan ne change rien au code.', 'main...feature reversed: nothing since the common base');
});

test('architectureDelta takes the review files as they are (R, docs/review.md)', async () => {
  const d = await architectureDelta({ repo, base: 'main', head: 'feature', files: [{ path: 'lib/review/index.mjs', additions: 2, deletions: 0 }] });
  assert.deepEqual(d.changedModules, [{ id: 'lib/review', additions: 2, deletions: 0 }]);
  await assert.rejects(architectureDelta({ repo, base: 'main' }), /requis/);
});

test('the caps: a file over 2 MB is skipped, not read', async () => {
  const root = tmp('escadrille-arch-big-');
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  put(root, 'a.js', "app.get('/a', f);\n"); put(root, 'big.js', "app.get('/big', f);\n" + 'x'.repeat(MAX_BYTES + 10));
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', 's']);
  const m = await mapOf(root);
  assert.equal(m.skipped, 1); assert.equal(m.files, 1);
  assert.deepEqual(m.routes.map((r) => r.path), ['/a']);
});

test('the regexes: imports, routes of each kind, tables of each kind, module ids', () => {
  const has = new Set(['src/a.ts', 'src/b/index.ts', 'pkg/m.py', 'pkg/__init__.py']);
  assert.deepEqual(importsOf('src/c.ts', "import x from './a.js';\nimport {\n y,\n} from './b';\nconst z = await import('./a');\nrequire('lodash');", has), ['src/a.ts', 'src/b/index.ts', 'src/a.ts']);
  assert.deepEqual(importsOf('pkg/n.py', 'from .m import f\nfrom pkg.m import g\nimport os', has), ['pkg/m.py', 'pkg/m.py']);
  assert.deepEqual(routesOf('r.js', "router.post('/login', h); fastify.get('/x', h); axios.get('/not-a-route');").map((r) => `${r.kind} ${r.method} ${r.path}`), ['express POST /login', 'fastify GET /x']);
  assert.deepEqual(routesOf('app/(tabs)/quiz/[id].tsx', '', { expo: true }).map((r) => r.path), ['/quiz/:id']);
  assert.deepEqual(routesOf('src/app/api/users/route.ts', 'export async function GET() {}\nexport function POST() {}', { next: true }).map((r) => `${r.method} ${r.path}`), ['GET /api/users', 'POST /api/users']);
  assert.deepEqual(routesOf('pages/index.tsx', '', { next: true }).map((r) => r.path), ['/']);
  assert.deepEqual(tablesOf('m.js', "sequelize.define('User', {}); queryInterface.createTable('Quizzes', {}); @Entity() class Score {}").map((t) => `${t.kind} ${t.name}`), ['sequelize User', 'sequelize Quizzes', 'typeorm Score']);
  assert.deepEqual(tablesOf('schema.prisma', 'model Post {\n id Int\n}').map((t) => t.name), ['Post']);
  assert.deepEqual(['a.js', 'src/x/y/z.js', 'apps/api/src/routes/u.js'].map((f) => moduleOf(f)), ['.', 'src/x', 'apps/api/src/routes']);
  const many = [...Array(50)].map((_, i) => `server/domains/d${i % 5}/c${i}.ts`).concat(['server/app.ts', 'lib/a.js']);
  const ids = moduleIds(many);
  assert.equal(ids.get('server/domains/d3/c3.ts'), 'server/domains/d3', 'a module over 40 files and a fifth of the repository splits');
  assert.equal(ids.get('server/app.ts'), 'server'); assert.equal(ids.get('lib/a.js'), 'lib');
  const al = aliasesOf('server/tsconfig.json', '{ // c\n "compilerOptions": { "paths": { "@/*": ["./*"] }, }, "include": ["**/*.ts"] }');
  assert.deepEqual(al, [{ prefix: '@/', dir: 'server/', targets: ['server'] }]);
  assert.deepEqual(importsOf('server/domains/a.ts', 'import db from "@/config/db";', new Set(['server/config/db.ts']), al), ['server/config/db.ts']);
});

// ---------------------------------------------------------------- the HTTP routes
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(tmp('escadrille-arch-db-'), 'db.sqlite');
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-arch-plans-'), ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_TEST_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill());
const ready = new Promise((resolve) => server.stdout.on('data', (c) => { if (String(c).includes('escadrille on')) resolve(); }));
const get = async (p, headers = {}) => { const r = await fetch(BASE + p, { headers }); return { status: r.status, body: await r.json() }; };

test('GET /api/architecture and /api/architecture/delta, by project or by plan and session; the page is served', async () => {
  await ready;
  const P = encodeURIComponent(repo);
  assert.equal((await get('/api/architecture')).status, 400);
  const m = await get(`/api/architecture?project=${P}&ref=feature`);
  assert.equal(m.status, 200); assert.ok(m.body.modules.some((x) => x.id === 'lib/review'));
  const d = await get(`/api/architecture/delta?project=${P}&base=main&head=feature`);
  assert.equal(d.body.summary[0], 'Ce plan ajoute 1 route, 1 table, 1 module, touche 3 modules.');
  assert.equal((await get(`/api/architecture/delta?project=${P}`)).status, 400);
  assert.equal((await get(`/api/architecture?project=${P}`, { 'x-escadrille-remote': '1' })).status, 401, 'nothing for the LAN');
  // a session whose worktree is on the feature branch
  const plan = { id: 'arch-plan', title: 'Arch', sessions: [{ id: 'A', name: 'a', path: repo, model: 'claude-sonnet-5-5', prompt: 'x', stops: ['fin'] }] };
  const created = await fetch(BASE + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan) }).then((r) => r.json());
  assert.ok(created.ok, JSON.stringify(created)); const planId = created.id;
  const db = new DatabaseSync(DB); db.prepare('update sessions set worktree = ? where plan = ? and id = ?').run(JSON.stringify({ path: repo, cwd: repo, root: repo, branch: 'feature', merged: false }), planId, 'A'); db.close();
  const s = await get(`/api/architecture/delta?plan=${encodeURIComponent(planId)}&session=A`);
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.deepEqual(s.body.added.modules, ['lib/review']);
  assert.equal((await get(`/api/architecture?plan=${encodeURIComponent(planId)}&session=Z`)).status, 400);
  const page = await fetch(BASE + '/architecture?project=' + P);
  assert.equal(page.status, 200); assert.match(await page.text(), /<svg|id="map"/);
});
