// Phase 9, session P1: the status panel beside the Conversation (lib/status.mjs, docs/phase9/direction.md §4).
// The windows of a rate_limit_event read without invention, the measurer capped at one call per interval and only
// when a client reads, a stale reading said stale, the costs recomputed from the fixture transcripts, then the
// route against the server on a spare port (no claude: every limit « non mesuré »).
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowsOf, hasWindows, createMeasurer, limitsOf, costWindows, lastRun, withRun, nowOf, guardOf, statusOf, measureArgs, measureLimits, MEASURE_EVERY_MS, STALE_MS } from '../lib/status.mjs';
import { scanTranscripts, costOf } from '../lib/usage.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const T0 = Date.parse('2026-11-01T18:00:00.000Z');
const EV = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.742, resetsAt: 1793620800 }, five_hour: { utilization: 0.12, resetsAt: 1793556000 }, seven_day_opus: { utilization: 0.3, resetsAt: 1793620800 }, odd_key: { utilization: 0.5 }, seven_day_sonnet: { resetsAt: 1 } } } };

test('the windows of a rate_limit_event: those present, a model window under its name, nothing invented', () => {
  const w = windowsOf(EV);
  assert.deepEqual(w.weekly, { utilization: 0.742, pct: 74.2, resetsAt: '2026-11-02T12:00:00.000Z' });
  assert.deepEqual(w.fiveHour, { utilization: 0.12, pct: 12, resetsAt: '2026-11-01T18:00:00.000Z' });
  assert.deepEqual(Object.keys(w.models), ['opus'], 'a window without utilization is not a window');
  assert.equal(w.models.opus.weekly.pct, 30); assert.equal(w.models.opus.fiveHour, null);
  assert.deepEqual(windowsOf({ type: 'rate_limit_event' }), { weekly: null, fiveHour: null, models: {} });
  assert.equal(hasWindows(windowsOf({})), false); assert.equal(hasWindows(w), true);
});

test('the measurer: one call per interval, only when a client reads, the reading kept, a failure kept quiet', async () => {
  let t = T0; let calls = 0; let answer = { at: new Date(T0).toISOString(), weekly: { utilization: 0.5, pct: 50, resetsAt: null }, fiveHour: null, models: {} };
  const m = createMeasurer({ measure: async () => { calls++; return answer; }, now: () => t });
  assert.equal(calls, 0, 'nothing measured before someone looks');
  const first = m.read(); assert.equal(first.measuring, true); assert.equal(first.last, null, 'read() never waits');
  await m.pending();
  assert.equal(m.read().last.weekly.pct, 50);
  for (let i = 0; i < 5; i++) { t += 60e3; m.read(); await m.pending(); }
  assert.equal(calls, 1, 'six reads in six minutes: one measure');
  t = T0 + MEASURE_EVERY_MS; answer = null; m.read(); await m.pending();
  assert.equal(calls, 2, 'the next interval measures again');
  assert.equal(m.read().last.weekly.pct, 50, 'a measure that gives nothing keeps the last reading');
  const off = createMeasurer({ measure: async () => { throw new Error('no claude'); }, now: () => t, enabled: false });
  off.read(); await off.pending(); assert.equal(off.read().last, null);
  const bad = createMeasurer({ measure: async () => { throw new Error('no claude'); }, now: () => t });
  bad.read(); await bad.pending(); assert.equal(bad.read().last, null); assert.equal(bad.read().measuring, false);
});

test('the limits: the newest reading wins per window, the rest is null, a reading older than STALE_MS is stale', () => {
  const quota = { weekly: 0.7, resetsAt: '2026-11-02T12:00:00.000Z', at: '2026-11-01T17:50:00.000Z' };
  const none = limitsOf({ quota: null, measured: null, now: T0 });
  assert.deepEqual(none, { weekly: null, fiveHour: null, models: {}, measuredAt: null, stale: false, measuring: false, nextAt: null });
  const s = limitsOf({ quota, now: T0 });
  assert.deepEqual(s.weekly, { pct: 70, rawResetsAt: quota.resetsAt, resetsAt: quota.resetsAt, at: quota.at, source: 'session' }); assert.equal(s.fiveHour, null); assert.equal(s.stale, false);
  const measured = { at: '2026-11-01T17:55:00.000Z', ...windowsOf(EV) };
  const both = limitsOf({ quota, measured, now: T0 });
  assert.equal(both.weekly.source, 'measure'); assert.equal(both.weekly.pct, 74.2); assert.equal(both.fiveHour.pct, 12); assert.equal(both.models.opus.weekly.pct, 30);
  const older = limitsOf({ quota: { ...quota, at: '2026-11-01T17:58:00.000Z' }, measured, now: T0 });
  assert.equal(older.weekly.source, 'session', 'a session reading newer than the measure keeps the weekly share');
  assert.equal(older.fiveHour.pct, 12, 'the 5-hour window still comes from the measure');
  assert.equal(limitsOf({ quota, measured, now: T0 + STALE_MS + 60e3 }).stale, true);
  assert.equal(limitsOf({ quota, now: T0 + STALE_MS + 60e3 }).stale, true, 'a lone session reading ages too');
});

