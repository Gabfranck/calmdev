// One Claude Code process driven over stream-json: the planning session of an escadrille, and every
// session of a plan launched from the page. The server writes the developer's turns on its stdin and
// reads, line by line, what the session does, says and asks. Nothing from the browser reaches a
// shell: the folder and the model are checked here, the text travels as JSON on stdin.
//
//   const p = startSession({ cwd, model, systemPrompt, resume, budget, allowedTools, permissionMode, permissionPrompt, onEvent })
//                                   budget: the cap in US dollars, passed as --max-budget-usd when given
//   const p = startPlanner({ … })   the same, read-only and never asking (the planning session)
//   p.send(text)                    one user turn; what is sent while a turn runs waits and leaves in ONE turn after it
//                                   (lib/coalesce.mjs joinMessages, phase 14 RAF); p.held: how many wait
//   p.interrupt()                   cuts the running turn (stream-json control_request interrupt); what waits leaves next
//   p.answer(id, { allow, always, message })   the developer's answer to an 'ask'
//   p.busy                          true while the session works on a turn
//   p.stop()                        closes stdin, kills after 3 s
//
// onEvent receives:
//   { type: 'init', sessionId }
//   { type: 'text', text }                       an assistant text block (one message may hold several)
//   { type: 'block', name, json }                a closed ```escadrille:<name> block found in a text (json parsed, or error)
//   { type: 'activity', text }                   a tool call, said in words ("lit README.md")
//   { type: 'ask', id, tool, input, text, network }  the session needs a permission (permissionPrompt only); answer(id, …);
//                                                network: an access outside localhost, which "always" never covers
//   { type: 'turn', usage, cost, model, turns }  the end of a turn
//   { type: 'quota', weekly, resetsAt }          the weekly quota share (0..1), when Claude Code says it
//   { type: 'error', text }
//   { type: 'exit', code }
import { joinMessages } from './coalesce.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { vars, PROJECT_DIR, CONFIG_LABEL, LEGACY_CONFIG_LABEL } from './names.mjs';
import { findBlocks } from './blocks.mjs';
import { withFrugal } from './frugal.mjs';
import { isModel } from './models.mjs';
import { which } from './terminal.mjs';
import { windowsOf } from './status.mjs';


// What the planning session may do in the project: read it, and ask git. Nothing writes.
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git branch:*)', 'Bash(git diff --stat:*)', 'Bash(ls:*)', 'Bash(wc:*)'];
// What a launched session may do on its own, in its worktree. Everything else (git push, rm, curl,
// open, a path outside the worktree) goes through the permission channel and up to the page. No
// entry here may reach the network: see isNetwork, the rule that any access outside localhost asks.
// No `cat`, `head` or `wc` here: a whitelisted `cat` reads any file on the Mac without asking, while the
// Read tool asks for anything outside the session's folders. `node` stays, and is the known hole (a
// script can read or reach anything): the sandbox of Claude Code is the answer, phase 4.
export const SESSION_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git branch:*)', 'Bash(git checkout:*)', 'Bash(git rebase:*)', 'Bash(git merge:*)', 'Bash(git worktree list:*)',
  'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(ls:*)'];

// The environment a session inherits: the developer's shell exports every key it has (an OpenAI key in
// .zshrc, cloud tokens…); none of them is the session's business. Only what Claude Code itself needs
// goes through. Values never reach the page or the logs.
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
export const KEEP_ENV = /^(CLAUDE_|ANTHROPIC_|CLAUDE_CODE_)/;
// git config passed through the environment goes whole or not at all: GIT_CONFIG_KEY_0 looks like a key and is stripped, GIT_CONFIG_COUNT left alone breaks every git call
const GIT_ENV_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
// What the session gets on top, whatever it inherited: npm runs no install script (a booby-trapped package runs through its postinstall)
export const ADDED_ENV = { npm_config_ignore_scripts: 'true' };
export const safeEnv = (env) => { const out = {}; for (const [k, v] of Object.entries(env)) { if (k === 'CLAUDE_CODE_SIMPLE' || GIT_ENV_CONFIG.test(k)) continue; if (SECRET_NAME.test(k) && !KEEP_ENV.test(k)) continue; if (k.toLowerCase() === 'npm_config_ignore_scripts') continue; out[k] = v; }
  Object.assign(out, ADDED_ENV);
  // The sandbox shell does not source nvm: the node that runs this server comes first on the PATH
  const bin = path.dirname(process.execPath); out.PATH = [bin, ...String(out.PATH || '').split(':').filter((p) => p && p !== bin)].join(':'); return out; };

