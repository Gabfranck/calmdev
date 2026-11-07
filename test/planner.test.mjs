// The planner against a fake `claude` that speaks stream-json, so the test needs no account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPlanner, describeTool, safeEnv, SESSION_TOOLS, SANDBOX_SETTINGS } from '../lib/planner.mjs';

const fake = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-')));
  const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
let n = 0;
rl.on('line', (line) => { const m = JSON.parse(line); n++;
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: process.cwd() + '/README.md' } }] } }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Réponse ' + n + ' à « ' + m.message.content + ' »' }] } }));
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.04, resetsAt: 1793538000 } } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01 * n, usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1000000 } } }));
  if (n === 2) process.exit(0);
});
`); chmodSync(file, 0o755);
  return { dir, file };
};

test('startPlanner drives a two-turn conversation and reports usage and quota', async () => {
  const { dir, file } = fake();
  const events = [];
  const done = new Promise((resolve) => {
    const p = startPlanner({ cwd: dir, model: 'claude-sonnet-5-5', claude: file, onEvent: (e) => { events.push(e); if (e.type === 'exit') resolve(); } });
    p.send('Bonjour'); p.send('Encore');
  });
  await done;
  const types = events.map((e) => e.type);
  assert.equal(events[0].sessionId, 'sess-1');
  assert.deepEqual(types.filter((t) => t === 'text').length, 2);
  assert.equal(events.find((e) => e.type === 'text').text, 'Réponse 1 à « Bonjour »');
  assert.equal(events.find((e) => e.type === 'activity').text, 'lit README.md');
  assert.equal(events.find((e) => e.type === 'quota').weekly, 0.04);
  const turns = events.filter((e) => e.type === 'turn');
  assert.equal(turns.length, 2); assert.equal(turns[0].usage.input, 112); assert.equal(turns[1].cost, 0.02);
});

test('describeTool says a tool call in words', () => {
  assert.equal(describeTool('Bash', { command: 'git log --oneline -5' }), 'git log --oneline -5');
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), 'grep TODO');
});

test('startPlanner refuses a folder that does not exist or an unknown model', () => {
  assert.throws(() => startPlanner({ cwd: '/nope/nope', model: 'claude-opus-5-5' }), /dossier/);
  assert.throws(() => startPlanner({ cwd: tmpdir(), model: 'gpt' }), /modèle/);
});

test('safeEnv strips the developer keys and keeps what Claude Code needs', () => {
  const env = safeEnv({ PATH: '/bin', HOME: '/opt/x', OPENAI_API_KEY: 'sk-1', AWS_SECRET_ACCESS_KEY: 'a', SCW_SECRET_KEY: 'b', GITHUB_TOKEN: 'c', NPM_TOKEN: 'd', DB_PASSWORD: 'e', ANTHROPIC_API_KEY: 'keep', CLAUDE_CODE_MESSAGING_TOKEN: 'keep', CLAUDE_CODE_SIMPLE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN', 'HOME', 'PATH', 'npm_config_ignore_scripts']);
});

test('safeEnv forces npm_config_ignore_scripts=true, whatever the inherited value', () => {
  assert.equal(safeEnv({ PATH: '/bin' }).npm_config_ignore_scripts, 'true');
  assert.equal(safeEnv({ PATH: '/bin', npm_config_ignore_scripts: 'false' }).npm_config_ignore_scripts, 'true');
  const up = safeEnv({ PATH: '/bin', NPM_CONFIG_IGNORE_SCRIPTS: 'false' });
  assert.equal(up.npm_config_ignore_scripts, 'true'); assert.ok(!('NPM_CONFIG_IGNORE_SCRIPTS' in up), 'no second spelling left to win');
});

test('a launched session may not cat or head any file', () => {
  assert.ok(!SESSION_TOOLS.some((t) => /cat|head/.test(t)));
});

test('every launched session is sandboxed: no network, keys unreadable, reads held to the session folders', () => {
  const sb = SANDBOX_SETTINGS.sandbox;
  assert.equal(sb.enabled, true); assert.equal(sb.failIfUnavailable, true); assert.deepEqual(sb.network.allowedDomains, []);
  assert.equal(sb.network.allowLocalBinding, true, 'a session may open a local port (node --test on Escadrille itself)');
  for (const p of ['~/.ssh', '~/.aws', '~/.config/gcloud', '~/.npmrc']) assert.ok(sb.filesystem.denyRead.includes(p), p);
  assert.equal(SANDBOX_SETTINGS.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.ok(SANDBOX_SETTINGS.permissions.deny.includes('Read(//**/.env)'));
});
