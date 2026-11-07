// The frugal reading rule: decide on temporary files, then the hook script as Claude Code runs it
// (JSON on stdin, JSON on stdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, countLines, FRUGAL_SETTINGS, withFrugal } from '../lib/frugal.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'frugal-'));
const write = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
const long = write('long.js', Array.from({ length: 301 }, (_, i) => `line ${i}`).join('\n') + '\n');
const short = write('short.md', 'a\nb\nc');
const image = write('shot.png', 'not really a png');
const big = write('big.txt', 'x'.repeat(201 * 1024));
const HOOK = new URL('../lib/frugal-hook.mjs', import.meta.url).pathname;

test('counts lines without a trailing newline too', () => {
  assert.equal(countLines(long), 301);
  assert.equal(countLines(short), 3);
});

test('a 301-line file without limit is refused, with its line count and what to do', () => {
  const d = decide({ file_path: long });
  assert.equal(d.allow, false);
  assert.match(d.reason, /301 lignes/);
  assert.match(d.reason, /offset et limit/);
  assert.match(d.reason, /Grep/);
  assert.match(d.reason, /refais exactement la même lecture/);
  assert.equal(decide({ file_path: long, limit: 2000 }).allow, false);
});

test('the same file with limit 100 passes', () => {
  assert.equal(decide({ file_path: long, offset: 200, limit: 100 }).allow, true);
});

test('images, transcripts, databases and files over 200 KB are refused, even with a limit', () => {
  assert.equal(decide({ file_path: image }).allow, false);
  assert.equal(decide({ file_path: '/x/session.jsonl', limit: 10 }).allow, false);
  assert.equal(decide({ file_path: '/x/sessions.sqlite' }).allow, false);
  const d = decide({ file_path: big, limit: 50 });
  assert.equal(d.allow, false);
  assert.match(d.reason, /201 Ko/);
});

test('a small file, a missing file and a relative path resolved against cwd pass or refuse correctly', () => {
  assert.equal(decide({ file_path: short }).allow, true);
  assert.equal(decide({ file_path: path.join(dir, 'nope.txt') }).allow, true);
  assert.equal(decide({ file_path: 'long.js' }, dir).allow, false);
});

test('the settings fragment points at the hook and merges with existing hooks', () => {
  const h = FRUGAL_SETTINGS.hooks.PreToolUse[0];
  assert.equal(h.matcher, 'Read');
  assert.ok(h.hooks[0].command.includes(HOOK));
  const merged = withFrugal({ sandbox: { enabled: true }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } });
  assert.equal(merged.sandbox.enabled, true);
  assert.deepEqual(merged.hooks.PreToolUse.map((x) => x.matcher), ['Bash', 'Read']);
});

const STATE = mkdtempSync(path.join(tmpdir(), 'frugal-state-'));
const runHook = (input, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ESCADRILLE_FRUGAL_STATE: STATE, ...env } });

test('the hook script denies with the JSON form on stdout', () => {
  const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'long.js' }, cwd: dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /301 lignes/);
});

test('the hook script says nothing on a read it lets through, or on garbage', () => {
  for (const input of [{ tool_name: 'Read', tool_input: { file_path: long, limit: 100 }, cwd: dir }, { tool_name: 'Read', tool_input: { file_path: short } }]) {
    const r = runHook(input);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
});

test('firstTurn counts usage once per message.id, up to the second prompt, and lists the Reads', async () => {
  const { firstTurn } = await import('../lib/frugal.mjs');
  const u = (id, cr, content = []) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: cr, output_tokens: 5 }, content } });
  const lines = [JSON.stringify({ type: 'user', message: { content: 'idée' } }),
    u('a', 100, [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }]), u('a', 100, [{ type: 'tool_use', name: 'Grep', input: {} }]),
    u('b', 200, [{ type: 'tool_use', name: 'Read', input: { file_path: 'server.mjs', offset: 100, limit: 60 } }]),
    JSON.stringify({ type: 'user', message: { content: 'réponses' } }), u('c', 9999)];
  const r = firstTurn(lines.join('\n'));
  assert.deepEqual({ calls: r.calls, tools: r.tools, read: r.read, output: r.output }, { calls: 2, tools: 3, read: 322, output: 10 });
  assert.deepEqual(r.reads, ['README.md', 'server.mjs 100 60']);
});

// Phase 14 SOR: the pilot and the plan sessions, outputs capped, a second explicit try passes
import { limitsFor, LIMITS } from '../lib/frugal.mjs';
import { capText } from '../lib/frugal-cap.mjs';
import { mkdirSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';

test('a refused read passes on the explicit second try, per session', () => {
  const input = { session_id: 's-retry', tool_name: 'Read', tool_input: { file_path: long }, cwd: dir };
  const first = runHook(input);
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runHook(input).stdout, '', 'the second identical read passes');
  assert.equal(JSON.parse(runHook({ ...input, session_id: 's-other' }).stdout).hookSpecificOutput.permissionDecision, 'deny', 'another session starts over');
  assert.equal(decide({ file_path: long }, dir, { retry: true }).allow, true);
});

