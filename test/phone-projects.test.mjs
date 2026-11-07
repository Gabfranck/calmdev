// The phone's project functions (phone/lib/projects.ts), which have no imports: node 22 strips the types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortName, filterPlans, groupPlans, projectsOf, projectOfPlan, pickPlan, validProject } from '../phone/lib/projects.ts';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const plans = [
  { id: 'a1', title: 'Quick wins', created: '2026-11-01T03:00:00Z', project: `${USERS}/dev/Dev/Orchard` },
  { id: 'a2', title: 'Avatars', created: '2026-11-01T05:00:00Z', project: `${USERS}/dev/Dev/Orchard` },
  { id: 'p1', title: 'Import', created: '2026-11-01T04:00:00Z', project: `${USERS}/dev/Dev/Tandem/` },
  { id: 'x', title: 'Sans projet', created: '2026-11-01T06:00:00Z', project: null },
];

test('shortName is the last path segment', () => {
  assert.equal(shortName(`${USERS}/dev/Dev/Orchard`), 'Orchard');
  assert.equal(shortName(`${USERS}/dev/Dev/Tandem/`), 'Tandem');
  assert.equal(shortName(null), '');
});

test('filterPlans keeps one project, or everything', () => {
  assert.deepEqual(filterPlans(plans, `${USERS}/dev/Dev/Orchard`).map((p) => p.id), ['a1', 'a2']);
  assert.equal(filterPlans(plans, null).length, 4);
  assert.equal(filterPlans(plans, '').length, 4);
  assert.deepEqual(filterPlans(plans, '/nope'), []);
});

test('groupPlans: newest group first, newest plan first, no project last', () => {
  const g = groupPlans(plans);
  assert.deepEqual(g.map((x) => x.name), ['Orchard', 'Tandem', '']);
  assert.deepEqual(g[0].plans.map((p) => p.id), ['a2', 'a1']);
  assert.equal(g[2].project, null);
});

test('projectsOf lists the projects by name with their plan count', () => {
  assert.deepEqual(projectsOf(plans), [{ path: `${USERS}/dev/Dev/Orchard`, name: 'Orchard', count: 2 }, { path: `${USERS}/dev/Dev/Tandem/`, name: 'Tandem', count: 1 }]);
});

test('projectOfPlan, pickPlan, validProject', () => {
  assert.equal(projectOfPlan(plans, 'p1'), `${USERS}/dev/Dev/Tandem/`);
  assert.equal(projectOfPlan(plans, 'x'), null);
  assert.equal(projectOfPlan(plans, 'zz'), null);
  assert.equal(pickPlan(plans, 'a1'), 'a1');
  assert.equal(pickPlan(plans, 'gone'), 'x');
  assert.equal(pickPlan([], 'a1'), null);
  assert.equal(validProject(plans, `${USERS}/dev/Dev/Tandem/`), `${USERS}/dev/Dev/Tandem/`);
  assert.equal(validProject(plans, '/gone'), null);
});