// A tool call said in words, for the activity strip of the chat
export const describeTool = (name, input = {}, cwd = '') => {
  const short = (p) => { p = String(p ?? ''); if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1); return p.replace(/^\/Users\/[^/]+\//, '~/'); };
  switch (name) {
    case 'Read': return `lit ${short(input.file_path)}`;
    case 'Write': return `écrit ${short(input.file_path)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `modifie ${short(input.file_path || input.notebook_path)}`;
    case 'Glob': return `cherche ${input.pattern || ''}`.trim();
    case 'Grep': return `grep ${input.pattern || ''}`.trim();
    case 'Bash': return `${String(input.command || '').split('\n')[0].slice(0, 80)}`;
    case 'WebFetch': case 'WebSearch': return `consulte ${input.url || input.query || ''}`;
    default: return name;
  }
};

// The network rule: any access outside localhost (curl, wget, fetch, git push or pull, npm install,
// ssh, a web tool…) asks the developer, without exception: no whitelist entry covers it, and an
// "always" never remembers it. (A script run by node or npm can still reach out: that stays a limit.)
const NET_CMD = /(^|[\s;&|(])(curl|wget|http|https|xh|nc|ncat|telnet|ssh|scp|sftp|rsync|ftp|gh|hub|brew|pip3?|pipx|gem|cargo|go|npx|pnpx|bunx)\s|(^|[\s;&|(])git\s+(push|pull|fetch|clone|remote|ls-remote|submodule)\b|(^|[\s;&|(])(npm|pnpm|yarn|bun|deno|uv)(\s*($|[;&|)])|\s+(install|i|ci|add|update|upgrade|publish|exec|dlx|x|create|init|pack|audit|outdated|view|info|login)\b)/;
const LOCAL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/;
const hostsOf = (s) => [...String(s).matchAll(/(?:https?:\/\/|\b[\w.-]+@)?([\w.-]+\.[a-z]{2,}|localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?/gi)].map((m) => m[0]);
// A quoted argument that is not one URL or one host (a JSON body, a sentence: a space, or {, [ or @ first) is data, not a
// destination: dropped before looking for hosts, so a curl to localhost whose body says "decisions.md" stays local
const unquoteData = (cmd) => cmd.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (m, a, b) => { const v = a ?? b; return /\s|^[{[@]/.test(v) || !v ? ' _ ' : m; }); // a token kept: -H 'a: b' still has its value
// The command cut at ; & | ( ) and newlines (quoted data already blanked), shell keywords and the `time`/`env` prefixes dropped
const KEYWORD = /^(time|env|command|nohup|then|do|else|elif|!|\{)$/;
const piecesOf = (cmd) => unquoteData(cmd).split(/[;&|()\n]+/).map((p) => { const w = p.trim().split(/\s+/).filter(Boolean); while (w.length && (KEYWORD.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w.shift(); return w; }).filter((w) => w.length);
const HTTP_TOOL = /^(curl|wget|xh|http|https)$/;
// The options of curl, wget, xh whose value is a file, a header, a body or a number, never a destination
const FILE_OPT = /^(-o|--output|-O|--output-document|-D|--dump-header|-c|--cookie-jar|-b|--cookie|-K|--config|-T|--upload-file|-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-H|--header|-X|--request|-w|--write-out|-m|--max-time|--connect-timeout|--retry|-A|--user-agent|-e|--referer|-r|--range|-u|--user|-E|--cert|--cacert|-P|--directory-prefix|--post-data|--post-file|--body-file|--input-file|--append-output|-[a-zA-Z]+[oODHdXwmFTbcKeAuPr])$/; // -so out.json, -sH 'x: y'
// The destinations of one curl/wget/xh: its words that are not options, option values, redirections or @files
const destinationsOf = (w) => {
  const out = [];
  for (let i = 1; i < w.length; i++) {
    const v = w[i];
    if (/^\d*>>?$|^<$/.test(v)) { i++; continue; } // > out.json, 2> err.log
    if (/^\d*[<>]/.test(v)) continue; // >out.json, 2>&1
    if (FILE_OPT.test(v)) { i++; continue; }
    if (v.startsWith('-') || v.startsWith('@')) continue;
    out.push(v);
  }
  return out;
};
// FIAB 4 (6 November): one destination, one host, read on the URL alone (scheme, user, port, path, query and fragment
// dropped), so `curl localhost:3078/docs/decisions.md?x=a.io` stays local and `127.0.0.1.evil.com` stays network
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;
export const destHost = (d) => {
  let s = String(d || '').replace(/^['"]+|['"]+$/g, '').replace(/^[a-z][\w+.-]*:\/\//i, '');
  s = s.split(/[/?#]/)[0].replace(/^[^@]*@/, '');
  if (s.startsWith('[')) return s.includes(']') ? s.slice(0, s.indexOf(']') + 1) : '';
  if (/^[0-9a-f:]+$/i.test(s) && s.includes('::')) return s; // ::1, bare
  return s.replace(/:\d{1,5}$/, '');
};
const isLocalDest = (d) => LOCAL_HOST.test(destHost(d));
export const isNetwork = (tool, input = {}) => {
  if (tool === 'WebFetch' || tool === 'WebSearch') return !LOCAL.test(String(input.url || ''));
  if (/^mcp__/.test(tool)) return true;
  if (tool !== 'Bash') return false;
  const cmd = String(input.command || '');
  if (!NET_CMD.test(cmd)) return false;
  // Piece by piece: a curl/wget/xh whose every destination is loopback (localhost, 127.0.0.1, [::1], with a port, options,
  // a redirection or a body) is local; any other network command, a URL outside the machine anywhere, or a curl with no
  // readable destination asks. File names next to the curl (server.mjs, > out.json, -d @body.json) are not hosts.
  // Every other network command, read on the raw command (a `bash -c "cd x && git push"` asks; a word in a commit message
  // asks too, and lib/policy.mjs tells it apart as quoted-word)
  for (const p of cmd.split(/[;&|()\n]+/)) { const w = p.trim().split(/\s+/).filter(Boolean); while (w.length && (KEYWORD.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w.shift(); if (w.length && !HTTP_TOOL.test(w[0]) && NET_CMD.test(w.join(' '))) return true; }
  for (const w of piecesOf(cmd)) {
    if (HTTP_TOOL.test(w[0])) { const dests = destinationsOf(w); if (!dests.length || !dests.every(isLocalDest)) return true; continue; }
    const line = w.join(' ');
    if (NET_CMD.test(line)) return true;
    for (const m of line.matchAll(/https?:\/\/[^\s'"`)]+/g)) if (!isLocalDest(m[0])) return true; // node -e "fetch('https://…')"
  }
  return false;
};

