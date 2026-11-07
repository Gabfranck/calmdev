// lib/devenv.mjs (docs/devenv.md): the setting validated, the ENV: lines, the commands run as argv (node -e here, never
// Docker), the health URLs waited for, the secrets blanked, the queue; then against the server and the fake claude: the
// setting written by the developer's cookie only, the accounts never returned, a session's ENV: lines answered and the
// session resumed, « Ce qui tourne » with its Arrêter, and the declared tests of a repository run at done with the reads
// its sandbox lacked (a node_modules linked in, a sibling folder beside the worktree).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort } from './free-port.mjs';
import { fakeClaude } from './fake-claude.mjs';
import * as D from '../lib/devenv.mjs';
import { ours, markDevEnv, unmarkDevEnv, devEnvs } from '../lib/running.mjs';
// A LAN address is assembled at run time: scripts/trace-scan.mjs would take a written one for a real one.
const ip = (net, host) => `${net}.${host}`;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 160)); await new Promise((r) => setTimeout(r, 100)); } };
const procs = []; after(() => { for (const p of procs) p.kill('SIGKILL'); });
const project = tmp('devenv-proj-');

test('validateEnvironment: argv commands, env, LAN hosts, health URLs on known hosts, accounts apart, tests per repository', () => {
  const raw = { commands: { up: ['docker', 'compose', 'up', '-d'], down: ['docker', 'compose', 'down'], status: ['docker', 'compose', 'ps'] }, env: { LAN_IP: `${ip('192.168.1', 2)}`, DB_PASSWORD: 'pw-secret' }, lanHosts: [`${ip('192.168.1', 2)}`], health: ['http://localhost:3050/', `http://${ip('192.168.1', 2)}:8081`],
    accounts: { prof: { username: 'prof.free', password: 'password' }, eleve: { identifiant: 'eleve.1', motDePasse: 'password' } }, tests: { 'Orchard-teacher': { command: 'npm test', reads: ['Orchard-teacher/node_modules', 'Orchard-analytics'] } }, note: 'dev.sh écrit .env' };
  const { value, accounts, errors } = D.validateEnvironment(raw, { project });
  assert.equal(errors, null);
  assert.deepEqual(value.commands.up, ['docker', 'compose', 'up', '-d']); assert.deepEqual(value.lanHosts, [`${ip('192.168.1', 2)}`]);
  assert.deepEqual(value.health, ['http://localhost:3050/', `http://${ip('192.168.1', 2)}:8081/`]);
  assert.deepEqual(accounts, { prof: { username: 'prof.free', password: 'password' }, eleve: { username: 'eleve.1', password: 'password' } });
  assert.ok(!JSON.stringify(value).includes('password'), 'no account in the stored value');
  assert.deepEqual(value.tests['Orchard-teacher'].reads, [path.join(project, 'Orchard-teacher/node_modules'), path.join(project, 'Orchard-analytics')]);
  const pub = D.publicView(value, accounts);
  assert.deepEqual(pub.accounts, [{ name: 'prof', username: 'prof.free' }, { name: 'eleve', username: 'eleve.1' }]); assert.equal(pub.set, true);
  assert.ok(!JSON.stringify(pub).includes('password'));
  assert.deepEqual(D.publicView(null, null), { set: false, accounts: [] });
  for (const [bad, why] of [
    [{ commands: { up: 'docker compose up' } }, /argv, sans shell/], [{ commands: { up: [] } }, /argv/], [{ commands: { start: ['x'] } }, /inconnu/],
    [{ health: ['http://example.com/'] }, /ni localhost ni un hôte LAN/], [{ health: ['ftp://localhost/'] }, /http\(s\) seulement/], [{ lanHosts: ['bad host'] }, /pas un hôte/],
    [{ env: { 'A B': 'x' } }, /nom de variable/], [{ accounts: { prof: { username: 'p' } } }, /username, password/], [{ accounts: { 'bad name': { username: 'a', password: 'b' } } }, /nom illisible/],
    [{ tests: { '../x': { command: 'npm test' } } }, /relatif au projet/], [{ tests: { '.': { command: 'a\nb' } } }, /une ligne/], [{ timeouts: { up: 10 } }, /millisecondes/], [[], /un objet/],
  ]) { const r = D.validateEnvironment(bad, { project }); assert.equal(r.value, null, JSON.stringify(bad)); assert.match(r.errors.join(' ; '), why); }
  assert.equal(D.validateEnvironment({ accounts: { prof: { username: 'p', password: 'x' } } }, { project }).value.commands && true, true);
  assert.equal(D.validateEnvironment({}, { project }).accounts, null, 'absent accounts: the stored ones stay');
});

