// The captures of a stop, played against the server and the fake claude: the session asks for twenty CAPTURE: lines
// in one stop (targets the browser would refuse, so no browser is needed), the server takes all twenty, one at a
// time, says each failure in one line, then sends the session the lines itself so that it carries on alone, unless
// the turn crossed a stop of the plan: then the session waits for the developer and keeps the lines for his message.
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
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 100)); } };
const procs = []; after(() => { for (const p of procs) p.kill('SIGKILL'); });

const prose = 'Les écrans sont prêts.\n' + Array.from({ length: 20 }, (_, i) => `CAPTURE: http://example.com:80/p${i}`).join('\n');

const boot = async (turns) => {
  const root = tmp('escadrille-capb-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  const fake = fakeClaude(); const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const empty = tmp('escadrille-none-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  const S = { get: async (p) => (await fetch(base + p)).json(), post: async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).status };
  S.prompts = () => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  S.session = async () => (await S.get('/api/plan/cap')).state.find((x) => x.id === 'A');
  S.messages = async () => (await S.get('/api/plan/cap/session/A/messages')).messages;
  await until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  assert.equal(await S.post('/api/plan', { id: 'cap', title: 'Captures', sessions: [{ id: 'A', name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['Les écrans', 'Fin'] }] }), 200);
  await S.post('/api/launch', { plan: 'cap' });
  return S;
};
const captureLines = (text) => text.split('\n').filter((l) => l.startsWith('[système] CAPTURE '));

test('twenty CAPTURE: lines in an intermediate turn: all taken, then the session is resumed by the server alone', async () => {
  const S = await boot([{ stops: [0], claude: 'Premier arrêt' }, { stops: [0], claude: 'Je continue', prose }, { stops: [0, 1], claude: 'Fini', done: true }]);
  await until(async () => (await S.session()).status === 'waiting');
  await S.post('/api/plan/cap/session/A/message', { text: 'Va.' }); // turn 2 crosses no new stop and asks for twenty captures
  await until(() => S.prompts().length >= 3); // the third prompt is the server's own message: nobody wrote to the session
  const third = S.prompts()[2].text; const lines = captureLines(third);
  assert.equal(lines.length, 20, 'the twenty lines lead the message');
  assert.match(lines[0], /p0 : capture refusée : hôte example\.com/); assert.match(lines[19], /p19 :/);
  assert.match(third, /reprends/);
  const msgs = await S.messages();
  assert.equal(msgs.filter((m) => m.role === 'system' && /^CAPTURE /.test(m.text)).length, 20, 'one system line per capture in the page');
  assert.equal(msgs.filter((m) => m.role === 'dev').length, 1, 'only the developer’s own "Va."');
  await until(async () => (await S.session()).status === 'done');
  assert.equal(S.prompts().length, 3, 'the lines are sent once');
});

test('captures asked at a stop of the plan: the session waits for the developer, the lines lead his next message', async () => {
  const S = await boot([{ stops: [0], claude: 'Valide ce design', prose }, { stops: [0, 1], claude: 'Fini', done: true }]);
  await until(async () => (await S.session()).status === 'waiting');
  await until(async () => (await S.messages()).filter((m) => m.role === 'system' && /^CAPTURE /.test(m.text)).length === 20);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(S.prompts().length, 1, 'no resume: the stop belongs to the developer');
  assert.equal((await S.session()).status, 'waiting');
  await S.post('/api/plan/cap/session/A/message', { text: 'Le design est bon.' });
  await until(() => S.prompts().length >= 2);
  const second = S.prompts()[1].text;
  assert.equal(captureLines(second).length, 20, 'the lines kept for the next message');
  assert.match(second, /Le design est bon\.$/);
});
