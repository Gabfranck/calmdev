// The access view (docs/access.md): one test per block of GET /api/access, the report computed from a
// throwaway home (settings, ~/.claude.json with secrets that must never come back) and a server on a spare
// port whose database holds a plan running with a network domain and two asks outside the sandbox.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accessReport as accessReportRaw, strippedEnv, connectorsOf as connectorsOfRaw } from '../lib/access.mjs';
import { plain } from '../lib/i18n.mjs';
// phase 9 I: the report carries markers; the French the API answers by default is what these lines read
const accessReport = (...a) => plain(accessReportRaw(...a)); const connectorsOf = (...a) => plain(connectorsOfRaw(...a));
import * as secrets from '../lib/secrets.mjs';
import { SANDBOX_SETTINGS, SESSION_TOOLS } from '../lib/planner.mjs';
// A LAN address is assembled at run time: scripts/trace-scan.mjs would take a written one for a real one.
const ip = (net, host) => `${net}.${host}`;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

// A home with the user's settings and ~/.claude.json, a project with its own settings and .mcp.json
const home = tmp('escadrille-home-'); const project = tmp('escadrille-acc-');
mkdirSync(path.join(home, '.claude')); mkdirSync(path.join(project, '.claude'));
writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'linear@market': true }, permissions: { deny: ['Bash(rm -rf*)'] } }));
writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'stripe@claude-plugins-official': false }, permissions: { deny: ['Bash(git push*)', 'Bash(npm publish*)'] } }));
writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_SECRET1' } } },
  projects: { [project]: { mcpServers: { db: { command: '/usr/local/bin/pg-mcp', args: ['--token', 'SECRET2'], env: { PGPASSWORD: 'SECRET3' } } }, disabledMcpjsonServers: ['off'] } } }));
writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['fs-mcp'] }, off: { command: 'x' } } }));

const server = { host: '127.0.0.1', port: 3078, lan: false, address: null, devices: [], pushUrl: 'https://exp.host/--/api/v2/push/send' };

test('Serveur: where it listens, the devices with their date, the push service and its tokens', () => {
  const closed = accessReport({ project, home, server });
  assert.deepEqual([closed.server.host, closed.server.port, closed.server.lan, closed.server.address], ['127.0.0.1', 3078, false, null]);
  assert.equal(closed.summary.level.server, 'green');
  const open = accessReport({ project, home, server: { ...server, host: '0.0.0.0', lan: true, address: `http://${ip('192.168.1', 5)}:3078`, devices: [{ name: 'iPhone', created: '2026-11-01T05:00:00Z', push: true }] } });
  assert.deepEqual(open.server.devices, [{ name: 'iPhone', created: '2026-11-01T05:00:00Z', push: true }]);
  assert.deepEqual(open.server.push, { service: 'exp.host', active: true, tokens: 1, key: false });
  assert.equal(open.summary.level.server, 'amber');
});

test('Sessions: the sandbox, what is unreadable, the env stripped by name, the tools, the deny rules, the network, addDirs', () => {
  const r = accessReport({ project, home, env: { OPENAI_API_KEY: 'sk-val-1', ANTHROPIC_API_KEY: 'y', GITHUB_TOKEN: 'ghp-val-2', PATH: '/bin' }, server,
    plans: [{ id: 'p1', title: 'Plan un', network: ['api.github.com'], addDirs: [path.join(home, 'shared')] }], settings: { network: ['registry.npmjs.org'], addDirs: [] } });
  const s = r.sessions;
  assert.equal(s.sandbox.enabled, true);
  assert.deepEqual(s.unreadable.denyRead, SANDBOX_SETTINGS.sandbox.filesystem.denyRead);
  assert.ok(s.unreadable.readRules.includes('Read(//**/.env)'));
  assert.equal(s.unreadable.count, s.unreadable.denyRead.length + s.unreadable.readRules.length);
  assert.deepEqual(s.env.stripped, ['GITHUB_TOKEN', 'OPENAI_API_KEY'], 'by name, ANTHROPIC_ kept');
  assert.deepEqual(s.env.added, { npm_config_ignore_scripts: 'true' }, 'npm runs no install script in a session');
  assert.ok(!/sk-val-1|ghp-val-2/.test(JSON.stringify(r)), 'names, never values');
  assert.deepEqual(s.tools.sessions, SESSION_TOOLS);
  assert.deepEqual(s.denied.map((d) => [d.rule, d.scope]), [['Bash(rm -rf*)', 'utilisateur'], ['Bash(git push*)', 'projet'], ['Bash(npm publish*)', 'projet']]);
  assert.equal(s.denied[1].source, '.claude/settings.json');
  assert.deepEqual(s.network.announced, [{ id: 'p1', title: 'Plan un', hosts: ['api.github.com'], missing: ['api.github.com'] }], 'a plan announces, the project opens');
  assert.deepEqual(s.network.list, [{ host: 'registry.npmjs.org', scope: 'sessions' }]);
  assert.deepEqual(s.addDirs, [{ dir: '~/shared', from: 'p1' }]);
  assert.equal(r.summary.level.sessions, 'amber', 'a plan with a domain shows in amber');
  assert.equal(accessReport({ project, home, env: {}, server }).summary.level.sessions, 'green');
  assert.deepEqual(strippedEnv({ GIT_CONFIG_KEY_0: 'a', CLAUDE_CODE_SIMPLE: '1', HOME: '/h' }), ['CLAUDE_CODE_SIMPLE', 'GIT_CONFIG_KEY_0']);
});

