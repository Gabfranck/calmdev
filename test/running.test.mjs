// What runs on the Mac (lib/running.mjs): the parsers of ps and lsof on fixed outputs, ours and others on
// injected data, and a dev server started by a fake npm whose dev script prints its URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePs, parseLsof, isClaude, ours, others, startDevServer, stopDevServer, devServers, devServerOf } from '../lib/running.mjs';
import { fakeNpm, devProject } from './fake-npm.mjs';
import { safeEnv, validateDomains, sandboxSettings, SANDBOX_SETTINGS } from '../lib/planner.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const PS = `    1     0 Sat Oct 31 21:02:11 2026     /sbin/launchd
  812   640 Sun Nov  1 04:15:23 2026     claude --model claude-opus-5-5
  901   812 Sun Nov  1 04:15:24 2026     /opt/homebrew/bin/node ${USERS}/dev/.npm/_npx/x/claude-helper
  930   777 Sun Nov  1 05:01:02 2026     /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p
  950   500 Sun Nov  1 05:10:00 2026     node /tmp/escadrille-x/claude -p --input-format stream-json
  960     1 Sun Nov  1 06:00:00 2026     /Applications/Claude.app/Contents/MacOS/Claude
  970   812 Sun Nov  1 06:30:00 2026     grep claude
garbage line
`;
const LSOF = `p812
fcwd
n${USERS}/dev/Dev/orchard
p930
fcwd
n${USERS}/dev/Dev/escadrille
`;

test('parsePs reads pid, ppid, the start time (local) and the command', () => {
  const ps = parsePs(PS);
  assert.equal(ps.length, 7);
  assert.deepEqual(ps[1], { pid: 812, ppid: 640, since: new Date(2026, 10, 1, 4, 15, 23).toISOString(), args: 'claude --model claude-opus-5-5' });
  assert.equal(ps[0].since, new Date(2026, 9, 31, 21, 2, 11).toISOString());
});

test('parsePs reads a French ps too (dim.  1 nov.), and every month', () => {
  const fr = parsePs(` 4679 68635 dim.  1 nov. 03:34:36 2026   ${USERS}/dev/.local/bin/claude --model x
