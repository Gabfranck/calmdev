// Phase 16 MCP (docs/mcp.md): the servers of a project without a value, the setting behind the cookie, and a simulated
// session launched with two chosen servers: exactly those, wrapped, keys in a 0600 file erased at init, never in argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as mcp from '../lib/mcp.mjs';
import * as secrets from '../lib/secrets.mjs';
import * as pilotlog from '../lib/pilotlog.mjs';
import { DatabaseSync } from 'node:sqlite';

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const KEY = 'fake-key-ne-doit-jamais-sortir-1234';

// A home with ~/.claude.json and a project with .mcp.json: two local servers, one npx, one remote, one disabled
const fixture = () => {
  const home = tmp('mcp-home-'); const project = tmp('mcp-proj-'); const secretsFile = path.join(tmp('mcp-sec-'), 'secrets.json');
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { notes: { command: '/usr/local/bin/notes-mcp', args: ['--dir', '/tmp/x'] }, remote: { type: 'http', url: 'https://mcp.example.com/v1', headers: { Authorization: 'Bearer ' + KEY } } },
    projects: { [project]: { mcpServers: { sqlite: { command: 'node', args: ['tools/sqlite-mcp.mjs'], env: { DB_URL: 'file:dev.db' } } }, disabledMcpjsonServers: ['off'] } },
  }));
  writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
    gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: KEY } },
    docs: { command: './bin/docs-mcp', env: { DOCS_ROOT: '${DOCS_ROOT}' } },
    off: { command: './bin/off' },
    notes: { command: './bin/notes-local' }, // the project's wins over the user's
  } }));
  return { home, project, secretsFile };
};

test('listServers: name, type, source, supposed network; never a value', () => {
  const { home, project, secretsFile } = fixture();
  const list = mcp.listServers({ project, home, secretsFile });
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['docs', 'gh', 'notes', 'off', 'remote', 'sqlite']);
  assert.equal(by.notes.source, '.mcp.json');
  assert.equal(by.sqlite.source, '~/.claude.json (projet)');
  assert.equal(by.remote.source, '~/.claude.json');
  assert.deepEqual([by.docs.network, by.sqlite.network, by.notes.network], ['local', 'local', 'local']);
  assert.equal(by.gh.network, 'needs'); assert.match(by.gh.why, /demande le réseau/);
  assert.equal(by.remote.network, 'remote'); assert.equal(by.remote.host, 'mcp.example.com'); assert.match(by.remote.why, /distant/);
  assert.equal(by.off.enabled, false); assert.equal(by.off.allowed, false);
  assert.deepEqual(by.gh.keys, [{ name: 'GITHUB_TOKEN', stored: false }]);
  assert.deepEqual(by.docs.setting, { sessions: 'none', readOnly: true });
  const text = JSON.stringify(list);
  for (const leak of [KEY, 'file:dev.db', '/tmp/x', 'Bearer', 'https://']) assert.ok(!text.includes(leak), leak);
});

test('classify: a key in an argument, a known service, a fetcher', () => {
  assert.equal(mcp.classify('x', { command: '/bin/x', args: ['--token=abc'] }).network, 'needs');
  assert.match(mcp.classify('x', { command: '/bin/x', args: ['--api-key', 'a'] }).why, /clé en argument/);
  assert.equal(mcp.classify('slack', { command: './slack' }).network, 'needs');
  assert.equal(mcp.classify('x', { command: 'uvx', args: ['thing'] }).network, 'needs');
  assert.equal(mcp.classify('x', { type: 'sse', url: 'http://localhost:1' }).network, 'remote');
  assert.equal(mcp.classify('x', { command: 'node', args: ['tools/x.mjs'] }).network, 'local');
});

