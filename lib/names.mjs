// The technical names, in one place (docs/decisions.md, 5 November 22:30, then the MIG session of 6 November): the
// product is calmdev, the identifiers move from « escadrille » to « calmdev » with the old ones still read.
//
//   PROJECT_DIR, LEGACY_PROJECT_DIR        '.calmdev', '.escadrille': a project's private folder (handoffs, captures, memory)
//   projectDir(root, ...parts)             <root>/.calmdev/...
//   projectRel(...parts)                   '.calmdev/...', the same relative to a project (prompts, globs, allowed paths)
//   configDir(...parts) / configDirIn(home, ...parts)   ~/.config/calmdev/... (keys, secrets, projects.json)
//   homeDir(...parts)                      ~/.calmdev/... (or ~/.escadrille when only it exists; never moved: a browser profile lives there)
//   envVar(name, env)                      CALMDEV_<name>, else ESCADRILLE_<name>
//   vars / envVars(env)                    the same as an object: vars.DB reads CALMDEV_DB, else ESCADRILLE_DB
//   isOurVar(key)                          a CALMDEV_* or ESCADRILLE_* key (the ones a child environment drops)
//   bridgeEnv(env)                         copies each CALMDEV_X to ESCADRILLE_X, for the readers that only know the old name
//   migrateDir(old, new)                   moves a folder to its new name once, resumable, and leaves a link at the old path
//   ignoreBoth(root)                       .calmdev/ and the link .escadrille in .git/info/exclude (never .gitignore)
//   migrateAll({ home, projects })         the start of the server: ~/.config/escadrille, then each project and its worktrees
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const NAME = 'calmdev';
export const LEGACY_NAME = 'escadrille';
export const PROJECT_DIR = `.${NAME}`;
export const LEGACY_PROJECT_DIR = `.${LEGACY_NAME}`;
export const PREFIX = 'CALMDEV_';
export const LEGACY_PREFIX = 'ESCADRILLE_';

export const projectDir = (root, ...parts) => path.join(root, PROJECT_DIR, ...parts);
export const legacyProjectDir = (root, ...parts) => path.join(root, LEGACY_PROJECT_DIR, ...parts);
export const projectRel = (...parts) => path.posix.join(PROJECT_DIR, ...parts);

export const configDirIn = (home, ...parts) => path.join(home, '.config', NAME, ...parts);
export const legacyConfigDirIn = (home, ...parts) => path.join(home, '.config', LEGACY_NAME, ...parts);
export const configDir = (...parts) => configDirIn(homedir(), ...parts);
// For the texts shown to a developer: '~/.config/calmdev'
export const CONFIG_LABEL = `~/.config/${NAME}`;
export const LEGACY_CONFIG_LABEL = `~/.config/${LEGACY_NAME}`;

const lexists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
// The maintainers' signing key (scripts/license-issue.mjs): ~/.config/calmdev-licence, else the old one when only it
// exists; never moved by the server (a private key stays where its owner put it)
export const licenceDirIn = (home) => {
  const fresh = path.join(home, '.config', `${NAME}-licence`); const old = path.join(home, '.config', `${LEGACY_NAME}-licence`);
  return !existsSync(fresh) && existsSync(old) ? old : fresh;
};
export const homeDir =(...parts) => {
  const h = homedir(); const fresh = path.join(h, PROJECT_DIR); const old = path.join(h, LEGACY_PROJECT_DIR);
  return path.join(!existsSync(fresh) && existsSync(old) ? old : fresh, ...parts);
};

export const envVar = (name, env = process.env) => (env[PREFIX + name] !== undefined ? env[PREFIX + name] : env[LEGACY_PREFIX + name]);
export const envVars = (env = process.env) => new Proxy({}, {
  get: (_, k) => (typeof k === 'string' ? envVar(k, env) : undefined),
  has: (_, k) => typeof k === 'string' && envVar(k, env) !== undefined,
});
export const vars = envVars();
// Variables given to a child, under both names: { DB: x } → { CALMDEV_DB: x, ESCADRILLE_DB: x }
export const envPairs = (o) => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => [[PREFIX + k, v], [LEGACY_PREFIX + k, v]]));
export const isOurVar =(k) => k.startsWith(PREFIX) || k.startsWith(LEGACY_PREFIX);
export const bridgeEnv = (env = process.env) => {
  for (const k of Object.keys(env)) if (k.startsWith(PREFIX)) env[LEGACY_PREFIX + k.slice(PREFIX.length)] = env[k];
  return env;
};

// Moves src into dst, entry by entry, without losing any: what dst lacks is renamed into it, two folders merge, two
// equal files keep one, two different files keep both (the old one gets the suffix). src is emptied, then removed.
const CONFLICT = `.from-${LEGACY_NAME}`;
const freeName = (p) => { let c = p + CONFLICT; for (let i = 2; lexists(c); i++) c = `${p}${CONFLICT}-${i}`; return c; };
const sameFile = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
const mergeInto = (src, dst, out) => {
  for (const name of readdirSync(src)) {
    const s = path.join(src, name); const d = path.join(dst, name);
    const ls = lstatSync(s);
    if (!lexists(d)) { renameSync(s, d); out.moved++; continue; }
    const ld = lstatSync(d);
    if (ls.isDirectory() && ld.isDirectory()) { mergeInto(s, d, out); continue; }
    if (ls.isFile() && ld.isFile() && sameFile(s, d)) { unlinkSync(s); continue; }
    const kept = freeName(d); renameSync(s, kept); out.conflicts.push(kept);
  }
  rmdirSync(src);
};