14878 84505 lun. 12 févr. 04:38:10 2026   claude -p
  12     1 mar.  3 août 23:59:59 2026   claude
  13     1 jeu. 24 déc. 00:00:00 2026   claude`);
  assert.deepEqual(fr.map((p) => [p.pid, p.since]), [[4679, new Date(2026, 10, 1, 3, 34, 36).toISOString()], [14878, new Date(2026, 1, 12, 4, 38, 10).toISOString()], [12, new Date(2026, 7, 3, 23, 59, 59).toISOString()], [13, new Date(2026, 11, 24).toISOString()]]);
  assert.equal(fr[0].args, `${USERS}/dev/.local/bin/claude --model x`);
  assert.equal(parsePs('  1  0 Sun Foo  1 04:15:23 2026  claude').length, 0, 'an unknown month');
  assert.equal(isClaude(`${USERS}/dev/.local/bin/claude --chrome-native-host`), false, 'the Chrome bridge is not a session');
});

test('parseLsof maps each pid to its cwd', () => {
  assert.deepEqual([...parseLsof(LSOF)], [[812, `${USERS}/dev/Dev/orchard`], [930, `${USERS}/dev/Dev/escadrille`]]);
  assert.equal(parseLsof('').size, 0);
});

test('isClaude: the native claude, node …/claude, the npm cli; not the desktop app, not grep', () => {
  assert.deepEqual(parsePs(PS).filter((p) => isClaude(p.args)).map((p) => p.pid), [812, 930, 950]);
});

test('others: the claude processes minus the server\'s own pids and their children, cwd from lsof, read only', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'ps' ? PS : LSOF; };
  const got = await others({ exclude: new Set([4242]), parents: new Set([500]), run });
  assert.deepEqual(got, [
    { pid: 812, cwd: `${USERS}/dev/Dev/orchard`, since: new Date(2026, 10, 1, 4, 15, 23).toISOString(), args: 'claude --model claude-opus-5-5' },
    { pid: 930, cwd: `${USERS}/dev/Dev/escadrille`, since: new Date(2026, 10, 1, 5, 1, 2).toISOString(), args: '/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p' },
  ]);
  assert.deepEqual(calls, [['ps', '-axo', 'pid=,ppid=,lstart=,command='], ['lsof', '-a', '-p', '812,930', '-d', 'cwd', '-Fn']], 'ps then one lsof, nothing else (no kill)');
  // lsof refused: the cwd stays null; nothing found: no lsof at all
  const noLsof = await others({ run: async (cmd) => { if (cmd === 'lsof') throw new Error('denied'); return PS; } });
  assert.deepEqual(noLsof.map((p) => [p.pid, p.cwd]), [[812, null], [930, null], [950, null]]);
  const none = []; assert.deepEqual(await others({ run: async (cmd) => { none.push(cmd); return '    1     0 Sat Oct 31 21:02:11 2026     /sbin/launchd\n'; } }), []); assert.deepEqual(none, ['ps']);
  const long = await others({ run: async (cmd) => (cmd === 'ps' ? `  5   1 Sun Nov  1 04:15:23 2026     claude ${'x'.repeat(500)}` : '') });
  assert.equal(long[0].args.length, 300); assert.ok(long[0].args.endsWith('…'));
});

test('ours: live sessions, dev servers, the worktrees not merged and still on disk', () => {
  const got = ours({
    sessions: [{ plan: 'p', session: 'A', pid: 11, cwd: '/r/.claude/worktrees/p-A', since: '2026-11-01T04:00:00.000Z' }],
    devservers: [{ plan: 'p', session: 'A', pid: 12, cwd: '/r/.claude/worktrees/p-A', url: 'http://localhost:5173', since: '2026-11-01T04:05:00.000Z' }],
    rows: [
      { plan: 'p', id: 'A', worktree: { path: '/r/.claude/worktrees/p-A', cwd: '/r/.claude/worktrees/p-A/app', merged: false } },
      { plan: 'p', id: 'B', worktree: { path: '/r/.claude/worktrees/p-B', merged: true } },
      { plan: 'p', id: 'C', worktree: { path: '/r/.claude/worktrees/p-C', merged: false } },
      { plan: 'p', id: 'D', worktree: null },
    ],
    exists: (p) => p !== '/r/.claude/worktrees/p-C', born: () => '2026-11-01T03:59:00.000Z',
  });
  assert.deepEqual(got, [
    { kind: 'session', plan: 'p', session: 'A', pid: 11, cwd: '/r/.claude/worktrees/p-A', url: null, since: '2026-11-01T04:00:00.000Z' },
    { kind: 'devserver', plan: 'p', session: 'A', pid: 12, cwd: '/r/.claude/worktrees/p-A', url: 'http://localhost:5173', since: '2026-11-01T04:05:00.000Z' },
    { kind: 'worktree', plan: 'p', session: 'A', pid: null, cwd: '/r/.claude/worktrees/p-A/app', url: null, since: '2026-11-01T03:59:00.000Z' },
  ]);
  assert.deepEqual(ours(), []);
});

test('validateDomains: host names only; sandboxSettings opens them and leaves SANDBOX_SETTINGS alone', () => {
  assert.deepEqual(validateDomains(['api.github.com', ' Registry.NPMJS.org ', '*.example.com', 'api.github.com']), { domains: ['api.github.com', 'registry.npmjs.org', '*.example.com'], errors: null });
  for (const bad of ['https://api.github.com', 'api.github.com/x', 'api.github.com:443', '*', '*.com', 'localhost', '1.2.3.4', 'a b.com', '', 3, null, 'user@host.com', '-bad.com'])
    assert.ok(validateDomains([bad]).errors, `refused: ${JSON.stringify(bad)}`);
  assert.ok(validateDomains('api.github.com').errors, 'a list, not a string');
  const s = sandboxSettings(['api.github.com', 'https://bad']);
  assert.deepEqual(s.sandbox.network, { allowedDomains: ['api.github.com'], allowLocalBinding: true });
  assert.equal(s.sandbox.enabled, true); assert.deepEqual(s.permissions, SANDBOX_SETTINGS.permissions);
  assert.deepEqual(SANDBOX_SETTINGS.sandbox.network.allowedDomains, [], 'the shared default stays closed');
  assert.deepEqual(sandboxSettings().sandbox.network.allowedDomains, []);
});

test('a dev server: the URL read on its output, one per session, stopped with its group', async () => {
  const npm = fakeNpm(); const dir = devProject(realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-dev-'))));
  let changes = 0;
  const { url } = await startDevServer({ plan: 'p', session: 'A', cwd: dir, env: safeEnv(process.env), npm, onChange: () => changes++ });
  assert.match(url, /^http:\/\/localhost:\d+$/);
  assert.equal(await (await fetch(url)).text(), 'dev ok');
  assert.equal(devServerOf('p', 'A').url, url); assert.equal(devServers().length, 1); assert.ok(changes >= 2, 'a change at start and at the url');
  assert.deepEqual(await startDevServer({ plan: 'p', session: 'A', cwd: dir, npm }), { url }, 'one per session');
  // the fake npm ignores SIGTERM: the group's SIGTERM still reaches the dev script; then npm leaves with it
  assert.equal(await stopDevServer('p', 'A'), true);
  assert.equal(devServerOf('p', 'A'), null); assert.deepEqual(devServers(), []);
  await assert.rejects(fetch(url), 'the dev script is gone with the group');
  assert.equal(await stopDevServer('p', 'A'), false);
  // no URL within the timeout: url null, the server keeps running until stopped
  const quiet = devProject(realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-dev-'))), { url: false });
  assert.deepEqual(await startDevServer({ plan: 'p', session: 'B', cwd: quiet, env: safeEnv(process.env), npm, timeoutMs: 300 }), { url: null });
  assert.ok(devServerOf('p', 'B')); assert.equal(await stopDevServer('p', 'B'), true);
  await assert.rejects(startDevServer({ plan: 'p', session: 'C', cwd: tmpdir(), npm }), /package\.json/);
});
