// The measure (docs/mesure.md) against a hand-built database (test/seed-metrics.mjs) whose figures are known,
// then the routes on a server started over that database.
import { freePort } from './free-port.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planMetrics, overallMetrics } from '../lib/metrics.mjs';
import { storyOf } from '../lib/story.mjs';
import { seedMetrics } from './seed-metrics.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const NOW = Date.parse('2026-11-01T16:00:00.000Z');
const projectA = tmp('escadrille-metrics-a-'); const projectB = tmp('escadrille-metrics-b-');
const file = path.join(tmp('escadrille-metrics-db-'), 'db.sqlite');
const db = new DatabaseSync(file); seedMetrics(db, { projectA, projectB });

test('alpha: 2,40 $ per merged PR, 12 min of attention for 110 min running, unattended', () => {
  const m = planMetrics({ db, planId: 'alpha', now: NOW });
  assert.equal(m.costPerMergedPr, 2.4);
  assert.equal(m.attentionMinutes, 12, 'the permission (2 min) and the wait at stop 0 (10 min)');
  assert.equal(m.sessionHours, Math.round((110 / 60) * 100) / 100, 'A 30 + 20 min, B 60 min: a stop line does not cut the running');
  assert.equal(m.unattended, true);
  assert.equal(m.merged, 2); assert.equal(m.cost, 4.8); assert.equal(m.stops, 3);
  assert.equal(m.startedAt, '2026-11-01T10:00:00.000Z'); assert.equal(m.endedAt, '2026-11-01T11:00:00.000Z');
});

test('beta: no merged PR, the auto answer is not attention, an intervention and a cap', () => {
  const m = planMetrics({ db, planId: 'beta', now: NOW });
  assert.equal(m.costPerMergedPr, null);
  assert.equal(m.attentionMinutes, 15, 'the wait with no stop (12:30 → 12:45); the data.auto answer at 13:05 counts nothing');
  assert.equal(m.sessionHours, 1.25);
  assert.equal(m.unattended, false);
  assert.equal(m.interventions, 1); assert.equal(m.caps, 1); assert.equal(m.errors, 1); assert.equal(m.handoffs, 1);
});

test('gamma: an unanswered wait is no attention, a plan not finished is neither attended nor not', () => {
  const m = planMetrics({ db, planId: 'gamma', now: NOW });
  assert.equal(m.attentionMinutes, 0); assert.equal(m.sessionHours, 1); assert.equal(m.unattended, null); assert.equal(m.endedAt, null);
});

test('overall: by project, and every plan without one', () => {
  const a = overallMetrics({ db, project: projectA, now: NOW });
  assert.deepEqual(a.overall, { costPerMergedPr: 5.4, attentionMinutes: 27, sessionHours: 3.08, unattendedRate: 0.5, cost: 10.8, merged: 2, finished: 2, unattended: 1, plans: 2 });
  assert.deepEqual(a.plans.map((p) => [p.id, p.unattended]).sort(), [['alpha', true], ['beta', false]]);
  assert.deepEqual(Object.keys(a.plans[0]).sort(), ['attentionMinutes', 'costPerMergedPr', 'id', 'sessionHours', 'title', 'unattended']);
  const all = overallMetrics({ db, now: NOW });
  assert.equal(all.overall.plans, 3); assert.equal(all.overall.finished, 2); assert.equal(all.overall.sessionHours, 4.08);
  const none = overallMetrics({ db, project: '/nowhere', now: NOW });
  assert.deepEqual(none.overall, { costPerMergedPr: null, attentionMinutes: null, sessionHours: null, unattendedRate: null, cost: 0, merged: 0, finished: 0, unattended: 0, plans: 0 });
});

const storyInputs = (id) => {
  const plan = JSON.parse(db.prepare('select json from plans where id = ?').get(id).json);
  const state = db.prepare('select * from sessions where plan = ?').all(id).map((r) => ({ ...r, stops: JSON.parse(r.stops), worktree: JSON.parse(r.worktree), handoffs: JSON.parse(r.handoffs || '[]') }));
  const log = db.prepare('select * from log where plan = ? order by seq desc').all(id).map((r) => ({ ...r, stops: JSON.parse(r.stops) }));
  const messages = db.prepare('select session, role, text, data, at from session_messages where plan = ?').all(id);
  return { plan, state, log, messages, metrics: planMetrics({ db, planId: id, now: NOW }), timeZone: 'UTC' };
};

test('storyOf: the real figures, first person, nothing undefined', () => {
  const a = storyOf(storyInputs('alpha'));
  for (const s of ['# Alpha : deux sessions sages', 'Le 1er novembre 2026 à 10:00, j\'ai lancé « Alpha : deux sessions sages »', 'Le but : Deux sessions qui finissent seules.', '2 sessions en 1 vague, de 10:00 à 11:00, soit 1 h 00', '4,80 $ ; 2 PR fusionnées, soit 2,40 $ par PR', '12 min pour 1,8 h de sessions', 'Arrêts franchis : 3 sur 4', 'Fini sans intervention', 'Rien n’a cassé.']) assert.ok(a.includes(s), `${s}\n---\n${a}`);
  assert.ok(a.trimEnd().endsWith('Fait avec calmdev, local, source available.'));
  const b = storyOf(storyInputs('beta'));
  for (const s of ['aucune PR fusionnée', '15 min pour 1,3 h de sessions', 'intervenir une fois', 'Ce qui a cassé : 1 session en erreur, 1 passation', 'un plafond atteint']) assert.ok(b.includes(s), `${s}\n---\n${b}`);
  const g = storyOf(storyInputs('gamma'));
  assert.ok(g.includes('pas encore fini (1 session sur 1 en cours ou à venir)'), g);
  for (const t of [a, b, g, storyOf({})]) { assert.ok(!/undefined|null|NaN/.test(t), t); }
});

test('routes: /api/usage and /api/plan/:id carry metrics; POST /story writes then replaces docs/recits/<id>.md', async () => {
  const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
  const plans = tmp('escadrille-metrics-plans-'); mkdirSync(path.join(plans), { recursive: true });
  const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: file, ESCADRILLE_PLANS: plans, ESCADRILLE_TRANSCRIPTS: path.join(HERE, 'fixtures', 'projects'), ESCADRILLE_SESSIONS: path.join(HERE, 'fixtures', 'sessions') }, stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) { try { await fetch(BASE + '/api/plans'); break; } catch { if (i > 100) throw new Error('server did not start'); await new Promise((r) => setTimeout(r, 60)); } }
    const u = await (await fetch(`${BASE}/api/usage?project=${encodeURIComponent(projectA)}`)).json();
    assert.equal(u.metrics.overall.costPerMergedPr, 5.4); assert.equal(u.metrics.plans.length, 2); assert.ok(u.calibration !== undefined);
    const p = await (await fetch(`${BASE}/api/plan/alpha`)).json();
    assert.equal(p.metrics.costPerMergedPr, 2.4); assert.equal(p.metrics.unattended, true);
    const post = async () => (await fetch(`${BASE}/api/plan/alpha/story`, { method: 'POST' })).json();
    const r1 = await post();
    assert.equal(r1.ok, true); assert.equal(r1.file, path.join(projectA, 'docs', 'recits', 'alpha.md'));
    assert.equal(readFileSync(r1.file, 'utf8'), r1.text); assert.ok(r1.text.includes('2,40 $ par PR'));
    const r2 = await post(); assert.equal(r2.file, r1.file); assert.equal(readFileSync(r2.file, 'utf8'), r2.text);
    assert.ok(existsSync(r2.file));
  } finally { server.kill('SIGINT'); }
});
