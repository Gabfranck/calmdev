// What Escadrille and its sessions can read, write and reach, computed at the time of the request from the
// code and the settings (docs/access.md): never a fixed text. The server gives what only it knows (where it
// listens, the devices, the plans running); this module reads the rest (the Claude Code settings of the
// project and of the user, ~/.claude.json, .mcp.json) and never returns a secret: of an MCP server, only
// its name, its kind, its command or its host, and whether it carries a key.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SANDBOX_SETTINGS, SESSION_TOOLS, READ_ONLY_TOOLS, SECRET_NAME, KEEP_ENV, ADDED_ENV } from './planner.mjs';
import { ghPresent } from './github.mjs';
import * as secrets from './secrets.mjs';
import { msg } from './i18n.mjs';
import { entriesOf, missingFrom } from './domains.mjs';
import { validateAutonomy, summaryLine, NOTIFY_NAMES, DEFAULTS as AUTONOMY_DEFAULTS } from './autonomy.mjs';

const readJson = (f) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; } };
const tilde = (p, home, project) => { p = String(p); if (project && p.startsWith(project + '/')) return p.slice(project.length + 1); return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p; };
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

// The Claude Code settings files that apply to a session started in the project, in Claude Code's order
const settingsFiles = (project, home) => [
  { scope: 'utilisateur', file: path.join(home, '.claude', 'settings.json') },
  ...(project ? [{ scope: 'projet', file: path.join(project, '.claude', 'settings.json') }, { scope: 'local', file: path.join(project, '.claude', 'settings.local.json') }] : []),
];

// One MCP server, without its secrets: env, headers and args never leave this function
const mcpEntry = (name, c, source) => {
  c = c && typeof c === 'object' ? c : {};
  const type = c.type || (c.url ? 'http' : 'stdio');
  const secret = !!((c.env && Object.keys(c.env).length) || (c.headers && Object.keys(c.headers).length) || (Array.isArray(c.args) && c.args.some((a) => /(key|token|secret|password|bearer)/i.test(String(a)))));
  return { name, source, type, ...(c.url ? { host: hostOf(c.url) } : { command: path.basename(String(c.command || '')) || null }), secret };
};

// The connectors of Escadrille itself (docs/connectors.md): what each may do, where its access lives, whether it is
// ready. gh is looked for on the PATH (existsSync), never launched; of the Linear key, only whether one is stored.
// linearSync: the project's setting (on by default once a key is stored, lib/linearsync.mjs); with a key and the sync on,
// Linear is reached without a click, and the connector says so (sync: true).
export const connectorsOf = ({ project = null, env = process.env, secretsFile = secrets.fileOf(env), linearSync = true } = {}) => {
  const linearKey = !!project && secrets.has(project, 'linear', secretsFile);
  const sync = linearKey && linearSync !== false;
  return [
    { name: 'GitHub', kind: 'gh', scope: msg('srv.gh.scope'), where: msg('srv.gh.where'), ready: ghPresent(env), key: false },
    { name: 'Linear', kind: 'api', scope: msg(sync ? 'srv.lin.scopeSync' : 'srv.lin.scope'), where: msg('srv.lin.where'), ready: linearKey, key: linearKey, sync },
  ];
};
// The hosts the connectors reach, only when the developer clicks « Ouvrir la PR » (onClick: not open now)
const ON_CLICK = [
  { host: 'api.github.com', why: msg('srv.gh.why'), by: msg('srv.gh.by'), onClick: true },
  { host: 'api.linear.app', why: msg('srv.lin.why'), by: msg('srv.lin.by'), onClick: true },
];
// The same host when the sync is on: reached by the server itself at a session's launch, merge or PR merge (amber)
const LINEAR_SYNC_OUT = () => ({ host: 'api.linear.app', why: msg('srv.lin.whySync'), by: msg('srv.lin.by'), onClick: false });

