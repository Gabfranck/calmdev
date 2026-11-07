// The limits and their thresholds (lib/limits.mjs, docs/limits.md): a simulated stream of rate_limit_event that rises
// crosses the soft threshold, then the hard one, once each; the rows say what is not measured, never a past reset,
// and the one closest to its threshold leads; the planner reads the margins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsOf, limitsOf, statusOf, measureAll, FABLE_MODEL } from '../lib/status.mjs';
import { DEFAULTS, validateThresholds, effectiveThresholds, rowsOf, verdictOf, createWatch, marginsSection } from '../lib/limits.mjs';
import { plain } from '../lib/i18n.mjs';

const now = Date.parse('2026-11-02T03:00:00Z');
const in2h = Math.floor((now + 2 * 36e5) / 1000); const in3d = Math.floor((now + 3 * 864e5) / 1000);
const ev = (weekly, fiveHour, extra = {}) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: weekly, resetsAt: in3d }, ...(fiveHour != null ? { five_hour: { utilization: fiveHour, resetsAt: in2h } } : {}), ...extra } } });
// The fixed defaults, as the tests of the rows were written before the pace of the week (see the last test)
const FIXED = effectiveThresholds(DEFAULTS, {});
const rowsFor = (e, thresholds = FIXED, more = {}) => rowsOf({ claude: limitsOf({ measured: { at: new Date(now).toISOString(), ...windowsOf(e) }, now }), thresholds, now, ...more });

test('a rising stream crosses the soft threshold, then the hard one, each once', () => {
  const watch = createWatch(); const seen = [];
  for (const w of [0.2, 0.5, 0.79, 0.81, 0.85, 0.94, 0.96, 0.97]) {
    const v = verdictOf(rowsFor(ev(w, 0.1)));
    seen.push([w, v.level, watch.observe('p', v)]);
  }
  assert.deepEqual(seen.map((x) => x[2]), [null, null, null, 'soft', null, null, 'hard', null]);
  const v = verdictOf(rowsFor(ev(0.96, 0.1)));
  assert.equal(v.row, 'weekly');
  assert.equal(plain(v.line), 'Quota hebdo à 96 %, seuil dur 95 %', 'the stop says which limit, in one line');
  assert.equal(watch.observe('p', verdictOf(rowsFor(ev(0.1, 0.1)))), 'clear', 'a new week clears it');
});

test('the 5-hour window, in the unified shape and in the older one-window shape, has its own thresholds', () => {
  assert.equal(verdictOf(rowsFor(ev(0.1, 0.91))).row, 'fiveHour');
  assert.equal(verdictOf(rowsFor(ev(0.1, 0.91))).level, 'soft');
  assert.equal(verdictOf(rowsFor(ev(0.1, 0.985))).level, 'hard');
  const old = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.92, resetsAt: in2h } };
  const w = windowsOf(old); assert.equal(w.fiveHour.pct, 92); assert.equal(w.weekly, null);
});

test('the rows: in the order that stops the work first, the closest to its threshold leads, nothing invented', () => {
  const rows = rowsFor(ev(0.5, 0.2, { seven_day_opus: { utilization: 0.3, resetsAt: in3d } }), FIXED, { burst: { capUsd: 10, spentUsd: 8.5, until: new Date(now + 36e5).toISOString() }, run: { title: 'Phase 9', usd: 2, capUsd: 20 } });
  assert.deepEqual(rows.map((r) => r.id), ['burst', 'fiveHour', 'weekly', 'model:fable', 'model:opus', 'plan']);
  assert.equal(rows[0].lead, true); assert.equal(rows[0].margin, 5); // 85 % of the burst against a soft 90
  const fable = rows.find((r) => r.id === 'model:fable');
  assert.equal(fable.pct, null); assert.equal(fable.level, 'unmeasured'); assert.equal(fable.resetsAt, null);
  for (const r of rows) assert.equal(r.soft, (DEFAULTS[r.kind] || {}).soft);
  for (const r of rows) if (r.resetsAt && r.kind !== 'burst') assert.ok(Date.parse(r.resetsAt) > now, 'never a reset in the past');
});

test('a reading older than a reset already past no longer says the window; one read after it holds', () => {
  const reset = new Date(now - 36e5).toISOString();
  const claude = { fiveHour: { pct: 97, resetsAt: reset, at: new Date(now - 2 * 36e5).toISOString() }, weekly: { pct: 40, rawResetsAt: reset, resetsAt: reset, at: new Date(now - 60e3).toISOString() }, models: {} };
  const rows = rowsOf({ claude, now, thresholds: FIXED });
  const fh = rows.find((r) => r.id === 'fiveHour'); assert.equal(fh.pct, null); assert.equal(fh.reason, 'reset'); assert.ok(Date.parse(fh.resetsAt) > now);
  const wk = rows.find((r) => r.id === 'weekly'); assert.equal(wk.pct, 40); assert.ok(Date.parse(wk.resetsAt) > now);
  assert.equal(verdictOf(rows).level, 'ok', 'a stale 97 % does not stop anything');
});

