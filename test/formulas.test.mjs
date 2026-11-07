// The three formulas of a plan (phase 10, session G): the escadrille:plan block carries économe, recommandée and
// sans limite (lib/blocks.mjs, lib/formulas.mjs), the plan screen shows them in three rows, the recommended checked,
// and another one in one click replaces the plan's sessions (POST /api/plan/:id/formula).
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { validatePlan, findBlocks } from '../lib/blocks.mjs';
import { summarize, switchTo, tierOf, TIERS } from '../lib/formulas.mjs';
import { planChangeRefusals } from '../lib/queue.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = (id, model, budget, extra = {}) => ({ id, name: 'Session ' + id, path: '/tmp/p', model, budget, stops: ['Fini'], prompt: 'Fais ' + id, ...extra });
const threeFormulas = () => ({
 title: 'Trois formules', formula: 'recommended',
 formulas: [
  { tier: 'unlimited', gain: 'Parfait, sans regarder le coût.', sessions: [S('A', 'claude-fable-5-1', 10), S('B', 'claude-fable-5-1', 10), S('C', 'claude-fable-5-1', 8, { wave: 2, after: ['A', 'B'] })] },
  { tier: 'économe', gain: 'Moitié prix, pas de vérificateur.', sessions: [S('A', 'claude-sonnet-5-5', 2)] },
  { tier: 'recommended', gain: 'Une tête Fable, des mains Opus, un vérificateur neuf.', sessions: [S('A', 'claude-fable-5-1', 6), S('B', 'claude-opus-5-5', 5), S('V', 'claude-sonnet-5-5', 2, { wave: 2, after: ['A', 'B'] })] },
 ],
});

test('tiers: ids and French names, nothing else', () => {
 assert.deepEqual(TIERS, ['frugal', 'recommended', 'unlimited']);
 assert.equal(tierOf('économe'), 'frugal'); assert.equal(tierOf('Recommandée'), 'recommended'); assert.equal(tierOf('sans limite'), 'unlimited');
 assert.equal(tierOf('premium'), null); assert.equal(tierOf(undefined), null);
});

test('a plan with one formula, as before, stays valid and gets no formula field', () => {
 const { plan, errors } = validatePlan({ title: 'Seul', sessions: [S('A', 'claude-opus-5-5', 5)] });
 assert.equal(errors, undefined); assert.equal(plan.formulas, undefined); assert.equal(plan.formula, undefined);
 const lines = summarize(plan, { defaultBudget: 5 }); assert.equal(lines.length, 1); assert.equal(lines[0].chosen, true);
});

test('three formulas: sorted, the recommended chosen by default, its sessions are the plan\'s', () => {
 const raw = threeFormulas(); delete raw.formula;
 const { plan, errors } = validatePlan(raw);
 assert.equal(errors, undefined, String(errors));
 assert.deepEqual(plan.formulas.map((f) => f.tier), ['frugal', 'recommended', 'unlimited']);
 assert.equal(plan.formula, 'recommended');
 assert.deepEqual(plan.sessions.map((s) => s.id), ['A', 'B', 'V']);
 assert.equal(plan.formulas[1].sessions, plan.sessions);
 assert.equal(plan.waves.length, 2);
 // every formula's sessions are filled like the plan's
 assert.equal(plan.formulas[2].sessions[2].wave, 2); assert.deepEqual(plan.formulas[0].sessions[0].stops, ['Fini']);
});

test('the plan\'s own sessions win for the chosen formula; a chosen tier by its French name', () => {
 const raw = threeFormulas(); raw.formula = 'économe'; raw.sessions = [S('Z', 'claude-sonnet-5-5', 1)];
 const { plan } = validatePlan(raw);
 assert.equal(plan.formula, 'frugal'); assert.deepEqual(plan.sessions.map((s) => s.id), ['Z']); assert.deepEqual(plan.formulas[0].sessions.map((s) => s.id), ['Z']);
});

test('formulas refused: unknown tier, twice the same, a broken session named with its formula, an empty one', () => {
 const bad = threeFormulas(); bad.formulas[0].tier = 'premium';
 assert.match(validatePlan(bad).errors.join(' ; '), /formule 1 : tier inconnu premium/);
 const twice = threeFormulas(); twice.formulas[1].tier = 'unlimited';
 assert.match(validatePlan(twice).errors.join(' ; '), /formule unlimited : en double/);
 const broken = threeFormulas(); broken.formulas[0].sessions[2].model = 'gpt-9';
 assert.match(validatePlan(broken).errors.join(' ; '), /formule unlimited, session C : modèle inconnu gpt-9/);
 const wave = threeFormulas(); wave.formulas[0].sessions[2].wave = 1;
 assert.match(validatePlan(wave).errors.join(' ; '), /formule unlimited, session C : dépend de A/);
 const empty = threeFormulas(); empty.formulas[1].sessions = [];
 assert.match(validatePlan(empty).errors.join(' ; '), /formule frugal : au moins une session/);
 const notList = threeFormulas(); notList.formulas = {};
 assert.match(validatePlan(notList).errors.join(' ; '), /formulas : une liste/);
 const askedBad = threeFormulas(); askedBad.formula = 'or';
 assert.match(validatePlan(askedBad).errors.join(' ; '), /formula : inconnue or/);
});

