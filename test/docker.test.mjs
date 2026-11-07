// Phase 16 DOCK (docs/docker.md), without Docker: ESCADRILLE_DOCKER points to test/fake-docker.mjs, a compose of five
// services. The setting, the closed argv (never down, rm, prune, -v), ps read in both formats, a service outside the
// compose refused before any command, the session's closed verbs and exec only where declared, the SSE logs, the queue
// per project, the masking, the two failure sentences; against the server: 403 without the cookie, the clicks, the
// pilot's log, and a session's DOCKER: lines answered and the session resumed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort } from './free-port.mjs';
import { fakeClaude } from './fake-claude.mjs';
import * as K from '../lib/docker.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const FAKE = path.join(HERE, 'fake-docker.mjs');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 160)); await new Promise((r) => setTimeout(r, 50)); } };
const procs = []; after(() => { for (const p of procs) p.kill('SIGKILL'); });
const project = tmp('docker-proj-');
const callsFile = path.join(tmp('docker-calls-'), 'calls.jsonl');
const env = (extra = {}) => ({ ...testEnv(), ESCADRILLE_DOCKER: FAKE, FAKE_DOCKER_LOG: callsFile, ...extra });
const calls = () => { try { return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const environment = { cwd: project, commands: {}, env: { LAN_IP: '192.0.2.10', DB_PASSWORD: 'db-secret-456' }, docker: { exec: ['api'], files: [] } };
const accounts = { prof: { username: 'prof.free', password: 'pw-prof-789' } };
const FORBIDDEN = ['down', 'rm', 'prune', 'kill', '-v', '--volumes', '--rmi', 'system', 'volume'];

test('validateDocker: exec services and compose files, nothing else', () => {
  assert.deepEqual(K.validateDocker({ exec: ['api', 'api', 'web'], files: ['docker-compose.yml'] }), { value: { exec: ['api', 'web'], files: ['docker-compose.yml'] }, errors: null });
  assert.deepEqual(K.validateDocker(undefined), { value: null, errors: null });
  for (const bad of [[], 'api', { exec: 'api' }, { exec: ['-x'] }, { exec: ['a b'] }, { files: ['-f'] }, { socket: true }]) assert.ok(K.validateDocker(bad).errors, JSON.stringify(bad));
});

test('argvFor: a closed list of verbs; never down, rm, prune, kill or a volume flag', () => {
  const e = { docker: { files: ['a.yml', 'b.yml'] } };
  assert.deepEqual(K.argvFor('status', { environment: e }), ['compose', '-f', 'a.yml', '-f', 'b.yml', 'ps', '--all', '--format', 'json']);
  assert.deepEqual(K.argvFor('build', { service: 'web' }), ['compose', 'up', '-d', '--build', '--no-deps', 'web']);
  assert.deepEqual(K.argvFor('logs', { service: 'api', follow: true }), ['compose', 'logs', '--no-color', '--timestamps', '--tail', '200', '--follow', 'api']);
  assert.deepEqual(K.argvFor('exec', { service: 'api', words: ['npm', 'run', 'seed'] }), ['compose', 'exec', '-T', 'api', 'npm', 'run', 'seed']);
  for (const v of ['services', 'status', 'logs', 'restart', 'stop', 'build']) for (const follow of [false, true]) {
    const a = K.argvFor(v, { service: 'api', follow }); for (const w of FORBIDDEN) assert.ok(!a.includes(w), `${v} carries ${w}`);
  }
  for (const v of ['down', 'rm', 'prune', 'kill']) assert.throws(() => K.argvFor(v, { service: 'api' }));
  const src = readFileSync(path.join(HERE, '..', 'lib', 'docker.mjs'), 'utf8');
  for (const w of ["'down'", "'rm'", "'prune'", "'-v'", "'--volumes'", "'kill'"]) assert.ok(!src.includes(w), `lib/docker.mjs names ${w}`);
});

test('parsePs: NDJSON and a JSON array, ports deduplicated, long lines intact', () => {
  const nd = execFileSync(NODE, [FAKE, 'compose', 'ps', '--all', '--format', 'json'], { env: env() }).toString();
  const arr = execFileSync(NODE, [FAKE, 'compose', 'ps', '--all', '--format', 'json'], { env: env({ FAKE_DOCKER_PS: 'array' }) }).toString();
  const a = K.parsePs(nd); assert.deepEqual(K.parsePs(arr), a);
  assert.deepEqual(a.map((s) => s.service), ['api', 'mysql', 'redis', 'student', 'web']);
  assert.deepEqual(a[0], { service: 'api', container: 'aq-api-1', state: 'running', health: 'healthy', status: 'Up 2 minutes (healthy)', ports: [{ host: 3050, container: 3000, protocol: 'tcp' }] });
  assert.deepEqual(a[1].ports, [], 'an unpublished port is not listed'); assert.deepEqual(a[4].ports, [{ host: 8080, container: 80, protocol: 'tcp' }], 'the older Ports string');
  assert.equal(a[3].state, 'exited'); assert.deepEqual(K.parsePs(''), []);
});

test('services(): the compose read in its folder with the declared env; Docker absent or stopped, no compose: one clear sentence', async () => {
  const r = await K.services({ environment, project, env: env() });
  assert.equal(r.services.length, 5); assert.equal(calls().at(-1).cwd, project); assert.equal(calls().at(-1).lan, '192.0.2.10');
  assert.deepEqual(await K.services({ environment, project, env: env({ ESCADRILLE_DOCKER: '/nonexistent/docker' }) }), { error: K.NO_DOCKER });
  assert.deepEqual(await K.services({ environment, project, env: env({ FAKE_DOCKER_MODE: 'daemon' }) }), { error: K.DAEMON_DOWN });
  assert.match((await K.services({ environment, project, env: env({ FAKE_DOCKER_MODE: 'nocompose' }) })).error, /^Aucun docker-compose dans /);
  assert.match((await K.services({ environment: null, project, env: env() })).error, /environnement non réglé/);
});

test('act(): restart, stop and build of a named service of the compose only; anything else refused before any command', async () => {
  for (const action of ['restart', 'stop', 'build']) { const r = await K.act({ action, service: 'web', environment, project, env: env() }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.code, 0); assert.ok(r.lines.length); }
  const tail = calls().slice(-2).map((c) => c.args); assert.deepEqual(tail, [['compose', 'config', '--services'], ['compose', 'up', '-d', '--build', '--no-deps', 'web']]);
  const n = calls().length;
  assert.match((await K.act({ action: 'restart', service: 'ghost', environment, project, env: env() })).error, /ghost n’est pas un service du compose \(api, mysql, redis, student, web\)/);
  assert.equal(calls().length, n + 1, 'only config --services ran');
  for (const service of ['-v', 'api;rm', '', null, 'a b']) assert.ok((await K.act({ action: 'restart', service, environment, project, env: env() })).error, String(service));
  assert.equal(calls().length, n + 1, 'a malformed name runs nothing');
  for (const action of ['down', 'rm', 'exec', 'prune']) assert.match((await K.act({ action, service: 'api', environment, project, env: env() })).error, /action refusée/);
  assert.equal(calls().length, n + 1);
  assert.equal((await K.act({ action: 'restart', service: 'api', environment, project, env: env({ FAKE_DOCKER_MODE: 'daemon' }) })).error, K.DAEMON_DOWN);
});

test('parseDocker: lines alone, verbs and services, unique, four at most, in the text and the state block', () => {
  const t = 'Je regarde.\nDOCKER: status\n- DOCKER: logs api\nDOCKER: exec api npm run seed -- --replace\nDOCKER: status\npas DOCKER: restart web\nDOCKER: restart web';
  assert.deepEqual(K.parseDocker(t, { claude: 'DOCKER: logs mysql' }), [{ verb: 'status', service: null, words: [] }, { verb: 'logs', service: 'api', words: [] }, { verb: 'exec', service: 'api', words: ['npm', 'run', 'seed', '--', '--replace'] }, { verb: 'restart', service: 'web', words: [] }]);
  assert.deepEqual(K.parseDocker('rien', null), []);
});

test('sessionRun: status, logs, restart, exec; stop, build and the rest refused; exec only where declared; 60 lines, masked', async () => {
  const o = { environment, accounts, project, env: env() };
  const st = await K.sessionRun({ verb: 'status', ...o });
  assert.match(K.dockerNote(st, { verb: 'status' }), /^DOCKER status : 5 services · api en marche \(sain\) :3050, mysql en marche \(sain\), redis en marche, student arrêté, web en marche :8080$/);
  const lg = await K.sessionRun({ verb: 'logs', service: 'api', ...o });
  assert.equal(lg.lines.length, 60); const note = K.dockerNote(lg, { verb: 'logs', service: 'api' });
  assert.match(note, /^DOCKER logs api : 60 dernières lignes\n  │ /);
  assert.ok(note.includes('DB_PASSWORD=•••') && note.includes('Bearer •••') && note.includes('mysql://•••@mysql/db'), note.split('\n').at(-1));
  assert.ok(!/hunter22|abcdef123456|s3cret/.test(note));
  assert.match(K.dockerNote(await K.sessionRun({ verb: 'restart', service: 'api', ...o }), { verb: 'restart', service: 'api' }), /^DOCKER restart api : redémarré \(code 0\)/);
  const ex = await K.sessionRun({ verb: 'exec', service: 'api', words: ['npm', 'run', '$(id)', ';', 'pw-prof-789'], ...o });
  assert.equal(ex.code, 0); assert.deepEqual(calls().at(-1).args, ['compose', 'exec', '-T', 'api', 'npm', 'run', '$(id)', ';', 'pw-prof-789'], 'no shell: the words arrive as they are');
  const exNote = K.dockerNote(ex, { verb: 'exec', service: 'api' });
  assert.ok(exNote.includes('API_SECRET=•••') && !exNote.includes('topsecret99') && !exNote.includes('pw-prof-789'), exNote);
  const n = calls().length;
  assert.match((await K.sessionRun({ verb: 'exec', service: 'mysql', words: ['mysql'], ...o })).error, /exec refusé : mysql n’est pas déclaré exec-permis/);
  assert.match((await K.sessionRun({ verb: 'exec', service: 'api', words: ['--privileged'], ...o })).error, /commence par un programme/);
  assert.match((await K.sessionRun({ verb: 'exec', service: 'api', words: [], ...o })).error, /la commande manque/);
  for (const verb of ['stop', 'build', 'down', 'rm', 'prune', 'run']) assert.equal(K.dockerNote(await K.sessionRun({ verb, service: 'api', ...o }), { verb, service: 'api' }), 'DOCKER : verbe refusé (status, logs, restart, exec).');
  assert.equal(calls().length, n, 'nothing ran');
  assert.equal(K.dockerNote(await K.sessionRun({ verb: 'status', ...o, env: env({ FAKE_DOCKER_MODE: 'daemon' }) }), { verb: 'status' }), `DOCKER status : ${K.DAEMON_DOWN}`);
  const failed = await K.sessionRun({ verb: 'exec', service: 'api', words: ['false'], ...o }); assert.match(K.dockerNote(failed, { verb: 'exec', service: 'api' }), /^DOCKER exec api : code 3/);
});

test('streamLogs: 200 lines then the flow, masked; stop() kills the docker CLI', async () => {
  const got = []; let end = null;
  const stop = await K.streamLogs({ service: 'api', environment, accounts, project, env: env(), onLine: (l) => got.push(l), onEnd: (r) => { end = r; } });
  await until(() => got.length >= 203);
  assert.match(got[0], /line 101$/); assert.match(got[199], /line 300 DB_PASSWORD=•••/); assert.match(got[200], /live 1$/);
  stop(); await until(() => end); assert.ok(end.code !== 0 || end.code === null);
  let e2 = null; await K.streamLogs({ service: 'ghost', environment, project, env: env(), onLine: () => {}, onEnd: (r) => { e2 = r; } }); assert.match(e2.error, /n’est pas un service/);
});

test('createQueue: one command at a time per project, busy by session', async () => {
  const q = K.createQueue(); let running = 0; let max = 0; const job = () => async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 20)); running--; return { ok: true }; };
  const all = [q.push('P', job(), { planId: 'p', sid: 'A' }), q.push('P', job(), { planId: 'p', sid: 'B' }), q.push('Q', job())];
  assert.equal(q.busy('p', 'A'), true); await Promise.all(all); assert.equal(max, 2, 'two projects in parallel, one at a time each'); assert.equal(q.busy('p', 'A'), false);
});

