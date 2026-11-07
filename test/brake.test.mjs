// FREIN (Dev, 7 Nov.): the review pace brake. The count of finished deliveries not reviewed, the threshold, the refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { STALE_DAYS, unreviewedOf, unreviewedCount, brakeOf, brakeCheck, validateBrake, DEFAULT_BRAKE } from '../lib/brake.mjs';

import { ensure, mark } from '../lib/sessiondone.mjs';

const dbWith = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table sessions (plan text, id text, status text, worktree text, at text);
    create table reviews (id text primary key, project text, plan text, session text, verdict text);`);
  return db;
};
const NOW = Date.parse('2026-11-07T12:00:00Z');
const ago = (days) => new Date(NOW - days * 864e5).toISOString();
const plan = (db, id, project, extra = {}) => db.prepare('insert into plans (id, json, project) values (?, ?, ?)').run(id, JSON.stringify({ id, sessions: [], ...extra }), project);
const session = (db, p, id, status, wt = { path: '/w', branch: 'b' }, at = ago(0.1)) => db.prepare('insert into sessions values (?, ?, ?, ?, ?)').run(p, id, status, wt ? JSON.stringify(wt) : null, at);

test('the count: a finished session not merged and not approved, per project', () => {
  const db = dbWith();
  plan(db, 'p1', '/a'); plan(db, 'p2', '/b'); plan(db, 'kit', '/a', { kit: true }); plan(db, 'old', '/a', { status: 'closed' });
  session(db, 'p1', 'A', 'done');                                   // counted
  session(db, 'p1', 'B', 'done', { path: '/w', merged: true });     // merged
  session(db, 'p1', 'C', 'running');                                // still at work
  session(db, 'p1', 'D', 'done', null);                             // no worktree, nothing to review
  session(db, 'p1', 'E', 'done');                                   // approved below
  session(db, 'p1', 'pilot', 'done');                               // the pilot is no delivery
  session(db, 'kit', 'K', 'done'); session(db, 'old', 'O', 'done'); // a kit, a closed plan
  session(db, 'p2', 'X', 'done');                                   // another project
  db.prepare("insert into reviews values ('r1', '/a', 'p1', 'E', 'approve')").run();
  assert.deepEqual(unreviewedOf(db, '/a', NOW), [{ plan: 'p1', session: 'A' }]);
  assert.equal(unreviewedCount(db, '/b'), 1);
  assert.equal(unreviewedCount(db, '/none'), 0);
});

test('a delivery idle for more than STALE_DAYS no longer counts; yesterday\'s does', () => {
  assert.equal(STALE_DAYS, 3);
  const db = dbWith();
  plan(db, 'p', '/a');
  session(db, 'p', 'OLD', 'done', undefined, ago(4));
  session(db, 'p', 'NEW', 'done', undefined, ago(1));
  assert.deepEqual(unreviewedOf(db, '/a', NOW), [{ plan: 'p', session: 'NEW' }]);
});

test('the age reads the fixed end date (session_done) when there is one, sessions.at otherwise', () => {
  const db = dbWith(); ensure(db);
  plan(db, 'p', '/a');
  session(db, 'p', 'TOUCHED', 'done', undefined, ago(0.1)); mark(db, 'p', 'TOUCHED', ago(5)); // finished 5 days ago, row rewritten since
  session(db, 'p', 'FRESH', 'done', undefined, ago(4)); mark(db, 'p', 'FRESH', ago(1));       // the fixed date wins over an old `at`
  session(db, 'p', 'LEGACY', 'done', undefined, ago(0.5));                                    // no fixed date: sessions.at
  assert.deepEqual(unreviewedOf(db, '/a', NOW).map((x) => x.session).sort(), ['FRESH', 'LEGACY']);
});

test('the count holds without a reviews table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table plans (id text, json text, project text); create table sessions (plan text, id text, status text, worktree text, at text);');
  plan(db, 'p', '/a'); session(db, 'p', 'A', 'done');
  assert.equal(unreviewedCount(db, '/a'), 1);
});

test('the threshold: 8 by default, the project setting otherwise, a bad value falls back', () => {
  assert.equal(DEFAULT_BRAKE, 8);
  assert.equal(brakeOf({}), 8); assert.equal(brakeOf(null), 8);
  assert.equal(brakeOf({ reviewBrake: 3 }), 3);
  assert.equal(brakeOf({ reviewBrake: 0 }), 8); assert.equal(brakeOf({ reviewBrake: 'x' }), 8);
  assert.deepEqual(validateBrake(null), { value: null });
  assert.deepEqual(validateBrake(12), { value: 12 });
  for (const bad of [0, -1, 1.5, true, '', 'abc', 1000]) assert.ok(validateBrake(bad).errors, String(bad));
});

test('the refusal: only above the threshold, with the path that works', () => {
  assert.equal(brakeCheck({ count: 8, threshold: 8 }).ok, true);
  const r = brakeCheck({ count: 9, threshold: 8 });
  assert.equal(r.ok, false);
  assert.match(r.why, /9 livraisons finies à relire \(seuil 8\)/);
  assert.match(r.why, /Relis-en/); assert.match(r.why, /monte le seuil dans Accès/); assert.match(r.why, /à la main reste possible/);
  assert.equal(brakeCheck({ count: 1, threshold: 0 }).threshold, 8);
});
