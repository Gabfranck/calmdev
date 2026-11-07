// The launch of a session keeps a team alert already in its pending (2026-11-02: the launch reset pending to [] and the
// session never saw a collision raised just before; backlog l. 60). The alert is written as teamCollision writes it
// (server.mjs: { kind: 'info', team: {…} }), straight in a throwaway base between two boots of the server.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeClaude } from './fake-claude.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 120)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

const boot = (dbFile, plans, fake) => {
  const PORT = freePort(); const url = `http://127.0.0.1:${PORT}`; const empty = tmp('escadrille-none-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: dbFile, ESCADRILLE_PLANS: plans, ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_TESTBOX: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(proc); const S = { err: '' }; proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(url + p)).json();
  S.post = async (p, body) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + S.err); });
  S.stop = () => new Promise((resolve) => { proc.on('exit', resolve); proc.kill('SIGINT'); });
  return S;
};

test('a team alert posted before the launch is still in pending after it; a reply of an earlier turn is not', async () => {
  const root = tmp('escadrille-lp-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  const dbFile = path.join(tmp('escadrille-db-'), 'db.sqlite'); const plans = tmp('escadrille-plans-'); const fake = fakeClaude();
  let S = boot(dbFile, plans, fake); await S.ready();
  assert.equal((await S.post('/api/plan', { id: 'equipe', title: 'Équipe', sessions: [{ id: 'A', name: 'A', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 1 }] })).status, 200);
  await S.stop();
  const alert = { id: 'team-1', kind: 'info', team: { member: 'Léa', kind: 'file', files: ['a.txt'], session: 'Scores', branch: 'lea/B' }, text: 'Léa touche a.txt', at: new Date().toISOString() };
  const stale = { id: 'reply-old', kind: 'reply', stop: 0, text: 'un arrêt d’un tour précédent', at: new Date().toISOString() };
  { const db = new DatabaseSync(dbFile); db.prepare('update sessions set pending = ? where plan = ? and id = ?').run(JSON.stringify([alert, stale]), 'equipe', 'A'); db.close(); }
  S = boot(dbFile, plans, fake); await S.ready();
  assert.equal((await S.get('/api/plan/equipe')).state.find((s) => s.id === 'A').pending.length, 2, 'the alert is there before the launch');
  assert.equal((await S.post('/api/launch', { plan: 'equipe', session: 'A' })).status, 200);
  const A = await until(async () => { const s = (await S.get('/api/plan/equipe')).state.find((x) => x.id === 'A'); return s.status !== 'todo' ? s : null; });
  const kept = A.pending.find((p) => p.id === 'team-1');
  assert.ok(kept, 'the team alert survives the launch: ' + JSON.stringify(A.pending)); assert.deepEqual(kept.team, alert.team);
  assert.ok(!A.pending.some((p) => p.id === 'reply-old'), 'what belongs to an earlier turn goes');
});
