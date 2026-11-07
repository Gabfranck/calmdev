// Run by hand (node test/control.probe.mjs), not under node --test: does `claude -p` over stream-json
// send a control_request for a tool outside --allowedTools, accept our control_response, stay alive
// between two turns and send a result each turn? The verdict is in docs/sessions.md.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
if (process.env.NODE_TEST_CONTEXT) process.exit(0); // a script run by hand, not a test: node --test picks every .mjs under test/
const require = createRequire(import.meta.url);
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--permission-mode', process.env.MODE || 'default', '--allowedTools', 'Read', '--model', process.env.MODEL || 'claude-haiku-5-5'];
const child = spawn('claude', args, { cwd: process.env.CWD || process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const user = (text) => send({ type: 'user', message: { role: 'user', content: text } });
let turn = 0;
createInterface({ input: child.stdout }).on('line', (line) => {
  const ev = JSON.parse(line);
  const keep = ev.type === 'control_request' || ev.type === 'result' ? ev : { type: ev.type, subtype: ev.subtype, content: ev.message?.content?.map((c) => (c.type === 'text' ? c.text : c.type === "tool_use" ? { tool_use: c.name, input: c.input } : c.type === "tool_result" ? { tool_result: String(c.content).slice(0, 200), is_error: c.is_error } : c.type)) };
  console.log(JSON.stringify(ev.type === "system" && ev.subtype === "init" ? { init: { permissionMode: ev.permissionMode, tools: ev.tools?.length, model: ev.model } } : keep).slice(0, 1200));
  if (ev.type === 'control_request' && ev.request?.subtype === 'can_use_tool') send({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: process.env.DENY ? { behavior: 'deny', message: 'Refusé par le développeur : pas de curl ce soir.' } : { behavior: 'allow', updatedInput: ev.request.input } } });
  if (ev.type === 'result') { turn++; if (turn === 1) user('Merci. Maintenant dis seulement « deuxième tour ».'); else child.stdin.end(); }
});
child.on('exit', (code) => console.log('exit', code, 'turns', turn));
user(process.env.PROMPT_FILE ? require('node:fs').readFileSync(process.env.PROMPT_FILE, 'utf8') : 'Exécute `echo bonjour` avec l’outil Bash et dis-moi ce qu’il affiche, en une ligne.');
