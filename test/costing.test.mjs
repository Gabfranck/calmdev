// Phase 11 PX: a task costed in three formulas before it is launched (lib/costing.mjs, docs/learning.md), the
// preferences rewritten by the developer (lib/learning.mjs savePreferences), and the Apprentissage screen served
// with its routes (POST /api/costing, POST /api/costing/launch, POST /api/learning/preferences). No browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as costing from '../lib/costing.mjs';
import { savePreferences, readPreferences, writePreferences } from '../lib/learning.mjs';
import { validatePlan } from '../lib/blocks.mjs';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const PROJECT = path.join(tmp('escadrille-costing-'), 'Carnet'); mkdirSync(PROJECT, { recursive: true });
const TEXT = "L'écran des réglages : une page public/settings.html avec les seuils, et ses tests";

test('composition: the three tiers of the skill, Sonnet hands for docs and tests, Opus elsewhere, Fable where there is judgment', () => {
  const c = costing.composition('front');
  assert.deepEqual(c.frugal.map((s) => s.model), [costing.OPUS]);
  assert.deepEqual(c.recommended.map((s) => [s.role, s.model]), [['hands', costing.OPUS], ['verifier', costing.OPUS]]);
  assert.deepEqual(c.unlimited.map((s) => [s.role, s.model]), [['hands', costing.FABLE], ['verifier', costing.OPUS], ['final', costing.FABLE]]);
  assert.equal(costing.composition('docs').frugal[0].model, costing.SONNET);
  assert.equal(costing.composition('tests').unlimited[0].model, costing.OPUS);
});

test('buildPlan: a valid plan skeleton, its kind read from the text, the recommended formula chosen, briefs in the developer\'s language', () => {
  const plan = costing.buildPlan({ project: PROJECT, text: TEXT, lang: 'fr', now: new Date('2026-11-02T10:00:00Z') });
  assert.equal(plan.kind, 'front');
  assert.equal(plan.formula, 'recommended');
  assert.deepEqual(plan.formulas.map((f) => f.tier), ['frugal', 'recommended', 'unlimited']);
  assert.deepEqual(plan.formulas.map((f) => f.sessions.length), [1, 2, 3]);
  assert.match(plan.id, /^2026-11-02-l-ecran-des-reglages-une$/);
  assert.equal(plan.title, TEXT.slice(0, 64).replace(/\s+\S*$/, '') + '…');
  const v = plan.formulas[2].sessions.find((s) => s.id === 'V'); assert.equal(v.wave, 2); assert.match(v.prompt, /session A/);
  assert.match(costing.buildPlan({ project: PROJECT, text: 'Write the README', lang: 'en' }).sessions[0].prompt, /Work in your worktree/);
  const { errors } = validatePlan(plan, { path: PROJECT, project: PROJECT }); assert.equal(errors, undefined, 'lib/blocks.mjs accepts it: ' + (errors || []).join(' ; '));
  assert.throws(() => costing.buildPlan({ project: PROJECT, text: '  ' }), /empty/);
});