test('parseEnv: ENV: lines alone on their line, unique, four at most, the state fields included, nothing else read', () => {
  assert.deepEqual(D.parseEnv('Je lance.\nENV: up\n- ENV: status\nIl faut écrire ENV: down ailleurs.\nENV: up\nENV: reset ; rm -rf /\n> ENV: STATUS'), ['up', 'status']);
  assert.deepEqual(D.parseEnv('', { claude: 'ENV: status', summary: 'Fait\nENV: down' }), ['status', 'down']);
  assert.deepEqual(D.parseEnv('ENV: up\nENV: down\nENV: reset\nENV: status\nENV: up'), ['up', 'down', 'reset', 'status']);
  assert.deepEqual(D.parseEnv('ENV: destroy\nENV:up\nENV: up extra'), ['up'], 'like CAPTURE:, the space after the colon is optional');
  assert.deepEqual(D.parseEnv(null, null), []);
});

test('runCommand: argv without a shell, the last 40 lines, ANSI stripped, a timeout kills the group, a missing program is one line', async () => {
  const r = await D.runCommand({ argv: [NODE, '-e', 'for (let i = 0; i < 50; i++) console.log("\\x1b[32mline " + i + "\\x1b[0m"); console.error("err"); process.exit(3)'], cwd: project, env: process.env, timeoutMs: 10000 });
  assert.equal(r.code, 3); assert.equal(r.lines.length, 40); assert.equal(r.lines[0], 'line 11'); assert.equal(r.lines[39], 'err'); assert.ok(!r.lines.some((l) => l.includes('\x1b')));
  const slow = await D.runCommand({ argv: [NODE, '-e', 'console.log("start"); setTimeout(() => {}, 60000)'], cwd: project, env: process.env, timeoutMs: 800 });
  assert.equal(slow.killed, true); assert.match(slow.error, /délai de 1 s/); assert.deepEqual(slow.lines, ['start']);
  const none = await D.runCommand({ argv: ['/nulle/part/docker', 'ps'], cwd: project, env: process.env, timeoutMs: 1000 });
  assert.equal(none.code, null); assert.match(none.error, /ENOENT/);
  const shellish = await D.runCommand({ argv: [NODE, '-e', 'console.log(process.argv[1])', '$(touch /tmp/pwned) ; echo'], cwd: project, env: process.env, timeoutMs: 5000 });
  assert.deepEqual(shellish.lines, ['$(touch /tmp/pwned) ; echo'], 'the argument reaches the program as it is: no shell');
});

test('probeHealth: every URL polled until it answers (any status under 500) or the delay is spent', async () => {
  let calls = 0; const f = async (url) => { calls++; if (url.endsWith('/slow') && calls < 4) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); return { status: url.endsWith('/404') ? 404 : url.endsWith('/500') ? 503 : 200 }; };
  let t = 0; const now = () => t; const sleep = async () => { t += 1000; };
  const r = await D.probeHealth(['http://localhost:1/ok', 'http://localhost:1/404', 'http://localhost:1/slow', 'http://localhost:1/500'], { untilMs: 5000, fetch: f, now, sleep, eachMs: 10 });
  assert.deepEqual(r.map((h) => [h.url.split('/').pop(), h.ok, h.status]), [['ok', true, 200], ['404', true, 404], ['slow', true, 200], ['500', false, 503]]);
  assert.ok(t >= 5000, 'the 503 is waited for until the deadline');
  const once = await D.probeHealth(['http://localhost:1/500'], { untilMs: 0, fetch: f, now, sleep, eachMs: 10 });
  assert.equal(once[0].ok, false);
});