test('the setting: none by default, validated, written only with the cookie (403)', () => {
  const { home, project, secretsFile } = fixture();
  assert.throws(() => mcp.update({ body: { project, name: 'docs', sessions: 'all' }, guardOk: false, home, secretsFile }), (e) => e.status === 403);
  assert.throws(() => mcp.update({ body: { project, name: 'nope', sessions: 'all' }, guardOk: true, home, secretsFile }), (e) => e.status === 400);
  assert.throws(() => mcp.update({ body: { project, name: 'docs', sessions: 'some' }, guardOk: true, home, secretsFile }), (e) => e.status === 400);
  assert.throws(() => mcp.update({ body: { project, name: 'docs', readOnly: 'yes' }, guardOk: true, home, secretsFile }), (e) => e.status === 400);
  assert.throws(() => mcp.update({ body: { project, name: 'docs', keys: { OTHER: 'v' } }, guardOk: true, home, secretsFile }), (e) => e.status === 400);
  const r = mcp.update({ body: { project, name: 'docs', sessions: ['RES'], keys: { DOCS_ROOT: '/srv/docs' } }, guardOk: true, home, secretsFile });
  assert.deepEqual(r.setting, { docs: { sessions: ['RES'], readOnly: true } });
  assert.deepEqual(r.server.keys, [{ name: 'DOCS_ROOT', stored: true }]);
  assert.ok(!JSON.stringify(r).includes('/srv/docs'));
  assert.equal(secrets.get(project, 'mcp.docs.DOCS_ROOT', secretsFile), '/srv/docs');
  // Back to the default: the name leaves the setting
  assert.deepEqual(mcp.update({ body: { project, name: 'docs', sessions: 'none' }, guardOk: true, home, secretsFile, setting: r.setting }).setting, {});
  assert.deepEqual(mcp.validateSetting({ a: { sessions: 'all' } }).value, { a: { sessions: 'all', readOnly: true } });
  assert.ok(mcp.validateSetting([]).errors);
});

test('GET view: the contract of docs/mcp.md', () => {
  const { home, project, secretsFile } = fixture();
  const v = mcp.view({ project, home, secretsFile, tool: '/usr/bin/sandbox-exec', setting: { docs: { sessions: 'all', readOnly: false } } });
  assert.deepEqual(v.sandbox, { ok: true, tool: 'sandbox-exec', note: '' });
  const d = v.servers.find((s) => s.name === 'docs');
  for (const k of ['name', 'type', 'source', 'enabled', 'network', 'allowed', 'why', 'command', 'host', 'keys', 'setting']) assert.ok(k in d, k);
  assert.deepEqual(d.setting, { sessions: 'all', readOnly: false });
  assert.equal(mcp.view({ project, home, secretsFile, tool: null }).sandbox.ok, false);
});

test('no server chosen: still --strict-mcp-config, an empty config, no file, no log line', () => {
  const { home, project, secretsFile } = fixture(); const wt = tmp('mcp-wt-');
  const l = mcp.prepareLaunch({ project, planId: 'p', sessionId: 'A', worktree: wt, home, secretsFile, tool: '/usr/bin/sandbox-exec' });
  assert.deepEqual(l.args, ['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config']);
  assert.equal(l.file, null); assert.equal(l.logText, null);
});

test('the profile: no network but localhost, sensitive reads denied, writes by readOnly', () => {
  const home = '/h/someone';
  const ro = mcp.sandboxProfile({ readOnly: true, worktree: '/w/t', home, tmp: '/tmp' });
  assert.match(ro, /\(deny network\*\)/); assert.match(ro, /localhost/);
  assert.match(ro, /\/h\/someone\/\.ssh/); assert.match(ro, /\/h\/someone\/\.config\/escadrille/);
  assert.match(ro, /\(deny file-write\*\)/); assert.ok(!ro.includes('/w/t'));
  assert.ok(mcp.sandboxProfile({ readOnly: false, worktree: '/w/t', home, tmp: '/tmp' }).includes('"/w/t"'));
  const b = mcp.wrap({ command: 'srv', args: ['a'], tool: '/usr/bin/bwrap', readOnly: true, worktree: '/w', home });
  assert.ok(b.args.includes('--unshare-net')); assert.deepEqual(b.args.slice(-3), ['--', 'srv', 'a']); assert.ok(!b.args.includes('/w'));
  assert.equal(mcp.wrap({ command: 'srv', tool: null }), null);
});