test('costing: each formula summed from the estimate of its sessions, the learned gap and the real median beside, the delta against the recommended', () => {
  const plan = costing.buildPlan({ project: PROJECT, text: TEXT, lang: 'fr' });
  const all = costing.allSessionsPlan(plan);
  assert.deepEqual(all.sessions.map((s) => s.id), ['frugal:A', 'recommended:A', 'recommended:V', 'unlimited:A', 'unlimited:V', 'unlimited:F']);
  const e = (cost, learned = null) => ({ cost, weeklyPct: cost / 100, basis: { sessions: 4, scope: 'project', learned, rawCost: learned ? cost / learned.ratio : cost } });
  const estimate = { sessions: { 'frugal:A': e(6, { kind: 'front', ratio: 3, sessions: 4 }), 'recommended:A': e(6, { kind: 'front', ratio: 3, sessions: 4 }), 'recommended:V': e(2), 'unlimited:A': e(9), 'unlimited:V': e(2), 'unlimited:F': e(5) }, calibration: { calibrated: true }, total: { weeklyNow: 0.3 } };
  const registry = { byKind: [{ kind: 'front', model: costing.OPUS, sessions: 9, cost: { median: 6.1 }, firstTryRate: 0.89 }] };
  const c = costing.costing(plan, estimate, { registry });
  assert.equal(c.kind, 'front'); assert.equal(c.calibrated, true);
  const [f, r, u] = c.formulas;
  assert.deepEqual([f.cost, r.cost, u.cost], [6, 8, 16]);
  assert.deepEqual([f.delta, r.delta, u.delta], [-0.25, 0, 1]);
  assert.equal(r.weeklyPct, 0.08);
  assert.deepEqual(r.learned, [{ model: costing.OPUS, kind: 'front', ratio: 3, sessions: 4 }]);
  assert.deepEqual(r.sessions[0].real, { median: 6.1, sessions: 9, firstTryRate: 0.89 });
  assert.deepEqual(r.sessions[1].real, r.sessions[0].real, 'the verifier, same kind and model: the same row of the registry (the page says it once)');
  assert.equal(costing.costing(plan, null).formulas[1].cost, null, 'no estimate: no figure, never 0');
  // no transcript to read but the registry knows the kind on the model: the real median prices the session, said as such
  const bare = { sessions: { 'frugal:A': e(null), 'recommended:A': e(null), 'recommended:V': e(null), 'unlimited:A': e(null), 'unlimited:V': e(null), 'unlimited:F': e(null) }, calibration: { calibrated: true, dollarsPerPct: 2 } };
  const fr = costing.costing(plan, bare, { registry }).formulas[0];
  assert.deepEqual([fr.cost, fr.weeklyPct, fr.sessions[0].fromReal, fr.sessions[0].basis], [6.1, 0.0305, true, { sessions: 9, scope: 'registry' }]);
  assert.equal(costing.costing(plan, bare, { registry }).formulas[2].cost, null, 'Fable unknown to the registry: the formula stays unpriced');
  assert.equal(costing.costing(plan, { ...bare, calibration: { calibrated: false } }, { registry }).formulas[0].weeklyPct, null, 'no calibration: no weekly share');
  // the plan to launch: the chosen formula, each cap at 1,5 × the estimate rounded up to the half-dollar, never under 1 $
  const ready = costing.launchable(plan, 'frugal', c);
  assert.equal(ready.formula, 'frugal'); assert.equal(ready.sessions.length, 1); assert.equal(ready.sessions[0].budget, 9);
  assert.equal(ready.formulas[2].sessions[1].budget, 3);
  assert.equal(costing.launchable(plan, 'unlimited', costing.costing(plan, null), { defaultBudget: 4 }).sessions[0].budget, 4);
  assert.throws(() => costing.launchable(plan, 'gold', c), /unknown formula/);
});

test('savePreferences: the developer\'s file as he wrote it, a kept distilled line keeps its mark, the state untouched', () => {
  const p = path.join(tmp('escadrille-prefs-'), 'P'); mkdirSync(p);
  writePreferences(p, { dev: ['Jamais de Sonnet sur le front'], lines: ['Le front sur Opus suffit (preuve : 9 sessions, 8 approuvées)', 'Les migrations en kit (preuve : 3 sessions)'] });
  const r = savePreferences(p, ['- Jamais de Sonnet sur le front', 'Le front sur Opus suffit (preuve : 9 sessions, 8 approuvées)', '', 'Toujours des tests'].join('\n'));
  assert.deepEqual(r.lines.map((l) => [l.text, l.source]), [['Jamais de Sonnet sur le front', 'dev'], ['Le front sur Opus suffit (preuve : 9 sessions, 8 approuvées)', 'distilled'], ['Toujours des tests', 'dev']]);
  assert.deepEqual(readPreferences(p).lines.length, 3);
  assert.equal(JSON.parse(readFileSync(path.join(p, '.calmdev', 'learning.json'), 'utf8')).written.length, 2, 'the state still names the two lines Escadrille wrote: the dropped one is seen as removed');
  assert.equal(savePreferences(p, []).lines.length, 0);
  // a file this process may not read (a sandbox denying the folder) is told, never thrown
  chmodSync(path.join(p, '.calmdev', 'preferences.md'), 0o000);
  try { const r = readPreferences(p); assert.equal(r.exists, true); assert.equal(r.unreadable, 'EACCES'); assert.deepEqual(r.lines, []); }
  finally { chmodSync(path.join(p, '.calmdev', 'preferences.md'), 0o644); }
});

