// Escadrille en équipe, the PoC (docs/team.md, lib/team.mjs): the repository id, the areas read in a session's `where`, the
// collisions (by file, by migrations folder, by motif; once per pair; a planned session counts), the setting (off by default,
// the token never exposed), the sync loop against a fake relay (the contract); then the server: the setting by the developer's
// cookie only, presence published with the files of a worktree, a collision raised once in the session's pending and in
// « À toi », the team memory both ways, the planner's « Équipe » section, off again, the relay down.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort } from './free-port.mjs';
import { fakeClaude } from './fake-claude.mjs';
import { fakeRelay } from './fake-relay.mjs';
import { makeLicense } from './license-fixture.mjs';
const LIC = makeLicense(); // the team sharing needs a valid Escadrille Équipe key (lib/license.mjs, test/license.test.mjs)
import * as team from '../lib/team.mjs';
import { plain } from '../lib/i18n.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 160)); await new Promise((r) => setTimeout(r, 100)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = []; const relays = []; after(() => { for (const p of procs) p.kill('SIGKILL'); for (const r of relays) r.close(); });
const GAB = 'tok-gab-0123456789'; const LEA = 'tok-lea-0123456789';

// ---------------------------------------------------------------- pure
test('repoIdOf: credentials, .git, case and the ssh form fall on the same id; nothing → null', () => {
  const a = team.repoIdOf('https://user:pw@GitHub.com/Team/Repo.git'); const b = team.repoIdOf('git@github.com:team/repo'); const c = team.repoIdOf('ssh://git@github.com/Team/Repo.git/');
  assert.equal(team.normalizeRemote('https://user:pw@GitHub.com/Team/Repo.git'), 'github.com/team/repo');
  assert.equal(a, b); assert.equal(a, c); assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, team.repoIdOf('https://github.com/team/other'));
  assert.equal(team.repoIdOf(''), null); assert.equal(team.repoIdOf(null), null);
});

test('areasOf, matchArea, migrationDirOf: the paths of a `where`, the folder of a session, globs and migration folders', () => {
  assert.deepEqual(team.areasOf('lib/team.mjs, docs/team.md ; le dossier `migrations/` et public/*.js (rien d’autre, v2.1)'), ['lib/team.mjs', 'docs/team.md', 'migrations/', 'public/*.js']);
  assert.deepEqual(team.areasOf('', 'apps/web'), ['apps/web/']); assert.deepEqual(team.areasOf(null, '.'), []);
  assert.ok(team.matchArea('lib/', 'lib/team.mjs')); assert.ok(team.matchArea('lib', 'lib/team.mjs')); assert.ok(!team.matchArea('lib/', 'library/x.mjs'));
  assert.ok(team.matchArea('public/*.js', 'public/app.js')); assert.ok(!team.matchArea('public/*.js', 'public/sub/app.js')); assert.ok(team.matchArea('public/**', 'public/sub/app.js'));
  assert.equal(team.migrationDirOf('db/migrations/001.sql'), 'db/migrations/'); assert.equal(team.migrationDirOf('prisma/schema.prisma'), 'prisma/'); assert.equal(team.migrationDirOf('db/migrate/001.rb'), 'db/migrate/'); assert.equal(team.migrationDirOf('lib/x.mjs'), null); assert.equal(team.migrationDirOf('migrations'), null);
});