// One folder to its new name, run at every start and resumable at any step:
//   old is a link            → done (a missing target is created back, empty)
//   old missing, new there   → a rename that stopped before the link: the link is made
//   old a folder, new absent → rename (atomic: the modes, 0600 keys included, stay), then the link
//   old a folder, new there  → a merge that stopped half-way (or an old writer that came back): merged, then the link
// The link is relative (.escadrille → .calmdev), so a moved home or project keeps it right.
export const migrateDir = (oldDir, newDir, { mode } = {}) => {
  const out = { state: 'none', moved: 0, conflicts: [] };
  const link = () => { symlinkSync(path.relative(path.dirname(oldDir), newDir) || '.', oldDir); };
  if (lexists(oldDir) && lstatSync(oldDir).isSymbolicLink()) {
    if (!existsSync(newDir)) { mkdirSync(newDir, { recursive: true, ...(mode ? { mode } : {}) }); out.state = 'recreated'; } else out.state = 'done';
    return out;
  }
  if (!lexists(oldDir)) {
    if (!lexists(newDir)) return out;
    link(); out.state = 'linked'; return out;
  }
  if (!lstatSync(oldDir).isDirectory()) { out.state = 'skipped'; return out; }
  if (!lexists(newDir)) { renameSync(oldDir, newDir); out.state = 'renamed'; }
  else { mergeInto(oldDir, newDir, out); out.state = 'merged'; }
  link();
  return out;
};

// .calmdev/ and .escadrille (no slash, for the link: git never takes a link for a folder, so `.escadrille/` alone would
// leave the link untracked and committable) in the project's .git/info/exclude: local, shared by its worktrees, never
// committed. The project's .gitignore is never touched: it is the team's file (Dev, 6 November: a client repository
// must not get a change, nor calmdev's name, from a migration).
const IGNORE = [`${PROJECT_DIR}/`, LEGACY_PROJECT_DIR];
export const ignoreBoth = (root) => {
  const git = path.join(root, '.git');
  if (!existsSync(git) || !lstatSync(git).isDirectory()) return { file: null, added: [] };
  const exclude = path.join(git, 'info', 'exclude');
  const have = existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n').map((l) => l.trim()) : [];
  const missing = IGNORE.filter((x) => !have.includes(x));
  if (missing.length) { mkdirSync(path.dirname(exclude), { recursive: true }); appendFileSync(exclude, (have.length && have[have.length - 1] !== '' ? '\n' : '') + missing.join('\n') + '\n'); }
  return { file: exclude, added: missing };
};

// The config folder: always there after the start (0700), with the old path as a link, so a reader that still names
// ~/.config/escadrille (lib/guardrails.mjs until Dev applies its patch) lands in the same folder.
export const migrateConfig = (home = homedir()) => {
  const r = migrateDir(legacyConfigDirIn(home), configDirIn(home), { mode: 0o700 });
  if (r.state === 'none') { mkdirSync(configDirIn(home), { recursive: true, mode: 0o700 }); migrateDir(legacyConfigDirIn(home), configDirIn(home)); r.state = 'created'; }
  try { chmodSync(configDirIn(home), 0o700); } catch {}
  return r;
};

// A project: its .escadrille/ (or nothing, for a project that never had one), and the .gitignore when something moved
export const migrateProject = (root) => {
  const r = migrateDir(legacyProjectDir(root), projectDir(root));
  if (r.state !== 'none') { try { r.ignore = ignoreBoth(root); } catch (e) { r.ignore = { error: e.message }; } }
  return r;
};

// The worktrees of a project (<root>/.claude/worktrees/*), where the sessions keep their handoffs
const worktreesOf = (root) => { const d = path.join(root, '.claude', 'worktrees'); try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };

export const migrateAll = ({ home = homedir(), projects = [], config = true, log = () => {} } = {}) => {
  const report = [];
  const one = (what, fn) => { try { const r = fn(); report.push({ what, ...r }); if (!['none', 'done'].includes(r.state)) log(`${what}: ${r.state}${r.conflicts?.length ? ` (${r.conflicts.length} kept with ${CONFLICT})` : ''}`); } catch (e) { report.push({ what, state: 'error', error: e.message }); log(`${what}: ${e.message}`); } };
  if (config) one(legacyConfigDirIn(home), () => migrateConfig(home));
  for (const root of new Set(projects.filter(Boolean))) {
    if (!existsSync(root)) continue;
    one(root, () => migrateProject(root));
    for (const wt of worktreesOf(root)) one(wt, () => migrateDir(legacyProjectDir(wt), projectDir(wt)));
  }
  return report;
};

// A fresh folder (a new worktree): .calmdev/ and the link .escadrille, for the sessions still told the old path
export const ensureProjectDir = (root) => {
  mkdirSync(projectDir(root), { recursive: true });
  return migrateDir(legacyProjectDir(root), projectDir(root));
};

export const readLink = (p) => { try { return readlinkSync(p); } catch { return null; } };
