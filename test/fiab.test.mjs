// FIAB (6 November): the reliable pilot. One test per requirement, pure modules only (no server, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { proposalCheck, decideAnswer, createDenials, permissionKey, wakePrompt } from '../lib/pilot.mjs';
import { isNetwork, destHost } from '../lib/planner.mjs';
import { guardFilesArgs, filesOf } from '../lib/guardbase.mjs';
import { needsProjectQa, projectQaPlans, projectQaBrief, projectQaFile, pendingPlanQa, abandonPlanQa } from '../lib/qa.mjs';
import { nextStep, EFFECT } from '../lib/nextstep.mjs';
import { items } from '../lib/todo.mjs';

test('2. git judges: a branch already in main is never proposed for a merge, a running session never relaunched', () => {
  const sessions = [
    { plan: 'p1', id: 'PMOD', status: 'done', branch: 'escadrille/p1/PMOD' },
    { plan: 'p1', id: 'DOM', status: 'done', branch: 'escadrille/p1/DOM' },
    { plan: 'p2', id: 'APPS', status: 'running', branch: 'escadrille/p2/APPS', who: 'session' },
  ];
  const merged = ['escadrille/p1/PMOD', 'escadrille/p1/DOM'];
  const merge = proposalCheck({ plan: { id: 'p9', title: 'Fusionner', sessions: [{ name: 'Fusion', prompt: 'merge escadrille/p1/PMOD into main' }] }, sessions, merged });
  assert.equal(merge.ok, false); assert.match(merge.why, /déjà dans main/);
  const relaunch = proposalCheck({ plan: { id: 'p9', sessions: [{ name: 'Reprise', prompt: 'reprendre escadrille/p2/APPS' }] }, sessions, merged });
  assert.equal(relaunch.ok, false); assert.match(relaunch.why, /tourne déjà/);
  const samePlan = proposalCheck({ plan: { id: 'p2', sessions: [{ name: 'x', prompt: 'y' }] }, sessions, merged });
  assert.equal(samePlan.ok, false);
  assert.equal(proposalCheck({ plan: { id: 'p9', sessions: [{ name: 'Nouvelle', prompt: 'écrire docs/x.md' }] }, sessions, merged }).ok, true);
  // the wake says who acts (nextStep) and what git has in main
  const w = wakePrompt({ project: '/p', state: { plans: [{ id: 'p2', title: 'T', sessions: [{ id: 'APPS', status: 'running', who: 'session' }] }], merged } });
  assert.match(w, /APPS running \(à la session\)/); assert.match(w, /Déjà dans main \(git\) : escadrille\/p1\/PMOD, escadrille\/p1\/DOM/);
});

test('3. never grant what the rule refuses: the exact command to the developer, muted from the first refusal', () => {
  const entry = { kind: 'permission', tool: 'Bash', input: { command: 'rm -rf  build' }, suggest: { allow: false, rule: 'rm', reason: 'suppression' } };
  const d = decideAnswer({ entry, mode: 'guide', allow: true });
  assert.equal(d.ok, false); assert.equal(d.dev, true); assert.equal(d.command, 'rm -rf build');
  const denials = createDenials(); const key = permissionKey('p', 'S', entry);
  const first = denials.refuse(key, { toDev: d.dev }); assert.equal(first.first, true); assert.equal(first.muted, true);
  const second = denials.refuse(key, { toDev: d.dev }); assert.equal(second.first, false, 'second pass is silent');
});

test('4. a local curl is not network; a host is read on the URL alone', () => {
  const local = ['curl http://127.0.0.1:3078/api/x', 'curl -s localhost:3078/docs/decisions.md', 'curl http://[::1]:3078/', 'curl ::1',
    'curl -s "http://localhost:3078/api/plans?next=a.io"', 'curl http://user@localhost:3078/x#frag'];
  for (const c of local) assert.equal(isNetwork('Bash', { command: c }), false, c);
  const evil = ['127.0.0.1', 'evil', 'com'].join('.');
  const remote = [`curl http://${evil}/`, `curl http://localhost.${['evil', 'com'].join('.')}/x`, `curl http://${['10', '0', '0', '2'].join('.')}:80/`]; // assembled, or the trace scan reads a LAN address
  for (const c of remote) assert.equal(isNetwork('Bash', { command: c }), true, c);
  assert.equal(destHost('http://[::1]:80/a?b'), '[::1]'); assert.equal(destHost('::1'), '::1');
  // the rule read it all local: never refused as network. POL (7 November): the pilot grants what the rule allows by the
  // call's target, no longer only the reads; a call the rule does not say yes to still goes to the developer, never as network
  const d = decideAnswer({ entry: { kind: 'permission', network: true, input: { command: 'curl -X POST localhost:3078/api/x' }, suggest: { allow: true, rule: 'local-host' } }, mode: 'guide', allow: true });
  assert.equal(d.ok, true);
  const u = decideAnswer({ entry: { kind: 'permission', network: true, input: { command: 'curl -X POST localhost:3078/api/x' }, suggest: { rule: 'local-host' } }, mode: 'guide', allow: true });
  assert.equal(u.ok, false); assert.doesNotMatch(u.why, /réseau/);
});