test('no default stops a new user', () => {
  assert.equal(verdictOf(rowsFor(ev(0.02, 0.05))).level, 'ok');
  assert.equal(verdictOf(rowsOf({ now })).level, 'ok', 'nothing measured: nothing blocks');
  assert.deepEqual({ ...DEFAULTS.weekly }, { soft: 80, hard: 95 }); assert.deepEqual({ ...DEFAULTS.fiveHour }, { soft: 90, hard: 98 });
});

test('thresholds: validated, the Mac sets the line, a project may only be stricter', () => {
  assert.deepEqual(validateThresholds({ weekly: { soft: 20, hard: 25 } }).value, { weekly: { soft: 20, hard: 25 } });
  assert.ok(validateThresholds({ weekly: { soft: 90, hard: 80 } }).errors);
  assert.ok(validateThresholds({ weekly: { soft: 0, hard: 80 } }).errors);
  assert.ok(validateThresholds({ nope: { soft: 1, hard: 2 } }).errors);
  assert.deepEqual(validateThresholds({ weekly: { soft: '', hard: 99 } }).value, { weekly: { soft: null, hard: 99 } });
  const mac = { weekly: { soft: 20, hard: 25 } };
  assert.deepEqual(effectiveThresholds(mac, {}).weekly, { soft: 20, hard: 25 }, "tonight's guard: alert 20 %, cut 25 %");
  assert.deepEqual(effectiveThresholds(mac, { weekly: { soft: 50, hard: 60 } }).weekly, { soft: 20, hard: 25 }, 'a project cannot loosen the Mac');
  assert.deepEqual(effectiveThresholds(mac, { weekly: { soft: 10, hard: null } }).weekly, { soft: 10, hard: 25 });
  assert.deepEqual(effectiveThresholds({}, {}).fiveHour, { soft: 90, hard: 98 });
  assert.equal(verdictOf(rowsFor(ev(0.26, 0.1), effectiveThresholds(mac))).level, 'hard');
});

