// The merge on green tests, alone (phase 10, session A; docs/autonomy.md, « Fusion si tests verts »): lib/testbox.mjs
// alone (the profile, the failing files, the dry merge, the rerun of a file that failed under load), then the server
// against a fake claude: a green merge without a click, a red told once to its session then to the developer, a
// merge of the server's own code that exits with 75 and the sessions taken back by the next start, and run.sh that
// starts the server again on 75. The server's tests run inside a session sandbox where Seatbelt cannot nest: they use
// test/fake-box.sh; the real box is tried when this Mac can apply one.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import * as TB from '../lib/testbox.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const BOX = path.join(HERE, 'fake-box.sh');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-am-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const branch = (root, name, files) => { sh(root, ['checkout', '-qb', name]); for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), c); } sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'branch ' + name]); sh(root, ['checkout', '-q', 'main']); };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

// ---------------------------------------------------------------- lib/testbox.mjs alone
test('the box: no network but localhost, writes held to its folders, the keys unreadable; ESCADRILLE_TESTBOX', () => {
  const p = TB.seatbeltProfile({ writable: ['/w/t', '/w/g'] });
  assert.match(p, /\(deny network\*\)/); assert.match(p, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.match(p, /\(deny file-write\*\)\n\(allow file-write\* \(subpath "\/w\/t"\) \(subpath "\/w\/g"\)/);
  assert.ok(p.includes(`(subpath "${path.join(homedir(), '.ssh')}")`), 'the keys of a session are unreadable here too');
  assert.equal(TB.boxCommand({ cmd: 'true', writable: [], box: 'none' }), null, 'none: no box, the click stays');
  assert.deepEqual(TB.boxCommand({ cmd: 'x', writable: [], box: '/b' }), { file: '/b', args: ['sh', '-c', 'x'] });
  assert.equal(TB.boxCommand({ cmd: 'x', writable: [], platform: 'darwin', box: '' }).file, '/usr/bin/sandbox-exec');
  assert.ok(TB.boxCommand({ cmd: 'x', writable: ['/w'], platform: 'linux', box: '' }).args.includes('--unshare-net'));
  assert.equal(TB.boxCommand({ cmd: 'x', writable: [], platform: 'win32', box: '' }), null);
  assert.equal(TB.shortPath().split(':')[0], path.dirname(NODE)); assert.ok(TB.shortPath().endsWith('/usr/bin:/bin:/usr/sbin:/sbin'));
});

test('the failing files of node --test (TAP and spec), the rerun of one file, the summary sent to the session', () => {
  const tap = "# Subtest: ok\nok 1 - ok\n# Subtest: boom\nnot ok 2 - boom\n  ---\n  location: '/r/wt/test/b.test.mjs:1:30'\n  error: 'x'\n  ...\nnot ok 3 - /r/wt/test/c.test.mjs\n  ---\n  location: '/r/wt/test/c.test.mjs:1:1'\n  ...\n# fail 2\n";
  assert.deepEqual(TB.failingFiles(tap, '/r/wt'), ['test/b.test.mjs', 'test/c.test.mjs']);
  assert.deepEqual(TB.failingFiles('✖ boom (1ms)\n  test at test/d.test.mjs:4:1\n'), ['test/d.test.mjs']);
  assert.equal(TB.rerunCommand('node --test test/*.test.mjs', 'test/b.test.mjs'), 'node --test test/b.test.mjs');
  assert.equal(TB.rerunCommand('npm test', 'x'), null, 'no glob: the whole command again');
  const s = TB.failureSummary(tap); assert.match(s, /not ok 2 - boom/); assert.match(s, /error: 'x'/);
});

const verify = (root, name, cmd) => TB.verifyMerge({ root, branch: name, cmd, box: BOX, timeoutMs: 60000 });
test('the dry merge: green, red, a file that fails under load run again alone, a conflict; main never moves', async () => {
  const root = repo(); const head = sh(root, ['rev-parse', 'HEAD']);
  branch(root, 'vert', { 'src/x.txt': 'x\n' });
  const g = await verify(root, 'vert', 'test -f src/x.txt && test -f a.txt'); assert.equal(g.code, 0, g.out);
  const r = await verify(root, 'vert', 'echo cassé; exit 3'); assert.equal(r.code, 3); assert.match(r.out, /cassé/);
  // A test file that fails the first time (the suite under load) and passes alone
  const flaky = `import test from 'node:test'; import fs from 'node:fs';\ntest('under load', () => { if (!fs.existsSync('.ran')) { fs.writeFileSync('.ran', '1'); throw new Error('timeout under load'); } });\n`;
  branch(root, 'charge', { 't/a.test.mjs': "import test from 'node:test'; test('ok', () => {});\n", 't/b.test.mjs': flaky });
  const f = await verify(root, 'charge', `"${NODE}" --test t/*.test.mjs`); assert.equal(f.code, 0, f.out); assert.deepEqual(f.flaky, ['t/b.test.mjs']);
  const red = `import test from 'node:test'; test('always', () => { throw new Error('vraiment rouge'); });\n`;
  branch(root, 'rouge', { 't/a.test.mjs': "import test from 'node:test'; test('ok', () => {});\n", 't/b.test.mjs': red });
  const rr = await verify(root, 'rouge', `"${NODE}" --test t/*.test.mjs`); assert.notEqual(rr.code, 0); assert.deepEqual(rr.failed, ['t/b.test.mjs']);
  sh(root, ['checkout', '-qb', 'conf']); writeFileSync(path.join(root, 'a.txt'), 'branche\n'); sh(root, ['commit', '-qam', 'b']); sh(root, ['checkout', '-q', 'main']);
  writeFileSync(path.join(root, 'a.txt'), 'main\n'); sh(root, ['commit', '-qam', 'main']); const head2 = sh(root, ['rev-parse', 'HEAD']);
  assert.deepEqual(await verify(root, 'conf', 'true'), { conflict: true, files: ['a.txt'] });
  assert.equal(sh(root, ['rev-parse', 'HEAD']), head2, 'main untouched'); assert.notEqual(head, head2);
  assert.equal(sh(root, ['worktree', 'list']).split('\n').length, 1, 'the verification worktrees are gone');
});

// The real box, where this Mac can apply one (outside a session's sandbox): a write outside its folders is refused
const canBox = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
test('the real Seatbelt box: green inside, a write in the home folder refused', { skip: canBox ? false : 'Seatbelt cannot nest inside a session sandbox: runs on the Mac' }, async () => {
  const root = repo(); branch(root, 'b', { 'b.txt': 'b\n' });
  assert.equal((await TB.verifyMerge({ root, branch: 'b', cmd: 'test -f b.txt && echo ok > out.txt && git status --short' })).code, 0);
  const probe = path.join(homedir(), `escadrille-box-probe-${process.pid}`);
  const r = await TB.verifyMerge({ root, branch: 'b', cmd: `touch '${probe}' || exit 9` }); assert.equal(r.code, 9, r.out); assert.equal(existsSync(probe), false);
});

// ---------------------------------------------------------------- the server
// A fake claude by session (the worktree folder ends with -<id>): FAKE_ACTS = { A: [{ write?, done? }, …] }, turn k
// plays act k (the last one after); every prompt lands in prompts.jsonl, every launch in launches.jsonl
const actClaude = () => {
  const dir = tmp('escadrille-amc-'); const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const DIR = ${JSON.stringify(dir)}; const argv = process.argv.slice(2);
const me = /-([A-Z])$/.exec(process.cwd())[1]; const acts = JSON.parse(process.env.FAKE_ACTS)[me];
const SID = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : 'am-' + me + '-' + Date.now();
fs.appendFileSync(path.join(DIR, 'launches.jsonl'), JSON.stringify({ session: me, resume: argv.includes('--resume') }) + '\\n');
const out = (o) => console.log(JSON.stringify(o)); out({ type: 'system', subtype: 'init', session_id: SID });
let n = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); if (m.type !== 'user') return; n++;
  fs.appendFileSync(path.join(DIR, 'prompts.jsonl'), JSON.stringify({ session: me, text: String(m.message.content) }) + '\\n');
  const a = acts[Math.min(n, acts.length) - 1];
  if (a.write) { fs.mkdirSync(path.dirname(a.write), { recursive: true }); fs.writeFileSync(a.write, 'tour ' + n + '\\n'); cp.execFileSync('git', ['add', '.']); cp.execFileSync('git', ['commit', '-qm', 'turn ' + n]); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tour ' + n + '\\n\\n\`\`\`escadrille:state\\n' + JSON.stringify({ stops: a.done ? [0] : [], health: 'ok', why: '', claude: 'Tour ' + n, done: !!a.done }) + '\\n\`\`\`' }] } });
  out({ type: 'result', subtype: 'success', num_turns: n, total_cost_usd: 0.01 * n, usage: { input_tokens: 2, output_tokens: 5 } });
});
`); chmodSync(file, 0o755);
  const read = (f) => { try { return readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, file, prompts: () => read('prompts.jsonl'), launches: () => read('launches.jsonl') };
};
const boot = (acts, env = {}, from = null) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = from ? { ...from } : { fake: actClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  S.proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_TESTBOX: BOX, FAKE_ACTS: JSON.stringify(acts), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.out = ''; S.proc.stderr.on('data', (d) => { S.err += d; }); S.proc.stdout.on('data', (d) => { S.out += d; });
  S.exited = new Promise((resolve) => S.proc.on('exit', (code) => resolve(code)));
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + S.err); });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.messages = async (plan, id) => (await S.get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  S.stop = () => { S.proc.kill('SIGINT'); return S.exited; };
  return S;
};
const sess = (root, id) => ({ id, name: 'Session ' + id, path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['La fin'] });
const autoPlan = async (S, root, id, cmd, ids = ['A']) => {
  const autonomy = { mode: 'autonome', autoMergeIfGreen: true, testCommand: cmd };
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy })).status, 200);
  const r = await S.post('/api/plan', { id, title: id, autonomy, sessions: ids.map((x) => sess(root, x)) }); assert.equal(r.status, 200, JSON.stringify(r.body));
  await S.post('/api/launch', { plan: id });
};