// The plugins and MCP servers Claude Code will load in this project
export const extensionsOf = ({ project = null, home = homedir(), connectors = [] } = {}) => {
  const plugins = new Map();
  const files = settingsFiles(project, home).map((f) => ({ ...f, json: readJson(f.file) }));
  for (const f of files) for (const [id, on] of Object.entries(f.json?.enabledPlugins || {})) plugins.set(id, { id, enabled: on === true, source: tilde(f.file, home, project) });
  const mcp = [];
  const user = readJson(path.join(home, '.claude.json')) || {};
  for (const [n, c] of Object.entries(user.mcpServers || {})) mcp.push(mcpEntry(n, c, '~/.claude.json'));
  if (project) {
    for (const [n, c] of Object.entries(user.projects?.[project]?.mcpServers || {})) mcp.push(mcpEntry(n, c, `~/.claude.json (${path.basename(project)})`));
    const shared = readJson(path.join(project, '.mcp.json'));
    const pj = user.projects?.[project] || {};
    for (const [n, c] of Object.entries(shared?.mcpServers || {})) {
      const off = (pj.disabledMcpjsonServers || []).includes(n) || (Array.isArray(pj.enabledMcpjsonServers) && !pj.enabledMcpjsonServers.includes(n) && !pj.enableAllProjectMcpServers);
      mcp.push({ ...mcpEntry(n, c, '.mcp.json'), ...(off ? { enabled: false } : {}) });
    }
  }
  return { connectors, plugins: [...plugins.values()], mcp: mcp.map((m) => ({ enabled: true, ...m })), files: files.filter((f) => f.json).map((f) => tilde(f.file, home, project)) };
};

// The deny rules of the project's and the user's settings, Bash commands apart
export const denyRulesOf = ({ project = null, home = homedir() } = {}) => settingsFiles(project, home).flatMap((f) => {
  const deny = readJson(f.file)?.permissions?.deny; if (!Array.isArray(deny)) return [];
  return deny.map((rule) => ({ rule: String(rule), scope: f.scope, source: tilde(f.file, home, project) }));
});

// The environment variables a session does not get: those of this server's environment that match the pattern, by name only
export const strippedEnv = (env = process.env) => Object.keys(env).filter((k) => (SECRET_NAME.test(k) && !KEEP_ENV.test(k)) || k === 'CLAUDE_CODE_SIMPLE' || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)).sort();