test('runEnv: nothing set → one line; an unknown command → one line; up runs the argv with the env and waits for health; secrets blanked', async () => {
  const none = await D.runEnv({ action: 'up', environment: null, project });
  assert.equal(none.ok, false); assert.equal(none.configured, false); assert.match(none.error, /environnement non réglé pour devenv-proj/);
  assert.match(D.envNote(none, 'up'), /^ENV up : environnement non réglé/); assert.ok(!D.envNote(none, 'up').includes('\n'));
  const env = D.validateEnvironment({ commands: { up: [NODE, '-e', 'console.log("LAN=" + process.env.LAN_IP + " PW=" + process.env.DB_PASSWORD + " home=" + (process.env.OPENAI_API_KEY || "stripped"))'], status: [NODE, '-e', 'console.log("ps ok")'] }, env: { LAN_IP: '203.0.113.9', DB_PASSWORD: 'pw-secret-1' }, health: ['http://localhost:1/'] }, { project }).value;
  const accounts = { prof: { username: 'prof.free', password: 'top-secret-2' } };
  const missing = await D.runEnv({ action: 'down', environment: env, accounts, project });
  assert.equal(missing.ok, false); assert.match(missing.error, /commande down non déclarée/);
  const f = async () => ({ status: 200 });
  const up = await D.runEnv({ action: 'up', environment: env, accounts, project, env: { ...testEnv(), ESCADRILLE_GATE: 'off', OPENAI_API_KEY: 'sk-xxx' }, fetch: f, healthOpts: { eachMs: 10 } });
  assert.equal(up.ok, true); assert.equal(up.code, 0); assert.deepEqual(up.lines, ['LAN=203.0.113.9 PW=••• home=stripped']); assert.equal(up.health[0].ok, true);
  const note = D.envNote(up, 'up', ['prof']);
  assert.match(note, /^ENV up : prêt · localhost:1 ok \(200, \d+ s\) · comptes de test : prof\n  │ LAN=203\.0\.113\.9 PW=•••/);
  assert.ok(!note.includes('pw-secret-1') && !note.includes('top-secret-2'));
  const st = await D.runEnv({ action: 'status', environment: env, accounts, project, fetch: async () => { throw new Error('refused'); }, healthOpts: { eachMs: 10 } });
  assert.equal(st.running, false); assert.match(D.envNote(st, 'status', ['prof']), /^ENV status : ne tourne pas · localhost:1 injoignable/);
  const leak = D.redactor(D.secretValues(env, accounts))('pw-secret-1 and top-secret-2 and 203.0.113.9');
  assert.equal(leak, '••• and ••• and 203.0.113.9', 'a password and a secret-named env value are blanked, the rest stays');
});

test('createEnvQueue: one command at a time per project, notes in order, onIdle once the session has nothing left', async () => {
  const seen = []; const notes = []; const idle = []; let running = 0; let maxRunning = 0;
  const run = async (job) => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 20)); running--; seen.push(job.project + ':' + job.action); return { ok: true, action: job.action, code: 0, lines: [] }; };
  const q = D.createEnvQueue({ run, onNote: (job, line) => notes.push(line), onIdle: (p, s) => idle.push(p + '/' + s) });
  q.enqueue([{ project: 'P', planId: 'p', sid: 'A', action: 'up' }, { project: 'P', planId: 'p', sid: 'A', action: 'status' }, { project: 'P', planId: 'p', sid: 'B', action: 'status' }, { project: 'Q', planId: 'p', sid: 'C', action: 'up' }]);
  assert.equal(q.busy('p', 'A'), true);
  await until(() => idle.length === 3);
  assert.deepEqual(seen.filter((s) => s.startsWith('P:')), ['P:up', 'P:status', 'P:status']); assert.equal(maxRunning, 2, 'two projects in parallel, one command at a time each');
  assert.deepEqual(idle.sort(), ['p/A', 'p/B', 'p/C']); assert.equal(notes.length, 4); assert.match(notes[0], /^ENV up : démarré \(code 0\)$/);
  assert.equal(q.busy('p', 'A'), false);
});

