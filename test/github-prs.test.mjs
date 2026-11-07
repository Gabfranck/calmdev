// Phase 16 GH (docs/connectors.md): reading the PRs, the failed log, the review threads, the merge on a click, the
// conflicts by git merge-tree, and the three routes, all against test/fake-gh.mjs and a throwaway git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeGh } from './fake-gh.mjs';
import * as github from '../lib/github.mjs';
import { handle } from '../lib/ghroutes.mjs';

const gh = fakeGh(); process.env.ESCADRILLE_GH = gh.file;
const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-ghprs-')));
const reset = (m = '') => { gh.setMode(m); gh.setHead('abc1234def5678'); gh.setBranch('feature'); };

test('prList: open PRs with CI summary, mergeable and the linked session', async () => {
  reset();
  const [pr] = await github.prList({ cwd, sessions: [{ planId: 'p1', sessionId: 'GH', branch: 'feature', pr: null }] });
  assert.deepEqual({ ...pr }, { number: 7, title: 'Demo', branch: 'feature', base: 'main', head: 'abc1234def5678', author: 'gab', reviewDecision: 'REVIEW_REQUIRED', ci: 'green', mergeable: 'MERGEABLE', url: 'https://github.com/acme/demo/pull/7', state: 'OPEN', session: { planId: 'p1', sessionId: 'GH' } });
  assert.deepEqual(gh.calls().at(-1).args.slice(0, 4), ['pr', 'list', '--state', 'open']);
  reset('red'); assert.equal((await github.prList({ cwd }))[0].ci, 'red');
  reset('pending'); assert.equal((await github.prList({ cwd }))[0].ci, 'pending');
  assert.equal(github.ciOf([]), 'none');
  reset(); assert.deepEqual((await github.prList({ cwd, sessions: [{ planId: 'p2', sessionId: 'X', branch: 'other', pr: { number: 7 } }] }))[0].session, { planId: 'p2', sessionId: 'X' }, 'by pr.number first');
});

test('prChecks keeps the JSON of the red (1) and pending (8) exits; failedLog: 200 lines, secrets hidden', async () => {
  reset('red');
  const c = await github.prChecks({ cwd, number: 7 });
  assert.equal(c.ci, 'red'); assert.equal(c.checks[0].bucket, 'fail');
  reset('pending'); assert.equal((await github.prChecks({ cwd, number: 7 })).ci, 'pending');
  reset('red');
  const log = await github.failedLog({ cwd, number: 7, secrets: ['hunter22'] });
  assert.deepEqual([log.check, log.run, log.job], ['test', '42', '4242']);
  assert.deepEqual(gh.calls().at(-1).args, ['run', 'view', '42', '--job', '4242', '--log-failed']);
  const lines = log.log.split('\n'); assert.equal(lines.length, 200);
  assert.match(lines.at(-1), /expected 2, got 3/);
  assert.doesNotMatch(log.log, /ghp_abc|hunter22|abc\.def\.ghi/);
  assert.match(log.log, /Bearer •••/);
  reset(); assert.equal(await github.failedLog({ cwd, number: 7 }), null, 'nothing red: no log');
  await assert.rejects(github.prChecks({ cwd, number: '7; rm -rf /' }), /numéro de PR invalide/);
});

test('prReviewComments: the unresolved threads by a fixed GraphQL query, gh fills owner and repo', async () => {
  reset('changes-requested');
  const list = await github.prReviewComments({ cwd, number: 7 });
  assert.deepEqual(list.map((c) => [c.id, c.path, c.line, c.author]), [['PRRT_1', 'lib/a.mjs', 12, 'alice'], ['PRR_9', null, null, 'alice']]);
  const args = gh.calls().at(-1).args;
  assert.deepEqual([args[0], args[1], args[2], args.slice(4)], ['api', 'graphql', '-f', ['-F', 'owner={owner}', '-F', 'repo={repo}', '-F', 'n=7']]);
  assert.match(args[3], /^query=query\(\$owner/);
});

test('mergeBlock and prMerge: refused in one sentence, otherwise merged on the head seen', async () => {
  for (const [m, re] of [['red', /CI est rouge/], ['pending', /CI tourne encore/], ['changes-requested', /changements sont demandés/], ['conflict', /en conflit/]]) {
    reset(m); const n = gh.calls().length;
    await assert.rejects(github.prMerge({ cwd, number: 7 }), (e) => e.status === 409 && re.test(e.message));
    assert.ok(!gh.calls().slice(n).some((c) => c.args[1] === 'merge'), m + ': gh pr merge never called');
  }
  await assert.rejects(github.prMerge({ cwd, number: 7, method: 'octopus' }), /merge, squash ou rebase/);
  reset();
  assert.deepEqual(await github.prMerge({ cwd, number: 7, method: 'rebase', deleteBranch: true }), { ok: true, number: 7, method: 'rebase', deleted: true, head: 'abc1234def5678' });
  assert.deepEqual(gh.calls().at(-1).args, ['pr', 'merge', '7', '--rebase', '--delete-branch', '--match-head-commit', 'abc1234def5678']);
});

test('conflicts: git merge-tree, locally', async () => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-mt-')));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'one');
  git('checkout', '-qb', 'clean'); writeFileSync(path.join(repo, 'b.txt'), 'b\n'); git('add', '.'); git('commit', '-qm', 'b');
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'clash'); writeFileSync(path.join(repo, 'a.txt'), 'clash\n'); git('commit', '-qam', 'clash');
  git('checkout', '-q', 'main'); writeFileSync(path.join(repo, 'a.txt'), 'main\n'); git('commit', '-qam', 'main');
  assert.deepEqual(await github.conflicts({ cwd: repo, base: 'main', head: 'clean' }), { conflict: false, files: [] });
  assert.deepEqual(await github.conflicts({ cwd: repo, base: 'main', head: 'clash' }), { conflict: true, files: ['a.txt'] });
  await assert.rejects(github.conflicts({ cwd: repo, base: '--output=x', head: 'clash' }), /nom de branche invalide/);
});

