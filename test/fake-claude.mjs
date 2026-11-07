// A fake `claude` that speaks stream-json for the tests and the local trials. Each turn asks one
// permission over the control channel, says what the answer was and closes with a state block:
//   1. curl http://x   (network: an "always" must not cover the next one)
//   2. curl http://y   (asks again)
//   3. rm -f out.txt   (an "always" here covers the next one)
//   4. rm -f out2.txt  (let through without asking), then done
// FAKE_CLAUDE_WEEKLY: the weekly shares of its rate_limit_event, one per turn (docs/limits.md); FAKE_CLAUDE_RESET_S: its reset in
// that many seconds (3 days by default).
// FAKE_CLAUDE_TURNS: other turns, each { command?, hold?, write?, writeFrom?, run?, prose?, stops, claude, done?, releases? } (no command: no permission asked;
// releases: copied into the state block, docs/sessions.md « Les fusions de release »).
// Its arguments land in args.json next to it (every launch in args.jsonl), every prompt it receives in prompts.jsonl ({ session_id, text }).
// Its session id grows with each launch (sess-9, sess-10…) unless --resume gives one.
// Its total_cost_usd counts the whole Claude session, as Claude Code does: under --resume it starts from what
// that session id had already cost (kept in cost-<id> next to it), then each turn adds FAKE_CLAUDE_TURN_COST
// (default 0.01 $). With FAKE_CLAUDE_ENFORCE_CAP=1 it holds --max-budget-usd on that total, as Claude Code
// does: a turn that reaches it ends in error_max_budget_usd.
//
// With FAKE_CLAUDE_CONTEXT_WINDOW=<tokens> (and FAKE_CLAUDE_CONTEXT_STEP=<tokens>, default 250) it plays a
// context that climbs instead: no permission asked, turn k reads 2 + k × step input tokens of that window,
// each turn costs 0.01 $ more, the state block carries a summary; and when a message names a
// .escadrille/passation.md file, it writes it (what is done, what is left) and closes the turn, as the
// handoff asks. FAKE_CLAUDE_DONE_AT=k: turn k of a process that starts from a handoff writes and commits docs/essai.txt and says done.
import { writeFileSync, chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const TURNS = [
  { command: 'curl -s http://x', rule: 'curl:*', stops: [0], claude: 'Regarde docs/essai.txt' },
  { command: 'curl -s http://y', rule: 'curl:*', stops: [0], claude: 'Regarde docs/essai.txt' },
  { command: 'rm -f out.txt', rule: 'rm:*', stops: [0], claude: 'Regarde docs/essai.txt' },
  { command: 'rm -f out2.txt', rule: 'rm:*', stops: [0, 1], claude: 'Tout est dans docs/', done: true },
];

export const fakeClaude = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-')));
  const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const DIR = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(DIR, 'args.json'), JSON.stringify(argv)); fs.appendFileSync(path.join(DIR, 'args.jsonl'), JSON.stringify(argv) + '\\n');
