#!/usr/bin/env node
// POL (Dev, 7 November): the PreToolUse hook of a main conversation (docs/pilot.md, « Le garde-fou suit la cible »).
// Claude Code gives the call on stdin ({ cwd, tool_name, tool_input, … }); the hook asks POST /api/policy/check of the
// local server and answers Claude Code's way: { hookSpecificOutput: { hookEventName, permissionDecision, … } }.
// Node 22, no dependency. The server absent, slow or in error: `ask` with the way, except an obvious push or post,
// refused locally by lib/policycheck.mjs.
//
//   node scripts/policy-hook.mjs [--port 3078] [--pilot]
//   the pilot's token: CALMDEV_PILOT_TOKEN (or ESCADRILLE_PILOT_TOKEN) when it is there; with --pilot, else the file
//   <config>/pilot-token (CALMDEV_GUARD_DIR, else ~/.config/calmdev) — the server's own pilot, whose environment drops *TOKEN*
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const env = process.env;
const port = Number(arg('--port') || env.CALMDEV_PORT || env.ESCADRILLE_PORT || 3078);
const timeoutMs = Number(env.CALMDEV_POLICY_TIMEOUT_MS || 3000);

const tokenOf = () => {
  const given = String(env.CALMDEV_PILOT_TOKEN || env.ESCADRILLE_PILOT_TOKEN || '').trim(); if (given.length >= 32) return given;
  if (!argv.includes('--pilot')) return '';
  const dir = env.CALMDEV_GUARD_DIR || env.ESCADRILLE_GUARD_DIR || path.join(homedir(), '.config', 'calmdev');
  try { return readFileSync(path.join(dir, 'pilot-token'), 'utf8').trim(); } catch { return ''; }
};

const answer = (decision, reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }) + '\n');
  process.exit(0);
};

const readStdin = async () => { const chunks = []; for await (const c of process.stdin) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };

// The server absent or in error: `ask`, but an obvious push, post or secret read is refused here, by the same rule read locally
// (lib/policycheck.mjs, no registry, no pilot list: so no push at all)
const WAKE = `lance le serveur calmdev (npm start dans son dossier, port ${port}), ou accepte cet appel toi-même dans Claude Code`;
const offline = async (call, why) => {
  try {
    const { check } = await import(new URL('../lib/policycheck.mjs', import.meta.url));
    const r = check({ cwd: call.cwd, tool: call.tool_name, input: call.tool_input || {}, caller: 'conversation' });
    if (r.decision === 'deny' && ['git-push', 'post', 'secret'].includes(r.rule)) return answer('deny', `calmdev : ${why}, refus local : ${r.why} — Le chemin qui marche : ${r.path}`);
  } catch { /* the rule unreadable: ask */ }
  return answer('ask', `calmdev : ${why} — Le chemin qui marche : ${WAKE}`);
};

const main = async () => {
  let call; try { call = JSON.parse(await readStdin()); } catch { return answer('ask', 'calmdev : appel illisible — Le chemin qui marche : Claude Code envoie l’appel en JSON sur stdin ; sinon accepte-le toi-même dans Claude Code'); }
  const token = tokenOf();
  let r;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/policy/check`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', ...(token ? { 'x-escadrille-pilot': token } : {}) },
      body: JSON.stringify({ cwd: call.cwd, tool: call.tool_name, input: call.tool_input || {} }),
    });
    if (!res.ok) return offline(call, `la règle a répondu ${res.status}`);
    r = await res.json();
  } catch { return offline(call, `calmdev absent (port ${port})`); }
  const decision = ['allow', 'deny', 'ask'].includes(r?.decision) ? r.decision : 'ask';
  const reason = [r?.why, decision !== 'allow' && r?.path ? `Le chemin qui marche : ${r.path}` : ''].filter(Boolean).join(' — ') || 'calmdev';
  return answer(decision, `calmdev : ${reason}`);
};
main();
