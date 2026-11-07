// lib/projecttests.mjs (docs/projecttests.md): the TEST: lines of a session, run outside the sandbox, with
// test/fake-box.sh for a host command and test/fake-docker.mjs for a container, no Docker and no PHP needed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTests, failures, testRun, testNote, parseTests, instruction, createProjectTests, MAX_LINES } from '../lib/projecttests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOX = path.join(here, 'fake-box.sh'); const DOCKER = path.join(here, 'fake-docker.mjs');

// A project with a test script (its own folder, never the worktree) and a session's worktree
const setup = () => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'projtests-')));
  const project = path.join(tmp, 'harbor'); const wt = path.join(tmp, 'wt'); mkdirSync(path.join(project, '.escadrille'), { recursive: true }); mkdirSync(path.join(wt, 'backend'), { recursive: true });
  const log = path.join(tmp, 'runs.log');
  writeFileSync(path.join(project, '.escadrille', 'be-test.sh'), [
    `echo "start $ESCADRILLE_TEST $(pwd)" >> ${log}`,
    'sleep 0.3',
    'echo "DB_PASSWORD=hunter22 database harbor_test"',
    `if [ -f "$1/fail" ]; then echo "There was 1 failure:"; echo "1) Tests\\\\Feature\\\\PlanTest::test_it_saves"; echo "  ⨯ app/Models/Plan.php"; echo "end" >> ${log}; exit 1; fi`,
    `echo "OK (12 tests)"; echo "end" >> ${log}`,
  ].join('\n'));
  const environment = {
    cwd: project, env: {},
    projectTests: {
      be: { command: `/bin/sh ${BOX} /bin/sh {project}/.escadrille/be-test.sh {worktree}`, dir: 'backend' },
      php: { command: 'php artisan test', service: 'api', dir: '/var/www' },
    },
  };
  return { tmp, project, wt, log, environment };
};
const until = (f) => new Promise((r) => { const t = setInterval(() => { if (f()) { clearInterval(t); r(); } }, 20); });

test('validateTests: names, one-line commands, a relative folder, a service, a delay', () => {
  assert.deepEqual(validateTests({ be: { command: 'sh {project}/.escadrille/be-test.sh {worktree}', dir: 'backend', timeoutMs: 900000 } }).value, { be: { command: 'sh {project}/.escadrille/be-test.sh {worktree}', dir: 'backend', timeoutMs: 900000 } });
  assert.equal(validateTests(undefined).value, null);
  for (const bad of [[], { 'b e': { command: 'x' } }, { be: { command: '' } }, { be: { command: 'a\nb' } }, { be: { command: 'x', dir: '../up' } }, { be: { command: 'x', dir: '/abs' } }, { be: { command: 'x', service: 'a b' } }, { be: { command: 'x', timeoutMs: 5 } }, { be: { command: 'x', shell: true } }, { be: { command: 'x', service: 'api', dir: 'rel' } }])
    assert.ok(validateTests(bad).errors, JSON.stringify(bad));
});

test('failures: node --test, PHPUnit, Pest and Pint', () => {
  assert.deepEqual(failures("not ok 1 - a\n  ---\n  location: 'test/a.test.mjs:3:1'\n"), ['test/a.test.mjs']);
  assert.deepEqual(failures('1) Tests\\Feature\\PlanTest::test_it_saves\nFAILED  Tests\\Unit\\FooTest > it works\n  ⨯ app/Models/Plan.php\n'), ['Tests\\Feature\\PlanTest::test_it_saves', 'Tests\\Unit\\FooTest > it works', 'app/Models/Plan.php']);
});

