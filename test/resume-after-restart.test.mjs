// A session in the middle of a turn when the server is killed (SIGKILL: no shutdown, nothing written at the end) comes back
// on its own when the server starts again on the same database: running again, resumed with --resume and the resume
// message, and one more turn lands in its flow, without a click. test/robustness.test.mjs covers the clean stop (SIGINT);
// this one is the crash. Fake claude, a free port, the database and every folder in mkdtemp, the gate open explicitly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 100)); } };
const procs = []; after(() => { for (const p of procs) p.kill('SIGKILL'); });

const RESUME_TEXT = 'Le serveur a redémarré pendant ton tour ; reprends où tu en étais, puis finis par ton bloc calmdev:state.';
// every process of the fake plays this turn first: it holds 5 s, long enough for the kill to fall in the middle of it
const TURNS = [{ hold: 5000, stops: [0], claude: 'Tour fini', prose: 'Le tour est fait.' }, { stops: [0, 1], claude: 'Fini', done: true }];

const repo = () => {
  const root = tmp('escadrille-resume-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root;
};
const boot = (files) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: files.db, ESCADRILLE_PLANS: files.plans, ESCADRILLE_CLAUDE: files.fake.file, ESCADRILLE_TRANSCRIPTS: files.empty, ESCADRILLE_SESSIONS: files.empty, FAKE_CLAUDE_TURNS: JSON.stringify(TURNS) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  const S = { proc, get: async (p) => (await fetch(base + p)).json(), post: async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).status };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async () => (await S.get('/api/plan/reprise')).state.find((x) => x.id === 'A');
  S.messages = async () => (await S.get('/api/plan/reprise/session/A/messages')).messages;
  return S;
};

test('a session killed with the server in the middle of a turn runs again after the restart, and one more turn lands in its flow', async () => {
  const files = { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  const prompts = () => { try { return readFileSync(path.join(files.fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  const claudeSaid = async (S) => (await S.messages()).filter((m) => m.role === 'claude' && /Le tour est fait/.test(m.text)).length;

  const S1 = boot(files); await S1.ready();
  assert.equal(await S1.post('/api/plan', { id: 'reprise', title: 'Reprise', sessions: [{ id: 'A', name: 'Seule', path: repo(), model: 'claude-sonnet-5-5', prompt: 'Écris.', budget: 1, stops: ['Le tour', 'Fin'] }] }), 200);
  assert.equal(await S1.post('/api/launch', { plan: 'reprise' }), 200);
  // the turn is under way: the fake got the prompt, the session runs and holds its Claude session id
  await until(async () => prompts().length === 1 && (await S1.session())?.status === 'running' && (await S1.session()).sessionId);
  assert.equal(await claudeSaid(S1), 0, 'killed before the turn ends');
  S1.proc.kill('SIGKILL'); await new Promise((r) => S1.proc.once('exit', r));

  const S2 = boot(files); await S2.ready();
  // resumed alone: the second prompt is the server's own resume message, on the same Claude session
  await until(() => prompts().length >= 2);
  const resumed = prompts()[1];
  assert.equal(resumed.text, RESUME_TEXT, 'nobody wrote: the server resumed the turn');
  assert.equal(resumed.session_id, prompts()[0].session_id, 'the same Claude session, by --resume');
  const A = await S2.session();
  assert.equal(A.status, 'running', 'running again after the restart');
  assert.ok(A.pending.some((p) => p.kind === 'info' && p.text === 'Reprise seule après redémarrage'));
  // one more turn lands in its flow, then the session stops at its stop and waits for the developer
  await until(async () => (await claudeSaid(S2)) >= 1);
  await until(async () => (await S2.session()).status === 'waiting');
  assert.equal(prompts().length, 2, 'resumed once, not twice');
});