test('the costs: today from the local midnight, 7 days, the project only, the hour of the start counts whole', () => {
  const sessions = scanTranscripts({ root: path.join(HERE, 'fixtures', 'projects') });
  const a1 = costOf([16, 60, 40, 3500, 80], 'claude-opus-5-5'), a2 = costOf([20, 0, 0, 3000, 100], 'claude-fable-5-1');
  const now = Date.parse('2026-10-31T12:00:00.000Z'); const dayStart = Date.parse('2026-10-31T09:30:00.000Z');
  const c = costWindows({ sessions, project: '/fx/alpha', now, dayStart, dollarsPerPct: 0.001 });
  assert.equal(c.today.usd, Math.round(a2 * 100) / 100); assert.equal(c.today.sessions, 1);
  assert.equal(c.week.usd, Math.round((a1 + a2) * 100) / 100); assert.equal(c.week.sessions, 2, 'b1 is another project and 11 days old');
  assert.equal(c.today.pct, Math.round(c.today.usd / 0.001 * 10) / 10); assert.equal(c.calibrated, true);
  const d = costWindows({ sessions, project: '/fx/alpha', now, dayStart: Date.parse('2026-10-31T10:40:00.000Z') });
  assert.equal(d.today.usd, Math.round(a2 * 100) / 100, 'the hour that holds the day start counts whole');
  assert.equal(d.today.pct, null); assert.equal(d.calibrated, false);
  assert.deepEqual(costWindows({ sessions, project: '/fx/none', now }).week, { usd: 0, sessions: 0, pct: null });
  assert.equal(costWindows({ sessions, project: null, now }).today.usd, 0);
});

test('the last run, « Maintenant » and the guard, from the plans and the flow', () => {
  const plans = [
    { id: 'p-old', title: 'Old', created: '2026-10-30T10:00:00Z', status: 'merged', state: [{ id: 'A', status: 'done', usage: { cost: 3 } }] },
    { id: 'p-new', title: 'New', created: '2026-11-01T10:00:00Z', status: 'running', network: ['registry.npmjs.org'], state: [{ id: 'A', status: 'running', usage: { cost: 1.234 } }, { id: 'B', status: 'waiting', usage: null }] },
    { id: 'p-plan', title: 'Planned only', created: '2026-11-01T12:00:00Z', status: 'todo', state: [] },
  ];
  assert.deepEqual(lastRun(plans, 0.01), { plan: 'p-new', title: 'New', usd: 1.23, capUsd: null, pct: 123, live: true, created: '2026-11-01T10:00:00Z' });
  assert.equal(lastRun([]), null); assert.equal(lastRun([plans[2]]), null);
  // a run of today is part of today and of the week: the floor of both windows when the transcripts say less, never a sum
  const zero = { today: { usd: 0, sessions: 0, pct: null }, week: { usd: 0, sessions: 0, pct: null }, calibrated: false };
  const now = Date.parse('2026-11-01T14:00:00Z'); const dayStart = Date.parse('2026-11-01T00:00:00Z');
  const r = withRun(zero, lastRun(plans, 0.01), { now, dayStart, dollarsPerPct: 0.01 });
  assert.deepEqual([r.today.usd, r.today.pct, r.week.usd, r.week.pct], [1.23, 123, 1.23, 123]);
  assert.equal(withRun({ ...zero, today: { usd: 5, sessions: 2, pct: null } }, lastRun(plans), { now, dayStart }).today.usd, 5, 'the transcripts already say more: unchanged');
  const old = withRun(zero, lastRun([plans[0]]), { now, dayStart });
  assert.deepEqual([old.today.usd, old.week.usd], [0, 3], 'a run of two days ago: in the week, not in today');
  assert.equal(withRun(zero, lastRun([{ ...plans[0], created: '2026-10-20T10:00:00Z' }]), { now, dayStart }).week.usd, 0, 'older than the week: untouched');
  assert.equal(withRun(zero, null, { now, dayStart }), zero);
  const nodes = [
    { plan: 'p-new', session: 'A', name: 'a', status: 'running', waitingFor: null, cost: 1.23, budget: 5 },
    { plan: 'p-new', session: 'B', name: 'b', status: 'waiting', waitingFor: 'pilot', cost: 0, budget: 5 },
    { plan: 'p-new', session: 'C', name: 'c', status: 'todo', waitingFor: null, cost: 0, budget: 5 },
    { plan: 'p-new', session: 'D', name: 'd', status: 'done', waitingFor: 'review', cost: 2, budget: 5 },
    { plan: 'p-new', session: 'E', name: 'e', status: 'running', waitingFor: 'permission', cost: 0.5, budget: 5 },
    { plan: 'p-plan', session: 'A', name: 'x', status: 'todo', waitingFor: null, cost: 0, budget: 5 },
    { plan: 'p-old', session: 'A', name: 'y', status: 'merged', waitingFor: null, cost: 3, budget: 5 },
  ];
  const n = nowOf(nodes, plans);
  assert.deepEqual([n.running, n.waiting, n.pilot, n.queued, n.errors, n.more], [2, 1, 1, 1, 0, 0], 't\'attend counts the developer\'s waits only; B waits for the pilot (phase 11, X)');
  assert.deepEqual(n.rows.map((r) => r.session), ['A', 'E', 'D', 'B', 'C'], 'running first, then what waits for the developer, then the pilot\'s, then the queued of a running plan; five at most');
  assert.deepEqual(n.rows[4].after, [], 'a queued row carries what it waits for');
  const many = nowOf([...nodes, { plan: 'p-new', session: 'F', name: 'f', status: 'later', after: ['A', 'B'], cost: 0, budget: 5 }, { plan: 'p-new', session: 'G', name: 'g', status: 'later', after: ['A'], cost: 0, budget: 5 }], plans);
  assert.deepEqual([many.rows.length, many.more, many.queued], [5, 2, 3], 'five rows, the rest counted');
  assert.equal(nowOf([], []).running, 0);
  const g = guardOf({ autonomy: { mode: 'guide', autoMergeIfGreen: true, testCommand: null }, plan: plans[1], burst: { id: 'b1', status: 'running', capUsd: 40, spentUsd: 3 }, network: [{ host: 'registry.npmjs.org', scope: 'sessions' }] });
  assert.deepEqual(g, { mode: 'guide', network: ['registry.npmjs.org'], plan: { id: 'p-new', title: 'New' }, burst: { id: 'b1', status: 'running', capUsd: 40, spentUsd: 3 }, autoMerge: false });
  assert.equal(guardOf({ burst: { id: 'b2', status: 'done' } }).burst, null); assert.equal(guardOf({}).mode, 'surveille');
  const s = statusOf({ project: '/fx/alpha', now: T0, plans, nodes, quota: null, measure: null });
  assert.equal(s.cost.run.plan, 'p-new'); assert.equal(s.guard.plan.id, 'p-new'); assert.equal(s.claude.weekly, null); assert.equal(s.now.running, 2);
});