test('a simulated session launched with two chosen servers: exactly those, keys in the file, never in argv, erased at init, a log line', async () => {
  const { home, project, secretsFile } = fixture(); const wt = tmp('mcp-wt-');
  secrets.set(project, 'mcp.docs.DOCS_ROOT', KEY, secretsFile);
  const setting = { docs: { sessions: ['MCP'], readOnly: true }, sqlite: { sessions: 'all', readOnly: false }, gh: { sessions: 'all', readOnly: true }, notes: { sessions: ['OTHER'], readOnly: true } };
  const l = mcp.prepareLaunch({ project, planId: 'plan-1', sessionId: 'MCP', worktree: wt, setting, home, secretsFile, tool: '/usr/bin/sandbox-exec', tmp: '/tmp' });
  assert.deepEqual(l.servers.sort(), ['docs', 'sqlite']);
  assert.deepEqual(l.refused.map((r) => r.name), ['gh']);
  assert.equal(l.args[0], '--mcp-config'); assert.equal(l.args[2], '--strict-mcp-config');
  assert.equal(path.dirname(l.file), path.join(wt, '.calmdev'));
  assert.equal(statSync(l.file).mode & 0o777, 0o600);
  const cfg = JSON.parse(readFileSync(l.file, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(cfg).sort(), ['docs', 'sqlite']);
  assert.equal(cfg.docs.env.DOCS_ROOT, KEY); assert.equal(cfg.sqlite.env.DB_URL, 'file:dev.db');
  assert.equal(cfg.docs.command, '/usr/bin/sandbox-exec'); assert.deepEqual(cfg.docs.args.slice(-1), ['./bin/docs-mcp']);
  assert.ok(cfg.sqlite.args[1].includes(JSON.stringify(wt))); assert.ok(!cfg.docs.args[1].includes(JSON.stringify(wt)));
  assert.ok(!JSON.stringify(l.args).includes(KEY));
  assert.equal(l.logText.split('\n')[0], 'MCP pour MCP : docs, sqlite'); assert.match(l.logText, /écarté : gh demande le réseau/);
  assert.ok(!l.logText.includes(KEY));

  // A fake claude: reads --mcp-config, checks argv carries no key, says init; the launcher erases the file at init
  const bin = tmp('mcp-bin-'); const fake = path.join(bin, 'claude.cjs');
  writeFileSync(fake, `const a = process.argv.slice(2); const f = a[a.indexOf('--mcp-config') + 1];
const c = JSON.parse(require('fs').readFileSync(f, 'utf8'));
console.log(JSON.stringify({ type: 'system', subtype: 'init', strict: a.includes('--strict-mcp-config'), mcp_servers: Object.keys(c.mcpServers).map((name) => ({ name })), argv: a.join(' ') }));
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));`);
  const child = spawn(process.execPath, [fake, '-p', ...l.args], { stdio: ['pipe', 'pipe', 'inherit'] });
  const init = await new Promise((ok, ko) => { let buf = ''; child.stdout.on('data', (d) => { buf += d; const line = buf.split('\n')[0]; if (buf.includes('\n')) { const e = JSON.parse(line); l.cleanup(); ok(e); } }); child.on('error', ko); });
  child.stdin.end(); await new Promise((r) => child.on('exit', r)); l.cleanup();
  assert.equal(init.strict, true);
  assert.deepEqual(init.mcp_servers.map((s) => s.name).sort(), ['docs', 'sqlite']);
  assert.ok(!init.argv.includes(KEY));
  assert.equal(existsSync(l.file), false);

  // The pilot's log: one line, the names only
  const db = new DatabaseSync(':memory:'); pilotlog.schema(db);
  const row = pilotlog.record(db, { project, planId: 'plan-1', sessionId: 'MCP', kind: 'launch', text: l.logText });
  assert.equal(row.text, 'MCP pour MCP : docs, sqlite');
});

test('install: one entry in .mcp.json at the click, env as names, cookie required', () => {
  const project = tmp('mcp-inst-');
  assert.throws(() => mcp.install({ body: { project, name: 'x', command: './x' } }), (e) => e.status === 403);
  assert.throws(() => mcp.install({ body: { project, name: 'x', command: './x', args: ['--token=abc'] }, guardOk: true }), (e) => e.status === 400);
  assert.throws(() => mcp.install({ body: { project, name: 'x', command: './x', env: ['A=b'] }, guardOk: true }), (e) => e.status === 400);
  mcp.install({ body: { project, name: 'local', command: './bin/local-mcp', env: ['ROOT'] }, guardOk: true });
  const j = JSON.parse(readFileSync(path.join(project, '.mcp.json'), 'utf8'));
  assert.deepEqual(j.mcpServers.local, { command: './bin/local-mcp', args: [], env: { ROOT: '${ROOT}' } });
  assert.throws(() => mcp.install({ body: { project, name: 'local', command: './y' }, guardOk: true }), /existe déjà/);
});
