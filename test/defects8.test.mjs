// The four defects of phase 8 that the pilot worked around by hand on 2026-11-01 (docs/sessions.md, « Les défauts de
// la phase 8 »): the cap of a resumed session, the conflict of an automatic merge told to its session alone, an
// untracked plan of the main checkout that blocked merges, and the network of a plan's settings that refused an
// address with a port. Against fake claudes on spare ports with throwaway databases and repositories.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import * as worktree from '../lib/worktree.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-d8-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 120)); await new Promise((r) => setTimeout(r, 150)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

const boot = (env = {}, fake = fakeClaude()) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = { fake, plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  S.proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_TESTBOX: 'none', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + S.err); });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.messages = async (plan, id) => (await S.get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  S.args = () => JSON.parse(readFileSync(path.join(S.fake.dir, 'args.json'), 'utf8'));
  S.prompts = () => { try { return readFileSync(path.join(S.fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  S.launches = () => { try { return Number(readFileSync(path.join(S.fake.dir, 'launches'), 'utf8')); } catch { return 0; } };
  S.stop = () => new Promise((resolve) => { S.proc.on('exit', resolve); S.proc.kill('SIGINT'); });
  return S;
};
const cap = (args) => args[args.indexOf('--max-budget-usd') + 1];
const cents = (n) => Math.round(n * 100) / 100;

// 1. Claude Code counts the whole Claude session under --resume (its total_cost_usd and its --max-budget-usd start
// from what that session id had cost): the server must neither add that past twice nor cap the resume at once
test('defect 1: a resumed session has the rest of its cap, its past counted once', async () => {
  const S = boot({ FAKE_CLAUDE_CONTEXT_WINDOW: '1000000', FAKE_CLAUDE_TURN_COST: '0.4', FAKE_CLAUDE_ENFORCE_CAP: '1' }); await S.ready();
  const root = repo();
  assert.equal((await S.post('/api/plan', { id: 'reprise', title: 'Reprise', sessions: [{ id: 'R', name: 'Reprise', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 1 }] })).status, 200);
  const waiting = () => until(async () => { const s = await S.session('reprise', 'R'); return s.status === 'waiting' ? s : null; });
  await S.post('/api/launch', { plan: 'reprise', session: 'R' });
  let R = await waiting(); assert.equal(cap(S.args()), '1'); assert.equal(cents(R.usage.cost), 0.4);
  await S.post('/api/plan/reprise/session/R/stop');
  const n = S.launches();
  await S.post('/api/plan/reprise/session/R/message', { text: 'Encore' });
  await until(() => S.launches() > n); R = await until(async () => { const s = await S.session('reprise', 'R'); return s.status === 'waiting' && cents(s.usage.cost) > 0.4 ? s : null; });
  assert.ok(S.args().includes('--resume'));
  assert.equal(cap(S.args()), '1', 'Claude Code counts the 0,40 $ it restores: the rest (0,60 $) plus that past');
  assert.equal(cents(R.usage.cost), 0.8, 'two turns of 0,40 $, the first one counted once');
  assert.equal(R.health, 'ok', 'Claude Code did not cut the resumed turn'); assert.equal(R.mode, 'page', 'the server did not cap it');
  assert.ok(!(await S.messages('reprise', 'R')).some((m) => /Plafond de .* atteint/.test(m.text)));
  // a third turn reaches the cap: Claude Code and the server stop it there, at the plan's 1 $
  await S.post('/api/plan/reprise/session/R/message', { text: 'Encore' });
  R = await until(async () => { const s = await S.session('reprise', 'R'); return s.status === 'waiting' && cents(s.usage.cost) > 0.8 ? s : null; });
  assert.equal(cents(R.usage.cost), 1.2); assert.equal(R.mode, null, 'capped at the third turn');
  await S.stop();
});

// 2. A fake claude for the merge: session A writes a.txt against main, B writes b.txt; told « en conflit », A merges
// main keeping its side (FAKE_RESOLVE=1) or, without it, says done again without merging. It stays alive as Claude Code does.
const conflictClaude = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-conf-'))); const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const DIR = ${JSON.stringify(dir)}; const argv = process.argv.slice(2);
let launches = 0; try { launches = Number(fs.readFileSync(path.join(DIR, 'launches'), 'utf8')); } catch {}
fs.writeFileSync(path.join(DIR, 'launches'), String(++launches)); fs.writeFileSync(path.join(DIR, 'args.json'), JSON.stringify(argv));
const SID = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : 'conf-' + launches;
const me = /-([A-Z])$/.exec(process.cwd())[1]; const git = (...a) => cp.execFileSync('git', a, { stdio: 'ignore' });
const out = (o) => console.log(JSON.stringify(o)); out({ type: 'system', subtype: 'init', session_id: SID });
let n = 0;
const finish = (prose, done) => { out({ type: 'assistant', message: { content: [{ type: 'text', text: prose + '\\n\\n\`\`\`escadrille:state\\n' + JSON.stringify({ stops: [0], health: 'ok', why: '', claude: prose, done }) + '\\n\`\`\`' }] } }); out({ type: 'result', subtype: 'success', num_turns: n, total_cost_usd: 0.01 * n, usage: { input_tokens: 2, output_tokens: 5 } }); };
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); if (m.type !== 'user') return; n++; const text = String(m.message.content);
  fs.appendFileSync(path.join(DIR, 'prompts.jsonl'), JSON.stringify({ session: me, text }) + '\\n');
  if (/en conflit/.test(text)) {
    if (process.env.FAKE_RESOLVE) { try { git('merge', '-q', 'main', '-m', 'merge main'); } catch { git('checkout', '--ours', 'a.txt'); git('add', 'a.txt'); git('commit', '-qm', 'merge main, a.txt de la branche'); } }
    return finish(process.env.FAKE_RESOLVE ? 'Conflit résolu' : 'Fini (sans rien faire)', true);
  }
  const f = me === 'A' ? 'a.txt' : 'b.txt'; fs.writeFileSync(f, 'la branche de ' + me + '\\n'); git('add', f); git('commit', '-qm', 'turn of ' + me);
  finish('Écrit ' + f, true);
});
`); chmodSync(file, 0o755);
  return { dir, file };
};
const conflictPlan = async (S, root) => {
  // A's branch starts before main changes a.txt: its merge conflicts
  sh(root, ['branch', 'escadrille/conf/A']); writeFileSync(path.join(root, 'a.txt'), 'main\n'); sh(root, ['commit', '-qam', 'main changes a.txt']);
  const sess = (id) => ({ id, name: 'Session ' + id, path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Écris.' });
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'true' } })).status, 200);
  const made = await S.post('/api/plan', { id: 'conf', title: 'Conflit', autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'true' }, sessions: [sess('A'), sess('B')] }); assert.equal(made.status, 200, JSON.stringify(made.body));
  await S.post('/api/launch', { plan: 'conf' });
};
// The automatic merge waits for the click that runs the tests (Dev, 2026-11-01): the test clicks as the developer would
const clickTests = async (S, id) => { await until(async () => (await S.session('conf', id)).pending.some((p) => p.kind === 'run-tests')); return S.post(`/api/plan/conf/session/${id}/run-tests`); };
const CONFLICT_TEXT = 'Ta fusion dans main est en conflit : merge main dans ta branche, résous, `node --test`, puis redis-toi finie.';

test('defect 2: an automatic merge in conflict tells its session alone, once; the next done merges again', async () => {
  const S = boot({ FAKE_RESOLVE: '1' }, conflictClaude()); await S.ready();
  const root = repo(); await conflictPlan(S, root); await clickTests(S, 'A');
  await until(async () => (await S.messages('conf', 'A')).some((m) => /^Fusion en conflit : a\.txt/.test(m.text)));
  await until(() => S.prompts().some((p) => p.session === 'A' && p.text === CONFLICT_TEXT), 5000);
  await clickTests(S, 'A'); await clickTests(S, 'B');
  const A = await until(async () => { const s = await S.session('conf', 'A'); return s.worktree?.merged ? s : null; });
  assert.equal(A.status, 'done'); assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'la branche de A\n', 'the resolved branch is merged');
  const B = await until(async () => { const s = await S.session('conf', 'B'); return s.worktree?.merged ? s : null; });
  assert.equal(B.status, 'done');
  assert.equal(S.prompts().filter((p) => p.text === CONFLICT_TEXT).length, 1, 'one message for one conflict');
  assert.ok(!S.prompts().some((p) => p.session === 'B' && /conflit/.test(p.text)), 'B receives nothing');
  const msgs = await S.messages('conf', 'A');
  assert.ok(msgs.some((m) => m.role === 'system' && m.text === CONFLICT_TEXT), 'the page shows what the server told it');
  await S.stop();
});

test('defect 2: a session that says done again without merging main gets no second message (no loop)', async () => {
  const S = boot({}, conflictClaude()); await S.ready();
  const root = repo(); await conflictPlan(S, root); await clickTests(S, 'A');
  await until(async () => (await S.messages('conf', 'A')).some((m) => /^Fusion en conflit : a\.txt/.test(m.text)));
  await until(() => S.prompts().some((p) => p.session === 'A' && p.text === CONFLICT_TEXT), 5000);
  // it says done again: the merge is tried again, conflicts again, and the server says nothing more
  await clickTests(S, 'A');
  await until(async () => (await S.messages('conf', 'A')).filter((m) => /^Fusion en conflit/.test(m.text)).length >= 2);
  await sleep(800);
  assert.equal(S.prompts().filter((p) => p.text === CONFLICT_TEXT).length, 1);
  const A = await S.session('conf', 'A'); assert.equal(A.worktree.merged, false); assert.equal(A.health, 'error', 'the developer sees the conflict');
  await S.stop();
});

// 3. A plan the server wrote in plans/ of the main checkout, not committed yet, and the same file in the branch
const mergeRepo = (branchText, rootText) => {
  const root = repo(); sh(root, ['checkout', '-qb', 'br']); mkdirSync(path.join(root, 'plans'));
  writeFileSync(path.join(root, 'plans', 'p.json'), branchText); writeFileSync(path.join(root, 'b.txt'), 'b\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'the plan in the branch']);
  sh(root, ['checkout', '-q', 'main']); mkdirSync(path.join(root, 'plans'), { recursive: true }); writeFileSync(path.join(root, 'plans', 'p.json'), rootText);
  return root;
};
test('defect 3: an untracked plan of the main checkout no longer blocks the merge, and nothing of it is lost', async () => {
  // the same plan on both sides: merged, tracked, clean
  let root = mergeRepo('{"v":1}\n', '{"v":1}\n');
  assert.deepEqual(await worktree.merge({ root, branch: 'br' }), { ok: true });
  assert.equal(readFileSync(path.join(root, 'plans', 'p.json'), 'utf8'), '{"v":1}\n'); assert.equal(sh(root, ['status', '--porcelain']), '');
  // the server's plan is newer than the branch's: merged, and the server's version stays on disk, uncommitted
  root = mergeRepo('{"v":1}\n', '{"v":2}\n');
  assert.deepEqual(await worktree.merge({ root, branch: 'br' }), { ok: true });
  assert.equal(readFileSync(path.join(root, 'plans', 'p.json'), 'utf8'), '{"v":2}\n', 'the file of the checkout is kept');
  assert.equal(sh(root, ['show', 'HEAD:plans/p.json']), '{"v":1}'); assert.equal(sh(root, ['status', '--porcelain']), 'M plans/p.json');
  assert.ok(existsSync(path.join(root, 'b.txt')), 'the branch is merged');
  // a merge in conflict gives the untracked file back as it was
  root = mergeRepo('{"v":1}\n', '{"v":2}\n'); rmSync(path.join(root, 'plans', 'p.json')); writeFileSync(path.join(root, 'a.txt'), 'main\n'); sh(root, ['commit', '-qam', 'main a']);
  sh(root, ['checkout', '-q', 'br']); writeFileSync(path.join(root, 'a.txt'), 'br\n'); sh(root, ['commit', '-qam', 'br a']); sh(root, ['checkout', '-q', 'main']);
  mkdirSync(path.join(root, 'plans'), { recursive: true }); writeFileSync(path.join(root, 'plans', 'p.json'), '{"v":2}\n');
  const r = await worktree.merge({ root, branch: 'br' }); assert.deepEqual(r, { conflict: true, files: ['a.txt'] });
  assert.equal(readFileSync(path.join(root, 'plans', 'p.json'), 'utf8'), '{"v":2}\n'); assert.equal(sh(root, ['status', '--porcelain']), '?? plans/');
  // a tracked file modified in the checkout that the branch touches still refuses the merge
  const root2 = repo(); sh(root2, ['checkout', '-qb', 'br']); writeFileSync(path.join(root2, 'a.txt'), 'br\n'); sh(root2, ['commit', '-qam', 'br a']); sh(root2, ['checkout', '-q', 'main']); writeFileSync(path.join(root2, 'a.txt'), 'en cours\n');
  await assert.rejects(worktree.merge({ root: root2, branch: 'br' }), /non commités.*a\.txt/);
  assert.equal(readFileSync(path.join(root2, 'a.txt'), 'utf8'), 'en cours\n');
});

// 4. The network of a plan's settings takes what the project's settings take (validateNetwork)
test('defect 4: the settings of a plan take 127.0.0.1:3318, as the settings of its project', async () => {
  const S = boot(); await S.ready();
  const root = repo();
  assert.equal((await S.post('/api/plan', { id: 'reseau', title: 'Réseau', sessions: [{ id: 'A', name: 'A', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Rien.' }] })).status, 200);
  const list = ['127.0.0.1:3318', 'localhost:5432', 'api.github.com'];
  assert.equal((await S.post('/api/project/settings', { project: root, network: list })).status, 200, 'the project takes it');
  const r = await S.post('/api/plan/reseau/settings', { network: list });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual((await S.get('/api/plan/reseau')).plan.network, list);
  for (const bad of ['http://127.0.0.1', '127.0.0.1:99999', 'exemple']) assert.equal((await S.post('/api/plan/reseau/settings', { network: [bad] })).status, 400, bad);
  await S.stop();
});