test('the planner\'s block with three formulas is read whole', () => {
 const text = 'Voici.\n```escadrille:plan\n' + JSON.stringify(threeFormulas()) + '\n```\nChoisis.';
 const [b] = findBlocks(text); assert.equal(b.kind, 'plan');
 const { plan } = validatePlan(b.value); assert.equal(plan.formulas.length, 3);
});

test('one line per formula: sessions, models per role, cap, share of the weekly quota, gain', () => {
 const { plan } = validatePlan(threeFormulas());
 const lines = summarize(plan, { defaultBudget: 5, dollarsPerPct: 2 });
 assert.deepEqual(lines.map((l) => [l.tier, l.chosen, l.sessions, l.cap]), [['frugal', false, 1, 2], ['recommended', true, 3, 13], ['unlimited', false, 3, 28]]);
 assert.deepEqual(lines[1].models, [{ model: 'claude-fable-5-1', n: 1, ids: ['A'] }, { model: 'claude-opus-5-5', n: 1, ids: ['B'] }, { model: 'claude-sonnet-5-5', n: 1, ids: ['V'] }]);
 assert.equal(lines[1].weeklyPct, 0.065); // 13 $ at 2 $ a point: 6.5 points
 assert.equal(lines[0].gain, 'Moitié prix, pas de vérificateur.');
 assert.equal(summarize(plan, { defaultBudget: 5 })[0].weeklyPct, null, 'no calibration, no share');
 const noBudget = validatePlan({ title: 'x', sessions: [{ ...S('A', 'claude-opus-5-5'), budget: undefined }] }).plan;
 assert.equal(summarize(noBudget, { defaultBudget: 5 })[0].cap, 5, 'a session without budget counts the default');
});

test('switching: another formula\'s sessions, valid again; refused once a session has left', () => {
 const { plan } = validatePlan(threeFormulas());
 const sw = switchTo(plan, 'économe'); assert.equal(sw.error, undefined);
 const { plan: next, errors } = validatePlan(sw.plan); assert.equal(errors, undefined);
 assert.equal(next.formula, 'frugal'); assert.deepEqual(next.sessions.map((s) => s.id), ['A']); assert.equal(next.sessions[0].model, 'claude-sonnet-5-5');
 assert.deepEqual(next.formulas[1].sessions.map((s) => s.id), ['A', 'B', 'V'], 'the old formula keeps its sessions for the way back');
 const back = validatePlan(switchTo(next, 'recommended').plan).plan; assert.deepEqual(back.sessions.map((s) => s.id), ['A', 'B', 'V']);
 assert.equal(switchTo(plan, 'recommended').same, true);
 assert.match(switchTo(plan, 'premium').error, /formule inconnue/);
 assert.match(switchTo(validatePlan({ title: 'x', sessions: [S('A', 'claude-opus-5-5', 5)] }).plan, 'frugal').error, /pas de formule frugal/);
 assert.ok(planChangeRefusals(plan, [{ id: 'A', status: 'running' }], next).length, 'A launched: the switch is refused');
 assert.deepEqual(planChangeRefusals(plan, [{ id: 'A', status: 'todo' }, { id: 'B', status: 'todo' }], next), []);
});

// ---- the screen: the block of plan.html run in a vm from the HTML as served
const fmlCode = () => { const html = readFileSync(path.join(HERE, '..', 'public', 'plan.html'), 'utf8'); const a = html.indexOf('// The three formulas (lib/formulas.mjs)'); const b = html.indexOf('const autoMergeOn', a); assert.ok(a > 0 && b > a, 'the formulas block is in plan.html'); return html.slice(a, b); };
const screen = (data) => {
 const posts = []; const listeners = []; const dict = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', 'en.json'), 'utf8'));
 const T = (k, v = {}) => { assert.ok(k in dict, 'key ' + k); return dict[k].replace(/\{(\w+)\}/g, (_, n) => v[n]); };
 const ctx = { data, planId: 'p1', T, MODEL_NAMES: { 'claude-fable-5-1': 'Fable', 'claude-opus-5-5': 'Opus', 'claude-sonnet-5-5': 'Sonnet' }, esc: (s) => String(s), plural: (n) => n + ' sessions', fmtBudget: (c) => '$' + c, fmtPct: (x) => Math.round(x * 1000) / 10 + ' %',
  allSessions: () => data.plan.sessions, stateFor: (s) => data.state.find((x) => x.id === s.id) || { status: 'todo' }, launched: (x) => ['running', 'waiting', 'done'].includes(x.status),
  render: () => {}, load: async () => {}, api: async (p, body) => { posts.push([p, body]); return { ok: true }; }, document: { addEventListener: (t, f) => listeners.push(f) }, encodeURIComponent };
 vm.createContext(ctx); vm.runInContext(fmlCode() + '\nthis.formulasBlock = formulasBlock; this.chooseFormula = chooseFormula;', ctx);
 return { ctx, posts };
};

