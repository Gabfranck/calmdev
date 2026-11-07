#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher Read), see docs/frugal.md.
// Read: refuses once, with the JSON output form, a read that lib/frugal.mjs's decide turns down; the same read
// tried again within 30 minutes passes (an image first goes through Haiku: a capture that is empty, stuck on a
// sign-in screen or an error is refused once more with Haiku's line; a third try passes whatever it said).
// Bash is never rewritten: Claude Code refused every capped form of a command (docs/frugal.md).
// A call it lets through gets no output at all: answering "allow" would skip the session's permission rules.
// Anything unexpected lets the call through: this hook saves tokens, it is not a lock.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decide, limitsFor, triageImage } from './frugal.mjs';
import { vars } from './names.mjs';

const RETRY_MS = 30 * 60e3;
const STATE = vars.FRUGAL_STATE || join(tmpdir(), 'escadrille-frugal');
// The refusals of a session: { key: { n, at } }, so a second identical try is known
const tries = (session) => {
  const file = join(STATE, String(session || 'none').replace(/[^\w.-]/g, '_') + '.json');
  let m = {}; try { m = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const now = Date.now();
  for (const k of Object.keys(m)) if (now - m[k].at > RETRY_MS) delete m[k];
  return { get: (k) => m[k]?.n || 0, set: (k, n) => { if (n) m[k] = { n, at: now }; else delete m[k]; try { mkdirSync(STATE, { recursive: true }); writeFileSync(file, JSON.stringify(m)); } catch {} } };
};
const deny = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    if (vars.FRUGAL_OFF) return;
    const e = JSON.parse(raw);
    const cwd = e.cwd || process.cwd();
    const limits = limitsFor(cwd);
    if (limits.off) return;
    const input = e.tool_input || {};
    if (e.tool_name && e.tool_name !== 'Read') return;
    const t = tries(e.session_id);
    const key = JSON.stringify([resolve(cwd, String(input.file_path || '')), input.offset ?? null, input.limit ?? null]);
    const n = t.get(key);
    const d = decide(input, cwd, { limits });
    if (d.allow) return;
    if (n === 0) { t.set(key, 1); deny(d.reason); return; }
    if (d.kind === 'image' && limits.images === 'triage' && n === 1) {
      const v = triageImage(resolve(cwd, String(input.file_path)));
      if (v.ok === false) { t.set(key, 2); deny(`Haiku : ${v.line}. Ne montre pas cette capture : refais-la (CAPTURE: <url> compte=<nom>) ; pour l'ouvrir quand même, relis-la.`); return; }
    }
    t.set(key, 0); // the explicit try passes
  } catch { /* let it through */ }
});
