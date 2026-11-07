// Phase 14 RAF: a plan session's messages written during a turn leave together, against a fake `claude` whose turns take
// 600 ms. Skipped on a lib/planner.mjs without joinMessages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPlanner } from '../lib/planner.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const patched = readFileSync(path.join(HERE, '..', 'lib', 'planner.mjs'), 'utf8').includes('joinMessages');
const skip = patched ? false : 'le patch docs/phase14/raf-protege.diff n’est pas posé';

const fake = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-raf-')));
  const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-raf' }));
let timer = null; let n = 0;
const end = (subtype) => { clearTimeout(timer); timer = null; console.log(JSON.stringify({ type: 'result', subtype, num_turns: 1, total_cost_usd: 0.01, usage: {} })); };
rl.on('line', (line) => { const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') { if (timer) end('error_during_execution'); return; }
  if (m.type !== 'user') return; n++;
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tour ' + n + ' : ' + m.message.content }] } }));
  timer = setTimeout(() => end('success'), 600);
});
`); chmodSync(file, 0o755);
  return { dir, file };
};
const run = (fn) => new Promise((resolve) => {
  // firstText: when the fake answered its first turn, so that a timing leaves out the start of the process (slow under load)
  const { dir, file } = fake(); const texts = []; let turns = 0; let p; let firstText = 0;
  p = startPlanner({ cwd: dir, model: 'claude-sonnet-5-5', claude: file, onEvent: (e) => { if (e.type === 'text') { texts.push(e.text); firstText ||= Date.now(); } if (e.type === 'turn') { turns++; fn.onTurn?.(p, turns, () => { p.stop(); resolve({ texts, turns, firstText, end: Date.now() }); }); } } });
  fn.start(p);
});

test('four messages, the last three written during the first turn: two turns', { skip }, async () => {
  const r = await run({ start: (p) => { p.send('a'); p.send('b'); p.send('c'); p.send('d'); assert.equal(p.held, 3); }, onTurn: (p, n, done) => { if (n === 2) done(); } });
  assert.equal(r.turns, 2); assert.equal(r.texts[0], 'Tour 1 : a');
  assert.match(r.texts[1], /^Tour 2 : 3 messages arrivés pendant ton tour/); assert.match(r.texts[1], /### Message 3\nd$/);
});

test('« Envoyer maintenant » cuts the turn and the waiting messages leave at once', { skip }, async () => {
  const r = await run({ start: (p) => { p.send('long'); p.send('vite'); assert.equal(p.interrupt(), true); }, onTurn: (p, n, done) => { if (n === 2) done(); } });
  // from the first answer to the end of turn 2: about 600 ms when turn 1 is cut, 1200 when it runs its 600 ms
  assert.equal(r.texts[1], 'Tour 2 : vite'); assert.ok(r.end - r.firstText < 1100, 'the first turn did not run its 600 ms');
});
