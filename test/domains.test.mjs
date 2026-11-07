// One list of domains per project, a scope per line (lib/domains.mjs, docs/access.md « Domaines »)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEntries, defaultScope, hostsFor, mergeNetwork, migrateSettings, missingFrom, entriesOf } from '../lib/domains.mjs';
import { sandboxSettings, validateDomains } from '../lib/planner.mjs';
import { accessReport } from '../lib/access.mjs';
import { decideAnswer } from '../lib/pilot.mjs';
import { decidePolicy } from '../lib/pilotpolicy.mjs';
import { suggest } from '../lib/policy.mjs';

const LIST = [{ host: 'v2.tauri.app', scope: 'plan' }, { host: 'crates.io', scope: 'sessions' }, { host: 'docs.rs', scope: 'both' }];

test('a bare string is worth both; a registry added without scope goes to the sessions', () => {
  assert.deepEqual(toEntries(['docs.rs'], validateDomains).entries, [{ host: 'docs.rs', scope: 'both' }]);
  const reg = ['registry.npmjs.org', '*.npmjs.org', 'crates.io', 'static.crates.io', 'pypi.org', 'files.pythonhosted.org', 'rubygems.org', 'proxy.golang.org'];
  assert.deepEqual(toEntries(reg, validateDomains).entries.map((e) => e.scope), reg.map(() => 'sessions'));
  assert.equal(defaultScope('api.github.com'), 'both'); assert.equal(defaultScope('notcrates.io'), 'both');
  assert.deepEqual(toEntries([{ host: 'crates.io', scope: 'both' }], validateDomains).entries, [{ host: 'crates.io', scope: 'both' }], 'a given scope wins over the default');
});

test('the host rules of validateDomains still hold, and an unknown scope is refused', () => {
  assert.ok(toEntries(['https://x.com/a'], validateDomains).errors);
  assert.ok(toEntries(['*'], validateDomains).errors);
  assert.ok(toEntries([{ host: 'x.com', scope: 'all' }], validateDomains).errors);
  assert.ok(toEntries('x.com', validateDomains).errors);
});

test('a session reaches only sessions and both; a planning run only plan and both', () => {
  assert.deepEqual(hostsFor(LIST, 'session'), ['crates.io', 'docs.rs']);
  assert.deepEqual(hostsFor(LIST, 'plan'), ['v2.tauri.app', 'docs.rs']);
  assert.deepEqual(sandboxSettings(hostsFor(LIST, 'session')).sandbox.network.allowedDomains, ['crates.io', 'docs.rs']);
  assert.deepEqual(sandboxSettings(hostsFor(LIST, 'plan')).sandbox.network.allowedDomains, ['v2.tauri.app', 'docs.rs']);
  assert.deepEqual(hostsFor(['docs.rs'], 'plan'), ['docs.rs'], 'an old string list reads as both');
});

test('the policy judges a host against the list of the role: a plan-only host stays refused to a session', () => {
  const ask = (url) => suggest({ tool: 'WebFetch', input: { url }, cwd: '/tmp/p', plan: { network: hostsFor(LIST, 'session') }, project: '/tmp/p' });
  assert.equal(ask('https://v2.tauri.app/start').allow, false);
  assert.notEqual(ask('https://docs.rs/serde').allow, false);
});

test('the migration merges the setting and the plans without duplicate; twice gives the same list', () => {
  const setting = ['api.github.com', { host: 'docs.rs', scope: 'plan' }];
  const plans = [['crates.io', 'registry.npmjs.org', 'v2.tauri.app', 'doc.rust-lang.org', 'docs.rs'], ['api.github.com']];
  const once = mergeNetwork(setting, plans, validateDomains);
  assert.deepEqual(once, [
    { host: 'api.github.com', scope: 'both' }, { host: 'docs.rs', scope: 'plan' }, { host: 'crates.io', scope: 'sessions' },
    { host: 'registry.npmjs.org', scope: 'sessions' }, { host: 'v2.tauri.app', scope: 'both' }, { host: 'doc.rust-lang.org', scope: 'both' }]);
  assert.deepEqual(mergeNetwork(once, plans, validateDomains), once);
  const a = migrateSettings({ budget: 4, network: setting }, plans, validateDomains);
  assert.equal(a.migrated, true); assert.equal(a.st.budget, 4); assert.deepEqual(a.st.network, once);
  const b = migrateSettings(a.st, [...plans, ['later.example.com']], validateDomains);
  assert.equal(b.migrated, false, 'once per project'); assert.deepEqual(b.st, a.st, 'a plan announced later opens nothing');
});

test('a plan\'s network alone opens nothing', () => {
  assert.deepEqual(hostsFor(entriesOf([]), 'session'), []);
  assert.deepEqual(missingFrom(LIST, ['crates.io', 'v2.tauri.app', 'serde.rs']), ['serde.rs'], 'only a host absent from the list, whatever its scope');
  assert.deepEqual(missingFrom([{ host: '*.npmjs.org', scope: 'sessions' }], ['registry.npmjs.org']), [], 'a wildcard covers its subdomains');
  const server = { host: '127.0.0.1', port: 1, lan: false, devices: [], pushUrl: 'https://exp.host/x' };
  const r = accessReport({ project: null, home: '/nonexistent', env: {}, server, plans: [{ id: 'p', title: 'P', network: ['crates.io'] }], settings: {}, connectors: [] });
  assert.deepEqual(r.out.filter((o) => !o.onClick).map((o) => o.host), []);
  assert.deepEqual(r.sessions.network.list, []);
  assert.deepEqual(r.sessions.network.announced, [{ id: 'p', title: 'P', hosts: ['crates.io'], missing: ['crates.io'] }]);
  const opened = accessReport({ project: null, home: '/nonexistent', env: {}, server, plans: [], settings: { network: ['crates.io'] }, connectors: [] });
  assert.equal(r.closed.length, opened.closed.length + 1, 'the sessions\' network says closed without a project domain');
  assert.deepEqual(opened.out.map((o) => o.host).filter((h) => h === 'crates.io'), ['crates.io']);
});

test('the pilot still opens nothing: a network ask goes to the developer', () => {
  const entry = { kind: 'permission', network: true, input: { command: 'curl https://crates.io' } };
  for (const mode of ['guide', 'autonome']) assert.equal(decideAnswer({ entry, mode, allow: true }).ok, false);
  assert.equal(decidePolicy({ on: true, suggest: { allow: true }, ask: entry }).answer, 'deny');
});
