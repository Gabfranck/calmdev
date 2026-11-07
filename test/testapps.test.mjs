// The test apps stop alone, the Environnement apart (lib/testapps.mjs, public/livecount.js), Dev 6 November
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as ta from '../lib/testapps.mjs';

const ROOT = '/Users/x/Dev/proj';
const WT = (n) => `${ROOT}/.claude/worktrees/${n}`;
const NOW = Date.parse('2026-11-06T22:00:00Z');
const rows = [
  { plan: 'p', id: 'RUN', status: 'running', at: '2026-11-06T21:59:00Z', worktree: { path: WT('run') } },
  { plan: 'p', id: 'MRG', status: 'done', at: '2026-11-06T21:59:00Z', worktree: { path: WT('mrg'), merged: true } },
  { plan: 'q', id: 'ABN', status: 'waiting', at: '2026-11-06T21:59:00Z', retired: true, worktree: { path: WT('abn') } },
  { plan: 'p', id: 'OLD', status: 'done', at: '2026-11-06T20:30:00Z', worktree: { path: WT('old') } },
  { plan: 'p', id: 'NEW', status: 'done', at: '2026-11-06T21:30:00Z', worktree: { path: WT('new') } },
];
const app = (cwd, pid = 1) => ({ pid, port: 4000 + pid, cwd });

test('merged, abandoned, done an hour ago and orphan apps stop; the running, the fresh and the project stay', () => {
  const apps = [app(WT('run'), 1), app(WT('mrg') + '/site', 2), app(WT('abn'), 3), app(WT('old'), 4), app(WT('new'), 5), app(WT('gone'), 6), app(ROOT, 7), app('/Users/x/other', 8)];
  const out = ta.toStop({ apps, rows, roots: [ROOT], now: NOW });
  assert.deepEqual(out.map((a) => [a.pid, a.why]), [[2, 'merged'], [3, 'abandoned'], [4, 'done'], [6, 'orphan']]);
});

test('a dev server of this server is judged by its plan and session', () => {
  assert.equal(ta.verdict({ app: { plan: 'p', session: 'MRG', cwd: '/x' }, rows, now: NOW }), 'merged');
  assert.equal(ta.verdict({ app: { plan: 'p', session: 'NONE', cwd: '/x' }, rows, now: NOW }), 'orphan');
  assert.equal(ta.verdict({ app: { plan: 'p', session: 'RUN', cwd: '/x' }, rows, now: NOW }), null);
});

test('isTestCwd names the worktree folder, never the project itself', () => {
  assert.equal(ta.isTestCwd(WT('a') + '/sub', [ROOT]), WT('a'));
  assert.equal(ta.isTestCwd(ROOT, [ROOT]), null);
  assert.equal(ta.isTestCwd(ROOT + '/.claude/worktrees', [ROOT]), null);
});

// the page: the Environnement shown, the test apps folded in one line, the count read from the same list
const T = (k, v = {}) => { const n = v.n; const s = { 'live.testsHead': `${n} apps de test`, 'live.envHead': 'Environnement', 'live.apps': `${n} apps`, 'live.appsWord': 'apps', 'live.appBranch': `environnement · ${v.b}` }[k]; return s ?? k; };
const live = () => { const ctx = { T, window: undefined }; ctx.globalThis = ctx; vm.runInNewContext(readFileSync(new URL('../public/livecount.js', import.meta.url), 'utf8'), ctx); return ctx.EscadrilleLive; };

test('livecount splits Environnement and folded test apps, the count is the list', () => {
  const L = live();
  const running = { ours: [{ kind: 'devserver', plan: 'p', session: 'RUN', url: 'http://localhost:5173' }], servers: [
    { port: 3000, url: 'http://localhost:3000', project: ROOT, role: 'env', branch: 'dev' },
    ...Array.from({ length: 19 }, (_, i) => ({ port: 4100 + i, url: `http://localhost:${4100 + i}`, cwd: WT('x'), role: 'test', session: 'X' })),
  ] };
  const m = L.group(running, {});
  assert.equal(m.apps.length, 21);
  const html = L.markup(m, true);
  assert.match(html, /Environnement<\/span><span class="num">1</);
  assert.match(html, /environnement · dev/);
  assert.match(html, /<details class="lc-tests"><summary><span>20 apps de test<\/span>/, 'folded by default');
  assert.equal((html.match(/class="lc-s lc-app"/g) || []).length, m.apps.length, 'every counted app is a row of the list');
  assert.match(html, /<b class="num">21<\/b>/);
  // 53 stop: the same answer feeds the count and the list at once
  const after = L.group({ ...running, servers: running.servers.slice(0, 1), ours: [] }, {});
  const h2 = L.markup(after, true);
  assert.match(h2, /<b class="num">1<\/b>/); assert.doesNotMatch(h2, /lc-tests/);
});
