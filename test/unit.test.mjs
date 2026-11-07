// The single unit of usage (docs/usage-unit.md): the value of a weekly point, measured per model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateSamples, modelRates, unitGauge, validateUnit } from '../lib/unit.mjs';

test('the gauge in euros paid: included points at the subscription price, credits at their billed price, the jump between', () => {
  // Dev, 7 November: Max 20x at 180 € a month, ~7.7 $ of API a point (the night of 1 November)
  const g = unitGauge({ unit: { planEurMonth: 180, creditEurPerUsd: 0.9 }, usdPerPct: 7.7, claude: { weekly: { pct: 40, resetsAt: '2026-11-08T13:00:00.000Z' }, fiveHour: { pct: 12 } }, credits: { enabled: true, usedMinor: 1240, limitMinor: 5000, currency: 'EUR' }, overage: { status: 'allowed', using: false } });
  assert.equal(g.week.includedEur, 41.54); assert.equal(g.week.eurPerPct, 0.415);
  assert.equal(g.week.usedEur, 16.62); assert.equal(g.week.leftEur, 24.92);
  assert.equal(g.week.apiWeekUsd, 770, 'the API-equivalent stays visible, second');
  assert.equal(g.credits.eurPerPct, 6.93); assert.equal(g.jump, 16.7, 'a point bought costs ~17 times a point included');
  assert.deepEqual([g.credits.spent, g.credits.limit, g.credits.left, g.credits.currency], [12.4, 50, 37.6, 'EUR']);
  assert.equal(g.fiveHour.pct, 12);
});

test('the credits as the stream and /usage say them', async () => {
  const { windowsOf, parseCreditsText } = await import('../lib/status.mjs');
  const w = windowsOf({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 1, resetsAt: 1794000000, overageStatus: 'rejected', isUsingOverage: false, overageDisabledReason: 'out_of_credits' } });
  assert.deepEqual(w.overage, { status: 'rejected', using: false, disabledReason: 'out_of_credits' });
  assert.equal(windowsOf({ rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.2 } }).overage, undefined);
  assert.deepEqual(parseCreditsText('Usage credits: €12,40 of €50,00 spent this month'), { enabled: true, usedMinor: 1240, limitMinor: 5000, currency: 'EUR', unlimited: false });
  assert.equal(parseCreditsText('Usage credits: Unlimited').unlimited, true);
  assert.equal(parseCreditsText('Current week (all models): 18% used'), null);
});

test('nothing invented: no subscription price, no credit price or no calibration leaves nulls', () => {
  const g = unitGauge({ claude: { weekly: { pct: 100 } } });
  assert.equal(g.week.pct, 100); assert.equal(g.week.saturated, true);
  assert.equal(g.week.eurPerPct, null); assert.equal(g.week.usedEur, null); assert.equal(g.credits.eurPerPct, null); assert.equal(g.jump, null);
  assert.equal(unitGauge({ unit: { planEurMonth: 180 } }).week.usedEur, null, 'no reading of the week, no euros used');
  assert.equal(unitGauge({ unit: { planEurMonth: 180 }, usdPerPct: 7.7 }).credits.eurPerPct, null, 'the credit price is a setting, never guessed');
  assert.deepEqual(validateUnit({ planEurMonth: '180', creditEurPerUsd: null }).value, { planEurMonth: 180, creditEurPerUsd: null });
  assert.ok(validateUnit({ planEurMonth: -1 }).errors);
});

const H = 36e5;
const T0 = Date.parse('2026-11-05T08:00:00.000Z');
const at = (h) => new Date(T0 + h * H).toISOString();
// a session's readings: weekly share and cost at its first and last quota event
const run = (id, model, h0, h1, w0, w1, c0, c1) => ({ id, model, from: at(h0), to: at(h1), w0, w1, c0, c1 });

test('a session that ran alone gives one sample: its cost over the points it moved', () => {
  const s = rateSamples([run('A', 'claude-opus-5-5', 0, 1, 0.20, 0.30, 0, 80)]);
  assert.deepEqual(s, [{ id: 'A', model: 'claude-opus-5-5', usdPerPct: 8, points: 10 }]);
});

test('no sample from a session that overlaps another, a saturated gauge, a reset or a move under 2 points', () => {
  const s = rateSamples([
    run('A', 'claude-opus-5-5', 0, 2, 0.20, 0.30, 0, 80),
    run('B', 'claude-sonnet-5-5', 1, 3, 0.25, 0.40, 0, 30), // overlaps A: neither is alone
    run('C', 'claude-opus-5-5', 4, 5, 0.95, 1, 0, 90), // reached 100 %: the move is capped
    run('D', 'claude-opus-5-5', 6, 7, 0.60, 0.05, 0, 40), // the week reset in between
    run('E', 'claude-opus-5-5', 8, 9, 0.50, 0.51, 0, 9), // one point: the rounding of the gauge weighs too much
  ]);
  assert.deepEqual(s, []);
  // activity seen elsewhere (a transcript of an interactive session) also spoils the window
  assert.deepEqual(rateSamples([run('A', 'claude-opus-5-5', 0, 1, 0.2, 0.3, 0, 80)], { others: [{ id: 'x', from: at(0.5), to: at(0.6) }] }), []);
  assert.equal(rateSamples([run('A', 'claude-opus-5-5', 0, 1, 0.2, 0.3, 0, 80)], { others: [{ id: 'A', from: at(0.5), to: at(0.6) }] }).length, 1, 'its own transcript is not another');
});

test('a rate per model, with a range that narrows as samples accumulate', () => {
  const opus = (n) => Array.from({ length: n }, (_, i) => ({ model: 'claude-opus-5-5', usdPerPct: i % 2 ? 9 : 7, points: 5 }));
  const one = modelRates(opus(1))['claude-opus-5-5'];
  assert.equal(one.n, 1); assert.equal(one.usdPerPct, 7);
  const two = modelRates(opus(2))['claude-opus-5-5'];
  const ten = modelRates(opus(10))['claude-opus-5-5'];
  assert.ok(one.high / one.low > two.high / two.low, 'two samples narrow the range');
  assert.ok(two.high / two.low > ten.high / ten.low, 'ten narrow it more');
  assert.ok(ten.low < 8 && ten.high > 8);
  const both = modelRates([...opus(2), { model: 'claude-sonnet-5-5', usdPerPct: 3, points: 4 }]);
  assert.deepEqual(Object.keys(both).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(both['claude-sonnet-5-5'].usdPerPct, 3, 'a model is never priced at another model\'s rate');
  assert.deepEqual(modelRates([]), {});
});