test('a green merge: the finished session is merged alone, its tests run boxed on the branch merged dry, no click', async () => {
  const S = boot({ A: [{ write: 'src/x.txt', done: true }] }); await S.ready();
  const root = repo(); await autoPlan(S, root, 'vert', 'test -f src/x.txt');
  const A = await until(async () => { const s = await S.session('vert', 'A'); return s.worktree?.merged ? s : null; });
  assert.ok(!A.pending.some((p) => p.kind === 'run-tests'), 'no click asked');
  assert.equal(sh(root, ['show', 'HEAD:src/x.txt']), 'tour 1');
  const msgs = (await S.messages('vert', 'A')).map((m) => m.text);
  assert.ok(msgs.includes('Tests de la branche fusionnée à blanc, dans un bac à sable : test -f src/x.txt'));
  assert.ok(msgs.some((t) => /^Tests : code 0/.test(t)));
  await S.stop();
});

test('a red merge: the session gets the failures and resumes once; red again, the developer is told; nothing merged', async () => {
  const S = boot({ A: [{ write: 'src/x.txt', done: true }, { write: 'src/y.txt', done: true }] }); await S.ready();
  const root = repo(); const head = sh(root, ['rev-parse', 'HEAD']);
  await autoPlan(S, root, 'rouge', 'echo "not ok 1 - cassé"; exit 3');
  const told = await until(() => S.fake.prompts().find((p) => p.session === 'A' && /sont rouges/.test(p.text)));
  assert.match(told.text, /code 3/); assert.match(told.text, /not ok 1 - cassé/);
  const A = await until(async () => { const s = await S.session('rouge', 'A'); return s.pending.find((p) => p.kind === 'alert' && p.what === 'tests') ? s : null; });
  assert.match(A.pending.find((p) => p.what === 'tests').text, /encore rouges après une reprise \(code 3\)/);
  assert.equal(A.worktree.merged, false); assert.equal(sh(root, ['rev-parse', 'main']), head, 'main never moved');
  assert.equal(S.fake.prompts().filter((p) => /sont rouges/.test(p.text)).length, 1, 'told once');
  await S.stop();
});