// The whole report. server: { host, port, lan, address, devices: [{ name, created, push }], pushUrl };
// plans: the plans with a session running or waiting [{ id, title, network (announced only), addDirs }];
// settings: the project's ({ network: [{ host, scope }], addDirs }), the only list that opens the network
// outside: the commands asked outside the sandbox [{ plan, session, command, at, answer: 'allowed' | 'denied' | 'pending' }]
// connectors: the list of connectorsOf (computed from env and the secrets file when not given)
export const accessReport = ({ project = null, home = homedir(), env = process.env, server, plans = [], settings = {}, outside = [], connectors = connectorsOf({ project, env, linearSync: settings.linear?.sync }) }) => {
  const sb = SANDBOX_SETTINGS.sandbox;
  const denyRead = sb.filesystem.denyRead;
  const readRules = SANDBOX_SETTINGS.permissions.deny.filter((r) => /^Read\(/.test(r));
  const rules = denyRulesOf({ project, home });
  // The team relay (docs/team.md), declared here when the project has the setting: ready when the sharing is on
  const tm = settings.team && typeof settings.team === 'object' ? settings.team : null; const tmHost = tm && tm.relay ? hostOf(tm.relay) : null;
  if (tm && (tm.relay || tm.member || tm.token)) connectors = [...connectors, { name: 'Équipe (relais)', kind: 'relay', scope: msg('srv.team.scope'), where: msg('srv.team.where', { host: tmHost || '—' }), ready: !!tm.on, key: !!tm.token, host: tmHost, member: tm.member || null, on: !!tm.on }];
  const ext = extensionsOf({ project, home, connectors });
  // The project's one list of domains opens the network; a plan's `network` only announces (lib/domains.mjs)
  const netList = entriesOf(settings.network);
  const announced = plans.map((p) => ({ id: p.id, title: p.title || p.id, hosts: Array.isArray(p.network) ? p.network.map(String) : [], missing: missingFrom(netList, p.network) })).filter((p) => p.hosts.length);
  const addDirs = [...plans.flatMap((p) => (p.addDirs || []).map((d) => ({ dir: tilde(d, home), from: p.id }))), ...(settings.addDirs || []).map((d) => ({ dir: tilde(d, home), from: msg('srv.acc.projectSetting') }))];
  const pushOn = server.devices.some((d) => d.push);
  // What leaves the Mac: Expo's push service when a phone is paired, the domains of the plans running; nothing else
  const out = [];
  if (server.devices.length) out.push({ host: hostOf(server.pushUrl) || server.pushUrl, why: msg('srv.acc.phonePush'), by: msg('srv.acc.server') });
  if (tm && tm.on && tmHost) out.push({ host: tmHost, why: msg('srv.team.why'), by: msg('srv.team.by') });
  // The Linear sync (docs/connectors.md): with a key and the setting on, the server reaches Linear by itself
  const linearSyncOn = connectors.some((c) => c.name === 'Linear' && c.sync);
  if (linearSyncOn) out.push(LINEAR_SYNC_OUT());
  for (const e of netList) out.push({ host: e.host, why: msg('srv.acc.scope.' + e.scope), by: msg('srv.acc.projectSetting') });
  // The autonomy of the project (docs/autonomy.md), one line; amber once the mode is not Surveillé or the auto merge is on.
  // autoBurst is K's setting ({ on, minMarginPct, maxHoursLeft }), read as it is, never validated here
  const au = validateAutonomy(settings.autonomy).value || { ...AUTONOMY_DEFAULTS };
  const auMerge = au.autoMergeIfGreen && au.testCommand;
  const autonomy = { mode: au.mode, line: msg('srv.acc.autonomy', { line: [summaryLine(au), msg('srv.acc.notify', { what: NOTIFY_NAMES[au.notifyLevel] }), ...(Number.isInteger(settings.parallel) ? [msg('srv.acc.queue', { n: settings.parallel })] : [])].join(' · ') }), amber: au.mode !== 'surveille' || !!auMerge, burst: !!(settings.autoBurst && settings.autoBurst.on) };
  // The dev environment the project declared (docs/devenv.md): run by the server outside the sandbox on a session's ENV:
  // line; the page says « à régler » until it is set. Names only here: never a password, never an env value.
  const ev = settings.environment && typeof settings.environment === 'object' ? settings.environment : { set: false };
  const devenv = { set: !!ev.set, commands: Object.keys(ev.commands || {}), health: ev.health || [], lanHosts: ev.lanHosts || [], accounts: (ev.accounts || []).map((a) => a.name), tests: Object.keys(ev.tests || {}), envNames: Object.keys(ev.env || {}), outside: msg('srv.acc.envOutside') };
  const sessions = {
    autonomy, devenv,
    sandbox: { enabled: !!sb.enabled, failIfUnavailable: !!sb.failIfUnavailable, writes: msg('srv.acc.writes'), localBinding: !!sb.network.allowLocalBinding },
    unreadable: { denyRead, readRules, count: denyRead.length + readRules.length },
    env: { pattern: SECRET_NAME.source, kept: KEEP_ENV.source, stripped: strippedEnv(env), added: { ...ADDED_ENV } },
    tools: { planner: READ_ONLY_TOOLS, sessions: SESSION_TOOLS },
    denied: rules,
    network: { default: sb.network.allowedDomains, list: netList, announced },
    addDirs,
    outside: { allowed: outside.filter((o) => o.answer === 'allowed').length, denied: outside.filter((o) => o.answer === 'denied').length, pending: outside.filter((o) => o.answer === 'pending').length,
      plans: [...new Set(outside.map((o) => o.plan))].map((id) => ({ id, count: outside.filter((o) => o.plan === id).length })),
      list: outside.map((o) => ({ ...o, command: o.command.length > 120 ? o.command.slice(0, 119) + '…' : o.command })) },
  };
  return {
    at: new Date().toISOString(), project,
    server: { host: server.host, port: server.port, lan: !!server.lan, address: server.lan ? server.address : null, devices: server.devices.map((d) => ({ name: d.name, created: d.created, push: !!d.push })),
      push: { service: hostOf(server.pushUrl) || server.pushUrl, active: pushOn, tokens: server.devices.filter((d) => d.push).length, key: false } },
    sessions,
    extensions: ext,
    out: [...out, ...ON_CLICK.filter((h) => !(linearSyncOn && h.host === 'api.linear.app'))],
    closed: [
      ...(server.lan ? [] : [msg('srv.acc.c1')]),
      ...(netList.length ? [] : [msg('srv.acc.c2')]),
      ...[3, 4, 5, 6, 7].map((k) => msg('srv.acc.c' + k)),
      msg('srv.acc.c8'),
    ],
    summary: {
      server: msg(server.lan ? 'srv.acc.lan' : 'srv.acc.mac', { n: server.devices.length }),
      level: { server: server.lan ? 'amber' : 'green', sessions: !sb.enabled ? 'red' : autonomy.amber || autonomy.burst || outside.some((o) => o.answer === 'allowed') || netList.length || addDirs.length ? 'amber' : 'green', extensions: ext.mcp.some((m) => m.enabled) || ext.plugins.some((p) => p.enabled) ? 'amber' : 'green', out: out.length ? 'amber' : 'green' },
    },
  };
};
