// Fable in reserve (session FAB, 2026-11-02; docs/fable-reserve.md): the setting fableReserve (auto | on | off), the line
// the planner reads, and the move of Fable sessions without a reason to Opus in every formula of a plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSetting, resolveSetting, reserveOf, reserveSection, applyReserve, reserveSummary, isFable, DEFAULT_SHARE } from '../lib/fablereserve.mjs';
import { validatePlan } from '../lib/blocks.mjs';
import { summarize } from '../lib/formulas.mjs';
import { rowsOf, effectiveThresholds } from '../lib/limits.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FABLE = 'claude-fable-5-1', OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';
const S = (id, model, extra = {}) => ({ id, name: 'Session ' + id, path: '/tmp/p', model, budget: 5, stops: ['Fini'], prompt: 'Fais ' + id, ...extra });
const fableRow = (pct, level = 'ok') => ({ id: 'model:fable', kind: 'model', label: 'Fable', pct, level });

test('the setting: auto by default at 70 %, on, off, a share, nothing else', () => {
 assert.equal(DEFAULT_SHARE, 70);
 assert.deepEqual(validateSetting(null), { value: null, errors: null });
 assert.deepEqual(validateSetting('on').value, { mode: 'on', share: 70 });
 assert.deepEqual(validateSetting('OFF').value, { mode: 'off', share: 70 });
 assert.deepEqual(validateSetting({ mode: 'auto', share: 55 }).value, { mode: 'auto', share: 55 });
 assert.ok(validateSetting('maybe').errors);
 assert.ok(validateSetting({ mode: 'auto', share: 0 }).errors);
 assert.ok(validateSetting({ mode: 'auto', share: 120 }).errors);
 assert.ok(validateSetting([1]).errors);
 assert.deepEqual(resolveSetting(null, null), { mode: 'auto', share: 70 });
 assert.deepEqual(resolveSetting('on', null), { mode: 'on', share: 70 }, 'the Mac when the project says nothing');
 assert.deepEqual(resolveSetting('on', 'off'), { mode: 'off', share: 70 }, 'the project when it says something');
 assert.deepEqual(resolveSetting({ mode: 'auto', share: 50 }, 'garbage'), { mode: 'auto', share: 50 }, 'an invalid project value falls back');
});

test('the reserve: on, off, auto by the week share or by the model threshold', () => {
 assert.equal(reserveOf({ setting: { mode: 'off' }, rows: [fableRow(99, 'hard')] }).active, false);
 assert.deepEqual(reserveOf({ setting: { mode: 'on' }, rows: [] }), { pct: null, share: 70, mode: 'on', active: true, why: 'on' });
 assert.equal(reserveOf({ setting: { mode: 'auto', share: 70 }, rows: [fableRow(69.9)] }).active, false);
 const at = reserveOf({ setting: { mode: 'auto', share: 70 }, rows: [fableRow(70)] }); assert.equal(at.active, true); assert.equal(at.why, 'share'); assert.equal(at.pct, 70);
 const th = reserveOf({ setting: { mode: 'auto', share: 90 }, rows: [fableRow(40, 'soft')] }); assert.equal(th.active, true); assert.equal(th.why, 'threshold');
 assert.equal(reserveOf({ setting: null, rows: [fableRow(null, 'unmeasured')] }).active, false, 'not measured: no reserve in auto');
 assert.equal(reserveOf({ rows: [] }).active, false);
});

test('the reserve reads the real Fable row of lib/limits.mjs, threshold off as on this Mac', () => {
 const now = Date.parse('2026-11-02T12:00:00Z'); const resetsAt = '2026-11-05T12:00:00Z';
 const claude = { weekly: { pct: 30, resetsAt }, models: { fable: { weekly: { pct: 82, resetsAt } } }, measuredAt: '2026-11-02T11:00:00Z' };
 const rows = rowsOf({ claude, thresholds: effectiveThresholds({ model: { soft: null, hard: null } }), now });
 const r = reserveOf({ setting: resolveSetting(null, null), rows }); assert.equal(r.active, true); assert.equal(r.why, 'share'); assert.equal(r.pct, 82);
 const low = rowsOf({ claude: { ...claude, models: { fable: { weekly: { pct: 20, resetsAt } } } }, thresholds: effectiveThresholds({ model: { soft: null, hard: null } }), now });
 assert.equal(reserveOf({ rows: low }).active, false);
});

