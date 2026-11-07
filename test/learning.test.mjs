// What Escadrille learns from its use (docs/learning.md), on a simulated project of ten plans: the registry computed
// from the base, the learned estimate gap, the developer's repeated answers, the review's refusals, the defects;
// the distillation with a fake claude (one proof per line, the developer's lines first, a removed line never back);
// the planner's section; and GET /api/learning on a server whose base holds that project.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as learning from '../lib/learning.mjs';
import { estimatePlan } from '../lib/usage.mjs';
import { startPlanner } from '../lib/planner.mjs';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

// The base, with the server's own tables (the columns the server adds by migration included)
const SCHEMA = `
create table plans (id text primary key, title text, created text, json text, project text);
create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, session_id text, mode text, worktree text, usage text, pending text, handoffs text, summary text, alerted text, pushed text, queued integer, pr text, review text, pause text, primary key (plan, id));
create table escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text, template text);
create table messages (seq integer primary key autoincrement, escadrille text, role text, text text, data text, at text);
create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
create table reviews (id text primary key, repo text, project text, base text, head text, plan text, session text, head_sha text, verdict text, body text, verdict_sha text, verdict_at text, created text, at text, kind text default 'code', retries integer default 0, escalated integer default 0, stop text);
create table review_comments (id integer primary key autoincrement, review text, path text, side text, line integer, body text, author text, at text, resolved integer default 0, head_sha text, snippet text);
create table transcripts (path text primary key, mtime real, size integer, json text);`;

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';
// Past transcripts of the project: 100 000 output tokens each, so the estimate says 2 $ on Opus and 1 $ on Sonnet
const transcriptsFor = (project) => Array.from({ length: 4 }, (_, i) => ({ v: 2, file: `/t/${i}.jsonl`, sessionId: `t${i}`, project, model: OPUS, input: 0, output: 100000, tokens: 100000, turns: 5, firstAt: '2026-10-01T10:00:00.000Z', lastAt: '2026-10-01T11:00:00.000Z', promptChars: null, buckets: [0, 0, 0, 0, 100000], byModel: { [OPUS]: [0, 0, 0, 0, 100000] }, hours: {} }));

// Ten plans: each one a front session on Opus (real 6,10 $ about, three times the estimate) and a server one on Sonnet;
// nine front sessions reviewed, eight approved the first time, one sent back with its reason
const FRONT_COSTS = [5.9, 6.0, 6.1, 6.1, 6.1, 6.2, 6.3, 5.8, 6.4, 6.0];
const seed = (db, project) => {
  db.exec(SCHEMA);
  const ins = (t, o) => db.prepare(`insert into ${t} (${Object.keys(o).join(', ')}) values (${Object.keys(o).map(() => '?').join(', ')})`).run(...Object.values(o));
  for (const t of transcriptsFor(project)) ins('transcripts', { path: t.file, mtime: 1, size: 1, json: JSON.stringify(t) });
  for (let i = 0; i < 10; i++) {
    const id = `plan-${i}`; const created = `2026-10-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`;
    const plan = { id, title: `Plan ${i}`, project, created, sessions: [
      { id: 'A', wave: 1, name: "L'écran des réglages", path: project, model: OPUS, budget: 8, prompt: 'Modifie public/settings.html et public/app.css.', stops: ['fini'] },
      { id: 'B', wave: 1, name: 'Le serveur : la route des réglages', path: project, model: SONNET, budget: 3, prompt: 'Ajoute la route dans server.mjs et lib/settings.mjs.', stops: ['fini'] },
    ] };
    ins('plans', { id, title: plan.title, created, json: JSON.stringify(plan), project });
    ins('sessions', { plan: id, id: 'A', status: 'done', name: 'A', at: created, usage: JSON.stringify({ cost: FRONT_COSTS[i] }) });
    ins('sessions', { plan: id, id: 'B', status: i < 9 ? 'done' : 'running', name: 'B', at: created, usage: JSON.stringify({ cost: 0.8 + i * 0.05 }) });
    if (i < 9) ins('reviews', { id: `r${i}`, plan: id, session: 'A', project, kind: 'code', verdict: i === 4 ? 'changes' : 'approve', body: i === 4 ? 'Échap ne ferme pas le panneau' : '', retries: i === 4 ? 1 : 0, verdict_at: created, at: created });
    if (i === 4) ins('review_comments', { review: 'r4', path: 'public/settings.html', body: 'le focus ne revient pas au bouton', at: created });
    if (i < 3) ins('session_messages', { plan: id, session: 'A', role: 'dev', text: 'Le bouton principal à droite, pas à gauche.', at: created });
  }
  // Three planning rounds: the cap question each time, accepted each time; the network question overridden once
  const q = (n, title, question, recommendation) => ({ n, title, question, recommendation, why: '' });
  const rounds = [['ok pour tout', 2], ['Ok pour tout, les recommandations telles quelles.', 2], ['ok pour tout sauf :\n2. Le réseau vers npm pour ce plan.', 2]];
  rounds.forEach(([answer], i) => {
    const e = `esc-${i}`; ins('escadrilles', { id: e, title: e, project, model: OPUS, status: 'planned', created: `2026-10-1${i}T08:00:00.000Z` });
    ins('messages', { escadrille: e, role: 'user', text: 'Une idée', at: '1' });
    ins('messages', { escadrille: e, role: 'questions', text: '2 questions', data: JSON.stringify({ items: [q(1, 'Le plafond', 'Quel plafond en dollars par session ?', '5 $ par session'), q(2, 'Le réseau', 'Ouvrir un domaine à ce plan ?', 'Aucun domaine')] }), at: '2' });
    ins('messages', { escadrille: e, role: 'user', text: answer, at: '3' });
  });
};
const project = tmp('escadrille-learn-');
mkdirSync(path.join(project, 'docs'));
writeFileSync(path.join(project, 'docs', 'backlog.md'), '# Backlog\n\n- [ ] Défaut (Flot) : cliquer une session n’ouvre rien\n- [x] Défaut (Flot) : Échap ne ferme rien\n- [ ] Une tâche\n- [ ] Défaut : le sélecteur liste tout\n');
const dbFile = path.join(tmp('escadrille-learn-db-'), 'db.sqlite');
const db = new DatabaseSync(dbFile); seed(db, project);
const TRANSCRIPTS = transcriptsFor(project);
const registry = learning.registryOf({ db, project, transcripts: TRANSCRIPTS });

