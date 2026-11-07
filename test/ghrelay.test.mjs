// Phase 16 GH, the relay (lib/ghrelay.mjs): once per 2 minutes per PR, one message per pass, never twice for the same
// cause without a new commit; REDEM routes (message, reopen, « À toi »). Against test/fake-gh.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeGh } from './fake-gh.mjs';
import * as github from '../lib/github.mjs';
import * as relay from '../lib/ghrelay.mjs';

const gh = fakeGh(); process.env.ESCADRILLE_GH = gh.file;
const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-relay-')));
const fresh = () => { const db = new DatabaseSync(':memory:'); relay.schema(db); return db; };
// no local branches in cwd: conflicts() fails and the relay falls back on GitHub's mergeable
const link = (over = {}) => ({ project: cwd, cwd, planId: 'p1', sessionId: 'GH', number: 7, base: 'main', branch: 'feature', status: 'waiting', ...over });
const tickAt = async (db, t, l = link()) => { const sent = []; await relay.relayTick({ db, links: [l], gh: github, now: t, deliver: (lk, e, r) => sent.push({ e, r }), secretsOf: () => ['hunter22'] }); return sent; };

test('a new comment and a red CI: one message; same causes: nothing; within 2 minutes: not even read', async () => {
  const db = fresh(); gh.setMode('red,changes-requested'); gh.setHead('aaa1111'); gh.setComments('');
  const t0 = 1_000_000;
  const [m, ...rest] = await tickAt(db, t0);
  assert.equal(rest.length, 0);
  assert.equal(m.r, 'message');
  assert.equal(m.e.kind, 'review-comment'); assert.equal(m.e.source, 'github');
  assert.deepEqual(m.e.causes, ['comment:PRRT_1', 'comment:PRR_9', 'ci-red:aaa1111']);
  assert.deepEqual(m.e.pr, { number: 7, url: 'https://github.com/acme/demo/pull/7', head: 'aaa1111', base: 'main' });
  assert.equal(m.e.ci.check, 'test'); assert.doesNotMatch(m.e.ci.log, /hunter22|ghp_/);
  assert.match(m.e.text, /^PR #7 : à corriger\./); assert.match(m.e.text, /> Renomme cette variable\./); assert.match(m.e.text, /CI rouge sur aaa1111 : test/); assert.match(m.e.text, /ne pousse pas/);
  const n = gh.calls().length;
  assert.deepEqual(await tickAt(db, t0 + 60_000), []); assert.equal(gh.calls().length, n, 'within 2 minutes: gh not called');
  assert.deepEqual(await tickAt(db, t0 + 121_000), [], 'same comments, same red head: nothing');
});

test('a red CI goes again only after a new commit; a conflict once per head', async () => {
  const db = fresh(); gh.setMode('red'); gh.setHead('aaa1111'); gh.setComments('[]');
  let t = 0;
  assert.deepEqual((await tickAt(db, t += 200_000))[0].e.causes, ['ci-red:aaa1111']);
  assert.deepEqual(await tickAt(db, t += 200_000), []);
  gh.setHead('bbb2222');
  assert.deepEqual((await tickAt(db, t += 200_000))[0].e.causes, ['ci-red:bbb2222'], 'new commit, still red: once more');
  gh.setMode('conflict');
  const [c] = await tickAt(db, t += 200_000);
  assert.deepEqual(c.e.causes, ['conflict:bbb2222']); assert.deepEqual(c.e.conflict, { files: [] }); assert.match(c.e.text, /Conflit avec main/);
  assert.deepEqual(await tickAt(db, t += 200_000), []);
  gh.setMode(''); assert.deepEqual(await tickAt(db, t += 200_000), [], 'green: nothing');
});

test('a new thread on a PR already relayed goes alone', async () => {
  const db = fresh(); gh.setMode('changes-requested'); gh.setHead('aaa1111'); gh.setComments('');
  await tickAt(db, 500_000);
  gh.setComments([{ id: 'PRRT_3', isResolved: false, isOutdated: false, path: 'x.mjs', line: 1, comments: { nodes: [{ author: { login: 'bob' }, body: 'Et ici ?', url: 'u', createdAt: 't' }] } }]);
  const [m] = await tickAt(db, 700_000);
  assert.deepEqual(m.e.causes, ['comment:PRRT_3']); assert.equal(m.e.ci, undefined);
});

test('REDEM: done → reopen, merged or plan finished → À toi, not launched → nothing', async () => {
  assert.equal(relay.routeOf(link()), 'message');
  assert.equal(relay.routeOf(link({ status: 'done' })), 'reopen');
  assert.equal(relay.routeOf(link({ status: 'done', canReopen: false })), 'toYou');
  assert.equal(relay.routeOf(link({ status: 'done', merged: true })), 'toYou');
  assert.equal(relay.routeOf(link({ planDone: true })), 'toYou');
  assert.equal(relay.routeOf(link({ status: 'todo' })), null);
  const db = fresh(); gh.setMode('red'); gh.setHead('ccc3333'); gh.setComments('[]');
  assert.equal((await tickAt(db, 900_000, link({ status: 'done', merged: true })))[0].r, 'toYou');
  assert.deepEqual(await tickAt(db, 1_200_000, link({ status: 'done', merged: true })), [], 'À toi once per cause too');
});

test('a closed PR or a gh error: nothing sent, the error reported', async () => {
  const db = fresh(); gh.setMode('merged,red');
  const sent = []; const errors = [];
  await relay.relayTick({ db, links: [link()], gh: github, now: 1, deliver: (...a) => sent.push(a), onError: (l, e) => errors.push(e.message) });
  assert.deepEqual([sent, errors], [[], []]);
  gh.setMode('unauth');
  await relay.relayTick({ db: fresh(), links: [link()], gh: github, now: 1, deliver: (...a) => sent.push(a), onError: (l, e) => errors.push(e.message) });
  assert.equal(sent.length, 0); assert.match(errors[0], /gh auth login/);
});