test('a merge of the server\'s own code: the server saves, exits with 75, and its next start takes the sessions back', async () => {
  const root = repo();
  const acts = { A: [{ write: 'lib/x.mjs', done: true }], B: [{ done: false }] };
  const env = { ESCADRILLE_SUPERVISED: '1', ESCADRILLE_SELF_ROOT: root, ESCADRILLE_RESTART_WAIT_MS: '20000' };
  const S = boot(acts, env); await S.ready();
  await autoPlan(S, root, 'soi', 'true', ['A', 'B']);
  assert.equal(await S.exited, 75, S.out + S.err);
  assert.match(S.out, /restart: a merge touched lib\/x\.mjs/);
  assert.equal(sh(root, ['show', 'HEAD:lib/x.mjs']), 'tour 1');
  // run.sh starts it again: the same base, the same plans
  const launched = S.fake.launches().length;
  const S2 = boot(acts, env, S); await S2.ready();
  const A = await S2.session('soi', 'A'); assert.equal(A.worktree.merged, true); assert.equal(A.status, 'done');
  assert.ok((await S2.messages('soi', 'A')).some((m) => /Fusion du code du serveur \(lib\/x\.mjs\)/.test(m.text)));
  await until(() => S2.fake.launches().slice(launched).some((l) => l.session === 'B' && l.resume), 20000);
  await S2.stop();
});