test('the plan screen: three rows, models, cap, share, gain, the recommended checked; one click posts the switch', async () => {
 const { plan } = validatePlan(threeFormulas());
 const data = { plan, state: plan.sessions.map((s) => ({ id: s.id, status: 'todo' })), formulas: summarize(plan, { defaultBudget: 5, dollarsPerPct: 2 }) };
 const { ctx, posts } = screen(data);
 const html = ctx.formulasBlock();
 assert.equal((html.match(/role="radio"/g) || []).length, 3);
 assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
 assert.match(html, /aria-checked="true" data-formula="recommended"/);
 assert.match(html, /Frugal[\s\S]*Recommended[\s\S]*No limit/);
 assert.match(html, /3 sessions · Fable ×1 · Opus ×1 · Sonnet ×1/);
 assert.match(html, /\$13/); assert.match(html, /6\.5 % of the week/);
 assert.match(html, /Moitié prix, pas de vérificateur\./);
 await ctx.chooseFormula('frugal');
 assert.equal(JSON.stringify(posts), JSON.stringify([['/api/plan/p1/formula', { tier: 'frugal' }]]));
 await ctx.chooseFormula('recommended'); assert.equal(posts.length, 1, 'the chosen one posts nothing');
 // without calibration the share says so; after a launch, or with one formula, the rows are gone
 assert.match(screen({ ...data, formulas: summarize(plan, { defaultBudget: 5 }) }).ctx.formulasBlock(), /week not measured/);
 assert.equal(screen({ ...data, state: [{ id: 'A', status: 'running' }] }).ctx.formulasBlock(), '');
 assert.equal(screen({ ...data, formulas: data.formulas.slice(0, 1) }).ctx.formulasBlock(), '');
});

test('the French dictionary names the three formulas too', () => {
 const fr = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', 'fr.json'), 'utf8'));
 assert.deepEqual(['plan.fml.frugal', 'plan.fml.recommended', 'plan.fml.unlimited'].map((k) => fr[k]), ['Économe', 'Recommandée', 'Sans limite']);
});

// ---- the server: GET answers the rows, POST .../formula swaps the sessions and the rows of the waves
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
let server = null; after(() => server && server.kill('SIGINT'));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('the server: three rows on GET, the switch replaces the sessions and their rows, back and forth', async () => {
 const project = tmp('escadrille-fml-proj-');
 server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-fml-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-fml-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-none-'), ESCADRILLE_DOLLARS_PER_PCT: '2' }, stdio: 'ignore' });
 await until(() => get('/api/plans'));
 const raw = threeFormulas(); raw.id = 'fml'; raw.project = project; for (const f of raw.formulas) for (const s of f.sessions) s.path = project;
 assert.equal((await post('/api/plan', raw)).status, 200);
 let r = await get('/api/plan/fml');
 assert.deepEqual(r.formulas.map((f) => [f.tier, f.chosen, f.cap]), [['frugal', false, 2], ['recommended', true, 13], ['unlimited', false, 28]]);
 assert.equal(r.formulas[1].weeklyPct, 0.065, 'the share follows the calibration of /api/usage (here ESCADRILLE_DOLLARS_PER_PCT)');
 assert.deepEqual(r.state.map((s) => [s.id, s.status]), [['A', 'todo'], ['B', 'todo'], ['V', 'later']]);
 assert.equal((await post('/api/plan/fml/formula', { tier: 'frugal' })).status, 200);
 r = await get('/api/plan/fml');
 assert.equal(r.plan.formula, 'frugal'); assert.deepEqual(r.plan.sessions.map((s) => [s.id, s.model]), [['A', 'claude-sonnet-5-5']]);
 assert.deepEqual(r.state.map((s) => s.id), ['A'], 'the sessions of the old formula never launched are gone');
 assert.equal(r.formulas.find((f) => f.chosen).tier, 'frugal');
 assert.equal((await post('/api/plan/fml/formula', { tier: 'unlimited' })).status, 200);
 r = await get('/api/plan/fml');
 assert.deepEqual(r.state.map((s) => [s.id, s.status]), [['A', 'todo'], ['B', 'todo'], ['C', 'later']]);
 assert.equal((await post('/api/plan/fml/formula', { tier: 'premium' })).status, 400);
});