test('Connecteurs: GitHub and Linear declared, the plugins and MCP servers Claude Code loads here, never a secret', () => {
  const r = accessReport({ project, home, server, connectors: connectorsOf({ project, env: { PATH: '/nulle/part', ESCADRILLE_SECRETS: path.join(home, 'none.json') } }) });
  const e = r.extensions;
  assert.deepEqual(e.connectors.map((c) => [c.name, c.kind, c.ready, c.key]), [['GitHub', 'gh', false, false], ['Linear', 'api', false, false]]);
  assert.deepEqual(e.plugins.map((p) => [p.id, p.enabled]), [['linear@market', true], ['stripe@claude-plugins-official', false]]);
  assert.deepEqual(e.mcp.map((m) => [m.name, m.type, m.host || m.command, m.secret, m.enabled]),
    [['github', 'http', 'api.githubcopilot.com', true, true], ['db', 'stdio', 'pg-mcp', true, true], ['files', 'stdio', 'npx', false, true], ['off', 'stdio', 'x', false, false]]);
  const all = JSON.stringify(r);
  for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'ghp_', 'PGPASSWORD', 'Bearer', '--token']) assert.ok(!all.includes(secret), `${secret} never leaves`);
  assert.equal(r.summary.level.extensions, 'amber');
});