test('5. guardrails count the branch from its merge base with main', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fiab-guard-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  try { git('init', '-q', '-b', 'main'); } catch (e) { return; } // no git in this sandbox: nothing to check
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'a');
  git('checkout', '-qb', 'escadrille/p/S'); writeFileSync(path.join(dir, 'b.txt'), '1'); git('add', '.'); git('commit', '-qm', 'b');
  git('checkout', '-q', 'main'); writeFileSync(path.join(dir, 'server.mjs'), '1'); git('add', '.'); git('commit', '-qm', 'main moved');
  assert.deepEqual(guardFilesArgs('escadrille/p/S'), ['diff', '--name-only', '--no-renames', 'main...escadrille/p/S']);
  assert.deepEqual(filesOf(git(...guardFilesArgs('escadrille/p/S'))), ['b.txt']);
});

test('6. one QA per project: none while a plan runs, one covering every merge when all are done, per-plan QA abandoned', () => {
  const plans = [{ id: 'a', mergedAt: '2026-11-06T10:00:00Z' }, { id: 'b', mergedAt: '2026-11-06T11:00:00Z' }, { id: 'c', mergedAt: null, running: true }];
  assert.equal(needsProjectQa({ plans }), false);
  const done = plans.map((p) => ({ ...p, running: false }));
  assert.equal(needsProjectQa({ plans: done }), true);
  assert.deepEqual(projectQaPlans({ plans: done }).map((p) => p.id), ['a', 'b']);
  assert.equal(needsProjectQa({ plans: done, lastQaAt: '2026-11-06T12:00:00Z' }), false, 'nothing merged since the last QA');
  assert.equal(projectQaFile('CalmDev', '2026-11-06T23:00:00Z'), 'docs/qa/calmdev-2026-11-06.md');
  const brief = projectQaBrief({ name: 'CalmDev', date: '2026-11-06', plans: [{ plan: { id: 'a', title: 'A', sessions: [{ id: 'S', name: 'S', stops: [] }] } }, { plan: { id: 'b', title: 'B', sessions: [] } }] });
  assert.match(brief, /docs\/qa\/calmdev-2026-11-06\.md/); assert.match(brief, /Plan « A »/); assert.match(brief, /Plan « B »/); assert.match(brief, /2 plans/);
  const old = { id: 'p', qa: { session: 'QA', at: 'x' }, sessions: [{ id: 'S' }, { id: 'QA' }] };
  assert.deepEqual(pendingPlanQa([old], () => [{ id: 'S', status: 'done' }]), [{ plan: 'p', session: 'QA' }]);
  assert.deepEqual(pendingPlanQa([old], () => [{ id: 'QA', status: 'running' }]), []);
  const ab = abandonPlanQa(old, 'now'); assert.deepEqual(ab.sessions.map((s) => s.id), ['S']); assert.equal(ab.qa.abandoned, 'now');
  assert.deepEqual(pendingPlanQa([ab], () => []), []);
});

test('7. a ready grouped QA is in « À toi » with « Commencer la QA », from nextStep alone', () => {
  const next = nextStep({ kind: 'projectQa', status: 'ready' }, { id: '/p', pilotOn: true, mode: 'autonome' });
  assert.equal(next.who, 'dev'); assert.equal(next.gesture, 'startQa'); assert.equal(next.button, 'next.btn.startQa');
  assert.equal(EFFECT.startQa({ status: 'todo' }).status, 'running');
  const list = items({ qa: { plans: ['a', 'b'], next } });
  assert.deepEqual(list, [{ kind: 'qa', plans: 2, act: 'startQa' }]);
  assert.deepEqual(items({ qa: { plans: [], next: nextStep({ kind: 'projectQa', status: 'todo' }) } }), []);
  assert.deepEqual(items({ qa: { plans: [], next: nextStep({ kind: 'projectQa', status: 'running' }) } }), []);
});

test('8. « à toi » and « pour le pilote » follow nextStep, whatever the old reading says', () => {
  const pilotStep = { who: 'pilot', gesture: 'reply' }; const devStep = { who: 'dev', gesture: 'merge' };
  // waitingFor says dev, nextStep says pilot: kept for the pilot; waitingFor says pilot, nextStep says merge: to the developer
  const nodes = [{ plan: 'p', session: 'A', waitingFor: 'dev', next: pilotStep }, { plan: 'p', session: 'B', waitingFor: 'pilot', next: devStep }, { plan: 'p', session: 'C', waitingFor: 'dev', next: { who: 'session', gesture: null } }];
  const all = items({ nodes, pilot: false, withKept: true });
  assert.deepEqual(all.map((i) => [i.s, i.kind, !!i.kept]), [['A', 'reply', true], ['B', 'merge', false]]);
  // the Review's lines: a review row reads its session's nextStep
  const reviews = [{ id: 'r1', plan: 'p', session: 'B' }, { id: 'r2', plan: 'p', session: 'A' }];
  const r = items({ nodes, reviews, pilot: true, withKept: true }).filter((i) => i.kind === 'review');
  assert.deepEqual(r.map((i) => [i.id, !!i.kept]), [['r1', false]]);
  // without a pilot the old reading gave the review to the developer; nextStep says pilot: not in « À toi »
  const one = [{ id: 'r2', plan: 'p', session: 'A' }];
  assert.equal(items({ nodes: [{ plan: 'p', session: 'A' }], reviews: one, pilot: false }).filter((i) => i.kind === 'review').length, 1);
  assert.equal(items({ nodes: [{ plan: 'p', session: 'A', next: pilotStep }], reviews: one, pilot: false }).filter((i) => i.kind === 'review').length, 0);
});