test('a merge of the server\'s own code with no supervisor: no exit, an entry asks for the restart', async () => {
  const root = repo();
  // no supervisor said explicitly: a suite run by a session of the supervised server inherits ESCADRILLE_SUPERVISED=1
  const S = boot({ A: [{ write: 'server.mjs', done: true }] }, { ESCADRILLE_SELF_ROOT: root, ESCADRILLE_SUPERVISED: '' }); await S.ready();
  await autoPlan(S, root, 'main', 'true');
  const A = await until(async () => { const s = await S.session('main', 'A'); return s.pending.find((p) => p.kind === 'info' && /relance-le/.test(p.text)) ? s : null; });
  assert.equal(A.worktree.merged, true); assert.equal(S.proc.exitCode, null, 'still up');
  await S.stop();
});

test('run.sh: the server started again when it exits with 75, run.sh ends with any other code', () => {
  const dir = tmp('escadrille-run-'); const bin = path.join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec "${NODE}" "$@"\n`); chmodSync(path.join(bin, 'node'), 0o755);
  const entry = path.join(dir, 'entry.mjs'); const count = path.join(dir, 'count');
  writeFileSync(entry, `import fs from 'node:fs'; const n = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')) : 0) + 1; fs.writeFileSync(${JSON.stringify(count)}, String(n)); console.log('run ' + n + ' ' + process.env.ESCADRILLE_SUPERVISED); process.exit(n < 3 ? 75 : 4);\n`);
  const r = spawnSync('/bin/sh', [path.join(HERE, '..', 'run.sh')], { env: { PATH: `${bin}:/usr/bin:/bin`, ESCADRILLE_ENTRY: entry }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 4, r.stdout + r.stderr); assert.equal(readFileSync(count, 'utf8'), '3');
  assert.match(r.stdout, /run 1 1\n[\s\S]*run 3 1/); assert.equal(r.stdout.match(/restart after a merge of its own code/g).length, 2);
});

test('the test box keeps the shared git folder\'s hooks, config and refs read-only (a hook would run later outside any box)', async () => {
  const { seatbeltProfile } = await import('../lib/testbox.mjs');
  const p = seatbeltProfile({ writable: ['/r/.git', '/tmp/x'], readOnly: ['/r/.git/hooks', '/r/.git/config'] });
  const allow = p.indexOf('(allow file-write*'); const deny = p.indexOf('(deny file-write* (subpath "/r/.git/hooks")');
  assert.ok(allow > 0 && deny > allow, 'the deny comes after the allow, so it wins');
  assert.ok(p.includes('(subpath "/r/.git/config")'));
});