test('Connecteurs: gh found on the PATH without being launched, the Linear key said stored but never shown', () => {
  const bin = tmp('escadrille-bin-'); writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho launched > ' + path.join(bin, 'ran') + '\n', { mode: 0o755 });
  const file = path.join(tmp('escadrille-sec-'), 'secrets.json'); secrets.set(project, 'linear', 'lin_api_SECRET4', file);
  const c = connectorsOf({ project, env: { PATH: '/nulle:' + bin, ESCADRILLE_SECRETS: file } });
  assert.deepEqual(c.map((x) => [x.name, x.ready, x.key]), [['GitHub', true, false], ['Linear', true, true]]);
  assert.match(c[1].where, /secrets\.json \(0600, hors dépôt, non chiffré/);
  assert.equal(connectorsOf({ project: tmp('escadrille-other-'), env: { PATH: bin, ESCADRILLE_SECRETS: file } })[1].key, false, 'the key is per project');
  const r = accessReport({ project, home, server, connectors: c });
  assert.ok(!JSON.stringify(r).includes('SECRET4'), 'the key never leaves');
  assert.ok(!existsSync(path.join(bin, 'ran')), 'gh is never launched');
});

test('Ce qui sort: exp.host when a phone is paired, the domains of the plans running, nothing else', () => {
  const idle = accessReport({ project, home, server });
  assert.deepEqual(idle.out.map((o) => [o.host, o.onClick]), [['api.github.com', true], ['api.linear.app', true]], 'the connectors, on a click only');
  assert.ok(idle.out.every((o) => /sur clic seulement/.test(o.why)));
  assert.equal(idle.summary.level.out, 'green', 'a host reached on a click only is not open now');
  const r = accessReport({ project, home, server: { ...server, devices: [{ name: 'iPhone', created: 'x', push: false }] }, plans: [{ id: 'p1', title: 'Plan un', network: ['api.github.com'] }], settings: { network: ['registry.npmjs.org'] } });
  assert.deepEqual(r.out.filter((o) => !o.onClick).map((o) => o.host), ['exp.host', 'registry.npmjs.org'], 'the project list opens, a plan\'s announcement does not');
  assert.equal(r.summary.level.out, 'amber');
});

test('Ce qui est fermé: the LAN, the network of the sessions, the keys, connectors, production', () => {
  const r = accessReport({ project, home, server });
  assert.ok(r.closed.some((c) => /réseau local/.test(c)));
  assert.ok(r.closed.some((c) => /réseau des sessions/.test(c)));
  assert.ok(r.closed.some((c) => /connecteur/.test(c)));
  const open = accessReport({ project, home, server: { ...server, lan: true }, plans: [], settings: { network: ['a.com'] } });
  assert.ok(!open.closed.some((c) => /réseau local|réseau des sessions/.test(c)));
});

// The server: the plans running, the asks outside the sandbox and their answers, read in its database
const DB = path.join(tmp('escadrille-db-'), 'db.sqlite');
{
  const db = new DatabaseSync(DB);
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, primary key (plan, id));
    create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);`);
  const plan = (id, network) => JSON.stringify({ id, title: 'Titre ' + id, created: '2026-11-01T01:00:00Z', project, network, waves: [{ n: 1, title: 'w' }], sessions: [{ id: 'A', name: 'a', wave: 1, path: project, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' }] });
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('run', 'Titre run', '2026-11-01T01:00:00Z', plan('run', ['api.github.com']), project);
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('old', 'Titre old', '2026-11-01T00:00:00Z', plan('old', ['old.example.com']), project);
  db.prepare("insert into sessions values ('run', 'A', 'waiting', '[]', 'ok', '', '', '', 'a', ?)").run(new Date().toISOString());
  db.prepare("insert into sessions values ('old', 'A', 'done', '[]', 'ok', '', '', '', 'a', ?)").run(new Date().toISOString());
  const at = new Date().toISOString(); const msg = db.prepare('insert into session_messages (plan, session, role, text, data, at) values (?, ?, ?, ?, ?, ?)');
  const ask = (planId, id, command) => msg.run(planId, 'A', 'ask', command, JSON.stringify({ id, tool: 'Bash', input: { command, dangerouslyDisableSandbox: true }, network: false }), at);
  ask('run', 'r1', 'node scripts/inspect.mjs --app'); msg.run('run', 'A', 'system', 'Autorisé : node scripts/inspect.mjs --app', JSON.stringify({ answer: 'r1', allow: true }), at);
  ask('run', 'r2', 'open /Applications'); msg.run('run', 'A', 'system', 'Refusé : open /Applications', null, at);
  ask('run', 'r3', 'x'.repeat(300));
  msg.run('run', 'A', 'ask', 'npm test', JSON.stringify({ id: 'r4', tool: 'Bash', input: { command: 'npm test' } }), at);
  ask('old', 'o1', 'ls ~');
  db.close();
}
const PORT = freePort();
const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', HOME: home, PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => proc.kill('SIGINT'));
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

test('GET /api/access: the plans running open their domains, the asks outside the sandbox are counted with their answer', async () => {
  const r = await until(async () => { try { return await get('/api/access?project=' + encodeURIComponent(project)); } catch { return null; } });
  assert.equal(r.server.port, PORT);
  // the migration at start: the project's list = its setting ∪ the domains of its plans not retired, each with its scope
  assert.deepEqual(r.sessions.network.list, [{ host: 'api.github.com', scope: 'both' }, { host: 'old.example.com', scope: 'both' }]);
  assert.deepEqual(r.sessions.network.announced.map((p) => [p.id, p.missing]), [['run', []]], 'only the plans running announce');
  assert.deepEqual(r.out.filter((o) => !o.onClick).map((o) => o.host), ['api.github.com', 'old.example.com']);
  assert.deepEqual(r.extensions.connectors.map((c) => c.name), ['GitHub', 'Linear']);
  const o = r.sessions.outside;
  assert.deepEqual([o.allowed, o.denied, o.pending], [1, 1, 1]);
  assert.deepEqual(o.plans, [{ id: 'run', count: 3 }]);
  assert.equal(o.list[0].command, 'node scripts/inspect.mjs --app');
  assert.ok(o.list[2].command.length <= 120 && o.list[2].command.endsWith('…'));
  assert.equal(r.summary.level.sessions, 'amber');
  assert.deepEqual(r.extensions.mcp.map((m) => m.name), ['github', 'db', 'files', 'off'], 'the server reads the home it runs in');
});