test('the kind of a task: the name says the role, else the files of the brief', () => {
  assert.equal(learning.kindOf({ name: "L'écran des réglages" }), 'front');
  assert.equal(learning.kindOf({ name: 'Le serveur : la route' }), 'back');
  assert.equal(learning.kindOf({ name: 'La migration des scores' }), 'migration');
  assert.equal(learning.kindOf({ name: 'La passe design générale' }), 'design');
  assert.equal(learning.kindOf({ name: 'Le README anglais, le CHANGELOG' }), 'docs');
  assert.equal(learning.kindOf({ name: 'Des tests stables sous charge' }), 'tests');
  assert.equal(learning.kindOf({ name: 'La vérification d’ensemble' }), 'qa');
  assert.equal(learning.kindOf({ name: 'Tâche 3', prompt: 'Lis docs/flot.md. Change migrations/004_scores.sql.' }), 'migration', 'the docs to read are not a docs task');
  assert.equal(learning.kindOf({ name: 'Tâche 4', prompt: 'Lis docs/terrain.md et docs/decisions.md.' }), 'other');
});

test('the answers to a questions block: all, all but some, one by one', () => {
  const all = learning.parseAnswer('ok pour tout', 3);
  assert.deepEqual([...all.values()].map((a) => a.accepted), [true, true, true]);
  const but = learning.parseAnswer('ok pour tout sauf :\n2. Le réseau vers npm pour ce plan.', 3);
  assert.deepEqual([but.get(1).accepted, but.get(2).accepted, but.get(3).accepted], [true, false, true]);
  assert.equal(but.get(2).text, 'Le réseau vers npm pour ce plan.');
  const each = learning.parseAnswer('Réponses : 1. Oui au découpage. 2. Non : deux sessions seulement. 3. Oui.', 3);
  assert.deepEqual([each.get(1).accepted, each.get(2).accepted, each.get(3).accepted], [true, false, true]);
  assert.equal(learning.parseAnswer('Stop Linear, écris le plan', 2).size, 0, 'no answer read from an unrelated message');
});