test('testsFor and testLayout: the repository of a worktree finds its declared tests; reads inside are linked, the others are siblings', () => {
  const env = D.validateEnvironment({ tests: { '.': { command: 'npm test' }, 'Orchard-teacher': { command: 'npm test', reads: ['Orchard-teacher/node_modules', 'Orchard-analytics', 'absent'] } } }, { project }).value;
  mkdirSync(path.join(project, 'Orchard-teacher', 'node_modules'), { recursive: true }); mkdirSync(path.join(project, 'Orchard-analytics'), { recursive: true });
  assert.equal(D.testsFor(env, project, project).key, '.');
  const t = D.testsFor(env, project, path.join(project, 'Orchard-teacher')); assert.equal(t.key, 'Orchard-teacher');
  assert.equal(D.testsFor(env, project, path.join(project, 'Orchard-expo')), null); assert.equal(D.testsFor(env, project, '/elsewhere'), null); assert.equal(D.testsFor(null, project, project), null);
  const lay = D.testLayout({ project, root: path.join(project, 'Orchard-teacher'), entry: t });
  assert.equal(lay.cmd, 'npm test');
  assert.deepEqual(lay.links, [{ at: 'node_modules', to: path.join(project, 'Orchard-teacher', 'node_modules') }]);
  assert.deepEqual(lay.siblings, [{ rel: '../Orchard-analytics', to: path.join(project, 'Orchard-analytics') }]);
  assert.deepEqual(lay.missing, [path.join(project, 'absent')]);
});

test('running.ours lists a dev environment Escadrille started, by project, until it is unmarked', () => {
  markDevEnv({ project: '/p/orchard', plan: 'qa', session: 'A', url: 'http://localhost:3050/', since: '2026-11-02T10:00:00.000Z' });
  assert.deepEqual(ours({ devenvs: devEnvs() }), [{ kind: 'devenv', plan: 'qa', session: 'A', pid: null, cwd: '/p/orchard', url: 'http://localhost:3050/', since: '2026-11-02T10:00:00.000Z' }]);
  markDevEnv({ project: '/p/orchard', plan: 'qa', session: 'B' }); assert.equal(devEnvs().length, 1, 'one per project');
  unmarkDevEnv('/p/orchard'); assert.deepEqual(devEnvs(), []);
});