let launches = 0; try { launches = Number(fs.readFileSync(path.join(DIR, 'launches'), 'utf8')); } catch {}
fs.writeFileSync(path.join(DIR, 'launches'), String(++launches));
const SID = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : 'sess-' + (8 + launches);
const W = Number(process.env.FAKE_CLAUDE_CONTEXT_WINDOW || 0); const STEP = Number(process.env.FAKE_CLAUDE_CONTEXT_STEP || 250);
const TURNS = process.env.FAKE_CLAUDE_TURNS ? JSON.parse(process.env.FAKE_CLAUDE_TURNS) : ${JSON.stringify(TURNS)}; // FAKE_CLAUDE_TURNS: other commands to ask for
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: SID });
let n = 0; let fresh = false;
const COST = Number(process.env.FAKE_CLAUDE_TURN_COST || 0.01); const COST_FILE = path.join(DIR, 'cost-' + SID);
const CAP = argv.includes('--max-budget-usd') ? Number(argv[argv.indexOf('--max-budget-usd') + 1]) : null;
let restored = 0; if (argv.includes('--resume')) { try { restored = Number(fs.readFileSync(COST_FILE, 'utf8')) || 0; } catch {} }
const finish = (prose, state) => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: prose + '\\n\\n\`\`\`escadrille:state\\n' + JSON.stringify(state) + '\\n\`\`\`' }] } });
  const total = Math.round((restored + COST * n) * 1e6) / 1e6; fs.writeFileSync(COST_FILE, String(total));
  const over = !!process.env.FAKE_CLAUDE_ENFORCE_CAP && CAP !== null && total >= CAP;
  out({ type: 'result', subtype: over ? 'error_max_budget_usd' : 'success', is_error: over, num_turns: n, total_cost_usd: total, usage: { input_tokens: 2 + (W ? n * STEP : 0), cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, modelUsage: { 'claude-sonnet-5-5': { contextWindow: W || 1000 } } });
  if (state.done) process.exit(0);
};
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'user') {
    const text = String(m.message.content); n++;
    // FAKE_CLAUDE_WEEKLY=0.5,0.85,0.97: the weekly share its rate_limit_event says at turn k (the last one after), counted across launches
    if (process.env.FAKE_CLAUDE_WEEKLY) { const ws = process.env.FAKE_CLAUDE_WEEKLY.split(',').map(Number); let k = 0; try { k = Number(fs.readFileSync(path.join(DIR, 'rate-turns'), 'utf8')) || 0; } catch {} fs.writeFileSync(path.join(DIR, 'rate-turns'), String(k + 1)); out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: ws[Math.min(k, ws.length - 1)], resetsAt: Math.floor(Date.now() / 1000) + Number(process.env.FAKE_CLAUDE_RESET_S || 3 * 86400) } } } }); }
    // FAKE_CLAUDE_FABLE_FILE=<file>: a rate_limit_event with the Fable weekly share written in that file (0..1), read at each turn
    if (process.env.FAKE_CLAUDE_FABLE_FILE) { const u = Number(fs.readFileSync(process.env.FAKE_CLAUDE_FABLE_FILE, 'utf8')); out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day_fable: { utilization: u, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 } } } }); }
    fs.appendFileSync(path.join(DIR, 'prompts.jsonl'), JSON.stringify({ session_id: SID, text }) + '\\n');
    const hand = /(\\S+\\/\\.(?:calmdev|escadrille)\\/passation\\.md)/.exec(text);
    if (hand) { fs.mkdirSync(path.dirname(hand[1]), { recursive: true }); fs.writeFileSync(hand[1], 'Fait : les tours 1 à ' + (n - 1) + ' de la session ' + SID + '.\\nReste : la fin.\\nFichiers : docs/essai.txt\\n'); return finish('Passation écrite.', { stops: [0], health: 'ok', why: '', claude: 'Passation écrite', done: false }); }
    if (W) {
      if (n === 1) fresh = /^# Passation/.test(text);
      const done = fresh && n === Number(process.env.FAKE_CLAUDE_DONE_AT || 0); // this process's turn k writes docs/essai.txt, commits it and says done
      if (done) { fs.mkdirSync('docs', { recursive: true }); fs.writeFileSync('docs/essai.txt', 'fait par ' + SID + '\\n'); require('node:child_process').execFileSync('git', ['add', '.']); require('node:child_process').execFileSync('git', ['commit', '-qm', 'essai: docs/essai.txt']); }
      return finish('Tour ' + n + '.', { stops: done ? [0, 1] : [0], health: 'ok', why: '', claude: 'Tour ' + n, summary: 'Fait : tour ' + n + '\\nReste : ' + (done ? 'rien' : 'la suite'), done });
    }
    const t = TURNS[n - 1];
    // write: a file written and committed in its folder before the turn ends; no command: the turn ends without asking
    // writeFrom: the same, at the first path of the prompt matching this pattern (one fake for sessions that write different files)
    if (t.writeFrom) { const w = new RegExp(t.writeFrom).exec(text); if (w) t.write = w[0]; }
    // run: a shell command played in its folder before the turn ends (a git mv, a commit made with git plumbing)
    if (t.run) require('node:child_process').execSync(t.run, { stdio: 'ignore', shell: '/bin/sh' });
    if (t.write) { fs.mkdirSync(path.dirname(t.write), { recursive: true }); fs.writeFileSync(t.write, 'écrit au tour ' + n + '\\n'); require('node:child_process').execFileSync('git', ['add', '.']); require('node:child_process').execFileSync('git', ['commit', '-qm', 'turn ' + n]); }
    // hold: the turn takes that many ms before its answer (a turn still running when the server acts)
    const end = () => finish(t.prose || 'Tour ' + n + '.', { stops: t.stops, health: 'ok', why: '', claude: t.claude || 'Tour ' + n, done: t.done && typeof t.done === "object" ? t.done : !!t.done, ...(t.releases ? { releases: t.releases } : {}) });
    if (!t.command) { if (t.hold) { setTimeout(end, t.hold); return; } return end(); }
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: t.command } }] } });
    out({ type: 'control_request', request_id: 'req-' + n, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: t.command }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: t.rule }], behavior: 'allow', destination: 'localSettings' }] } });
    return;
  }
  const t = TURNS[n - 1]; const r = m.response.response;
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: r.behavior === 'allow' ? 'ok' : r.message, is_error: r.behavior !== 'allow' }] } });
  finish(r.behavior === 'allow' ? 'La commande a dit ok.' : 'Refusé : ' + r.message, { stops: t.stops, health: 'ok', why: '', claude: t.claude, done: t.done && typeof t.done === "object" ? t.done : !!t.done });
});
`); chmodSync(file, 0o755);
  return { dir, file };
};