// The server: the page, the costing without any transcript, the preferences route, the launch route writing the plan
const DB = path.join(tmp('escadrille-costing-db-'), 'db.sqlite');
const PLANS = tmp('escadrille-costing-plans-');
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: PLANS, ESCADRILLE_PROJECTS: path.join(path.dirname(DB), 'projects.json'), ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: '/nulle/part', ESCADRILLE_LEARNING: 'off' }, stdio: 'ignore' });
after(() => server.kill('SIGINT'));
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, text: await r.text() }; };
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('the Apprentissage screen is served, in the Projet group of the bar; POST /api/costing answers three formulas without spending anything', async () => {
  await until(async () => { try { return (await get('/api/plans')).status === 200; } catch { return false; } });
  const page = await get('/learning?project=' + encodeURIComponent(PROJECT));
  assert.equal(page.status, 200); assert.match(page.text, /id="sidebar"/); assert.match(page.text, /id="costBtn"/); assert.match(page.text, /<script src="\/ux.js"><\/script>/);
  assert.match(page.text, /get\('task'\)/, '?task= pre-fills the field and costs it at load');
  const sidebar = readFileSync(path.join(HERE, '..', 'public', 'sidebar.js'), 'utf8'); assert.match(sidebar, /id: 'learning', label: 'nav.learning', href: '\/learning'/);
  const r = await post('/api/costing', { project: PROJECT, text: TEXT, lang: 'fr' });
  assert.equal(r.status, 200); assert.equal(r.body.plan.kind, 'front');
  assert.deepEqual(r.body.costing.formulas.map((f) => [f.tier, f.sessions.length, f.cost]), [['frugal', 1, null], ['recommended', 2, null], ['unlimited', 3, null]], 'no transcript: no figure');
  assert.equal(r.body.costing.formulas[1].chosen, true);
  assert.equal((await get('/api/plans?project=' + encodeURIComponent(PROJECT))).text, '[]', 'costing writes no plan');
  assert.equal((await post('/api/costing', { project: PROJECT, text: '' })).status, 400);
  assert.equal((await post('/api/costing', { project: 'relative', text: 'x' })).status, 400);
});

test('POST /api/learning/preferences rewrites the file; POST /api/costing/launch writes the chosen formula as a plan', async () => {
  const r = await post('/api/learning/preferences', { project: PROJECT, lines: ['Les tests avant la fusion', ''] });
  assert.equal(r.status, 200); assert.deepEqual(r.body.lines, [{ text: 'Les tests avant la fusion', source: 'dev' }]);
  assert.ok(existsSync(path.join(PROJECT, '.calmdev', 'preferences.md')));
  assert.deepEqual((await get('/api/learning?project=' + encodeURIComponent(PROJECT))).text.includes('Les tests avant la fusion'), true);
  const l = await post('/api/costing/launch', { project: PROJECT, text: TEXT, lang: 'fr', tier: 'frugal' });
  assert.ok(l.body.plan, 'the plan is written even when claude is missing: ' + JSON.stringify(l.body));
  const plan = JSON.parse((await get('/api/plan/' + encodeURIComponent(l.body.plan))).text);
  assert.equal(plan.plan.formula, 'frugal'); assert.equal(plan.plan.sessions.length, 1); assert.equal(plan.plan.costed, true);
  assert.equal(plan.formulas.length, 3, 'the plan page shows the three formulas');
  assert.ok(plan.plan.sessions[0].budget >= 1);
  assert.equal((await post('/api/costing/launch', { project: PROJECT, text: TEXT, tier: 'gold' })).status, 400);
});