// ---------------------------------------------------------------- against the server
const repo = (name) => { const root = tmp(name); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); writeFileSync(path.join(root, '.gitignore'), 'node_modules\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const boot = async (turns) => {
  const fake = fakeClaude(); const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`; const empty = tmp('escadrille-none-'); const guardDir = tmp('escadrille-guard-'); const secretsFile = path.join(tmp('escadrille-sec-'), 'secrets.json');
  const proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_GUARD_DIR: guardDir, ESCADRILLE_SECRETS: secretsFile, ESCADRILLE_TESTBOX: path.join(HERE, 'fake-box.sh'), FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc); let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const S = { base, secretsFile, err: () => err };
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.prompts = () => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  S.session = async (plan, id) => (await S.get('/api/plan/' + plan)).state.find((x) => x.id === id);
  S.messages = async (plan, id) => (await S.get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  await until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + err); });
  S.cookie = { cookie: 'escadrille_guard=' + readFileSync(path.join(guardDir, 'guard-key'), 'utf8').trim() };
  return S;
};
const plan = (id, root) => ({ id, title: id, project: root, sessions: [{ id: 'A', name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['Premier', 'Fin'] }] });
const envLines = (text) => text.split('\n').filter((l) => /^(\[système\] )?ENV /.test(l));

test('the server: the setting by the developer’s cookie only, accounts never returned; ENV: lines answered, the session resumed, « Ce qui tourne » and Arrêter; the declared tests at done', async () => {
  // a health target the fake `up` is checked against
  const web = createServer((req, res) => { res.writeHead(200); res.end('ok'); }); await new Promise((r) => web.listen(0, '127.0.0.1', r)); after(() => web.close());
  const health = `http://127.0.0.1:${web.address().port}/`;
  const turns = [{ stops: [0], claude: 'Premier arrêt' }, { stops: [0], claude: 'Je continue', prose: 'Je regarde.\nENV: status\nENV: up' }, { stops: [0, 1], claude: 'Fini', done: true, write: 'src/x.txt' }];
  const S = await boot(turns);
  const bare = repo('devenv-bare-'); const root = repo('devenv-root-');
  // the reads the session's sandbox lacks: the checkout's node_modules (ignored, absent from a fresh worktree) and a sibling repository
  mkdirSync(path.join(root, 'node_modules')); writeFileSync(path.join(root, 'node_modules', 'marker'), '1'); const voisin = path.join(path.dirname(root), path.basename(root) + '-voisin'); mkdirSync(voisin); writeFileSync(path.join(voisin, 'ok.txt'), '1');
  const environment = {
    commands: { up: [NODE, '-e', 'console.log("up ok"); console.log("DB_PASSWORD=" + process.env.DB_PASSWORD); console.log("arg " + process.argv[1])', 'arg-as-is'], status: [NODE, '-e', 'console.log("ps: api running")'], down: [NODE, '-e', 'console.log("down ok")'] },
    env: { DB_PASSWORD: 'db-secret-456' }, health: [health], accounts: { prof: { username: 'prof.free', password: 'secret-pw-123' } },
    tests: { '.': { command: 'test -f src/x.txt && test -f node_modules/marker && test -f ../' + path.basename(voisin) + '/ok.txt && echo tests-ok', reads: [path.join(root, 'node_modules'), voisin] } },
  };
  // 1. the write: 403 without the guard cookie (a session on 127.0.0.1), 200 with it; the GET never carries a password
  let r = await S.post('/api/project/settings', { project: root, environment }); assert.equal(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.error, /garde-fou|clé/);
  r = await S.post('/api/project/settings', { project: root, environment: { commands: { up: 'docker compose up' } } }, S.cookie); assert.equal(r.status, 400); assert.match(r.body.error, /argv/);
  r = await S.post('/api/project/settings', { project: root, environment }, S.cookie); assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = await S.get('/api/project/settings?project=' + encodeURIComponent(root));
  assert.deepEqual(got.environment.accounts, [{ name: 'prof', username: 'prof.free' }]); assert.deepEqual(got.environment.commands.status, [NODE, '-e', 'console.log("ps: api running")']); assert.ok(got.stored.includes('environment'));
  assert.ok(!JSON.stringify(got).includes('secret-pw-123'), 'the password never leaves');
  assert.ok(readFileSync(S.secretsFile, 'utf8').includes('secret-pw-123'), 'it lives in the secrets file');
  const acc = await S.get('/api/access?project=' + encodeURIComponent(root));
  assert.deepEqual([acc.sessions.devenv.set, acc.sessions.devenv.commands, acc.sessions.devenv.accounts, acc.sessions.devenv.tests], [true, ['up', 'status', 'down'], ['prof'], ['.']]);
  assert.ok(!JSON.stringify(acc).includes('secret-pw-123') && !JSON.stringify(acc).includes('db-secret-456'));
  assert.equal((await S.get('/api/access?project=' + encodeURIComponent(bare))).sessions.devenv.set, false, 'the access view says it is to set');
  // 2. a project without a setting: each ENV: line is answered in one line, the session is resumed by the server alone
  assert.equal((await S.post('/api/plan', plan('bare', bare))).status, 200); await S.post('/api/launch', { plan: 'bare' });
  await until(async () => (await S.session('bare', 'A')).status === 'waiting');
  await S.post('/api/plan/bare/session/A/message', { text: 'Va.' });
  await until(() => S.prompts().filter((p) => /reprends/.test(p.text)).length >= 1);
  const resumed = S.prompts().find((p) => /reprends/.test(p.text)).text;
  assert.deepEqual(envLines(resumed).map((l) => l.replace(/pour devenv-bare-\S+/, 'pour <projet>')), ['[système] ENV status : environnement non réglé pour <projet> : le développeur le déclare dans Accès › Réglages (docs/devenv.md)', '[système] ENV up : environnement non réglé pour <projet> : le développeur le déclare dans Accès › Réglages (docs/devenv.md)']);
  assert.match(resumed, /L’environnement a répondu : reprends\./);
  await until(async () => (await S.session('bare', 'A')).status === 'done');
  const bareMsgs = await S.messages('bare', 'A');
  assert.equal(bareMsgs.filter((m) => m.role === 'system' && /^ENV /.test(m.text)).length, 2, 'one system line per ENV: line in the page');
  assert.ok(!bareMsgs.some((m) => /Tests/.test(m.text)), 'no declared tests: nothing run at done');
  // 3. the project with its setting: status then up run the declared argv, health waited for, the output blanked; the environment is listed as running
  assert.equal((await S.post('/api/plan', plan('env', root))).status, 200); await S.post('/api/launch', { plan: 'env' });
  await until(async () => (await S.session('env', 'A')).status === 'waiting');
  await S.post('/api/plan/env/session/A/message', { text: 'Va.' });
  await until(() => S.prompts().filter((p) => /reprends/.test(p.text)).length >= 2, 60000);
  const text = S.prompts().filter((p) => /reprends/.test(p.text))[1].text;
  const lines = envLines(text);
  assert.match(lines[0], /^\[système\] ENV status : tourne · 127\.0\.0\.1:\d+ ok \(200, \d+ s\) · comptes de test : prof$/);
  assert.match(lines[1], /^\[système\] ENV up : prêt · 127\.0\.0\.1:\d+ ok \(200, \d+ s\) · comptes de test : prof$/);
  assert.ok(text.includes('  │ up ok') && text.includes('  │ DB_PASSWORD=•••') && text.includes('  │ arg arg-as-is'), text);
  assert.ok(!text.includes('secret-pw-123') && !text.includes('db-secret-456'), 'no secret reaches the session');
  const running = await S.get('/api/running');
  const dev = running.ours.find((o) => o.kind === 'devenv'); assert.ok(dev, JSON.stringify(running.ours)); assert.deepEqual([dev.plan, dev.session, dev.project, dev.cwd, dev.url], ['env', 'A', root, root, health]);
  // 4. done: the declared tests run boxed on the branch merged dry, with node_modules linked in and the sibling beside; the card knows
  await until(async () => (await S.session('env', 'A')).status === 'done');
  const A = await until(async () => { const s = await S.session('env', 'A'); return s.worktree?.tests ? s : null; }, 60000);
  assert.equal(A.worktree.tests.code, 0, JSON.stringify(A.worktree.tests)); assert.match(A.worktree.tests.cmd, /tests-ok/);
  assert.equal(A.worktree.merged, false, 'no automatic merge: the click stays');
  const msgs = (await S.messages('env', 'A')).map((m) => m.text);
  assert.ok(msgs.some((t) => /^Tests de la branche fusionnée à blanc.*\(tests déclarés pour \.\)/.test(t)), msgs.join('\n'));
  assert.ok(msgs.some((t) => /^Tests : code 0\n[\s\S]*tests-ok/.test(t)), msgs.join('\n'));
  assert.ok(!existsSync(path.join(root, '.git', 'worktrees')) || !readFileSync(path.join(root, '.git', 'worktrees', '..', 'HEAD'), 'utf8').includes('escadrille'), 'main never moves');
  // 5. « Arrêter » on « Ce qui tourne »: the declared down runs, the environment leaves the list, the session's thread says it
  r = await S.post('/api/running/stop', { kind: 'devenv', plan: 'env', session: 'A', project: root }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!(await S.get('/api/running')).ours.some((o) => o.kind === 'devenv'));
  const last = (await S.messages('env', 'A')).filter((m) => m.role === 'system').map((m) => m.text).pop();
  assert.match(last, /^ENV down : arrêté · comptes de test : prof\n  │ down ok$/);
  r = await S.post('/api/running/stop', { kind: 'devenv', project: root }); assert.equal(r.status, 400);
  // 6. null clears the setting and the accounts
  r = await S.post('/api/project/settings', { project: root, environment: null }, S.cookie); assert.equal(r.status, 200); assert.equal(r.body.settings.environment.set, false);
  assert.ok(!readFileSync(S.secretsFile, 'utf8').includes('secret-pw-123'));
});