test('collisions: the same file, the same migrations folder, a motif over a file, a planned session; once per pair; never with oneself', () => {
  const others = [
    { member: 'Léa', sessions: [{ id: 'B', plan: 'p-lea', title: 'Scores', branch: 'lea/B', status: 'running', files: ['lib/team.mjs', 'migrations/001_scores.sql', 'public/app.css'], areas: ['docs/'] }] },
    { member: 'Dev', sessions: [{ id: 'Z', plan: 'p', title: 'moi', files: ['lib/team.mjs'] }] },
  ];
  const ours = [
    { plan: 'p', id: 'A', title: 'Relais', status: 'running', files: ['lib/team.mjs', 'lib/other.mjs'], areas: [] },
    { plan: 'p', id: 'M', title: 'Migration', status: 'waiting', files: ['migrations/002_add.sql'], areas: [] },
    { plan: 'p', id: 'C', title: 'CSS', status: 'todo', files: [], areas: ['public/*.css'] },
    { plan: 'p', id: 'D', title: 'Docs', status: 'later', files: ['docs/team.md'], areas: [] },
    { plan: 'p', id: 'N', title: 'Rien', status: 'running', files: ['lib/none.mjs'], areas: ['test/'] },
  ];
  const c = team.collisions({ ours, others, self: 'Dev' });
  assert.deepEqual(c.map((x) => [x.ours.id, x.member, x.kind, x.file]), [['A', 'Léa', 'file', 'lib/team.mjs'], ['M', 'Léa', 'migrations', 'migrations/'], ['C', 'Léa', 'area', 'public/app.css'], ['D', 'Léa', 'area', 'docs/team.md']]);
  assert.equal(new Set(c.map((x) => x.key)).size, 4, 'one key per pair');
  assert.equal(c[0].theirs.title, 'Scores'); assert.equal(c[0].theirs.branch, 'lea/B');
  assert.deepEqual(team.collisions({ ours, others: [] }), []);
});

test('validateTeam and publicView: off by default, on needs a relay, a member and a token; the token never in the view', () => {
  assert.deepEqual(team.publicView(null, false), { relay: null, member: null, on: false, token: false });
  assert.match(team.validateTeam({ on: true }).errors.join(' '), /relais, un nom de membre et un jeton/);
  assert.match(team.validateTeam({ relay: 'ftp://x', member: 'Dev' }).errors.join(' '), /URL http/);
  assert.match(team.validateTeam({ token: 'short' }).errors.join(' '), /8 caractères/);
  assert.match(team.validateTeam({ member: 'a\nb' }).errors.join(' '), /member/);
  const ok = team.validateTeam({ relay: 'https://relais.example.org/', member: 'Dev', token: GAB, on: true });
  assert.equal(ok.errors, null); assert.deepEqual(ok.value, { relay: 'https://relais.example.org', member: 'Dev', on: true }); assert.equal(ok.token, GAB);
  assert.equal(team.validateTeam({ relay: 'https://r', member: 'Dev', on: true }, { hasToken: true }).errors, null, 'a stored token counts');
  assert.equal(team.validateTeam({ token: null }).token, null, 'null clears the token');
  const view = team.publicView({ relay: 'https://r', member: 'Dev', on: true, token: GAB }, true);
  assert.deepEqual(view, { relay: 'https://r', member: 'Dev', on: true, token: true }); assert.ok(!JSON.stringify(view).includes(GAB));
  assert.equal(team.publicView({ relay: 'https://r', member: 'Dev', on: true }, false).on, false, 'no token: not on');
  assert.equal(team.teamLine('équipe : Les scores en entier'), 'Les scores en entier'); assert.equal(team.teamLine('[équipe] x'), 'x'); assert.equal(team.teamLine('team: y'), 'y'); assert.equal(team.teamLine('Les scores'), null);
});