// The routes on a small node:http server, with the context the server gives them
const serve = async ({ guard = false } = {}) => {
  const said = []; const log = [];
  const ctx = {
    json: (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    readBody: (req) => new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s ? JSON.parse(s) : {})); }),
    projectArg: (v) => { if (v !== cwd) throw new Error('project : dossier introuvable'); return v; },
    guardOk: (req) => guard && /escadrille_guard=ok/.test(req.headers.cookie || ''),
    sessionsOf: () => [{ planId: 'p1', sessionId: 'GH', branch: 'feature', pr: { number: 7 } }],
    secretsOf: () => [], record: (r) => log.push(r), say: (...a) => said.push(a),
  };
  const server = createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); if (!(await handle(req, res, url, ctx))) { res.writeHead(418); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, opt = {}) => { const r = await fetch(base + p, opt); return { status: r.status, body: r.status === 418 ? null : await r.json() }; };
  return { call, said, log, close: () => server.close() };
};
const q = '?project=' + encodeURIComponent(cwd);
const post = (body, cookie) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

test('GET /api/github/prs and /api/github/pr/:n', async () => {
  const s = await serve();
  try {
    reset('red,changes-requested');
    const list = await s.call('/api/github/prs' + q);
    assert.equal(list.status, 200); assert.equal(list.body.prs[0].ci, 'red'); assert.deepEqual(list.body.prs[0].session, { planId: 'p1', sessionId: 'GH' });
    const one = await s.call('/api/github/pr/7' + q);
    assert.equal(one.status, 200);
    assert.equal(one.body.mergeBlock, 'La CI est rouge : corrige-la avant de fusionner.');
    assert.equal(one.body.failedLog.check, 'test'); assert.equal(one.body.comments.length, 2);
    assert.deepEqual(Object.keys(one.body.conflict), ['conflict', 'files']);
    assert.equal((await s.call('/api/github/pr/8' + q)).status, 404);
    assert.equal((await s.call('/api/github/pr/7x' + q)).status, 400);
    assert.equal((await s.call('/api/github/prs?project=/nope')).status, 400);
    reset('unauth'); const un = await s.call('/api/github/prs' + q); assert.equal(un.status, 400); assert.match(un.body.error, /gh auth login/);
    assert.equal((await s.call('/api/other')).status, 418, 'not ours: handle returns false');
  } finally { s.close(); }
});

test('POST /api/github/pr/:n/merge: 403 without the page cookie, 409 refusal, 200 on the click', async () => {
  const sim = await serve({ guard: false });
  try {
    reset(); const n = gh.calls().length;
    const r = await sim.call('/api/github/pr/7/merge', post({ project: cwd }, 'escadrille_guard=ok'));
    assert.equal(r.status, 403, 'a simulated session (no valid cookie) gets 403');
    assert.equal(gh.calls().length, n, 'gh never called');
  } finally { sim.close(); }
  const s = await serve({ guard: true });
  try {
    assert.equal((await s.call('/api/github/pr/7/merge', post({ project: cwd }))).status, 403, 'no cookie: 403');
    reset('red');
    const no = await s.call('/api/github/pr/7/merge', post({ project: cwd }, 'escadrille_guard=ok'));
    assert.deepEqual([no.status, no.body.error], [409, 'La CI est rouge : corrige-la avant de fusionner.']);
    assert.equal(s.log.at(-1).kind, 'refuse');
    reset();
    assert.equal((await s.call('/api/github/pr/7/merge', post({ project: cwd, method: 'nope' }, 'escadrille_guard=ok'))).status, 400);
    const ok = await s.call('/api/github/pr/7/merge', post({ project: cwd, method: 'squash', deleteBranch: true }, 'escadrille_guard=ok'));
    assert.deepEqual([ok.status, ok.body], [200, { ok: true, number: 7, method: 'squash', deleted: true }]);
    assert.deepEqual([s.log.at(-1).kind, s.log.at(-1).sessionId, s.log.at(-1).text.split('\n')[0]], ['merge', 'GH', 'PR #7 fusionnée (squash)']);
    assert.deepEqual(s.said.at(-1), ['p1', 'GH', 'PR #7 fusionnée sur GitHub (squash).']);
  } finally { s.close(); }
});