// Does a permission rule remembered by "always" cover this call? Rules come from Claude Code's own
// suggestions ("git push origin main", "rm:*"): the same command, or the prefix before ":*".
const covers = (rule, tool, input) => {
  if (rule.tool !== tool) return false;
  if (!rule.content) return true;
  const cmd = tool === 'Bash' ? String(input.command || '') : String(input.file_path || input.notebook_path || '');
  return rule.content.endsWith(':*') ? cmd.startsWith(rule.content.slice(0, -2)) : cmd === rule.content;
};

// Every session Escadrille launches runs its commands in Claude Code's sandbox (verified on 2026-11-01
// with claude -p --settings: a read of ~/.ssh fails with "Operation not permitted", an outgoing
// connection fails, a write in the session's folder works). Writes stay in the session's folders,
// the developer's keys are unreadable, and no network leaves the Mac but the plan's domains
// (sandboxSettings below, plan.network, empty by default). failIfUnavailable: a session that cannot be sandboxed does
// not start. The file tools are held by blockReadsOutsideWorkingDirectories.
// allowLocalBinding: a session may open a local port (the sessions Escadrille launches on Escadrille
// itself run `node --test`, which starts the server on a spare port; a dev server needs it too).
const SANDBOX_BASE = {
  sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, network: { allowedDomains: [], allowLocalBinding: true },
    filesystem: { denyRead: ['~/.ssh', '~/.aws', '~/.config/gcloud', '~/.config/gh', '~/.config/stripe', '~/.config/scw', '~/.npmrc', '~/.docker', '~/.expo', '~/.netrc', '~/.kube', '~/.zshrc', '~/.zprofile', '~/.zshenv', '~/.bash_profile', CONFIG_LABEL, LEGACY_CONFIG_LABEL] } }, // both: the old path is a link, and the sandbox resolves links
  permissions: { blockReadsOutsideWorkingDirectories: true, deny: ['Read(//**/.env)', 'Read(//**/.env.*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gcloud/**)', 'Read(~/.config/gh/**)', 'Read(~/.config/stripe/**)', 'Read(~/.npmrc)', 'Read(~/.docker/**)', 'Read(~/.expo/**)'] },
};