test('createTeamSync against the fake relay: PUT then GET, the others read, a collision once over two ticks, the memory cursor, offline said in one line', async () => {
  const relay = await fakeRelay({ tokens: { [GAB]: 'Dev', [LEA]: 'Léa' } }); relays.push(relay);
  const repoId = team.repoIdOf('https://github.com/team/repo');
  relay.seedPresence(repoId, 'Léa', [{ id: 'B', plan: 'p-lea', title: 'Scores', branch: 'lea/B', status: 'running', files: ['lib/team.mjs'], areas: [] }]);
  relay.seedMemory(repoId, 'Léa', 'Les avatars restent en PNG');
  const cols = []; const mem = []; let cursor = null; let on = true; let clock = 1e6; // each reading 6 s later: the ticks are past MIN_PUSH_GAP_MS
  const sync = team.createTeamSync({ settingsOf: () => ({ relay: relay.url, member: 'Dev', on, token: GAB }), repoIdOf: async () => repoId, projects: () => ['/p'], now: () => (clock += 6e3),
    sessionsOf: async () => [{ plan: 'p', id: 'A', title: 'Relais', status: 'running', branch: 'x/A', files: ['lib/team.mjs'], areas: [] }, { plan: 'p', id: 'T', title: 'Plus tard', status: 'todo', files: [], areas: ['docs/'] }],
    onCollision: (p, c) => cols.push(c), onMemory: (p, lines) => mem.push(...lines), cursorOf: () => cursor, saveCursor: (p, c) => { cursor = c; } });
  await sync.tick(); await sync.tick();
  const puts = relay.requests.filter((r) => r.method === 'PUT'); assert.equal(puts.length, 2);
  assert.equal(puts[0].headers.authorization, `Bearer ${GAB}`);
  assert.deepEqual(puts[0].body.sessions.map((s) => s.id), ['A'], 'only the sessions at work or waiting are published');
  assert.deepEqual(Object.keys(puts[0].body.sessions[0]).sort(), ['areas', 'branch', 'files', 'id', 'plan', 'since', 'status', 'title']);
  assert.deepEqual(sync.othersOf('/p').map((o) => o.member), ['Léa']);
  assert.equal(cols.length, 1, 'one alert per pair, even after two ticks'); assert.equal(cols[0].file, 'lib/team.mjs'); assert.equal(cols[0].member, 'Léa');
  assert.deepEqual(mem.map((l) => [l.member, l.line]), [['Léa', 'Les avatars restent en PNG']]); assert.equal(cursor, 1);
  assert.equal(sync.statusOf('/p').state, 'ok'); assert.match(plain(sync.statusOf('/p').line), /1 collègue/);
  assert.equal((await sync.sendMemory('/p', 'Les scores en entier')).sent, true); assert.deepEqual(relay.memoryOf(repoId).map((l) => [l.member, l.line]), [['Léa', 'Les avatars restent en PNG'], ['Dev', 'Les scores en entier']]);
  const sect = team.memorySection({ lines: mem, others: sync.othersOf('/p'), collisions: sync.collisionsOf('/p'), member: 'Dev' });
  assert.match(sect, /## Équipe/); assert.match(sect, /- Léa : Les avatars restent en PNG/); assert.match(sect, /Léa · Scores \(lea\/B\) · running · fichiers : lib\/team\.mjs/); assert.match(sect, /Léa touche aussi lib\/team\.mjs/);
  relay.setDown(true); await sync.tick(); assert.equal(sync.statusOf('/p').state, 'offline'); assert.match(sync.statusOf('/p').line, /injoignable/); relay.setDown(false);
  on = false; assert.equal(sync.statusOf('/p').state, 'off'); assert.equal((await sync.sendMemory('/p', 'x')).error, 'partage éteint');
  // a wrong token: refused, said as such
  const bad = team.createTeamSync({ settingsOf: () => ({ relay: relay.url, member: 'Dev', on: true, token: 'tok-wrong-00000' }), repoIdOf: async () => repoId, projects: () => ['/p'], sessionsOf: async () => [] });
  await bad.tick(); assert.equal(bad.statusOf('/p').state, 'refused');
});

test('tick never pushes twice within MIN_PUSH_GAP_MS: a short ESCADRILLE_TEAM_INTERVAL_MS stays under the relay’s 60 requests a minute; a 429 said in French', async () => {
  const relay = await fakeRelay({ tokens: { [GAB]: 'Dev' } }); relays.push(relay);
  let clock = 1e6; const repoId = team.repoIdOf('https://github.com/team/repo');
  const sync = team.createTeamSync({ settingsOf: () => ({ relay: relay.url, member: 'Dev', on: true, token: GAB }), repoIdOf: async () => repoId, projects: () => ['/p'], sessionsOf: async () => [], now: () => clock });
  // the demo ticks every 1.5 s: one minute of it
  for (let i = 0; i < 40; i++) { await sync.tick(); clock += 1500; }
  const puts = relay.requests.filter((r) => r.method === 'PUT').length;
  assert.ok(puts <= 12, `${puts} PUT in a minute (3 requests each): the relay would answer 429`);
  assert.ok(puts >= 10, `${puts} PUT: the presence must still refresh every ~5 s`);
  // an explicit sync (settings saved, « Synchroniser ») is never held back
  const before = relay.requests.length; await sync.sync('/p'); assert.ok(relay.requests.length > before);
  // the relay's 429: a plain line, not « too many requests »
  const busy = team.createTeamSync({ settingsOf: () => ({ relay: relay.url, member: 'Dev', on: true, token: GAB }), repoIdOf: async () => repoId, projects: () => ['/p'], sessionsOf: async () => [],
    fetch: async () => new Response(JSON.stringify({ error: 'too many requests' }), { status: 429, headers: { 'content-type': 'application/json' } }) });
  await busy.tick(); assert.equal(busy.statusOf('/p').state, 'error'); assert.equal(busy.statusOf('/p').line, 'Relais occupé : nouvel essai dans quelques secondes');
});

// ---------------------------------------------------------------- against the real relay (team/relay/relay.mjs, session REL)
test('createTeamSync against the real relay: a token of admin.mjs, presence and memory round trip, a member name other than the token’s refused', async () => {
  const { openDb, createRelay: realRelay } = await import('../team/relay/relay.mjs'); const { run: admin } = await import('../team/relay/admin.mjs');
  const db = openDb(path.join(tmp('escadrille-relaydb-'), 'relay.db')); const quiet = () => {};
  admin(['team-add', 'acme'], { db, out: quiet }); const gab = admin(['member-add', 'acme', 'gab'], { db, out: quiet }).token; const lea = admin(['member-add', 'acme', 'lea'], { db, out: quiet }).token;
  const server = realRelay({ db, log: quiet }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); relays.push({ close: () => { server.close(); db.close(); } });
  const url = `http://127.0.0.1:${server.address().port}`; const repoId = team.repoIdOf('git@github.com:Acme/App.git');
  const leaRelay = team.createRelay({ relay: url, token: lea });
  assert.equal((await leaRelay.putPresence(repoId, { member: 'lea', sessions: [{ id: 'B', title: 'Scores', status: 'running', files: ['db/migrations/001.sql'], areas: [] }], at: new Date().toISOString() })).ok, true);
  assert.equal((await leaRelay.postMemory(repoId, 'Une migration par PR')).ok, true);
  const cols = []; const mem = []; let cursor = null;
  const sync = team.createTeamSync({ settingsOf: () => ({ relay: url, member: 'gab', on: true, token: gab }), repoIdOf: async () => repoId, projects: () => ['/p'], onCollision: (p, c) => cols.push(c), onMemory: (p, l) => mem.push(...l), cursorOf: () => cursor, saveCursor: (p, c) => { cursor = c; },
    sessionsOf: async () => [{ plan: 'p', id: 'M', title: 'Migration', status: 'waiting', branch: 'x/M', files: ['db/migrations/002.sql'], areas: [] }] });
  await sync.tick();
  assert.equal(sync.statusOf('/p').state, 'ok', sync.statusOf('/p').line); assert.deepEqual(sync.othersOf('/p').map((o) => o.member), ['lea']);
  assert.deepEqual(cols.map((c) => [c.member, c.kind, c.file]), [['lea', 'migrations', 'db/migrations/']]);
  assert.deepEqual(mem.map((l) => [l.member, l.line]), [['lea', 'Une migration par PR']]); assert.equal(cursor, 1);
  assert.equal((await sync.sendMemory('/p', 'Les scores en entier')).sent, true);
  const read = await leaRelay.getMemory(repoId, 1); assert.deepEqual(read.body.lines.map((l) => [l.member, l.line]), [['gab', 'Les scores en entier']]);
  const wrongName = team.createTeamSync({ settingsOf: () => ({ relay: url, member: 'Martin', on: true, token: gab }), repoIdOf: async () => repoId, projects: () => ['/p'], sessionsOf: async () => [] });
  await wrongName.tick(); assert.equal(wrongName.statusOf('/p').state, 'refused'); assert.match(wrongName.statusOf('/p').line, /nom de membre/);
});

// ---------------------------------------------------------------- against the server
const repo = (name, remote) => { const root = tmp(name); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); writeFileSync(path.join(root, '.gitignore'), '.escadrille/\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); sh(root, ['remote', 'add', 'origin', remote]); return root; };
const boot = async (turns) => {
  const fake = fakeClaude(); const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`; const empty = tmp('escadrille-none-'); const guardDir = tmp('escadrille-guard-'); const secretsFile = path.join(tmp('escadrille-sec-'), 'secrets.json'); const dbFile = path.join(tmp('escadrille-db-'), 'db.sqlite');
  const proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: dbFile, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_GUARD_DIR: guardDir, ESCADRILLE_SECRETS: secretsFile, ESCADRILLE_TEAM_INTERVAL_MS: '400', ...LIC.env, FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc); let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const S = { base, secretsFile, dbFile, fake, err: () => err };
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.session = async (plan, id) => (await S.get('/api/plan/' + plan)).state.find((x) => x.id === id);
  S.messages = async (plan, id) => (await S.get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  await until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + err); });
  S.cookie = { cookie: 'escadrille_guard=' + readFileSync(path.join(guardDir, 'guard-key'), 'utf8').trim() };
  return S;
};

test('the server: off by default, the setting by the cookie only and the token never exposed; presence with the files of a worktree; collisions by motif and by migrations, once each, in the pending and « À toi »; the team memory both ways; the planner reads « Équipe »; off again; the relay down', async () => {
  const relay = await fakeRelay({ tokens: { [GAB]: 'Dev', [LEA]: 'Léa' } }); relays.push(relay);
  const root = repo('escadrille-team-', 'https://user:pw@GitHub.com/Team/Repo.git'); const repoId = team.repoIdOf('https://github.com/team/repo');
  const S = await boot([{ write: 'migrations/002_add.sql', stops: [0], claude: 'Migration écrite' }, { stops: [0, 1], claude: 'Fin', done: true }]);
  const q = '?project=' + encodeURIComponent(root);
  // 1. off by default
  let t = await S.get('/api/team' + q); assert.deepEqual([t.on, t.token, t.relay, t.member, t.status.state], [false, false, null, null, 'off']);
  // 2. the write: 403 without the cookie, 400 when on cannot be, 200 with everything; the token stays in the secrets file
  let r = await S.post('/api/team', { project: root, relay: relay.url, member: 'Dev', token: GAB }); assert.equal(r.status, 403);
  r = await S.post('/api/team', { project: root, on: true }, S.cookie); assert.equal(r.status, 400); assert.match(r.body.error, /relais/);
  r = await S.post('/api/team', { project: root, relay: relay.url, member: 'Dev', token: GAB }, S.cookie); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.on, r.body.token, r.body.member], [false, true, 'Dev'], 'a token given, still off: on is a separate gesture');
  assert.ok(!JSON.stringify(r.body).includes(GAB), 'the answer never carries the token');
  assert.ok(!JSON.stringify(await S.get('/api/project/settings' + q)).includes(GAB)); assert.ok(!JSON.stringify(await S.get('/api/access' + q)).includes(GAB));
  assert.equal(JSON.parse(readFileSync(S.secretsFile, 'utf8'))[root].team, GAB, 'in ~/.config/escadrille/secrets.json');
  { const db = new DatabaseSync(S.dbFile, { readOnly: true }); const all = db.prepare('select json from project_settings').all().map((x) => x.json).join(''); db.close(); assert.ok(!all.includes(GAB), 'never in the base'); }
  assert.equal(relay.requests.length, 0, 'off: nothing left the Mac');
  // 3. on: the first contact, the others read, nothing but metadata in what we send
  relay.seedPresence(repoId, 'Léa', [{ id: 'B', plan: 'p-lea', title: 'Migration des scores', branch: 'escadrille/lea/B', status: 'running', files: ['lib/team.mjs', 'migrations/001_scores.sql'], areas: [] }]);
  relay.seedMemory(repoId, 'Léa', 'Les avatars restent en PNG');
  r = await S.post('/api/team', { project: root, on: true }, S.cookie); assert.equal(r.status, 200); assert.equal(r.body.on, true);
  t = await until(async () => { const x = await S.get('/api/team' + q); return x.status.state === 'ok' ? x : null; });
  assert.deepEqual(t.members.map((m) => m.member), ['Léa']); assert.match(t.status.line, /1 collègue/);
  const access = await S.get('/api/access' + q); const conn = access.extensions.connectors.find((c) => c.kind === 'relay'); assert.ok(conn && conn.ready && conn.on, 'declared in Accès'); assert.ok(access.out.some((o) => o.host.startsWith('127.0.0.1:')), 'the relay host is what leaves the Mac');
  // 4. a planned session (never launched) whose `where` covers a colleague's file: the alert before the launch
  r = await S.post('/api/plan', { id: 'poc', title: 'PoC', project: root, sessions: [{ id: 'A', name: 'Le relais', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille sur le relais.', budget: 1, stops: ['Fin'], where: 'lib/team.mjs et docs/team.md' }] }); assert.equal(r.status, 200, JSON.stringify(r.body));
  t = (await S.post('/api/team/sync', { project: root })).body;
  assert.deepEqual(t.collisions.map((c) => [c.ours.id, c.kind, c.file, c.member]), [['A', 'area', 'lib/team.mjs', 'Léa']]);
  let s = await S.session('poc', 'A'); let infos = s.pending.filter((p) => p.kind === 'info' && p.team);
  assert.equal(infos.length, 1); assert.equal(infos[0].text, 'Léa touche aussi lib/team.mjs (session Migration des scores)'); assert.deepEqual(infos[0].team.files, ['lib/team.mjs']);
  assert.ok((await S.messages('poc', 'A')).some((m) => m.role === 'system' && /Léa travaille sur « Migration des scores » \(branche escadrille\/lea\/B\) et touche aussi : lib\/team\.mjs/.test(m.text)), 'the detail in the thread');
  await S.post('/api/team/sync', { project: root }); await sleep(900); // ticks go on
  s = await S.session('poc', 'A'); assert.equal(s.pending.filter((p) => p.kind === 'info' && p.team).length, 1, 'once per pair');
  // 5. a launched session: its files come from the worktree (git diff from the base); the migrations folder collides
  r = await S.post('/api/plan', { id: 'run', title: 'Run', project: root, sessions: [{ id: 'M', name: 'La migration', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['Premier', 'Fin'] }] }); assert.equal(r.status, 200);
  await S.post('/api/launch', { plan: 'run' });
  await until(async () => (await S.session('run', 'M')).status === 'waiting');
  t = (await S.post('/api/team/sync', { project: root })).body;
  const mine = relay.presenceOf(repoId).find((m) => m.member === 'Dev'); const pub = mine.sessions.find((x) => x.id === 'M');
  assert.ok(pub, 'our waiting session is published'); assert.deepEqual([pub.status, pub.files, pub.title], ['waiting', ['migrations/002_add.sql'], 'La migration']); assert.match(pub.branch, /^escadrille\/run\/M$/);
  assert.ok(!mine.sessions.some((x) => x.id === 'A'), 'a planned session is not published');
  const mig = t.collisions.find((c) => c.ours.id === 'M'); assert.ok(mig, JSON.stringify(t.collisions)); assert.deepEqual([mig.kind, mig.file], ['migrations', 'migrations/']);
  s = await S.session('run', 'M'); assert.equal(s.pending.filter((p) => p.kind === 'info' && p.team).length, 1);
  assert.deepEqual((await S.get('/api/team' + q)).collisions.map((c) => c.ours.id).sort(), ['A', 'M'], 'what « À toi » lists');
  // what left the Mac: the bearer header on every request, never the prompt, never the token in a body or a URL
  for (const x of relay.requests) { assert.equal(x.headers.authorization, `Bearer ${GAB}`); const flat = JSON.stringify([x.path, x.body]); assert.ok(!flat.includes(GAB) && !/Travaille/.test(flat), flat); if (x.method === 'PUT') assert.deepEqual(Object.keys(x.body).sort(), ['at', 'member', 'sessions']); }
  // 6. the team memory: « équipe : » goes to the relay, Léa's line lands in .escadrille/equipe.md once, the planner reads « Équipe »
  r = await S.post('/api/memory', { project: root, line: 'équipe : Les scores restent en entier' }); assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.body).sort(), ['file', 'ok'], 'the answer of POST /api/memory does not change');
  await until(() => relay.memoryOf(repoId).some((l) => l.member === 'Dev' && l.line === 'Les scores restent en entier'));
  assert.match(readFileSync(path.join(root, '.calmdev', 'memoire.md'), 'utf8'), /équipe : Les scores restent en entier/, 'the local memory keeps the line with its mark');
  r = await S.post('/api/memory', { project: root, line: 'Local seulement' }); assert.equal(r.status, 200); await sleep(300); assert.ok(!relay.memoryOf(repoId).some((l) => l.line === 'Local seulement'), 'an unmarked line stays local');
  await S.post('/api/team/sync', { project: root }); await S.post('/api/team/sync', { project: root });
  const eq = readFileSync(path.join(root, '.calmdev', 'equipe.md'), 'utf8');
  assert.equal((eq.match(/Léa : Les avatars restent en PNG/g) || []).length, 1, 'once, the cursor holds'); assert.ok(!/Dev : Les scores/.test(eq), 'our own lines are not echoed back');
  t = await S.get('/api/team' + q); assert.deepEqual(t.memory.lines.filter((l) => l.member === 'Léa').map((l) => l.line), ['Les avatars restent en PNG']);
  r = await S.post('/api/escadrille', { project: root, model: 'claude-sonnet-5-5', idea: 'Une idée' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const args = await until(() => { try { const a = readFileSync(path.join(S.fake.dir, 'args.jsonl'), 'utf8'); return /## Équipe/.test(a) ? a : null; } catch { return null; } });
  assert.match(args, /Léa : Les avatars restent en PNG/); assert.match(args, /Les escadrilles des autres/); assert.match(args, /Léa · Migration des scores \(escadrille\/lea\/B\)/); assert.match(args, /Collisions vues/);
  assert.ok(!args.includes(GAB), 'the planner never sees the token');
  // 7. off again: nothing more leaves; the sync route says off
  r = await S.post('/api/team', { project: root, on: false }, S.cookie); assert.equal(r.body.on, false); assert.equal(r.body.token, true, 'the token stays stored, off is a switch');
  await sleep(600); const n = relay.requests.length; await sleep(1000); assert.equal(relay.requests.length, n, 'off: no request');
  t = (await S.post('/api/team/sync', { project: root })).body; assert.equal(t.status.state, 'off'); assert.deepEqual(t.collisions, []);
  assert.equal((await S.get('/api/team' + q)).memory.lines.length >= 1, true, 'the received memory stays readable');
  // 8. on with the relay down: one line, the server goes on
  relay.setDown(true); r = await S.post('/api/team', { project: root, on: true }, S.cookie); assert.equal(r.status, 200);
  t = (await S.post('/api/team/sync', { project: root })).body; assert.equal(t.status.state, 'offline', JSON.stringify({ r: r.body, t, err: S.err().slice(-500) })); assert.match(t.status.line, /injoignable/);
  assert.ok(Array.isArray(await S.get('/api/plans')));
  relay.setDown(false); t = (await S.post('/api/team/sync', { project: root })).body; assert.equal(t.status.state, 'ok');
  // the token cleared: off follows, the secrets file forgets it
  r = await S.post('/api/team', { project: root, token: null }, S.cookie); assert.equal(r.status, 400, 'on with no token is refused');
  r = await S.post('/api/team', { project: root, token: null, on: false }, S.cookie); assert.equal(r.status, 200); assert.equal(r.body.token, false);
  assert.equal(JSON.parse(readFileSync(S.secretsFile, 'utf8'))[root]?.team, undefined);
  assert.ok(!S.err().includes(GAB), 'never logged'); assert.ok(!existsSync(path.join(root, 'sessions.sqlite')));
});
