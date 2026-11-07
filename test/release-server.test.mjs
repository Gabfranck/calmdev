// The release merges played against the server and the fake claude (docs/sessions.md, « Les fusions de release »):
// a release session of a kit plan writes its `releases` list in its state block; the server builds release/r01 from
// three clean ticket branches, stops release/r02 on its conflict without writing it, says both in the page and hands
// the lines back to the session itself. A plan that is not a kit gets nothing merged.
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
let canGit = true; try { sh(tmpdir(), ['--version']); } catch { canGit = false; }
const skip = canGit ? false : 'git ne se lance pas depuis Node ici (bac à sable : spawn EPERM)';
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 100)); } };
const procs = []; after(() => { for (const p of procs) p.kill('SIGKILL'); });

const repo = () => {
  const root = tmp('escadrille-relsrv-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'list.txt'), 'start\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  const ticket = (branch, files) => { sh(root, ['checkout', '-q', '-b', branch, 'main']); for (const [f, c] of Object.entries(files)) writeFileSync(path.join(root, f), c); sh(root, ['add', '.']); sh(root, ['commit', '-qm', branch]); sh(root, ['checkout', '-q', 'main']); };
  ticket('r01/a', { 'a.txt': 'a\n' }); ticket('r01/b', { 'b.txt': 'b\n' }); ticket('r01/c', { 'c.txt': 'c\n' });
  ticket('r02/x', { 'list.txt': 'start\nx\n' }); ticket('r02/y', { 'list.txt': 'start\ny\n' });
  return root;
};

const boot = async (turns, plan) => {
  const fake = fakeClaude(); const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`; const empty = tmp('escadrille-none-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  const S = { get: async (p) => (await fetch(base + p)).json(), post: async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).status };
  S.prompts = () => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  S.session = async () => (await S.get('/api/plan/rel')).state.find((x) => x.id === 'A');
  S.messages = async (lang = 'fr') => (await (await fetch(base + '/api/plan/rel/session/A/messages', { headers: { 'accept-language': lang } })).json()).messages;
  await until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  assert.equal(await S.post('/api/plan', { id: 'rel', title: 'Release', ...plan }), 200);
  await S.post('/api/launch', { plan: 'rel' });
  return S;
};
const releases = (root) => [
  { repo: root, release: 'release/r01', base: 'main', branches: ['r01/a', 'r01/b', 'r01/c'] },
  { release: 'release/r02', base: 'main', branches: ['r02/x', 'r02/y'] }, // no repo: the session's own
];
const sess = (root) => ({ id: 'A', name: 'Release', path: root, model: 'claude-sonnet-5-5', prompt: 'Rassemble la release.', budget: 1, stops: ['Les releases', 'Fin'] });

test('a kit release session: the server builds release/r01, gives the r02 conflict back, resumes the session alone', { skip }, async () => {
  const root = repo();
  const S = await boot([{ stops: [0], claude: 'Premier arrêt' }, { stops: [0], claude: 'Les fusions', releases: releases(root) }, { stops: [0, 1], claude: 'Fini', done: true }], { delivery: 'kit', sessions: [sess(root)] });
  await until(async () => (await S.session())?.status === 'waiting');
  await S.post('/api/plan/rel/session/A/message', { text: 'Va.' }); // turn 2 crosses no new stop and asks for the merges
  await until(() => S.prompts().length >= 3); // the server's own message: nobody wrote to the session
  const third = S.prompts()[2].text;
  assert.match(third, /\[système\] Release release\/r01 \(escadrille-relsrv-\w+\) : 3 branche\(s\) fusionnée\(s\) sur main → [0-9a-f]{7}, non poussée\./);
  assert.match(third, /\[système\] Release release\/r02 .*conflit en fusionnant r02\/y, rien n'est écrit\. Fichiers en conflit : list\.txt/);
  assert.match(third, /Les fusions de release sont faites : reprends\.$/);
  assert.deepEqual(sh(root, ['ls-tree', '--name-only', 'release/r01']).split('\n').sort(), ['a.txt', 'b.txt', 'c.txt', 'list.txt']);
  assert.equal(sh(root, ['branch', '--list', 'release/r02']), '', 'the conflict wrote nothing');
  assert.equal(sh(root, ['branch', '--show-current']), 'main');
  const page = async (lang) => (await S.messages(lang)).filter((m) => m.role === 'system' && /^Release /.test(m.text)).map((m) => m.text);
  const fr = await page('fr'); const en = await page('en');
  assert.equal(fr.length, 2, 'one line per repository in the page');
  assert.match(fr[0], /^Release release\/r01 \(.+\) : 3 branche\(s\) fusionnée\(s\) → [0-9a-f]{7}, non poussée\.$/);
  assert.match(fr[1], /conflit en fusionnant r02\/y, rien n’est écrit\. Fichiers en conflit : list\.txt\. Rendu à la session\.$/);
  assert.match(en[0], /^Release release\/r01 \(.+\): 3 branch\(es\) merged → [0-9a-f]{7}, not pushed\.$/);
  assert.match(en[1], /conflict merging r02\/y, nothing written\. Conflicting files: list\.txt\. Sent back to the session\.$/);
  await until(async () => (await S.session())?.status === 'done');
});

test('a plan that is not a kit: nothing merged, the session is told why', { skip }, async () => {
  const root = repo();
  const S = await boot([{ stops: [0], claude: 'Premier arrêt' }, { stops: [0], claude: 'Les fusions', releases: releases(root) }, { stops: [0, 1], claude: 'Fini', done: true }], { sessions: [sess(root)] });
  await until(async () => (await S.session())?.status === 'waiting');
  await S.post('/api/plan/rel/session/A/message', { text: 'Va.' });
  await until(() => S.prompts().length >= 3);
  assert.match(S.prompts()[2].text, /Fusions de release ignorées : le plan n’est pas livré en kit/);
  assert.equal(sh(root, ['branch', '--list', 'release/*']), '');
});
