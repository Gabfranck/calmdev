// scripts/first-run-check.mjs judges the steps of scripts/first-run.sh (docs/first-run.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, readEnv, markdown } from '../scripts/first-run-check.mjs';

const step = (name, facts) => ({ step: name, start: '2026-11-05T00:00:00.000Z', ms: 1000, ...facts });

test('the dry run: a fake claude makes login and plan « expected », a clean planner error included', () => {
  const rows = judge([step('login', { version_rc: 1, auth_rc: 1, fake: 1 }), step('plan', { status: 'error', plan: 'no', replied: 0, timeout: 60 })], { fake: '1' });
  assert.deepEqual(rows.map((r) => r.verdict), ['expected', 'expected']);
  assert.equal(judge([step('plan', { status: 'thinking', plan: 'no', timeout: 60 })], { fake: '1' })[0].verdict, 'red');
});

test('the window without the guard cookie, and a project added only through the guard link, are red', () => {
  const [w, a] = judge([step('window', { opened: 'http://localhost:1/', http: 200, cookie: 0 }), step('add', { http: 200, cookie: 2, listed: 'yes' })], {});
  assert.equal(w.verdict, 'red'); assert.equal(a.verdict, 'red');
  const [w2, a2] = judge([step('window', { opened: 'http://localhost:1/guard?k=(key)', http: 200, cookie: 1 }), step('add', { http: 200, cookie: 1, listed: 'yes' })], {});
  assert.equal(w2.verdict, 'green'); assert.equal(a2.verdict, 'green');
});

test('a refusal without the guard-link path is a warning; a request without proof that passes is red', () => {
  assert.equal(judge([step('add_nocookie', { http: 403, error: 'never from a session' })], {})[0].verdict, 'warn');
  assert.equal(judge([step('add_nocookie', { http: 403, error: 'open ~/.config/escadrille/guard-link once' })], {})[0].verdict, 'green');
  assert.equal(judge([step('add_nocookie', { http: 200 })], {})[0].verdict, 'red');
});

test('the real run: logged in and a plan are green; projects inherited from committed plans are named', () => {
  const rows = judge([
    step('login', { version_rc: 0, print_rc: 0, answer: 'ok' }),
    step('page', { http: 200, bytes: 9, projects: 3, via: 'migration', plans_committed: 24 }),
    step('plan', { status: 'waiting', plan: 'yes', replied: 1, page: 'http://127.0.0.1:1/e/x', timeout: 900 }),
  ], readEnv('fake=0\nport=1'));
  assert.deepEqual(rows.map((r) => r.verdict), ['green', 'red', 'green']);
  assert.match(rows[1].why, /plans\/\*\.json/);
  assert.match(markdown(rows, { fake: '0' }), /1 red, 0 warn, 0 by hand, 2 green/);
});

test('a Claude Code not logged in is the developer\'s gesture: login and plan by hand, install.sh must say it', () => {
  const login = step('login', { version_rc: 0, print_rc: 1, answer: 'Not logged in · Please run /login' });
  const rows = judge([login, step('install', { http: 200, fail_lines: 0, ok_lines: 3, warn_lines: 1, login_warn: 1, ms: 900 }),
    step('plan', { status: 'error', plan: 'no', error: 'Not logged in · Please run /login', timeout: 900 })], { fake: '0' });
  assert.deepEqual(rows.map((r) => r.verdict), ['manual', 'green', 'manual']);
  assert.equal(judge([login, step('install', { http: 200, fail_lines: 0, login_warn: 0, ms: 900 })], { fake: '0' })[1].verdict, 'red');
});