// The same settings for each platform: Claude Code isolates by Seatbelt on macOS and by bubblewrap (bwrap,
// with socat for the network proxy) on Linux, under the same keys (docs/linux.md, unverified on a real Linux).
// Linux adds its own shell files to the unreadable ones (macOS already denies ~/.zshrc and ~/.bash_profile).
const LINUX_DENY_READ = ['~/.bashrc', '~/.profile'];
export const sandboxSettingsFor = (platform = process.platform) => (platform !== 'linux' ? SANDBOX_BASE : {
  ...SANDBOX_BASE,
  sandbox: { ...SANDBOX_BASE.sandbox, filesystem: { ...SANDBOX_BASE.sandbox.filesystem, denyRead: [...SANDBOX_BASE.sandbox.filesystem.denyRead, ...LINUX_DENY_READ] } },
});
export const SANDBOX_SETTINGS = sandboxSettingsFor();
// Can a session be sandboxed here? macOS: Seatbelt is built in. Linux: bwrap and socat on the PATH.
// Elsewhere (Windows outside WSL2): no. → { ok, missing, note }; the server says it at start, startSession refuses.
export const sandboxStatus = ({ platform = process.platform, which: lookup = (n) => which(n) } = {}) => {
  if (platform === 'darwin') return { ok: true, missing: [], note: '' };
  if (platform !== 'linux') return { ok: false, missing: [], note: `pas de bac à sable Claude Code sur ${platform} (sous Windows : WSL2)` };
  const missing = ['bwrap', 'socat'].filter((n) => !lookup(n));
  if (!missing.length) return { ok: true, missing, note: '' };
  return { ok: false, missing, note: `${missing.join(' et ')} absent${missing.length > 1 ? 's' : ''} du PATH : installe bubblewrap et socat (sudo apt install bubblewrap socat)` };
};
// The domains a plan opens to its sessions (plan.network): host names only, "api.github.com" or
// "*.npmjs.org"; no scheme, path, port or bare wildcard. → { domains, errors } (errors null when all are good)
const HOST = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const validateDomains = (list) => {
  if (!Array.isArray(list)) return { domains: [], errors: ['network doit être une liste de noms d’hôte'] };
  const domains = []; const errors = [];
  for (const d of list) {
    const h = typeof d === 'string' ? d.trim().toLowerCase().replace(/\.$/, '') : '';
    if (!h) { errors.push(`domaine vide ou pas une chaîne : ${JSON.stringify(d)}`); continue; }
    if (/[/:@?#\s]/.test(h)) { errors.push(`${h} : un nom d’hôte, pas une URL (ni schéma, ni port, ni chemin)`); continue; }
    if (!HOST.test(h) || !/\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(h.replace(/^\*\./, ''))) { errors.push(`${h} : pas un nom d’hôte (un joker seul n’ouvre rien : écris *.exemple.com)`); continue; }
    if (!domains.includes(h)) domains.push(h);
  }
  return { domains, errors: errors.length ? errors : null };
};
// The sandbox of a session of that plan: SANDBOX_SETTINGS, its network opened to the plan's domains (the bad ones dropped)
export const sandboxSettings = (network = []) => {
  const domains = validateDomains(Array.isArray(network) ? network : []).domains;
  return { ...SANDBOX_SETTINGS, sandbox: { ...SANDBOX_SETTINGS.sandbox, network: { ...SANDBOX_SETTINGS.sandbox.network, allowedDomains: domains } } };
};

// The files of its worktree the sandbox refuses to a session (lib/guardrails.mjs sandboxGuard puts them in denyWrite),
// said plainly: five sessions of 2 November believed server.mjs and lib/planner.mjs refused and left patches to the pilot
// PIL (night of 3 November): sessions still rewrote files by script, refused about ten times; one sentence in every session
export const EDIT_RULE = "Un fichier ne se modifie qu'avec Edit ou Write ; un script qui réécrit un fichier (sed -i, python, node et writeFileSync, heredoc, cat >>) est refusé.";
// Dev, 2026-11-03 19:45 (« ne jamais montrer un bouton qui ne marche pas »): renaming a project failed because a fix left
// in docs/ was never applied; for every project, one sentence in every session, beside EDIT_RULE (lib/leftfixes.mjs holds the end)
export const BUTTON_RULE = "Chaque bouton visible est relié à un comportement qui marche, sinon il est caché ; la revue le vérifie, et le robot des clics aussi quand le projet en a un (« BOUTON MORT »). Un correctif laissé à appliquer à la main (docs/correctif-*.md, .patch dans " + PROJECT_DIR + "/) t'empêche de te dire finie tant qu'il ne porte pas « Statut : appliqué (<commit>) » ou « Statut : confié au pilote ».";
export const writeNote = (settings, cwd) => {
  if (!cwd) return '';
  const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  const files = (settings?.sandbox?.filesystem?.denyWrite || []).filter((p) => String(p).startsWith(root)).map((p) => p.slice(root.length));
  if (!files.length) return '';
  return `Fichiers de ton worktree refusés en écriture : ${files.join(', ')}. Tout le reste, server.mjs et lib/planner.mjs compris, s'écrit et se commite normalement, et se relit à la fusion.`;
};
export const startSession = ({ cwd, model, systemPrompt, resume, budget, allowedTools = SESSION_TOOLS, permissionMode = 'default', permissionPrompt = true, onEvent, claude = vars.CLAUDE || 'claude', settings = SANDBOX_SETTINGS , addDirs = [], platform = process.platform }) => {
  if (!cwd || !existsSync(cwd)) throw new Error('le dossier du projet n’existe pas');
  // Phase 3's rule: no session outside the sandbox. Claude Code refuses too (failIfUnavailable); this says why, before spawning
  if (settings?.sandbox?.enabled && settings.sandbox.failIfUnavailable) { const sb = sandboxStatus({ platform }); if (!sb.ok) throw new Error('bac à sable indisponible : ' + sb.note); }
  if (!isModel(model)) throw new Error('modèle inconnu');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', permissionMode, '--allowedTools', ...allowedTools];
  if (permissionPrompt) args.push('--permission-prompt-tool', 'stdio');
  // The cap in dollars: Claude Code (2.1.316, "only works with --print") stops the session by itself when it is reached
  if (Number.isFinite(budget) && budget > 0) args.push('--max-budget-usd', String(budget));
  if (settings) args.push('--settings', JSON.stringify(settings));
  // Folders a plan opens to its sessions' file tools beyond the worktree (a library next door): reads
  // only, the sandbox still holds writes to the worktree
  for (const d of addDirs) if (d && existsSync(d)) args.push('--add-dir', d);
  const note = writeNote(settings, cwd); const sys = [systemPrompt, note, systemPrompt ? EDIT_RULE : '', systemPrompt ? BUTTON_RULE : ''].filter(Boolean).join('\n\n'); // the rule rides the session's own prompt, never alone
  if (sys) args.push('--append-system-prompt', sys);
  if (resume) args.push('--resume', resume);
  const child = spawn(claude, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: safeEnv(process.env) });
  const state = { busy: false, sessionId: resume || null, queue: [], child, exited: false, asks: new Map(), rules: [] };
  const emit = (e) => { try { onEvent && onEvent(e); } catch (err) { console.error('session onEvent', err); } };
  // A write after the process ended (a stop, a handoff, a crash) must not take the server down:
  // the stream's own error is swallowed and a queued message is simply dropped.
  child.stdin.on('error', (err) => { if (err && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_WRITE_AFTER_END') console.error('session stdin', err.message); });
  const write = (o) => { if (state.exited || child.stdin.destroyed || child.stdin.writableEnded) return; try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
  const flush = () => { if (state.busy || state.exited || !state.queue.length) return; const text = joinMessages(state.queue.splice(0)); state.busy = true; write({ type: 'user', message: { role: 'user', content: text } }); };
  const respond = (id, response) => write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });

  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf += d; if (errBuf.length > 20000) errBuf = errBuf.slice(-20000); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'system' && ev.subtype === 'init') { if (!state.sessionId || ev.session_id !== state.sessionId) { state.sessionId = ev.session_id; emit({ type: 'init', sessionId: ev.session_id }); } return; }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      // The size of the context on this API call: what the window really holds (a turn's `result`
      // sums every call of the turn, which is not a share of the window)
      const mu = ev.message.usage; if (mu) state.contextInput = (mu.input_tokens || 0) + (mu.cache_creation_input_tokens || 0) + (mu.cache_read_input_tokens || 0);
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) { emit({ type: 'text', text: c.text }); for (const b of findBlocks(c.text)) emit({ type: 'block', name: b.kind, json: b.error ? undefined : b.value, error: b.error, raw: b.raw }); }
        else if (c.type === 'tool_use') emit({ type: 'activity', text: describeTool(c.name, c.input, cwd) });
      }
      return;
    }
    if (ev.type === 'control_request' && ev.request?.subtype === 'can_use_tool') {
      const r = ev.request; const input = r.input || {};
      const network = isNetwork(r.tool_name, input);
      if (!network && state.rules.some((rule) => covers(rule, r.tool_name, input))) { respond(ev.request_id, { behavior: 'allow', updatedInput: input }); emit({ type: 'activity', text: `${describeTool(r.tool_name, input, cwd)} (autorisé d’office)` }); return; }
      const suggested = (r.permission_suggestions || []).flatMap((s) => (s.rules || []).map((x) => ({ tool: x.toolName, content: x.ruleContent || '' })));
      state.asks.set(ev.request_id, { tool: r.tool_name, input, network, rules: network ? [] : suggested.length ? suggested : [{ tool: r.tool_name, content: '' }] });
      emit({ type: 'ask', id: ev.request_id, tool: r.tool_name, input, network, text: describeTool(r.tool_name, input, cwd) });
      return;
    }
    // Every window the event carries goes with it (lib/limits.mjs reads the 5-hour and per-model ones when present)
    if (ev.type === 'rate_limit_event') { const ws = windowsOf(ev); if (ws.weekly || ws.fiveHour || Object.keys(ws.models).length) emit({ type: 'quota', weekly: ws.weekly ? ws.weekly.utilization : undefined, resetsAt: ws.weekly ? ws.weekly.resetsAt : null, windows: ws }); return; }
    if (ev.type === 'result') {
      const u = ev.usage || {}; const mu = ev.modelUsage || {}; const first = Object.keys(mu)[0];
      state.busy = false;
      if (ev.is_error || ev.subtype !== 'success') emit({ type: 'error', text: ev.result || ev.subtype || 'la session a échoué' });
      emit({ type: 'turn', usage: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }, cost: ev.total_cost_usd || 0, model: first || model, turns: ev.num_turns || 1, durationMs: ev.duration_ms || 0, contextWindow: first ? mu[first].contextWindow : undefined, contextInput: state.contextInput ?? null });
      flush();
    }
  });
  child.on('error', (err) => { state.exited = true; emit({ type: 'error', text: `claude : ${err.message}` }); });
  // the signal and the error output's tail ride the exit too: the pilot's death is written in server.log (lib/pilotdeath.mjs)
  child.on('exit', (code, signal) => { state.exited = true; state.busy = false; if (code && errBuf.trim()) emit({ type: 'error', text: errBuf.trim().split('\n').slice(-3).join(' ') }); emit({ type: 'exit', code, signal: signal || null, stderr: errBuf.slice(-2000) }); });

  return {
    get busy() { return state.busy; }, get sessionId() { return state.sessionId; }, get exited() { return state.exited; }, get pid() { return child.pid; },
    get held() { return state.queue.length; },
    interrupt: () => { if (!state.busy || state.exited) return false; write({ type: 'control_request', request_id: 'interrupt-' + Date.now(), request: { subtype: 'interrupt' } }); return true; },
    send: (text) => { if (state.exited) throw new Error('la session est terminée'); state.queue.push(String(text)); flush(); },
    answer: (id, { allow, always, message } = {}) => {
      const ask = state.asks.get(id); if (!ask) throw new Error('demande inconnue'); state.asks.delete(id);
      if (allow) { if (always) state.rules.push(...ask.rules); respond(id, { behavior: 'allow', updatedInput: ask.input }); }
      else respond(id, { behavior: 'deny', message: message || 'Refusé par le développeur.' });
      return ask;
    },
    stop: () => { try { child.stdin.end(); } catch {} setTimeout(() => { if (!state.exited) child.kill(); }, 3000).unref(); },
  };
};

// The planning session: read-only, never asks (anything that would prompt is denied)
export const startPlanner = (opts) => startSession({ allowedTools: READ_ONLY_TOOLS, permissionMode: 'dontAsk', permissionPrompt: false, settings: withFrugal(SANDBOX_SETTINGS), ...opts });
