// The registry of Escadrille's projects (phase 11, session S, docs/multiproject.md): the folders the developer
// gave to Escadrille, never every folder Claude Code has seen. One JSON file, ~/.config/escadrille/projects.json
// (ESCADRILLE_PROJECTS elsewhere, for the tests), written by install.sh (the folder it was launched from), by the
// picker (« Ajouter un projet ») and once by the migration (the projects that already have a plan or a conversation).
// « Retirer de la liste » only takes the line out of this file: nothing on disk, nothing in the base is touched.
//   { "version": 1, "migrated": "<iso>", "projects": [{ "path": "/abs", "added": "<iso>", "via": "install|app|migration", "name": "free display name, optional" }] }
// Also a command, for install.sh (no server needed):  node lib/projects.mjs add <folder> [--via install]
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar, configDirIn } from './names.mjs';

export const registryFile = (env = process.env) => envVar('PROJECTS', env) || configDirIn(homedir(), 'projects.json');

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// Never a project: a temporary folder, a session's worktree, a dependency, a scratch folder
export const ignored = (p) => /\/(scratchpad|\.taste-skill|node_modules)(\/|$)/.test(p) || /\/\.claude\/worktrees\/[^/]+\/?$/.test(p) || /^\/(private\/)?tmp(\/|$)/.test(p);

// « ~/Dev/x », « /a/b/ » → an absolute path without its trailing slash; '' when it cannot be one
export const normalize = (v, home = homedir()) => {
  let p = String(v ?? '').trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  if (!p || !path.isAbsolute(p)) return '';
  return path.resolve(p);
};

export const read = (file = registryFile()) => {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const projects = (Array.isArray(j.projects) ? j.projects : []).filter((x) => x && typeof x.path === 'string' && path.isAbsolute(x.path));
    return { version: 1, migrated: j.migrated || null, projects };
  } catch { return { version: 1, migrated: null, projects: [] }; }
};

// Atomic: a reader never sees half a file; the folder is the developer's only (0700)
export const write = (reg, file = registryFile()) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, migrated: reg.migrated || null, projects: reg.projects }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return reg;
};

const now = () => new Date().toISOString();

// Validated: absolute (or ~), an existing folder. Throws with a sentence the picker shows as it is.
export const validate = (v, { home } = {}) => {
  const p = normalize(v, home);
  if (!p) { const e = new Error('not-absolute'); e.status = 400; throw e; }
  if (!existsSync(p)) { const e = new Error('not-found'); e.status = 400; throw e; }
  if (!isDir(p)) { const e = new Error('not-a-folder'); e.status = 400; throw e; }
  return p;
};

// Adds a folder (idempotent: a folder already there keeps its date and its origin)
export const add = (v, { via = 'app', file = registryFile(), home } = {}) => {
  const p = validate(v, { home });
  const reg = read(file);
  if (reg.projects.some((x) => x.path === p)) return { path: p, added: false, projects: reg.projects };
  reg.projects.push({ path: p, added: now(), via });
  write(reg, file);
  return { path: p, added: true, projects: reg.projects };
};

// A display name: no control character, no edge space, 60 characters at most; '' when nothing is left (the folder's name shows)
export const cleanName = (v) => [...String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 60).join('').trim();

// The name shown for a registry entry: its free name when it has one, else the folder's last segment
export const displayName = (x) => cleanName(x && x.name) || path.basename((x && x.path) || '');

// Gives a registered project a display name, or takes it back with '' (the key stays the path; atomic write)
export const setName = (v, name, { file = registryFile(), home } = {}) => {
  const p = normalize(v, home);
  const reg = read(file);
  const x = reg.projects.find((y) => y.path === p);
  if (!x) { const e = new Error('unknown-project'); e.status = 404; throw e; }
  const n = cleanName(name);
  if (n) x.name = n; else delete x.name;
  write(reg, file);
  return { path: p, name: displayName(x), custom: !!n, projects: reg.projects };
};

// Takes a folder out of the list; nothing else
export const remove = (v, { file = registryFile(), home } = {}) => {
  const p = normalize(v, home);
  const reg = read(file);
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((x) => x.path !== p);
  if (reg.projects.length !== before) write(reg, file);
  return { path: p, removed: reg.projects.length !== before, projects: reg.projects };
};

// Once per registry: the projects that already have a plan or a conversation enter by themselves. Later removals
// stick (the flag is in the file, so the migration never runs again, even if install.sh wrote the file first).
export const migrate = (paths, { file = registryFile() } = {}) => {
  const reg = read(file);
  if (reg.migrated) return { migrated: false, projects: reg.projects };
  const have = new Set(reg.projects.map((x) => x.path));
  const at = now();
  for (const raw of paths || []) {
    const p = normalize(raw);
    if (!p || have.has(p) || ignored(p) || !isDir(p)) continue;
    have.add(p); reg.projects.push({ path: p, added: at, via: 'migration' });
  }
  reg.migrated = at;
  write(reg, file);
  return { migrated: true, projects: reg.projects };
};

// The registered folders that still exist (a moved folder is kept in the file, shown again once it is back)
export const list = (file = registryFile()) => read(file).projects.filter((x) => isDir(x.path));

// Suggestions for « Ajouter un projet »: the folders Claude Code worked in lately (~/.claude.json, the newest
// transcript of ~/.claude/projects/<folder>), not registered, not ignored, the most recent first
export const suggestions = ({ home = homedir(), file = registryFile(), max = 6 } = {}) => {
  let known = [];
  try { known = Object.keys(JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')).projects || {}); } catch {}
  const have = new Set(read(file).projects.map((x) => x.path));
  const lastUsed = (p) => { try { const d = path.join(home, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-')); return Math.max(0, ...readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => statSync(path.join(d, f)).mtimeMs)); } catch { return 0; } };
  return [...new Set(known.map((p) => normalize(p)).filter(Boolean))]
    .filter((p) => !have.has(p) && !ignored(p) && p !== home && isDir(p))
    .map((p) => ({ path: p, at: lastUsed(p) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map(({ path: p, at }) => ({ path: p, name: path.basename(p), at: at ? new Date(at).toISOString() : null }));
};

// The folders under a typed prefix (« ~/Dev/es » → ~/Dev/escadrille, ~/Dev/essai), for the path field; no hidden ones
export const completions = (prefix, { home = homedir(), max = 8 } = {}) => {
  const raw = String(prefix ?? '');
  const p = normalize(raw, home); if (!p) return [];
  const dir = raw.endsWith('/') ? p : path.dirname(p);
  const start = raw.endsWith('/') ? '' : path.basename(p).toLowerCase();
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => (d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(dir, d.name)))) && !d.name.startsWith('.') && d.name.toLowerCase().startsWith(start)).map((d) => d.name); } catch { return []; }
  return names.sort((a, b) => a.localeCompare(b)).slice(0, max).map((n) => path.join(dir, n));
};

// The command, for install.sh: node lib/projects.mjs add <folder> [--via install]
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, folder, ...rest] = process.argv.slice(2);
  const via = rest[rest.indexOf('--via') + 1] && rest.includes('--via') ? rest[rest.indexOf('--via') + 1] : 'install';
  if (cmd !== 'add' || !folder) { console.error('usage: node lib/projects.mjs add <folder> [--via install]'); process.exit(2); }
  try {
    const r = add(folder, { via });
    console.log(r.added ? `added ${r.path} to Escadrille's projects` : `${r.path} is already one of Escadrille's projects`);
  } catch (e) { console.error(`not added: ${folder} (${e.message})`); process.exit(1); }
}
