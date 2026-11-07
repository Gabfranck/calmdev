// A message sent to a session during its turn (POST /api/plan/:id/session/:sid/message, or the pilot's answer) always
// reaches it (backlog, 2 November: X and FIX ended their turn without reading one). A fake claude whose first turn
// holds 1.5 s: what is written meanwhile must open the next turn, in order, in one user message.
//  1. two messages during the turn: the next turn carries both, in order; one written while it waits leaves at once;
//  2. while the held messages are read, the row says running, not « waiting » with a reply;
//  3. the cap raised during the turn (the process is restarted at its end with --resume): the held message survives;
//  4. the server stops during the turn: the message, kept in the base (sessions.inbox), leaves at the resume.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-msg-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 40)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TURNS = JSON.stringify([{ hold: 1500, stops: [0], claude: 'Tour 1' }, { hold: 600, stops: [0], claude: 'Tour 2' }, { hold: 300, stops: [0], claude: 'Tour 3' }, { hold: 300, stops: [0], claude: 'Tour 4' }]);

const servers = [];
after(() => { for (const s of servers) s.kill('SIGINT'); });
const start = (fake, db = path.join(tmp('escadrille-msg-db-'), 'db.sqlite'), plans = tmp('escadrille-msg-plans-')) => {
  const port = freePort(); const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: db, ESCADRILLE_PLANS: plans, ESCADRILLE_TRANSCRIPTS: tmp('escadrille-msg-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-msg-none-'), ESCADRILLE_CLAUDE: fake.file, FAKE_CLAUDE_TURNS: TURNS }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(proc);
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const row = async (plan, id) => (await get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  const ready = () => until(async () => { try { return (await fetch(base + '/api/plans')).status === 200; } catch { return false; } });
  const stop = () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGINT'); });
  return { get, post, row, ready, stop };
};
const prompts = (fake) => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const launches = (fake) => { try { return readFileSync(path.join(fake.dir, 'args.jsonl'), 'utf8').trim().split('\n').length; } catch { return 0; } };
const launch = async (s, fake, root, plan) => {
  await s.ready();
  assert.equal((await s.post('/api/plan', { id: plan, title: plan, sessions: [{ id: 'A', name: 'A', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 5 }] })).status, 200);
  assert.equal((await s.post('/api/launch', { plan })).body.ok, true);
  await until(() => prompts(fake).length === 1); // turn 1 runs, 1.5 s
};
const say = (s, plan, text) => s.post(`/api/plan/${plan}/session/A/message`, { text });

test('two messages during a turn open the next one, in order; one sent while it waits leaves at once', async () => {
  const fake = fakeClaude(); const root = repo(); const s = start(fake);
  await launch(s, fake, root, 'p-order');
  assert.equal((await say(s, 'p-order', 'premier message')).status, 200);
  assert.equal((await say(s, 'p-order', 'second message')).status, 200);
  const next = (await until(() => prompts(fake)[1])).text;
  assert.ok(next.includes('premier message') && next.includes('second message'), next);
  assert.ok(next.indexOf('premier message') < next.indexOf('second message'), 'in order');
  assert.equal(prompts(fake).length, 2, 'one user message for both');
  // the session waits after turn 2: a message leaves at once, alone
  await until(async () => (await s.row('p-order', 'A')).status === 'waiting');
  assert.equal((await say(s, 'p-order', 'troisième')).status, 200);
  await until(() => prompts(fake).length === 3, 3000);
  assert.ok(prompts(fake)[2].text.endsWith('troisième'));
});

test('while the held messages are read the session is running, not waiting on a reply', async () => {
  const fake = fakeClaude(); const root = repo(); const s = start(fake);
  await launch(s, fake, root, 'p-run');
  await say(s, 'p-run', 'lis-moi');
  await until(() => prompts(fake).length === 2); // turn 2 holds 600 ms
  await sleep(150);
  const r = await s.row('p-run', 'A');
  assert.equal(r.status, 'running', 'turn 2 reads the held message: the page must not say it waits');
  assert.ok(!r.pending.some((p) => p.kind === 'reply'), 'no reply asked of the developer on turn 1');
});

test('the cap raised during the turn: the restart at its end keeps the held message', async () => {
  const fake = fakeClaude(); const root = repo(); const s = start(fake);
  await launch(s, fake, root, 'p-budget');
  assert.equal((await s.post('/api/plan/p-budget/session/A/budget', { usd: 9 })).body.deferred, true);
  assert.equal((await say(s, 'p-budget', 'ne me perds pas')).status, 200);
  await until(() => launches(fake) === 2); // turn 1 ended, the process restarted with --resume and the new cap
  await until(() => prompts(fake).some((p) => p.text.includes('ne me perds pas')), 4000).catch(() => {});
  assert.ok(prompts(fake).some((p) => p.text.includes('ne me perds pas')), 'the message written during the turn never reached claude: ' + JSON.stringify(prompts(fake).map((p) => p.text.slice(0, 40))));
  await until(async () => (await s.row('p-budget', 'A')).status === 'running');
});

test('the server stops during the turn: the held message, kept in the base, leaves at the resume', async () => {
  const fake = fakeClaude(); const root = repo();
  const db = path.join(tmp('escadrille-msg-db-'), 'db.sqlite'); const plans = tmp('escadrille-msg-plans-');
  const s = start(fake, db, plans);
  await launch(s, fake, root, 'p-restart');
  assert.equal((await say(s, 'p-restart', 'survis au redémarrage')).body.held, 1);
  await s.stop();
  assert.ok(!prompts(fake).some((p) => p.text.includes('survis au redémarrage')), 'not sent before the restart');
  const s2 = start(fake, db, plans); await s2.ready();
  const p = await until(() => prompts(fake).find((x) => x.text.includes('survis au redémarrage')));
  assert.match(p.text, /^2 messages arrivés pendant ton tour/, 'the resume line and the held message in one user message');
  assert.ok(p.text.indexOf('Le serveur a redémarré') < p.text.indexOf('survis au redémarrage'), 'the resume line first');
});
