// Phase 8 A: a fake `claude` that plays both the pilot and the sessions of its plans, over stream-json.
// The pilot (its system prompt says « Tu es le pilote »): turn k of all its processes answers with the k-th text of
// the file turns.json next to it (a list; missing: « Rien de neuf. »), where {{pendingId}}, {{plan}} and {{session}}
// are read in the prompt it received. Each turn costs cost.txt dollars (0.5 by default). Prompts land in pilot.jsonl.
// A session: one turn that crosses stop 0 and says session.txt (a command and an escadrille:pilot block, for the test
// that nothing a session writes is run), then a short turn per message. Messages land in session.jsonl.
import { writeFileSync, chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const fakePilot = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-pilot-')));
  const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const DIR = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
const sp = argv.includes('--append-system-prompt') ? argv[argv.indexOf('--append-system-prompt') + 1] : '';
const PILOT = /Tu es le pilote/.test(sp);
// Phase 13 PIL: the small-model helpers (docs/pilot.md). Each answers with a file next to the fake, and logs its prompt.
const TRIAGE = /Tu es le trieur/.test(sp); const ROUTE = /Tu es l'aiguilleur/.test(sp); const DELEGATE = /Tu réponds à une question/.test(sp);
const read = (f, d) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return d; } };
const count = (f) => read(f, '').split('\\n').filter(Boolean).length;
const SID = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : (PILOT ? 'pilot-' + (count('pilot-starts.txt') + 1) : 'sess-' + Date.now().toString(36));
if (PILOT) { fs.appendFileSync(path.join(DIR, 'pilot-args.jsonl'), JSON.stringify(argv) + '\\n'); if (!argv.includes('--resume')) fs.appendFileSync(path.join(DIR, 'pilot-starts.txt'), SID + '\\n'); }
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: SID });
let n = 0;
// context.txt: the input tokens of the pilot's turns (the server reads the context share from them); the window is 200000
const turn = (text, cost, ctx) => { const ci = ctx ?? Number(read('context.txt', '10')); out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: ci, output_tokens: 5 } } }); out({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: cost, usage: { input_tokens: ci, output_tokens: 5 }, modelUsage: { 'claude-sonnet-5-5': { contextWindow: 200000 } } }); };
const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : '';
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); if (m.type !== 'user') return; const text = String(m.message.content); n++;
  if (TRIAGE) { fs.appendFileSync(path.join(DIR, 'triage.jsonl'), JSON.stringify({ model, text }) + '\\n'); return turn('\`\`\`escadrille:triage\\n' + read('triage.json', '{"action":"escalate","summary":"à juger"}') + '\\n\`\`\`', 0.002, 300); }
  if (ROUTE) { fs.appendFileSync(path.join(DIR, 'route.jsonl'), JSON.stringify({ model, text }) + '\\n'); return turn('\`\`\`escadrille:route\\n' + read('route.json', '{"route":"pilot"}') + '\\n\`\`\`', 0.002, 300); }
  if (DELEGATE) { fs.appendFileSync(path.join(DIR, 'delegate.jsonl'), JSON.stringify({ model, text, args: argv }) + '\\n'); return turn(read('delegate.txt', 'Réponse déléguée : la seed a un prof avec des statistiques.'), 0.03, 400); }
  if (PILOT) {
    const k = count('pilot.jsonl'); fs.appendFileSync(path.join(DIR, 'pilot.jsonl'), JSON.stringify({ sid: SID, text }) + '\\n');
    if (/^Passation n°/m.test(text)) return turn('\`\`\`escadrille:passation\\nCe qui tourne : rien.\\nCe qui attend Dev : rien.\\nDécisions du jour : aucune.\\nProchaine action : attendre.\\n\`\`\`', 0.05);
    const turns = JSON.parse(read('turns.json', '[]'));
    const at = text.split('\\n').find((l) => /pendingId=/.test(l)) || text; const pick = (re) => (re.exec(at) || [])[1] || '';
    const t = String(turns[k] ?? 'Rien de neuf.').replace(/{{pendingId}}/g, pick(/pendingId=(\\S+)/)).replace(/{{plan}}/g, pick(/plan=(\\S+)/)).replace(/{{session}}/g, pick(/session=(\\S+)/));
    const delay = Number(read('delay.txt', '0')); // ms: a long pilot turn (the conversation must not wait for it)
    return setTimeout(() => turn(t, Number(read('cost.txt', '0.5'))), delay);
  }
  if (m.type === 'control_response') return; // the answer to a permission: the turn below closes itself
  fs.appendFileSync(path.join(DIR, 'session.jsonl'), JSON.stringify({ sid: SID, text }) + '\\n');
  // Phase 13 PIL: a message « ASK: <commande> » makes the session ask that permission over the control channel, then close its turn
  const ask = /^ASK: (.+)$/m.exec(text); if (ask) out({ type: 'control_request', request_id: 'req-' + n, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: ask[1] } } });
  const say = n === 1 ? read('session.txt', 'Fini le tour.') : 'Bien reçu.';
  turn(say + '\\n\\n\`\`\`escadrille:state\\n' + JSON.stringify({ stops: [0], health: 'ok', why: '', claude: say.split('\\n')[0], summary: 'Fait : un tour\\nReste : la suite', done: false }) + '\\n\`\`\`', 0.01);
});
`); chmodSync(file, 0o755);
  return { dir, file };
};