test('the context line: one section when active, nothing when not', () => {
 assert.equal(reserveSection({ active: false }), '');
 assert.equal(reserveSection(null), '');
 const s = reserveSection(reserveOf({ rows: [fableRow(82)] }));
 assert.match(s, /^\n\n## Fable en réserve\n\nFable en réserve : 82 % du quota Fable de la semaine est utilisé \(réserve à 70 %\)/);
 assert.match(s, /fableWhy/); assert.match(s, /"fableReserve": true/); assert.match(s, /trois formules/);
 assert.match(reserveSection(reserveOf({ setting: { mode: 'on' } })), /réglée à « on »/);
 assert.match(reserveSection(reserveOf({ rows: [fableRow(30, 'hard')] })), /seuil du quota hebdo Fable est franchi/);
});

test('the skill carries the rule the context line names', () => {
 const skill = readFileSync(path.join(HERE, '..', '.claude', 'skills', 'plan', 'SKILL.md'), 'utf8');
 assert.match(skill, /\*\*Fable en réserve\*\*/); assert.match(skill, /sans limite comprise/); assert.match(skill, /`fableWhy`/); assert.match(skill, /"fableReserve": true/);
});

const reservedPlan = () => ({
 title: 'Réserve', formula: 'unlimited', fableReserve: true,
 formulas: [
  { tier: 'frugal', gain: 'Moins cher.', sessions: [S('A', OPUS), S('V', SONNET, { wave: 2, after: ['A'] })] },
  { tier: 'recommended', gain: 'Une tête Fable.', sessions: [S('A', FABLE, { fableWhy: 'Architecture neuve du flux de sessions.' }), S('B', OPUS), S('V', SONNET, { wave: 2, after: ['A', 'B'] })] },
  { tier: 'unlimited', gain: 'Parfait.', sessions: [S('A', FABLE, { fableWhy: '  Architecture neuve du flux de sessions.  ' }), S('B', FABLE), S('C', FABLE, { fableWhy: '' }), S('V', FABLE, { wave: 2, after: ['A', 'B', 'C'] })] },
 ],
});

test('the move in a formula: sans limite keeps Fable only where a reason is given, the rest goes to Opus', () => {
 const { plan, moved } = applyReserve(reservedPlan());
 const un = plan.formulas.find((f) => f.tier === 'unlimited').sessions;
 assert.deepEqual(un.map((s) => s.model), [FABLE, OPUS, OPUS, OPUS]);
 assert.equal(un[0].fableWhy, 'Architecture neuve du flux de sessions.');
 assert.equal(un[1].reservedFrom, FABLE); assert.equal(un[2].fableWhy, undefined);
 assert.deepEqual(moved.sort(), ['B', 'C', 'V']);
 assert.deepEqual(plan.formulas.find((f) => f.tier === 'frugal').sessions.map((s) => s.model), [OPUS, SONNET], 'Sonnet stays on the mechanical');
 // no reserve: nothing moves
 const off = { ...reservedPlan(), fableReserve: false }; assert.equal(applyReserve(off).plan, off); assert.deepEqual(applyReserve(off).moved, []);
});

test('validatePlan applies the reserve to the plan and every formula, and the formula rows count it', () => {
 const { plan, errors } = validatePlan(reservedPlan(), {}); assert.equal(errors, undefined);
 assert.equal(plan.fableReserve, true); assert.equal(plan.formula, 'unlimited');
 assert.deepEqual(plan.sessions.map((s) => s.model), [FABLE, OPUS, OPUS, OPUS]);
 const rows = summarize(plan); const un = rows.find((r) => r.tier === 'unlimited');
 assert.deepEqual(un.models.map((m) => [m.model, m.n]), [[FABLE, 1], [OPUS, 3]]);
 assert.deepEqual(reserveSummary(plan), { active: true, onOpus: 3, kept: [{ id: 'A', name: 'Session A', why: 'Architecture neuve du flux de sessions.' }] });
 // the same block without the reserve keeps its models, and the screen shows nothing
 const free = validatePlan({ ...reservedPlan(), fableReserve: undefined }, {}).plan;
 assert.equal(free.fableReserve, undefined); assert.equal(free.sessions.filter((s) => isFable(s.model)).length, 4);
 assert.deepEqual(reserveSummary(free), { active: false, onOpus: 0, kept: [] });
});

test('isFable: the Fable ids only', () => {
 assert.equal(isFable(FABLE), true); assert.equal(isFable('fable'), true); assert.equal(isFable(OPUS), false); assert.equal(isFable(''), false); assert.equal(isFable('claude-unfabled-1'), false);
});