test('the registry: cost by kind and model, first-try approval, retries, from the base alone', () => {
  assert.equal(registry.totals.plans, 10);
  assert.equal(registry.totals.sessions, 20);
  assert.equal(registry.totals.finished, 19);
  const front = registry.byKind.find((g) => g.kind === 'front' && g.model === OPUS);
  assert.equal(front.sessions, 10);
  assert.equal(front.cost.median, 6.1);
  assert.equal(front.estimate.median, 2, 'what the estimate said when each plan was written');
  assert.equal(front.ratio.median, 3.05); assert.equal(front.ratio.sessions, 10);
  assert.equal(front.reviewed, 9); assert.equal(front.firstTry, 8); assert.equal(front.firstTryRate, 0.889);
  assert.equal(front.retries, 1);
  assert.equal(front.budget.median, 8); assert.equal(front.budgetUse, 0.763);
  const back = registry.byKind.find((g) => g.kind === 'back' && g.model === SONNET);
  assert.equal(back.sessions, 9, 'the running session is not a result');
  assert.equal(back.estimate.median, 1);
  assert.equal(back.reviewed, 0); assert.equal(back.firstTryRate, null, 'nothing reviewed: no rate, not zero');
});

test('the registry: repeated questions and their answers, the refusals and their reasons, the defects, the corrections', () => {
  const cap = registry.questions.find((q) => q.title === 'Le plafond');
  assert.deepEqual([cap.asked, cap.answered, cap.accepted, cap.settled], [3, 3, 3, true]);
  assert.equal(cap.last.answer, '5 $ par session');
  const net = registry.questions.find((q) => q.title === 'Le réseau');
  assert.deepEqual([net.asked, net.accepted, net.overridden, net.settled], [3, 2, 1, false]);
  assert.equal(net.last.answer, 'Le réseau vers npm pour ce plan.');
  assert.deepEqual(registry.refusals.verdicts, { approve: 8, changes: 1 });
  assert.equal(registry.refusals.items.length, 1);
  assert.equal(registry.refusals.items[0].body, 'Échap ne ferme pas le panneau');
  assert.deepEqual(registry.refusals.items[0].comments, ['le focus ne revient pas au bouton']);
  assert.equal(registry.refusals.items[0].kind, 'front');
  assert.deepEqual([registry.defects.total, registry.defects.open], [3, 2]);
  assert.deepEqual(registry.defects.byScreen, { Flot: 2, '—': 1 });
  assert.equal(registry.totals.corrections, 3);
  assert.equal(registry.corrections[0].kind, 'front');
});

test('the learned gap feeds the estimate of a new plan, for that kind and that model only', () => {
  const gaps = learning.gapsOf(registry);
  assert.deepEqual(gaps.find((g) => g.kind === 'front'), { kind: 'front', model: OPUS, ratio: 3.05, sessions: 10 });
  const plan = { id: 'next', project, created: '2026-11-02T00:00:00.000Z', sessions: [
    { id: 'A', name: "L'écran du profil", path: project, model: OPUS, prompt: 'Modifie public/profile.html et public/app.css.' },
    { id: 'C', name: "L'écran du profil", path: project, model: 'claude-fable-5-1', prompt: 'Modifie public/profile.html et public/app.css.' },
  ] };
  const raw = estimatePlan(plan, { sessions: TRANSCRIPTS, calibration: { calibrated: false } });
  const adj = estimatePlan(plan, { sessions: TRANSCRIPTS, calibration: { calibrated: false }, adjust: learning.adjusterOf(registry) });
  assert.equal(raw.sessions.A.cost, 2);
  assert.equal(adj.sessions.A.cost, 6.1);
  assert.deepEqual(adj.sessions.A.basis.learned, { kind: 'front', ratio: 3.05, sessions: 10 });
  assert.equal(adj.sessions.A.basis.rawCost, 2);
  assert.equal(adj.sessions.C.basis.learned, null, 'no gap learned for the front on Fable');
  assert.equal(adj.sessions.C.cost, raw.sessions.C.cost);
  assert.equal(raw.sessions.A.basis.learned, undefined, 'without adjust the estimate is unchanged');
});