test('a big JSON file is refused with a filter to run; a small one passes', () => {
  const bigJson = write('data.json', JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i })) }));
  const d = decide({ file_path: bigJson }, dir);
  assert.equal(d.kind, 'json'); assert.match(d.reason, /jq|node -e/);
  assert.equal(decide({ file_path: write('small.json', '{"a":1}') }, dir).allow, true);
});

test('thresholds come from the project\'s .escadrille/frugal.json, found from a worktree up', () => {
  const proj = mkdtempSync(path.join(tmpdir(), 'frugal-proj-'));
  mkdirSync(path.join(proj, '.calmdev'), { recursive: true });
  writeFileSync(path.join(proj, '.calmdev', 'frugal.json'), JSON.stringify({ jsonBytes: 50, readLines: 1000 }));
  const wt = path.join(proj, '.claude', 'worktrees', 'x'); mkdirSync(wt, { recursive: true });
  const l = limitsFor(wt, {});
  assert.equal(l.jsonBytes, 50); assert.equal(l.readLines, 1000); assert.equal(l.readBytes, LIMITS.readBytes);
  assert.equal(limitsFor(wt, { ESCADRILLE_FRUGAL: '{"readLines":7}' }).readLines, 7);
  assert.equal(decide({ file_path: long }, dir, { limits: l }).allow, true, '301 lines under a 1000-line project threshold');
});

test('capText keeps a small output whole, cuts a long one to head and tail with the file and what to do', () => {
  assert.deepEqual(capText('a\nb\n', { lines: 10 }), { cut: false, text: 'a\nb\n' });
  const out = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') + '\n';
  const r = capText(out, { lines: 20, bytes: 100000 }, 'F.txt');
  assert.equal(r.cut, true);
  const lines = r.text.trim().split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[0], 'l0'); assert.equal(lines[20], 'l999');
  assert.match(lines[10], /^\[calmdev\] 980 lignes coupées sur 1000 .*F\.txt.*# entier/);
  const one = capText('x'.repeat(50000), { lines: 200, bytes: 1000 }, 'F');
  assert.ok(Buffer.byteLength(one.text) < 1400, 'one huge line is cut by bytes');
});

test('capText shows a big JSON as its shape and a filter, never its content', () => {
  const j = JSON.stringify({ plans: Array.from({ length: 300 }, (_, i) => ({ id: i, title: 'plan ' + i })), ok: true });
  const r = capText(j, { jsonBytes: 1000 }, 'F');
  assert.equal(r.cut, true);
  assert.match(r.text, /plans: \[300 × \{ id: number, title: string \}\]/);
  assert.match(r.text, /jq '\.plans' F/);
  assert.doesNotMatch(r.text, /plan 299/);
});

test('the hook leaves every Bash command whole, and stays out of Haiku\'s own run', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'frugal-hb-'));
  for (const permission_mode of ['default', 'dontAsk']) assert.equal(runHook({ session_id: 'b', tool_name: 'Bash', tool_input: { command: 'seq 1 3000' }, cwd, permission_mode }).stdout, '');
  assert.equal(existsSync(path.join(cwd, '.calmdev')), false);
  assert.equal(runHook({ tool_name: 'Read', tool_input: { file_path: long }, cwd: dir }, { ESCADRILLE_FRUGAL_OFF: '1' }).stdout, '', 'Haiku\'s own run is left alone');
});

test('an image: refused once, then Haiku checks it; a bad capture is refused with its line, a third try passes', () => {
  const fake = path.join(dir, 'fake-claude.sh');
  writeFileSync(fake, '#!/bin/sh\ncase "$*" in *login*) echo "connexion : bloquée sur la page de connexion";; *) echo "bonne : le tableau de bord";; esac\n'); chmodSync(fake, 0o755);
  const login = write('login.png', 'png'); const good = write('good.png', 'png');
  const env = { ESCADRILLE_CLAUDE: fake };
  const ask = (file_path, session_id) => runHook({ session_id, tool_name: 'Read', tool_input: { file_path }, cwd: dir }, env).stdout;
  assert.match(JSON.parse(ask(login, 'img')).hookSpecificOutput.permissionDecisionReason, /capture de contrôle/);
  assert.match(JSON.parse(ask(login, 'img')).hookSpecificOutput.permissionDecisionReason, /^Haiku : connexion : bloquée.*refais-la/);
  assert.equal(ask(login, 'img'), '', 'a third try opens it anyway');
  assert.ok(ask(good, 'img2')); assert.equal(ask(good, 'img2'), '', 'a good capture opens on the second try');
});