test('the measure call: the arguments of a minimal Haiku turn, and a missing claude gives null without throwing', async () => {
  const a = measureArgs();
  assert.ok(a.includes('--tools') && a[a.indexOf('--tools') + 1] === '' && a.includes('--max-turns') && a.includes('claude-haiku-5-5'));
  assert.equal(await measureLimits({ claude: '/nulle/part/claude', timeoutMs: 2000 }), null);
  assert.equal(await measureLimits({ claude: process.execPath, timeoutMs: 1500 }), null, 'a process that prints no event');
});

// ---- the route, on a server with no claude and no transcripts
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-status-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-status-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-status-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-status-none-'), ESCADRILLE_CLAUDE: '/nulle/part' }, stdio: 'ignore' });
after(() => server.kill('SIGINT'));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

test('GET /api/status: the four blocks, every limit non mesuré without claude, 400 without a project', async () => {
  await until(async () => { try { return (await fetch(BASE + '/api/plans')).status === 200; } catch { return false; } });
  const proj = tmp('escadrille-status-proj-');
  assert.equal((await fetch(BASE + '/api/status')).status, 400);
  const s = await fetch(BASE + '/api/status?project=' + encodeURIComponent(proj)).then((r) => r.json());
  assert.deepEqual(Object.keys(s), ['project', 'at', 'now', 'limits', 'claude', 'cost', 'guard', 'unit', 'pilot']);
  assert.equal(s.unit.unit, 'EUR'); assert.equal(s.unit.week.eurPerPct, null, 'no subscription price set: no euros invented'); assert.deepEqual(s.pilot, { present: false, external: false }, 'no pilot: every wait is the developer\'s');
  assert.deepEqual(s.limits.rows.map((r) => [r.id, r.pct, r.level]), [['fiveHour', null, 'unmeasured'], ['weekly', null, 'unmeasured'], ['model:fable', null, 'unmeasured']], 'every limit said, none invented');
  assert.equal(s.limits.verdict.level, 'ok');
  assert.deepEqual([s.now.running, s.now.waiting, s.now.queued, s.now.rows], [0, 0, 0, []]);
  assert.equal(s.claude.weekly, null); assert.equal(s.claude.fiveHour, null); assert.deepEqual(s.claude.models, {});
  assert.deepEqual([s.cost.today.usd, s.cost.week.usd, s.cost.run, s.cost.calibrated], [0, 0, null, false]);
  assert.deepEqual([s.guard.mode, s.guard.network, s.guard.burst, s.guard.autoMerge], ['surveille', [], null, false]);
  await new Promise((r) => setTimeout(r, 300));
  const again = await fetch(BASE + '/api/status?project=' + encodeURIComponent(proj)).then((r) => r.json());
  assert.equal(again.claude.measuring, false, 'the failed measure is over, no retry before the interval');
  assert.ok(again.claude.nextAt, 'the next measure is dated');
});