test('createDocker.handle: 403 without the cookie; services, the click logged, SSE logs closed with the tab', async () => {
  const logged = [];
  const d = K.createDocker({ environmentOf: () => environment, accountsOf: () => accounts, guardOk: (k) => k === 'good', record: (r) => logged.push(r), env: env() });
  const srv = createServer((req, res) => { const url = new URL(req.url, 'http://x'); d.handle(req, res, url, { guardKey: req.headers['x-k'] || null }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/docker`;
  assert.equal((await fetch(base + '?project=' + project)).status, 403);
  assert.equal((await fetch(base + '/action', { method: 'POST', body: JSON.stringify({ project, service: 'api', action: 'restart' }) })).status, 403);
  const s = await (await fetch(base + '?project=' + project, { headers: { 'x-k': 'good' } })).json(); assert.equal(s.services.length, 5);
  const a = await (await fetch(base + '/action', { method: 'POST', headers: { 'x-k': 'good' }, body: JSON.stringify({ project, service: 'api', action: 'stop' }) })).json();
  assert.equal(a.ok, true); assert.deepEqual(logged, [{ kind: 'note', project, text: 'Docker stop api (développeur) : ok' }]);
  const ctl = new AbortController(); const r = await fetch(base + '/logs?service=api&project=' + project, { headers: { 'x-k': 'good' }, signal: ctl.signal });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader(); let txt = ''; while (!txt.includes('live 1')) txt += new TextDecoder().decode((await reader.read()).value);
  assert.equal(txt.split('data: ').length - 1 >= 201, true); ctl.abort();
  const before = calls().length; await new Promise((res) => setTimeout(res, 200));
  const bad = await fetch(base + '/logs?service=ghost&project=' + project, { headers: { 'x-k': 'good' } }); assert.match(await bad.text(), /event: end\ndata: .*n’est pas un service/);
  assert.ok(calls().length >= before);
});

// ---------------------------------------------------------------- against the server
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = (name) => { const root = tmp(name); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };

test('the server: the docker setting by the cookie, the routes behind it, the click in the pilot’s log, a session’s DOCKER: lines answered and resumed', async () => {
  const turns = [{ stops: [0], claude: 'Premier arrêt' }, { stops: [0], claude: 'Je continue', prose: 'Je regarde.\nDOCKER: status\nDOCKER: exec api npm run seed\nDOCKER: exec mysql mysql\nDOCKER: stop api' }, { stops: [0, 1], claude: 'Fini', done: true }];
  const fake = fakeClaude(); const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`; const empty = tmp('docker-none-'); const guardDir = tmp('docker-guard-');
  const proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...env(), PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('docker-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('docker-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_GUARD_DIR: guardDir, ESCADRILLE_SECRETS: path.join(tmp('docker-sec-'), 'secrets.json'), ESCADRILLE_TESTBOX: path.join(HERE, 'fake-box.sh'), FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc); let err = ''; proc.stderr.on('data', (x) => { err += x; });
  const get = async (p, h = {}) => (await fetch(base + p, { headers: h })).json();
  const post = async (p, body, h = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  await until(async () => { try { await get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + err); });
  const cookie = { cookie: 'escadrille_guard=' + readFileSync(path.join(guardDir, 'guard-key'), 'utf8').trim() };
  const root = repo('docker-root-');
  // the setting keeps environment.docker; a bad one is refused
  assert.equal((await post('/api/project/settings', { project: root, environment: { commands: {}, docker: { exec: ['-x'] } } }, cookie)).status, 400);
  let r = await post('/api/project/settings', { project: root, environment: { commands: {}, docker: { exec: ['api'] } } }, cookie); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.settings.environment.docker, { exec: ['api'], files: [] });
  // the developer's routes: 403 without the cookie (a session on 127.0.0.1), 200 with it; the click goes to the pilot's log
  assert.equal((await fetch(base + '/api/docker?project=' + encodeURIComponent(root))).status, 403);
  assert.equal((await post('/api/docker/action', { project: root, service: 'api', action: 'restart' })).status, 403);
  assert.equal((await get('/api/docker?project=' + encodeURIComponent(root), cookie)).services.length, 5);
  r = await post('/api/docker/action', { project: root, service: 'api', action: 'restart' }, cookie); assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal((await post('/api/docker/action', { project: root, service: 'api', action: 'down' }, cookie)).body.ok, false);
  // a session: its DOCKER: lines run, the refusals said, the session resumed alone with the lines at the head
  const plan = { id: 'dk', title: 'dk', project: root, sessions: [{ id: 'A', name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['Premier', 'Fin'] }] };
  assert.equal((await post('/api/plan', plan)).status, 200); await post('/api/launch', { plan: 'dk' });
  await until(async () => (await get('/api/plan/dk')).state.find((x) => x.id === 'A').status === 'waiting');
  await post('/api/plan/dk/session/A/message', { text: 'Va.' });
  const prompts = () => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  const resumed = (await until(() => prompts().find((p) => /Docker a répondu : reprends/.test(p.text)), 30000)).text;
  const lines = resumed.split('\n').filter((l) => /^\[système\] DOCKER/.test(l));
  assert.equal(lines.length, 4, resumed);
  assert.match(lines[0], /^\[système\] DOCKER status : 5 services · api en marche \(sain\) :3050/);
  assert.match(lines[1], /^\[système\] DOCKER exec api : code 0$/);
  assert.match(lines[2], /exec refusé : mysql n’est pas déclaré exec-permis/);
  assert.equal(lines[3], '[système] DOCKER : verbe refusé (status, logs, restart, exec).');
  assert.ok(resumed.includes('API_SECRET=•••') && !resumed.includes('topsecret99'));
  assert.ok(calls().some((c) => c.args.join(' ') === 'compose exec -T api npm run seed'));
  // every gesture in the pilot's log
  const log = await get('/api/pilot/log?project=' + encodeURIComponent(root));
  const texts = log.actions.map((a) => a.text);
  assert.ok(texts.some((t) => t === 'Docker restart api (développeur) : ok'), texts.join('\n'));
  assert.ok(texts.some((t) => /^Docker exec api `npm run seed` \(session A\) : ok$/.test(t)), texts.join('\n'));
  assert.ok(texts.some((t) => /^Docker stop api \(session A\) : verbe refusé/.test(t)), texts.join('\n'));
  // the consigne carries the DOCKER: sentence
  assert.ok(prompts().some((p) => p.text.includes('DOCKER: restart <service>')), 'the instruction of every session says DOCKER:');
  // and the test rules (CONS, 6 November), under the name calmdev
  const consigne = prompts().find((p) => p.text.includes('## Suivi, obligatoire'))?.text || '';
  assert.match(consigne, /Tu es lancée par calmdev/); assert.doesNotMatch(consigne, /lancée par Escadrille|API d'Escadrille/);
  for (const rule of ['env -i, env -u ou testEnv', '.calmdev/<nom>.out', 'deux extractions au plus', '/bin en tête du PATH', 'Ni rm -rf, ni sed -i', 'Pas de $TMPDIR', 'se réutilise', '« dernière »']) assert.ok(consigne.includes(rule), rule);
});
