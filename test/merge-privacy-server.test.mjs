// The private-life net at merge time, in the server (lib/mergeprivacy.mjs in mergeSession): main is pushed after each
// local merge, so a branch whose added lines carry a trace is never merged, neither alone on green tests nor by the
// button; the refusal names file:line and kind (never the value) and the way out; once the trace is gone, it merges.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const BOX = path.join(HERE, 'fake-box.sh');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-mp-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

// A fake claude whose one turn commits src/host.mjs with a LAN address (built in pieces: this file carries no trace)
const LAN = ['192', '168', '1', '20'].join('.');
const leakyClaude = () => {
  const file = path.join(tmp('escadrille-mpc-'), 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const cp = require('node:child_process');
const out = (o) => console.log(JSON.stringify(o)); out({ type: 'system', subtype: 'init', session_id: 'mp-' + Date.now() });
let n = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); if (m.type !== 'user') return; n++;
  if (n === 1) { fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/host.mjs', "export const ok = 1;\\nexport const host = '${LAN}';\\n"); cp.execFileSync('git', ['add', '.']); cp.execFileSync('git', ['commit', '-qm', 'host']); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fini\\n\\n\`\`\`escadrille:state\\n' + JSON.stringify({ stops: [0], health: 'ok', why: '', claude: 'fini', done: true }) + '\\n\`\`\`' }] } });
  out({ type: 'result', subtype: 'success', num_turns: n, total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 5 } });
});
`); chmodSync(file, 0o755);
  return file;
};

test('a branch adding a LAN address: not merged on green tests nor by the button, file:line named, merged once fixed', async () => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const empty = tmp('escadrille-none-');
  const proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: leakyClaude(), ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_TESTBOX: BOX }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(proc); let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  await until(async () => { try { await get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + err); });
  const session = async () => (await get('/api/plan/fuite')).state.find((s) => s.id === 'A');
  const messages = async () => (await get('/api/plan/fuite/session/A/messages')).messages.map((m) => m.text);

  const root = repo(); const start = sh(root, ['rev-parse', 'HEAD']);
  const autonomy = { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'true' };
  assert.equal((await post('/api/project/settings', { project: root, autonomy })).status, 200);
  assert.equal((await post('/api/plan', { id: 'fuite', title: 'fuite', autonomy, sessions: [{ id: 'A', name: 'Session A', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['La fin'] }] })).status, 200);
  await post('/api/launch', { plan: 'fuite' });

  // the green tests ask to merge alone: refused, the reason names the file and the line, never the value
  const why = await until(async () => (await messages()).find((t) => /^Vie privée : /.test(t)));
  assert.match(why, /src\/host\.mjs:2 \(lan\)/); assert.ok(!why.includes(LAN), 'the value found never appears');
  assert.match(why, /retire-les de la branche/, 'the way out is given');
  const A = await session(); assert.ok(!A.worktree.merged); assert.equal(sh(root, ['rev-parse', 'main']), start, 'main never moved');

  // the button: refused too (409), same findings
  const btn = await post('/api/plan/fuite/session/A/merge'); assert.equal(btn.status, 409, JSON.stringify(btn.body));
  assert.deepEqual(btn.body.privacy, [{ file: 'src/host.mjs', line: 2, kind: 'lan' }]);
  assert.equal(sh(root, ['rev-parse', 'main']), start);

  // fixed on the branch: the button merges
  writeFileSync(path.join(A.worktree.path, 'src/host.mjs'), 'export const ok = 1;\nexport const host = process.env.HOST;\n');
  sh(A.worktree.path, ['commit', '-qam', 'no trace']);
  await until(async () => { const s = await session(); if (s.worktree.merged) return true; await post('/api/plan/fuite/session/A/merge'); return false; });
  assert.equal(sh(root, ['show', 'main:src/host.mjs']), 'export const ok = 1;\nexport const host = process.env.HOST;');
  proc.kill('SIGINT');
});
