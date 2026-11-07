// nextStep (docs/nextstep.md): every state × every cran gives exactly one actor, and every button unblocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextStep, EFFECT, CRANS, WHO, GESTURES, cranOf, storedOf, humanKinds, stalled, STALL_MS } from '../lib/nextstep.mjs';

const fr = JSON.parse(readFileSync(new URL('../public/i18n/fr.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'));
const wt = { path: '/w', branch: 'b', base: 'main' };
const stops = ['plain', { title: 'goût', kind: 'taste' }, { title: 'données', kind: 'data' }, { title: 'sécu', kind: 'security' }, { title: 'rel', kind: 'release' }];
const S = (o) => ({ plan: 'p1', id: 'A', stops, ...o });
// Every state of the table, one sample each
const STATES = {
  merged: S({ status: 'done', worktree: { ...wt, merged: true } }),
  todo: S({ status: 'todo' }),
  later: S({ status: 'later' }),
  paused: S({ status: 'paused', worktree: wt }),
  running: S({ status: 'running', worktree: wt }),
  permNetwork: S({ status: 'waiting', worktree: wt, pending: [{ id: 'x1', kind: 'permission', network: ['example.org'] }] }),
  permGuard: S({ status: 'waiting', worktree: wt, pending: [{ id: 'x2', kind: 'permission', guard: true }] }),
  perm: S({ status: 'waiting', worktree: wt, pending: [{ id: 'x3', kind: 'permission' }] }),
  replyTaste: S({ status: 'waiting', worktree: wt, pending: [{ id: 'r1', kind: 'reply', stop: 1 }] }),
  replyData: S({ status: 'waiting', worktree: wt, pending: [{ id: 'r2', kind: 'reply', stop: 2 }] }),
  replySecurity: S({ status: 'waiting', worktree: wt, pending: [{ id: 'r3', kind: 'reply', stop: 3 }] }),
  replyRelease: S({ status: 'waiting', worktree: wt, pending: [{ id: 'r4', kind: 'reply', stop: 4 }] }),
  reply: S({ status: 'waiting', worktree: wt, pending: [{ id: 'r5', kind: 'reply', stop: 0 }] }),
  error: S({ status: 'waiting', health: 'error', worktree: wt }),
  done: S({ status: 'done', worktree: wt }),
  waitingFinished: S({ status: 'waiting', worktree: wt }),
  doneAuto: S({ status: 'done', worktree: wt, autoMerge: true }),
  doneKit: S({ status: 'done', worktree: wt, delivery: 'kit' }),
  waitingNoBranch: S({ status: 'waiting' }),
};

test('every state × every cran: exactly one actor, a known gesture, and the button unblocks', () => {
  for (const cran of CRANS) for (const [name, s] of Object.entries(STATES)) {
    const r = nextStep(s, { id: 'proj', cran });
    assert.ok(WHO.includes(r.who), `${name}/${cran}: one actor among ${WHO}`);
    assert.ok(r.why && fr[r.why] && en[r.why], `${name}/${cran}: why ${r.why} in both dictionaries`);
    if (r.who === 'dev' || r.who === 'pilot') {
      assert.ok(GESTURES.includes(r.gesture), `${name}/${cran}: ${r.who} has a gesture`);
      assert.ok(fr[r.button] && en[r.button], `${name}/${cran}: button ${r.button} in both dictionaries`);
      assert.ok(r.link && r.link.startsWith('/plan/p1?project=proj#'), `${name}/${cran}: a link`);
      const after = nextStep(EFFECT[r.gesture](s), { id: 'proj', cran });
      assert.notDeepEqual([after.who, after.gesture, after.why], [r.who, r.gesture, r.why], `${name}/${cran}: ${r.gesture} must change the state`);
      assert.ok(['session', 'none'].includes(after.who), `${name}/${cran}: after ${r.gesture} nobody waits (${after.who})`);
    } else {
      assert.equal(r.gesture, null); assert.equal(r.button, null); assert.equal(r.link, null);
    }
  }
});

test('a button that unblocks nothing fails the contract', () => {
  const broken = { ...EFFECT, merge: (s) => s };
  const s = STATES.done; const r = nextStep(s, { cran: 'moi' });
  assert.deepEqual([nextStep(broken.merge(s), { cran: 'moi' }).who, nextStep(broken.merge(s), { cran: 'moi' }).gesture], [r.who, r.gesture]);
});

test('A3: a finished session waiting for its merge gives Approve and merge to its review, never Reply', () => {
  for (const cran of CRANS) for (const s of [STATES.done, STATES.waitingFinished]) {
    const r = nextStep(s, { id: 'proj', cran });
    assert.equal(r.who, 'dev'); assert.equal(r.gesture, 'merge'); assert.equal(r.button, 'next.btn.merge');
    assert.match(r.link, /#review-A$/);
  }
  assert.match(fr['next.btn.merge'], /Approuver et fusionner/);
});

test('the cran decides who answers: Moi everything to the dev, Pilote keeps taste for the dev, autonome gives taste to the pilot', () => {
  const who = (s, cran) => nextStep(s, { cran }).who;
  assert.equal(who(STATES.reply, 'moi'), 'dev'); assert.equal(who(STATES.reply, 'pilote'), 'pilot'); assert.equal(who(STATES.reply, 'autonome'), 'pilot');
  assert.equal(who(STATES.replyTaste, 'pilote'), 'dev'); assert.equal(who(STATES.replyTaste, 'autonome'), 'pilot');
  for (const c of CRANS) { assert.equal(who(STATES.replyData, c), 'dev'); assert.equal(who(STATES.permNetwork, c), 'dev'); assert.equal(who(STATES.permGuard, c), 'dev'); }
  assert.equal(who(STATES.perm, 'moi'), 'dev'); assert.equal(who(STATES.perm, 'pilote'), 'pilot');
  assert.equal(nextStep(STATES.reply, { cran: 'moi', pilotPresent: true }).who, 'pilot', 'an external pilot present answers under Moi');
  assert.deepEqual(humanKinds('pilote'), ['taste', 'data', 'security', 'release']);
  assert.deepEqual(humanKinds('autonome'), ['data', 'security', 'release']);
});

test('the old stored settings convert into a cran, and back', () => {
  assert.equal(cranOf({ pilotOn: false, mode: 'autonome' }), 'moi');
  assert.equal(cranOf({ pilotOn: true, mode: 'surveille' }), 'pilote');
  assert.equal(cranOf({ pilotOn: true, mode: 'guide' }), 'pilote');
  assert.equal(cranOf({ pilotOn: true, mode: 'autonome' }), 'autonome');
  assert.equal(cranOf({}), 'moi');
  assert.equal(cranOf({ cran: 'autonome', pilotOn: false }), 'autonome');
  for (const c of CRANS) assert.equal(cranOf(storedOf(c)), c);
});

test('C1: the same wait for over an hour, repeated by the pilot, goes to the developer with the real gesture', () => {
  const t0 = Date.parse('2026-11-06T20:00:00Z');
  const s = { ...STATES.reply, waitingSince: new Date(t0).toISOString(), pilotRepeats: 3 };
  assert.equal(nextStep(s, { cran: 'pilote' }, { now: t0 + 30 * 60e3 }).who, 'pilot', 'half an hour: still the pilot');
  const late = nextStep(s, { cran: 'pilote' }, { now: t0 + STALL_MS + 1 });
  assert.deepEqual([late.who, late.gesture, late.why], ['dev', 'reply', 'next.why.stalled']);
  assert.equal(nextStep({ ...s, pilotRepeats: 1 }, { cran: 'pilote' }, { now: t0 + STALL_MS + 1 }).who, 'pilot', 'one look is not a loop');
  assert.equal(stalled({ waitingSince: 'nope', pilotRepeats: 9 }, t0), false);
  const perm = { ...STATES.perm, waitingSince: new Date(t0).toISOString(), pilotRepeats: 2 };
  assert.deepEqual([nextStep(perm, { cran: 'autonome' }, { now: t0 + 2 * STALL_MS }).who, nextStep(perm, { cran: 'autonome' }, { now: t0 + 2 * STALL_MS }).gesture], ['dev', 'allow']);
});