test('the planner reads the margin under each soft threshold, the smallest first', () => {
  const text = marginsSection(rowsFor(ev(0.62, 0.3)), now);
  assert.match(text, /## Les marges/);
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.match(lines[0], /^- Quota hebdo : 62 % utilisés, seuil doux 80 % → marge 18 points, remise dans 3 j$/);
  assert.match(text, /Fenêtre de 5 h : 30 % utilisés, seuil doux 90 % → marge 60 points, remise dans 2 h/);
  assert.match(text, /Quota hebdo Fable : non mesuré \(seuil doux 80 %\)/);
  assert.match(marginsSection(rowsFor(ev(0.85, 0.3)), now), /franchi : rien de nouveau ne se lance/);
});

test('the status carries the rows and the verdict; a live run counts its cap', () => {
  const plans = [{ id: 'p1', title: 'Phase 9', created: new Date(now - 36e5).toISOString(), capUsd: 10, state: [{ id: 'T', status: 'running', usage: { cost: 9.6 } }] }];
  const s = statusOf({ project: '/x', now, plans, account: null, measure: { last: { at: new Date(now).toISOString(), ...windowsOf(ev(0.3, 0.1)) } } });
  const plan = s.limits.rows.find((r) => r.id === 'plan'); assert.equal(plan.pct, 96); assert.equal(plan.level, 'soft');
  assert.equal(s.limits.rows[0].id, 'plan'); assert.equal(s.limits.verdict.level, 'soft');
});

test('the measure asks Fable only when the Haiku event lacks its window', async () => {
  const asked = [];
  const one = async (o) => { asked.push(o.model || 'haiku'); return o.model === FABLE_MODEL ? { at: 'b', ...windowsOf(ev(0.4, null, { seven_day_fable: { utilization: 0.7, resetsAt: in3d } })) } : { at: 'a', ...windowsOf(ev(0.4, 0.2)) }; };
  const m = await measureAll({}, one);
  assert.deepEqual(asked, ['haiku', FABLE_MODEL]);
  assert.equal(m.models.fable.weekly.pct, 70); assert.equal(m.fiveHour.pct, 20);
  asked.length = 0; const one2 = async (o) => { asked.push(o.model || 'haiku'); return { at: 'a', ...windowsOf(ev(0.4, 0.2, { seven_day_fable: { utilization: 0.1, resetsAt: in3d } })) }; };
  await measureAll({}, one2); assert.deepEqual(asked, ['haiku']);
});

test('the pace of the week: a Monday cannot burn the week; a threshold set in Access replaces the pace', async () => {
  const { paceThresholds, effectiveThresholds, rowsOf } = await import('../lib/limits.mjs');
  const now = Date.parse('2026-11-02T00:40:00+01:00'); // the first night after a Sunday 14:00 reset
  assert.deepEqual(paceThresholds('weekly', '2026-11-08T13:00:00Z', now), { soft: 21, hard: 31, pace: true });
  assert.equal(paceThresholds('weekly', '2026-11-02T13:00:00Z', now).soft, 80); // the last hours of the week
  assert.equal(effectiveThresholds({}, {}).weekly.pace, true);
  assert.equal(effectiveThresholds({ weekly: { soft: 25, hard: 30 } }, {}).weekly.pace, undefined);
  const rows = rowsOf({ claude: { weekly: { pct: 22, resetsAt: '2026-11-08T13:00:00Z', at: '2026-11-02T00:39:00+01:00' } }, thresholds: effectiveThresholds({}, {}), now });
  const w = rows.find((r) => r.id === 'weekly'); assert.equal(w.soft, 21); assert.equal(w.level, 'soft'); assert.equal(w.pace, true);
});

// The pause (phase 10 P): a window that resets pauses at its hard threshold, a dollar cap never does; a paused session
// holds while the window is above its hard threshold, resumes at its reset or under its soft threshold, never on a
// figure missing before the reset
test('the pause: which limits pause, and when a paused session resumes', async () => {
  const { pausable, pauseOf, hardPausable, pauseStep } = await import('../lib/limits.mjs');
  const T25 = effectiveThresholds({ weekly: { soft: 20, hard: 25 } }, {});
  const hot = rowsFor(ev(0.30, 0.1), T25);
  const [w] = hardPausable(hot); assert.equal(w.id, 'weekly');
  assert.equal(pausable({ kind: 'burst' }), false); assert.equal(pausable({ kind: 'plan' }), false); assert.equal(pausable({ kind: 'model' }), true);
  const p = pauseOf(w, verdictOf([w]).line, '2026-11-02T03:00:00Z');
  assert.equal(p.limit, 'weekly'); assert.equal(p.until, new Date(in3d * 1000).toISOString()); assert.match(plain(p.line), /Quota hebdo à 30 %, seuil dur 25 %/);
  // still above: hold, the same pause
  assert.deepEqual(pauseStep(p, hot, now), { action: 'hold', pause: p });
  // forced by the developer (« Tout reprendre »): that limit no longer holds
  assert.equal(pauseStep(p, rowsFor(ev(0.30, 0.1), effectiveThresholds({ weekly: { soft: 25, hard: 100 } }, {})), now).action, 'hold', 'between soft and hard: hold');
  assert.equal(pauseStep(p, hot, now, (r) => r.id === 'weekly').action, 'hold', 'forced but still over its soft threshold: no auto resume either');
  // a threshold raised in Access: the same reading is now under the soft threshold
  assert.deepEqual(pauseStep(p, rowsFor(ev(0.30, 0.1), effectiveThresholds({ weekly: { soft: 40, hard: 50 } }, {})), now), { action: 'resume', why: 'below' });
  // the reset: its hour passed, or a reading older than the reset
  assert.deepEqual(pauseStep(p, [], in3d * 1000 + 1), { action: 'resume', why: 'reset' });
  const old = rowsOf({ claude: limitsOf({ measured: { at: new Date(now).toISOString(), ...windowsOf(ev(0.30, 0.1)) }, now: in3d * 1000 + 5 }), thresholds: T25, now: in3d * 1000 + 5 });
  assert.equal(old.find((r) => r.id === 'weekly').reason, 'reset'); assert.equal(pauseStep(p, old, in3d * 1000 + 5).action, 'resume');
  // nothing measured before the reset: hold
  assert.equal(pauseStep(p, rowsOf({ claude: null, thresholds: T25, now }), now).action, 'hold');
  // another window above its hard threshold: hold, the cause moves to it
  const five = rowsFor(ev(0.10, 0.99), T25); const s = pauseStep(p, five, now);
  assert.equal(s.action, 'hold'); assert.equal(s.changed, true); assert.equal(s.pause.limit, 'fiveHour'); assert.equal(s.pause.until, new Date(in2h * 1000).toISOString());
});

test('the pause: a reading of the same limit without its reset keeps the hour known', async () => {
  const { pauseStep } = await import('../lib/limits.mjs');
  const p = { limit: 'weekly', kind: 'weekly', label: 'weekly', line: 'x', until: '2026-11-05T00:00:00.000Z', at: 'a' };
  assert.deepEqual(pauseStep(p, [{ id: 'weekly', kind: 'weekly', level: 'hard', pct: 30, hard: 25, resetsAt: null }], now), { action: 'hold', pause: p });
});
