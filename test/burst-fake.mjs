// The fake claude of the burst (test/burst.test.mjs and the trial on port 3099), shaped like test/fake-claude.mjs:
// a planner (it has --append-system-prompt) asks one question, then writes a plan of one session; a session says
// done at its first turn and costs 0.5 $. Prompts land in prompts.jsonl, planner system prompts in system.txt, one line
// per process started in spawns.txt (planner or session).
import { writeFileSync, readFileSync, realpathSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
export const fake = () => {
  const dir = tmp('escadrille-fake-'); const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const DIR = ${JSON.stringify(dir)};
const argv = process.argv.slice(2); const planner = argv.includes('--append-system-prompt');
fs.appendFileSync(path.join(DIR, 'spawns.txt'), (planner ? 'planner' : 'session') + '\\n');
if (planner) fs.appendFileSync(path.join(DIR, 'system.txt'), argv[argv.indexOf('--append-system-prompt') + 1] + '\\n---\\n');
const out = (o) => console.log(JSON.stringify(o)); const B = '\`\`\`';
out({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid });
let n = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); if (m.type !== 'user') return; const text = String(m.message.content); n++;
  fs.appendFileSync(path.join(DIR, 'prompts.jsonl'), JSON.stringify({ planner, text }) + '\\n');
  let say;
  if (planner && n === 1) say = 'Deux questions.\\n\\n' + B + 'escadrille:questions\\n' + JSON.stringify([{ title: 'Portée', question: 'Tout ?', recommendation: 'Oui' }]) + '\\n' + B;
  else if (planner) say = 'Le plan.\\n\\n' + B + 'escadrille:plan\\n' + JSON.stringify({ title: 'Plan ' + process.pid, network: ['example.com'], sessions: [{ id: 'A', name: 'Faire', prompt: 'Fais-le.', stops: ['fini'], budget: 3 }] }) + '\\n' + B;
  else say = 'Fait.\\n\\n' + B + 'escadrille:state\\n' + JSON.stringify({ stops: [0], health: 'ok', why: '', claude: 'ok', summary: 'Fait', done: !process.env.FAKE_SESSION_WAITS }) + '\\n' + B;
  out({ type: 'assistant', message: { content: [{ type: 'text', text: say }] } });
  out({ type: 'result', subtype: 'success', num_turns: n, total_cost_usd: planner ? 0.05 * n : 0.5, usage: { input_tokens: 2, output_tokens: 5 }, modelUsage: {} });
});
`); chmodSync(file, 0o755);
  return { dir, file, prompts: () => { try { return readFileSync(path.join(dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } }, system: () => { try { return readFileSync(path.join(dir, 'system.txt'), 'utf8'); } catch { return ''; } }, sessionSpawns: () => { try { return readFileSync(path.join(dir, 'spawns.txt'), 'utf8').split('\n').filter((l) => l === 'session').length; } catch { return 0; } } };
};


if (process.argv[1] && process.argv[1].endsWith('burst-fake.mjs')) console.log(fake().file);
