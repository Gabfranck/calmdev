// The weekly quota never comes from before the last reset (phase 11, DP; Dev, 2026-11-02: the Flot said 74 % while the
// account was at 26 %: it read last week's reading of a planner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { weeklyNow, lastResetBefore, horizonOf } from '../lib/horizon.mjs';

const T = (s) => Date.parse(s);

test('lastResetBefore: the newest reset already past, by whole weeks from the one read', () => {
  const now = T('2026-11-02T03:00:00Z');
  assert.equal(lastResetBefore('2026-11-01T13:00:00Z', now), T('2026-11-01T13:00:00Z'), 'a reset of yesterday');
  assert.equal(lastResetBefore('2026-11-08T13:00:00Z', now), T('2026-11-01T13:00:00Z'), 'a reset to come: one week back');
  assert.equal(lastResetBefore('2026-10-18T13:00:00Z', now), T('2026-11-01T13:00:00Z'), 'a reset of two weeks ago: forward to the last one');
  assert.equal(lastResetBefore('bad', now), null);
});

test('weeklyNow: a reading older than the last reset is dropped, a newer one wins', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table escadrilles (weekly real, reset_at text, at text)'); db.exec('create table sessions (usage text, at text)');
  const now = T('2026-11-02T03:00:00Z');
  // last week's planner: 74 % with a reset on Sunday 1 November 13:00, read on 31 October
  db.prepare('insert into escadrilles values (?, ?, ?)').run(0.74, '2026-11-01T13:00:00Z', '2026-10-31T22:00:00Z');
  assert.equal(weeklyNow(db, now), null, 'the reading is from before the reset: nothing, never 74 %');
  assert.equal(horizonOf({ db, now }).usedPct, null);
  // a session read after the reset: its share counts, the reset stays the planner's
  db.prepare('insert into sessions values (?, ?)').run(JSON.stringify({ weekly: 0.26 }), '2026-11-02T01:00:00Z');
  assert.deepEqual(weeklyNow(db, now), { weekly: 0.26, resetsAt: '2026-11-08T13:00:00.000Z', at: '2026-11-02T01:00:00Z' }, 'the share of the session, the next reset after the last known');
  assert.equal(horizonOf({ db, now }).usedPct, 26);
  // the reset read on 1 November is past: the horizon says the next one, a week later
  db.prepare('insert into escadrilles values (?, ?, ?)').run(0.3, '2026-11-01T13:00:00Z', '2026-11-02T02:00:00Z');
  assert.equal(horizonOf({ db, now }).resetsAt, '2026-11-08T13:00:00.000Z'); assert.equal(horizonOf({ db, now }).hoursLeft, 154);
  // a session read before the reset does not come back even when it is the newest session
  db.prepare('delete from sessions').run(); db.prepare('delete from escadrilles where weekly = 0.3').run();
  db.prepare('insert into sessions values (?, ?)').run(JSON.stringify({ weekly: 0.77 }), '2026-11-01T12:00:00Z');
  assert.equal(weeklyNow(db, now), null);
  // before any reset is known, every reading counts (as before)
  db.exec('delete from escadrilles');
  assert.equal(weeklyNow(db, now).weekly, 0.77);
});