test('the distillation is due once a week at most, and only with enough new results', () => {
  const t = Date.parse('2026-11-02T12:00:00.000Z');
  assert.equal(learning.distillDue({ registry, state: {}, now: t }).due, true);
  assert.deepEqual(learning.distillDue({ registry, state: { distilledAt: '2026-10-30T12:00:00.000Z', results: 0 }, now: t }).reason, 'week');
  const few = learning.distillDue({ registry, state: { distilledAt: '2026-10-20T12:00:00.000Z', results: registry.results - (learning.DISTILL_MIN_RESULTS - 1) }, now: t });
  assert.deepEqual([few.due, few.reason, few.newResults], [false, 'results', learning.DISTILL_MIN_RESULTS - 1]);
  assert.equal(learning.distillDue({ registry, state: { distilledAt: '2026-10-20T12:00:00.000Z', results: registry.results - learning.DISTILL_MIN_RESULTS }, now: t }).due, true);
});

// A fake claude that answers one turn with the lines given in FAKE_PREFS (JSON), and logs its arguments and prompt
const fakeDistiller = () => {
  const dir = tmp('escadrille-distill-'); const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const DIR = ${JSON.stringify(dir)};
fs.writeFileSync(path.join(DIR, 'args.json'), JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'distill-1' });
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
  fs.writeFileSync(path.join(DIR, 'prompt.txt'), JSON.parse(line).message.content);
  const lines = JSON.parse(fs.readFileSync(path.join(DIR, 'prefs.json'), 'utf8'));
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Voici.\\n\\n\\u0060\\u0060\\u0060escadrille:preferences\\n' + JSON.stringify({ lines }) + '\\n\\u0060\\u0060\\u0060' }] } });
  out({ type: 'result', subtype: 'success', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 10 }, num_turns: 1 });
} });
process.stdin.on('end', () => process.exit(0));
`);
  chmodSync(file, 0o755);
  return { dir, file, setLines: (l) => writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify(l)) };
};

test('the distillation writes preferences.md: one proof per line, the developer’s edits first, a removed line never back', async () => {
  const fake = fakeDistiller();
  const FRONT = 'Le front sur Opus suffit (preuve : 10 sessions, 8 approuvées du premier coup sur 9 revues, médiane 6,10 $)';
  const CAP = 'Ne plus demander le plafond : 5 $ par session (preuve : demandé 3 fois, la recommandation acceptée 3 fois)';
  const BACK = 'Le serveur sur Sonnet tient sous 1 $ (preuve : 9 sessions, médiane 1,00 $)';
  fake.setLines([FRONT, CAP, 'Préférer des sessions courtes', BACK]);
  let r = await learning.distill({ db, project, registry, start: startPlanner, claude: fake.file });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.lines, [FRONT, CAP, BACK], 'the line without its proof is dropped');
  assert.equal(r.dropped, 1); assert.equal(r.cost, 0.12);
  const args = JSON.parse(readFileSync(path.join(fake.dir, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--model') + 1], learning.DISTILL_MODEL);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1');
  assert.match(readFileSync(path.join(fake.dir, 'prompt.txt'), 'utf8'), /"kind":"front","model":"claude-opus-5-5","sessions":10,"costMedian":6\.1/);
  const file = path.join(project, '.calmdev', 'preferences.md');
  assert.match(readFileSync(file, 'utf8'), /^# Préférences apprises/);
  let prefs = learning.readPreferences(project);
  assert.deepEqual(prefs.lines.map((l) => l.source), ['distilled', 'distilled', 'distilled']);

  // The developer edits: removes the Sonnet line, rewrites the cap line, adds his own
  const text = readFileSync(file, 'utf8').replace(`- ${BACK}\n`, '').replace(CAP, 'Plafond : 6 $ par session, toujours').concat('- Jamais de Fable pour le back\n');
  writeFileSync(file, text);
  prefs = learning.readPreferences(project);
  assert.deepEqual(prefs.lines.map((l) => [l.text.slice(0, 20), l.source]), [['Le front sur Opus su', 'distilled'], ['Plafond : 6 $ par se', 'dev'], ['Jamais de Fable pour', 'dev']]);

  // The next run: the developer's lines kept as they are and first; the removed line, proposed again, stays out
  fake.setLines([BACK, FRONT, 'Jamais de Fable pour le back (preuve : 0 session)']);
  r = await learning.distill({ db, project, registry, start: startPlanner, claude: fake.file });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.lines, [FRONT]);
  const prompt = readFileSync(path.join(fake.dir, 'prompt.txt'), 'utf8');
  assert.match(prompt, /Lignes du développeur[^\n]*\n- Plafond : 6 \$ par session, toujours\n- Jamais de Fable pour le back/);
  assert.match(prompt, /retirées[^\n]*\n- Ne plus demander le plafond[^\n]*\n- Le serveur sur Sonnet tient sous 1 \$/, 'the rewritten line and the deleted one');
  prefs = learning.readPreferences(project);
  assert.deepEqual(prefs.lines.map((l) => l.text), ['Plafond : 6 $ par session, toujours', 'Jamais de Fable pour le back', FRONT]);
  assert.deepEqual(prefs.lines.map((l) => l.source), ['dev', 'dev', 'distilled']);
  assert.ok(prefs.lines.length <= learning.MAX_LINES);
});

test('at most fifteen lines, the developer’s counted first', () => {
  const dev = Array.from({ length: 12 }, (_, i) => `ligne ${i}`);
  const lines = Array.from({ length: 10 }, (_, i) => `Préférence ${i} (preuve : ${i + 3} sessions)`);
  assert.equal(learning.acceptLines(lines, { dev }).length, 3);
  assert.equal(learning.acceptLines(['sans preuve', 'chiffre sans parenthèse 3 sessions', 'vide (preuve : aucune)']).length, 0);
});

test('the planner’s section: the preferences, the gaps, and the rule; nothing when nothing is learned', () => {
  const s = learning.learningSection(project, registry);
  assert.match(s, /## Ce que calmdev a appris de ce projet/);
  assert.match(s, /ne se repose pas : rappelle la réponse dans ton plan/);
  assert.match(s, /dis-le en une ligne/);
  assert.match(s, /- Plafond : 6 \$ par session, toujours \[développeur\]/);
  assert.match(s, /- front sur claude-opus-5-5 : réel = 3,05 × l'estimé \(10 sessions\)/);
  assert.equal(learning.learningSection(tmp('escadrille-empty-')), '');
  assert.equal(learning.learningSection(null), '');
});

test('GET /api/learning on the server; the planner gets the section in its prompt', async () => {
  const port = await freePort();
  const fakeDir = tmp('escadrille-learn-fake-'); const fake = path.join(fakeDir, 'claude');
  writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(fakeDir, 'args.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));\n`);
  chmodSync(fake, 0o755);
  db.close();
  const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: dbFile, ESCADRILLE_PLANS: tmp('escadrille-learn-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-learn-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-learn-none-'), ESCADRILLE_CLAUDE: fake }, stdio: ['ignore', 'pipe', 'pipe'] });
  after(() => server.kill('SIGINT'));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/api/plans')).status === 200) break; } catch {} if (i > 150) throw new Error('server did not start'); await new Promise((r) => setTimeout(r, 60)); }
  const r = await (await fetch(`${base}/api/learning?project=${encodeURIComponent(project)}`)).json();
  assert.equal(r.project, project);
  assert.equal(r.registry.totals.plans, 10);
  assert.equal(r.registry.sessions, undefined, 'the per-session lines stay on the server');
  const front = r.registry.byKind.find((g) => g.kind === 'front');
  assert.equal(front.estimate.median, 2, 'the estimate read from the transcripts cached in the base');
  assert.deepEqual(r.estimation.gaps.find((g) => g.kind === 'front'), { kind: 'front', model: OPUS, ratio: 3.05, sessions: 10 });
  assert.equal(r.preferences.exists, true); assert.equal(r.preferences.lines.length, 3);
  assert.equal(r.distill.threshold, learning.DISTILL_MIN_RESULTS); assert.equal(r.distill.model, SONNET); assert.equal(r.distill.running, false);
  assert.equal((await fetch(`${base}/api/learning?project=relatif`)).status, 400);
  // The planner of a new escadrille on that project gets the section
  const e = await fetch(base + '/api/escadrille', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, idea: 'La suite' }) });
  assert.equal(e.status, 200);
  let args = null;
  for (let i = 0; i < 150 && !args; i++) { try { args = readFileSync(path.join(fakeDir, 'args.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.includes('--append-system-prompt')) || null; } catch {} if (!args) await new Promise((r) => setTimeout(r, 60)); }
  assert.ok(args, 'the planner started');
  const sys = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## Ce que calmdev a appris de ce projet/);
  assert.match(sys, /Plafond : 6 \$ par session, toujours \[développeur\]/);
  assert.match(sys, /\*\*Ce que calmdev a appris du projet\*\*/, 'the rule of the plan skill');
  assert.ok(existsSync(path.join(project, '.calmdev', 'learning.json')));
});
