// Phase 16 MCP (docs/mcp.md): the MCP servers of a project, which sessions get them, and what a launch passes.
// Reads ~/.claude.json and <project>/.mcp.json, never returns a value of env, header or a key-like argument.
// The server stores the `mcp` setting and mounts the routes; this module holds every rule.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { homedir, tmpdir as osTmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { SANDBOX_SETTINGS, SECRET_NAME } from './planner.mjs';
import * as secrets from './secrets.mjs';
import { which } from './terminal.mjs';
import { projectDir } from './names.mjs';

const readJson = (f) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; } };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const DEFAULT = Object.freeze({ sessions: 'none', readOnly: true });
const REMOTE_TYPES = new Set(['http', 'sse', 'ws', 'streamable-http']);
// Launchers that fetch a package or an image at start: the network, whatever the server does next
const FETCHERS = new Set(['npx', 'uvx', 'pipx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'docker', 'podman']);
// Names of services reached over the network
const SERVICES = /(github|gitlab|slack|linear|notion|sentry|jira|atlassian|figma|stripe|brave|fetch|puppeteer|playwright|browser|google|gdrive|aws|azure|vercel|supabase|firebase|openai|anthropic|discord|telegram|twitter|search|http)/i;
const KEY_ARG = /(key|token|secret|password|passwd|bearer|credential)/i;
const NAME = /^[\w.-]{1,64}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const say = {
  needs: (n) => `${n} demande le réseau : une session n'en a pas, il passera par un connecteur d'Escadrille.`,
  remote: (n) => `${n} est un serveur distant : une session n'ouvre aucun domaine.`,
  argKey: (n) => `${n} porte une clé en argument : mets-la dans son env.`,
  disabled: (n) => `${n} est désactivé dans Claude Code.`,
  noSandbox: (n) => `${n} ne peut pas être enfermé ici (ni sandbox-exec ni bwrap).`,
};

// The three cases (docs/mcp.md, « Les trois cas »): a guess; the wrapper holds the rule whatever the guess
export const classify = (name, c = {}) => {
  const type = String(c.type || (c.url ? 'http' : 'stdio'));
  if (REMOTE_TYPES.has(type) || c.url) return { type, network: 'remote', why: say.remote(name) };
  const args = Array.isArray(c.args) ? c.args.map(String) : [];
  if (args.some((a) => KEY_ARG.test(a))) return { type, network: 'needs', why: say.argKey(name) };
  const cmd = path.basename(String(c.command || ''));
  const env = Object.keys(c.env && typeof c.env === 'object' ? c.env : {});
  if (FETCHERS.has(cmd) || env.some((k) => SECRET_NAME.test(k)) || SERVICES.test(name) || args.some((a) => SERVICES.test(a))) return { type, network: 'needs', why: say.needs(name) };
  return { type, network: 'local', why: '' };
};

// The raw entries of every source, closest to the project last (it wins on a shared name). Internal: values inside.
const rawServers = ({ project, home = homedir() }) => {
  const out = new Map();
  const user = readJson(path.join(home, '.claude.json')) || {};
  const put = (n, c, source, extra = {}) => { if (c && typeof c === 'object') out.set(n, { name: n, config: c, source, ...extra }); };
  for (const [n, c] of Object.entries(user.mcpServers || {})) put(n, c, '~/.claude.json');
  if (project) {
    const pj = user.projects?.[project] || {};
    for (const [n, c] of Object.entries(pj.mcpServers || {})) put(n, c, '~/.claude.json (projet)');
    const shared = readJson(path.join(project, '.mcp.json'));
    for (const [n, c] of Object.entries(shared?.mcpServers || {})) {
      const off = (pj.disabledMcpjsonServers || []).includes(n) || (Array.isArray(pj.enabledMcpjsonServers) && !pj.enabledMcpjsonServers.includes(n) && !pj.enableAllProjectMcpServers);
      put(n, c, '.mcp.json', off ? { enabled: false } : {});
    }
  }
  return [...out.values()];
};

// The public view of one server: names only
const publicOf = (r, { project, setting, secretsFile }) => {
  const c = r.config; const k = classify(r.name, c); const enabled = r.enabled !== false;
  const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
  return {
    name: r.name, type: k.type, source: r.source, enabled, network: k.network,
    allowed: enabled && k.network === 'local', why: !enabled ? say.disabled(r.name) : k.why,
    command: c.url ? null : path.basename(String(c.command || '')) || null, host: c.url ? hostOf(c.url) : null,
    keys: Object.keys(c.env && typeof c.env === 'object' ? c.env : {}).map((v) => ({ name: v, stored: !!project && secrets.has(project, `mcp.${r.name}.${v}`, secretsFile) })),
    setting: settingOf(setting, r.name),
  };
};

// listServers: name, type, source, supposed network, the setting; never a value
export const listServers = ({ project = null, home = homedir(), setting = {}, secretsFile = secrets.fileOf() } = {}) =>
  rawServers({ project, home }).map((r) => publicOf(r, { project, setting, secretsFile }));

// The setting: { [name]: { sessions: 'none' | 'all' | [ids], readOnly } }; an absent name is DEFAULT
export const settingOf = (setting, name) => ({ ...DEFAULT, ...((setting && setting[name]) || {}) });
const validSessions = (s) => s === 'none' || s === 'all' || (Array.isArray(s) && s.length <= 200 && s.every((x) => typeof x === 'string' && /^[\w.-]{1,120}(\/[\w.-]{1,64})?$/.test(x)));
export const validateSetting = (value) => {
  if (value === null || value === undefined) return { value: {}, errors: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { value: null, errors: ['mcp : un objet { nom: { sessions, readOnly } }'] };
  const out = {}; const errors = [];
  for (const [n, v] of Object.entries(value)) {
    if (!NAME.test(n)) { errors.push(`${n} : nom de serveur invalide`); continue; }
    const s = { ...DEFAULT, ...(v || {}) };
    if (!validSessions(s.sessions)) errors.push(`${n} : sessions vaut 'none', 'all' ou une liste d'ids`);
    if (typeof s.readOnly !== 'boolean') errors.push(`${n} : readOnly est un booléen`);
    out[n] = { sessions: Array.isArray(s.sessions) ? [...new Set(s.sessions)] : s.sessions, readOnly: s.readOnly };
  }
  return { value: errors.length ? null : out, errors: errors.length ? errors : null };
};
const gets = (s, planId, sessionId) => s.sessions === 'all' || (Array.isArray(s.sessions) && (s.sessions.includes(sessionId) || s.sessions.includes(`${planId}/${sessionId}`)));

// The wrapper of a stdio server (docs/mcp.md, « Le point dur »)
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const expand = (p, home) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
export const sandboxTool = ({ platform = process.platform, exists = existsSync, lookup = (n) => which(n) } = {}) =>
  platform === 'darwin' ? (exists('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : null) : platform === 'linux' ? lookup('bwrap') || null : null;
const q = (s) => JSON.stringify(String(s));
export const sandboxProfile = ({ readOnly = true, worktree = null, home = homedir(), tmp = osTmpdir() } = {}) => {
  const deny = SANDBOX_SETTINGS.sandbox.filesystem.denyRead.map((p) => expand(p, home));
  const lines = ['(version 1)', '(allow default)', '(deny network*)', '(allow network* (remote ip "localhost:*"))', '(allow network* (local ip "localhost:*"))'];
  for (const d of deny) lines.push(`(deny file-read* (subpath ${q(d)}) (subpath ${q(real(d))}))`);
  const writable = [real(tmp), '/private/tmp', '/private/var/folders'];
  if (!readOnly && worktree) writable.push(real(worktree));
  lines.push('(deny file-write*)', `(allow file-write* ${writable.map((w) => `(subpath ${q(w)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))`);
  return lines.join('\n');
};
export const wrap = ({ command, args = [], tool, readOnly = true, worktree = null, home = homedir(), tmp = osTmpdir() }) => {
  if (!tool) return null;
  if (path.basename(tool) === 'sandbox-exec') return { command: tool, args: ['-p', sandboxProfile({ readOnly, worktree, home, tmp }), command, ...args] };
  const hide = SANDBOX_SETTINGS.sandbox.filesystem.denyRead.map((p) => expand(p, home)).filter((p) => existsSync(p)).flatMap((p) => ['--tmpfs', p]);
  return { command: tool, args: ['--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', ...hide, ...(!readOnly && worktree ? ['--bind', worktree, worktree] : []), '--', command, ...args] };
};

// The env of a server at launch: secrets.json first, else the source's literal; a ${VAR} without a stored value stays empty
const envOf = (project, name, env = {}, secretsFile) => Object.fromEntries(Object.entries(env).map(([k, v]) => {
  const stored = project ? secrets.get(project, `mcp.${name}.${k}`, secretsFile) : null;
  return [k, stored ?? (/^\$\{[^}]*\}$/.test(String(v)) ? '' : String(v ?? ''))];
}));

const EMPTY = JSON.stringify({ mcpServers: {} });
// prepareLaunch: what a session start passes to claude. Always --strict-mcp-config (no server of ~/.claude.json slips in);
// with servers, a 0600 file in <worktree>/.escadrille/, its keys read now, never in argv. cleanup() erases it (at init, and at exit).
export const prepareLaunch = ({ project, planId, sessionId, worktree, setting = {}, home = homedir(), secretsFile = secrets.fileOf(), tool = sandboxTool(), tmp = osTmpdir() } = {}) => {
  const given = []; const refused = [];
  for (const r of rawServers({ project, home })) {
    const s = settingOf(setting, r.name); if (!gets(s, planId, sessionId)) continue;
    const pub = publicOf(r, { project, setting, secretsFile });
    if (!pub.allowed) { refused.push({ name: r.name, why: pub.why }); continue; }
    const w = wrap({ command: String(r.config.command), args: (r.config.args || []).map(String), tool, readOnly: s.readOnly, worktree, home, tmp });
    if (!w) { refused.push({ name: r.name, why: say.noSandbox(r.name) }); continue; }
    given.push({ name: r.name, entry: { type: 'stdio', ...w, env: envOf(project, r.name, r.config.env, secretsFile) } });
  }
  given.sort((a, b) => a.name.localeCompare(b.name));
  const logText = given.length || refused.length ? [`MCP pour ${sessionId} : ${given.map((g) => g.name).join(', ') || 'aucun'}`, ...refused.map((r) => `écarté : ${r.why}`)].join('\n') : null;
  const names = given.map((g) => g.name);
  if (!given.length) return { args: ['--mcp-config', EMPTY, '--strict-mcp-config'], file: null, servers: names, refused, logText, cleanup: () => {} };
  const dir = projectDir(worktree); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mcp-${String(sessionId).replace(/[^\w.-]/g, '_')}-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: Object.fromEntries(given.map((g) => [g.name, g.entry])) }), { mode: 0o600 }); chmodSync(file, 0o600);
  return { args: ['--mcp-config', file, '--strict-mcp-config'], file, servers: names, refused, logText, cleanup: () => rmSync(file, { force: true }) };
};

// GET /api/mcp
export const view = ({ project, setting = {}, home = homedir(), secretsFile = secrets.fileOf(), platform = process.platform, tool } = {}) => {
  const t = tool === undefined ? sandboxTool({ platform }) : tool;
  return { project, sandbox: { ok: !!t, tool: t ? path.basename(t) : null, note: t ? '' : 'ni sandbox-exec ni bwrap : aucun serveur MCP ne sera passé' }, servers: listServers({ project, home, setting, secretsFile }) };
};

const guard = (ok, file) => { if (!ok) throw bad(`le cookie escadrille_guard du développeur est requis (lien dans ${file || '~/.config/escadrille/guard-link'})`, 403); };

// POST /api/mcp → { setting (to store), server }. guardOk: the server checked the escadrille_guard cookie.
export const update = ({ body = {}, guardOk = false, guardFile, setting = {}, home = homedir(), secretsFile = secrets.fileOf() } = {}) => {
  guard(guardOk, guardFile);
  const { project, name } = body;
  if (!project) throw bad('project manquant');
  const server = rawServers({ project, home }).find((r) => r.name === name); if (!server) throw bad(`serveur inconnu : ${name}`);
  const cur = settingOf(setting, name);
  const next = { sessions: body.sessions !== undefined ? body.sessions : cur.sessions, readOnly: body.readOnly !== undefined ? body.readOnly : cur.readOnly };
  const { value, errors } = validateSetting({ [name]: next }); if (errors) throw bad(errors.join(' ; '));
  if (body.keys !== undefined) {
    if (!body.keys || typeof body.keys !== 'object' || Array.isArray(body.keys)) throw bad('keys : un objet { VAR: valeur | null }');
    const known = Object.keys(server.config.env || {});
    for (const k of Object.keys(body.keys)) if (!known.includes(k)) throw bad(`${k} : variable absente de ${name}`);
    for (const [k, v] of Object.entries(body.keys)) { if (v === null) secrets.clear(project, `mcp.${name}.${k}`, secretsFile); else secrets.set(project, `mcp.${name}.${k}`, v, secretsFile); }
  }
  const out = { ...setting, ...value };
  if (out[name].sessions === 'none' && out[name].readOnly === true) delete out[name];
  return { setting: out, server: publicOf(server, { project, setting: out, secretsFile }) };
};

// POST /api/mcp/install: one entry in <project>/.mcp.json at the developer's click; env as names (${VAR}); never launched
export const install = ({ body = {}, guardOk = false, guardFile } = {}) => {
  guard(guardOk, guardFile);
  const { project, name, command } = body; const args = body.args ?? []; const env = body.env ?? [];
  if (!project || !existsSync(project)) throw bad('projet introuvable');
  if (!NAME.test(String(name || ''))) throw bad('nom de serveur invalide');
  if (typeof command !== 'string' || !command.trim() || /[\n\0]/.test(command)) throw bad('command : une chaîne');
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw bad('args : une liste de chaînes');
  if (args.some((a) => KEY_ARG.test(a))) throw bad(say.argKey(name));
  if (!Array.isArray(env) || !env.every((v) => typeof v === 'string' && VAR.test(v))) throw bad('env : une liste de noms de variables');
  const file = path.join(project, '.mcp.json'); const cur = readJson(file) || {};
  if (cur.mcpServers?.[name]) throw bad(`${name} existe déjà dans .mcp.json`);
  const entry = { command: command.trim(), args, ...(env.length ? { env: Object.fromEntries(env.map((v) => [v, '${' + v + '}'])) } : {}) };
  writeFileSync(file, JSON.stringify({ ...cur, mcpServers: { ...(cur.mcpServers || {}), [name]: entry } }, null, 2) + '\n');
  return { ok: true, file: '.mcp.json', name };
};
