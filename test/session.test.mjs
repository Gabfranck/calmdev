// The pilot of a launched session against the fake `claude` (test/fake-claude.mjs): it asks
// permissions over the control channel, takes the answers, and closes its turns with a state block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startSession, isNetwork, SESSION_TOOLS } from '../lib/planner.mjs';
import { fakeClaude } from './fake-claude.mjs';

test('startSession asks over the channel, takes the answers, remembers "always" except for the network, and reports the state blocks', async () => {
  const { dir, file } = fakeClaude();
  const events = []; let p;
  const done = new Promise((resolve) => {
    p = startSession({ cwd: dir, model: 'claude-sonnet-5-5', claude: file, onEvent: (e) => {
      events.push(e);
      if (e.type === 'ask') p.answer(e.id, { allow: true, always: true });
      if (e.type === 'turn') p.send(e.turns < 3 ? 'Encore' : 'Fin');
      if (e.type === 'exit') resolve();
    } });
    p.send('Écris docs/essai.txt');
  });
  await done;
  const asks = events.filter((e) => e.type === 'ask');
  assert.deepEqual(asks.map((a) => [a.id, a.tool, a.text, a.network]), [['req-1', 'Bash', 'curl -s http://x', true], ['req-2', 'Bash', 'curl -s http://y', true], ['req-3', 'Bash', 'rm -f out.txt', false]], 'the second curl asks again, the second rm is covered');
  assert.equal(events.filter((e) => e.type === 'activity' && /autorisé d’office/.test(e.text)).length, 1);
  const blocks = events.filter((e) => e.type === 'block');
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0].json, { stops: [0], health: 'ok', why: '', claude: 'Regarde docs/essai.txt', done: false });
  assert.equal(blocks[2].json.done, false); assert.equal(blocks[3].json.done, true);
  assert.equal(events.filter((e) => e.type === 'turn').length, 4);
  assert.equal(events.find((e) => e.type === 'text').text.split('\n')[0], 'La commande a dit ok.');
  const args = JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.ok(args.includes('--permission-prompt-tool') && args.includes('stdio'), 'the channel is on');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  for (const t of SESSION_TOOLS) assert.ok(args.includes(t), t);
  assert.ok(!args.includes('--max-budget-usd'), 'no cap without a budget');
});

test('a budget goes to claude as --max-budget-usd', async () => {
  const { dir, file } = fakeClaude();
  await new Promise((resolve) => { const p = startSession({ cwd: dir, model: 'claude-sonnet-5-5', claude: file, budget: 2.5, onEvent: (e) => { if (e.type === 'init') { p.stop(); resolve(); } } }); });
  const args = JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2.5');
});

test('a denied answer goes back as a deny with the message', async () => {
  const { dir, file } = fakeClaude();
  const texts = []; let p;
  await new Promise((resolve) => {
    p = startSession({ cwd: dir, model: 'claude-sonnet-5-5', claude: file, onEvent: (e) => {
      if (e.type === 'ask') p.answer(e.id, { allow: false, message: 'Pas ce soir.' });
      if (e.type === 'text') texts.push(e.text);
      if (e.type === 'turn') { p.stop(); resolve(); }
    } });
    p.send('Vas-y');
  });
  assert.equal(texts[0].split('\n')[0], 'Refusé : Pas ce soir.');
  assert.throws(() => p.answer('req-1', { allow: true }), /demande inconnue/);
});

test('isNetwork: anything outside localhost, nothing local, nothing on the whitelist', () => {
  const net = (c) => isNetwork('Bash', { command: c });
  for (const c of ['curl https://api.github.com', 'wget http://x/y', 'git push origin main', 'git pull', 'git fetch --all', 'git clone https://x/y', 'npm install', 'npm i lodash', 'npm ci', 'npx create-x', 'pnpm add x', 'yarn', 'pip install x', 'brew install x', 'ssh host', 'scp a b:', 'gh pr create', 'cd app && npm install && npm test', 'curl -s http://localhost:3078/x && curl https://example.com'])
    assert.equal(net(c), true, c);
  for (const c of ['curl -s http://localhost:3079/api/plans', 'curl -s -X POST http://127.0.0.1:3078/api/update -d {}', 'git status', 'git commit -m "push the button"', 'node --test', 'npm test', 'npm run build', 'ls -la', 'cat README.md', 'echo curl', 'git log --oneline'])
    assert.equal(net(c), false, c);
  assert.equal(isNetwork('WebFetch', { url: 'https://example.com' }), true);
  assert.equal(isNetwork('WebFetch', { url: 'http://localhost:3078/' }), false);
  assert.equal(isNetwork('WebSearch', { query: 'x' }), true);
  assert.equal(isNetwork('Edit', { file_path: '/x' }), false);
});