test('a declared TEST: line runs outside the box in the worktree; an undeclared one is refused before anything runs', async () => {
  const { project, wt, log, environment } = setup();
  const ok = await testRun({ name: 'be', environment, project, worktree: wt });
  assert.equal(ok.ok, true); assert.equal(ok.code, 0);
  assert.match(readFileSync(log, 'utf8'), new RegExp(`start be ${path.join(wt, 'backend')}`));
  assert.ok(ok.lines.some((l) => l.includes('DB_PASSWORD=•••')), 'secrets masked'); assert.ok(!ok.lines.join('\n').includes('hunter22'));
  writeFileSync(path.join(wt, 'fail'), '');
  const ko = await testRun({ name: 'be', environment, project, worktree: wt });
  assert.equal(ko.ok, false); assert.equal(ko.code, 1);
  assert.deepEqual(ko.failed, ['Tests\\Feature\\PlanTest::test_it_saves', 'app/Models/Plan.php']);
  assert.match(testNote(ko), /^TEST be : échec \(code 1\) · 2 en échec\n  ✖ Tests/);
  const before = readFileSync(log, 'utf8');
  for (const [name, why] of [['rm', /n’est pas un test déclaré pour ce projet \(déclarés : be, php\)/], ['be; rm -rf /', /un nom de test est attendu/], ['constructor', /pas un test déclaré/], ['__proto__', /un nom de test est attendu/]]) {
    const r = await testRun({ name, environment, project, worktree: wt });
    assert.equal(r.refused, true); assert.match(r.error, why);
  }
  assert.equal((await testRun({ name: 'be', environment, project, worktree: null })).refused, true);
  assert.equal(readFileSync(log, 'utf8'), before, 'nothing ran');
});

test('a test declared in a container goes through docker compose exec, from the project folder', async () => {
  const { tmp, project, wt, environment } = setup();
  const calls = path.join(tmp, 'docker.log');
  const r = await testRun({ name: 'php', environment, project, worktree: wt, env: { ...process.env, ESCADRILLE_DOCKER: DOCKER, FAKE_DOCKER_LOG: calls } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.service, 'api');
  const call = JSON.parse(readFileSync(calls, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(call.args, ['compose', 'exec', '-w', '/var/www', '-T', 'api', 'php', 'artisan', 'test']); assert.equal(call.cwd, project);
  assert.ok(r.lines.some((l) => l.includes('API_SECRET=•••')));
});

test('the note is cut at 60 lines', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const note = testNote({ name: 'be', ok: false, code: 1, failed: Array.from({ length: 30 }, (_, i) => `f${i}`), lines });
  assert.equal(note.split('\n').length, MAX_LINES); assert.match(note, /line 199$/);
});

test('createProjectTests: the result goes back to the session, and two requests of one project run one after the other', async () => {
  const { project, wt, log, environment } = setup();
  const notes = []; const logs = []; const idle = [];
  const ops = createProjectTests({ environmentOf: () => environment, record: (r) => logs.push(r), onNote: (p, s, line) => notes.push([s, line]), onIdle: (p, s) => idle.push(s), projectOfPlan: () => project });
  assert.deepEqual(parseTests('Fait.\nTEST: be\n> TEST: be\nTEST: front\nTEST: x\n'), ['be', 'front']);
  assert.equal(ops.ofTurn('plan', 'A', 'Je lance les tests.\nTEST: be\n', null, wt), 1);
  assert.equal(ops.ofTurn('plan', 'B', 'TEST: be\nTEST: rm\n', null, wt), 2);
  assert.equal(ops.busy('plan', 'A'), true);
  await until(() => notes.length === 3);
  const runs = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(runs, ['start', 'end', 'start', 'end'], 'never two at once');
  assert.deepEqual(notes.map(([s, l]) => [s, l.split('\n')[0]]), [['A', 'TEST be : ok (code 0)'], ['B', 'TEST be : ok (code 0)'], ['B', 'TEST rm : refusé : « rm » n’est pas un test déclaré pour ce projet (déclarés : be, php)']]);
  assert.deepEqual(idle, ['A', 'B']);
  assert.equal(logs.length, 3); assert.match(logs[0].text, /^Test be \(session A\) : code 0 en \d+ s$/);
  assert.equal(ops.ofTurn('plan', 'A', 'rien', null, wt), 0);
  assert.match(instruction(environment), /`TEST: <nom>` \(déclarés : be, php\)/); assert.equal(instruction({}), '');
});
