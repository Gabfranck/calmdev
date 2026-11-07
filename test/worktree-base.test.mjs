// The worktree of a session starts from plan.base, not from the branch open in the repository at launch (2026-11-02:
// a plan based on main created its worktree from dev, the branch open then; backlog l. 57). On throwaway repositories.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { create } from '../lib/worktree.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
// main has one commit, dev one more, and dev is the branch open
const repo = () => {
  const root = tmp('escadrille-wtbase-');
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  sh(root, ['checkout', '-qb', 'dev']); writeFileSync(path.join(root, 'dev.txt'), 'dev\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'dev only']);
  return root;
};
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 120)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

test('create starts from the given base, records it, and keeps the open branch when none is given', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p', session: 'A', path: root, base: 'main' });
  assert.equal(sh(w.path, ['rev-parse', 'HEAD']), sh(root, ['rev-parse', 'main']), 'the worktree starts from main, not dev');
  assert.equal(w.base, 'main');
  const d = await create({ root, plan: 'p', session: 'B', path: root });
  assert.equal(sh(d.path, ['rev-parse', 'HEAD']), sh(root, ['rev-parse', 'dev']), 'no base: the branch open, as before');
  assert.equal(d.base, 'dev');
});

test('create refuses a base that does not exist, and creates nothing', async () => {
  const root = repo();
  await assert.rejects(create({ root, plan: 'p', session: 'C', path: root, base: 'nope' }), /base « nope » introuvable/);
  assert.equal(sh(root, ['branch', '--list', 'calmdev/p/C']), '','no branch left behind');
});

test('the launch: the worktree of a plan based on main starts from main while dev is open; a missing base is a clear error', async () => {
  const PORT = freePort(); const url = `http://127.0.0.1:${PORT}`; const fake = fakeClaude(); const empty = tmp('escadrille-none-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_TESTBOX: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(proc); let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const get = async (p) => (await fetch(url + p)).json();
  const post = async (p, body) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  await until(async () => { try { await get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + err); });
  const root = repo();
  const session = (id) => ({ id, name: id, path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 1 });
  assert.equal((await post('/api/plan', { id: 'surmain', title: 'Sur main', base: 'main', sessions: [session('A')] })).status, 200);
  assert.equal((await post('/api/launch', { plan: 'surmain', session: 'A' })).status, 200);
  const A = await until(async () => (await get('/api/plan/surmain')).state.find((s) => s.id === 'A' && s.worktree));
  assert.equal(A.worktree.base, 'main', 'wt.base is the base really used');
  assert.ok(!existsSync(path.join(A.worktree.path, 'dev.txt')), 'no commit of dev in the worktree');
  assert.equal(sh(A.worktree.path, ['merge-base', 'HEAD', 'dev']), sh(root, ['rev-parse', 'main']), 'the branch forks from main');
  assert.equal((await post('/api/plan', { id: 'surnope', title: 'Sur nope', base: 'nope', sessions: [session('B')] })).status, 200);
  const r = await post('/api/launch', { plan: 'surnope', session: 'B' });
  assert.notEqual(r.status, 200); assert.match(JSON.stringify(r.body), /base « nope » introuvable/);
  const B = (await get('/api/plan/surnope')).state.find((s) => s.id === 'B');
  assert.equal(B.status, 'todo', 'not launched'); assert.ok(!B.worktree, 'no worktree from the open branch');
  assert.equal(sh(root, ['branch', '--list', 'calmdev/surnope/B']), '');
});
