// lib/names.mjs: the technical names (calmdev, else escadrille) and the migration of the folders at the server's start
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, readlinkSync, existsSync, readdirSync, realpathSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as names from '../lib/names.mjs';
import { testEnv } from './test-env.mjs';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'names-')));
const mode = (p) => statSync(p).mode & 0o777;
const isLink = (p) => lstatSync(p).isSymbolicLink();
const read = (p) => readFileSync(p, 'utf8');

test('a variable: CALMDEV_X first, else ESCADRILLE_X', () => {
  assert.equal(names.envVar('DB', { ESCADRILLE_DB: 'old' }), 'old');
  assert.equal(names.envVar('DB', { CALMDEV_DB: 'new' }), 'new');
  assert.equal(names.envVar('DB', { CALMDEV_DB: 'new', ESCADRILLE_DB: 'old' }), 'new');
  assert.equal(names.envVar('DB', {}), undefined);
  const v = names.envVars({ ESCADRILLE_GATE: 'off', CALMDEV_HOST: '0.0.0.0' });
  assert.equal(v.GATE, 'off'); assert.equal(v.HOST, '0.0.0.0'); assert.equal(v.NOPE, undefined);
  assert.ok(names.isOurVar('CALMDEV_DB') && names.isOurVar('ESCADRILLE_DB') && !names.isOurVar('PORT'));
  const env = { CALMDEV_GUARD_DIR: '/x', ESCADRILLE_GUARD_DIR: '/old' }; names.bridgeEnv(env);
  assert.equal(env.ESCADRILLE_GUARD_DIR, '/x', 'a reader of the old name sees the new value');
});

test('the paths come from one place', () => {
  assert.equal(names.projectDir('/p', 'passation.md'), '/p/.calmdev/passation.md');
  assert.equal(names.projectRel('captures'), '.calmdev/captures');
  assert.equal(names.configDirIn('/h', 'secrets.json'), '/h/.config/calmdev/secrets.json');
});

// A home with keys in ~/.config/escadrille, the way an Escadrille install left it
const oldHome = () => {
  const home = tmp(); const old = names.legacyConfigDirIn(home);
  mkdirSync(old, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(old, 'guard-key'), 'k'.repeat(64), { mode: 0o600 });
  writeFileSync(path.join(old, 'secrets.json'), '{"a":1}', { mode: 0o600 });
  writeFileSync(path.join(old, 'projects.json'), '{"projects":[]}');
  return home;
};

test('the old config alone: renamed, 0600 kept, a link at the old path, once', () => {
  const home = oldHome(); const neu = names.configDirIn(home); const old = names.legacyConfigDirIn(home);
  const r = names.migrateConfig(home);
  assert.equal(r.state, 'renamed');
  assert.equal(mode(path.join(neu, 'guard-key')), 0o600); assert.equal(mode(path.join(neu, 'secrets.json')), 0o600); assert.equal(mode(neu), 0o700);
  assert.ok(isLink(old)); assert.equal(readlinkSync(old), 'calmdev');
  assert.equal(read(path.join(old, 'secrets.json')), '{"a":1}', 'the old path still reads the same file');
  assert.equal(names.migrateConfig(home).state, 'done', 'the second start does nothing');
});

test('the new config alone: kept, the link made; a fresh home gets both', () => {
  const home = tmp(); mkdirSync(names.configDirIn(home), { recursive: true });
  writeFileSync(names.configDirIn(home, 'guard-key'), 'n', { mode: 0o600 });
  assert.equal(names.migrateConfig(home).state, 'linked');
  assert.equal(read(names.legacyConfigDirIn(home, 'guard-key')), 'n');
  const fresh = tmp(); assert.equal(names.migrateConfig(fresh).state, 'created');
  assert.equal(mode(names.configDirIn(fresh)), 0o700); assert.ok(isLink(names.legacyConfigDirIn(fresh)));
});

test('both configs: merged without a loss (equal files once, different files both kept)', () => {
  const home = oldHome(); const neu = names.configDirIn(home); const old = names.legacyConfigDirIn(home);
  mkdirSync(neu, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(neu, 'guard-key'), 'k'.repeat(64), { mode: 0o600 }); // the same
  writeFileSync(path.join(neu, 'secrets.json'), '{"b":2}', { mode: 0o600 }); // a different one
  const r = names.migrateConfig(home);
  assert.equal(r.state, 'merged');
  assert.deepEqual(readdirSync(neu).sort(), ['guard-key', 'projects.json', 'secrets.json', 'secrets.json.from-escadrille']);
  assert.equal(read(path.join(neu, 'secrets.json')), '{"b":2}'); assert.equal(read(path.join(neu, 'secrets.json.from-escadrille')), '{"a":1}');
  assert.equal(mode(path.join(neu, 'secrets.json.from-escadrille')), 0o600);
  assert.ok(isLink(old));
});

test('an interrupted migration resumes without a loss, at every step', () => {
  // 1. stopped after the rename, before the link
  const a = oldHome(); const aNew = names.configDirIn(a);
  names.migrateConfig(a); unlinkSync(names.legacyConfigDirIn(a));
  assert.ok(!existsSync(names.legacyConfigDirIn(a)));
  assert.equal(names.migrateConfig(a).state, 'linked'); assert.equal(read(path.join(aNew, 'secrets.json')), '{"a":1}');

  // 2. stopped half-way through a merge: some entries moved, a nested folder split in two, the old folder still there
  const b = tmp(); const bOld = names.legacyProjectDir(b); const bNew = names.projectDir(b);
  mkdirSync(path.join(bOld, 'captures', 's1'), { recursive: true }); mkdirSync(path.join(bNew, 'captures'), { recursive: true });
  writeFileSync(path.join(bOld, 'captures', 's1', 'a.png'), 'A'); writeFileSync(path.join(bOld, 'passation.md'), 'reste');
  writeFileSync(path.join(bNew, 'memoire.md'), 'déjà déplacée'); writeFileSync(path.join(bNew, 'captures', 'b.png'), 'B');
  writeFileSync(path.join(b, '.gitignore'), 'node_modules\n.escadrille/\n');
  const r = names.migrateProject(b);
  assert.equal(r.state, 'merged');
  assert.equal(read(path.join(bNew, 'passation.md')), 'reste'); assert.equal(read(path.join(bNew, 'memoire.md')), 'déjà déplacée');
  assert.equal(read(path.join(bNew, 'captures', 's1', 'a.png')), 'A'); assert.equal(read(path.join(bNew, 'captures', 'b.png')), 'B');
  assert.ok(isLink(bOld)); assert.equal(readlinkSync(bOld), '.calmdev');
  assert.equal(read(path.join(b, '.gitignore')), 'node_modules\n.escadrille/\n', 'the project’s .gitignore is never touched');

  // 3. stopped after the merge emptied the old folder, before its removal
  const c = tmp(); mkdirSync(names.legacyProjectDir(c)); mkdirSync(names.projectDir(c)); writeFileSync(names.projectDir(c, 'x'), 'x');
  assert.equal(names.migrateProject(c).state, 'merged'); assert.equal(read(names.legacyProjectDir(c, 'x')), 'x');

  // 4. the link there, its target gone: made again, empty
  const d = tmp(); mkdirSync(names.legacyProjectDir(d)); names.migrateProject(d); rmSync(names.projectDir(d), { recursive: true });
  assert.equal(names.migrateProject(d).state, 'recreated'); assert.ok(existsSync(names.projectDir(d)));
});

test('a project: renamed once, ignored by git (the link too), its worktrees with it', () => {
  const root = tmp();
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(path.join(root, '.gitignore'), '.escadrille/\n');
  mkdirSync(names.legacyProjectDir(root)); writeFileSync(names.legacyProjectDir(root, 'memoire.md'), 'm');
  const wt = path.join(root, '.claude', 'worktrees', 'p-A'); mkdirSync(names.legacyProjectDir(wt), { recursive: true }); writeFileSync(names.legacyProjectDir(wt, 'passation.md'), 'h');
  const home = tmp();
  const report = names.migrateAll({ home, projects: [root, root, path.join(root, 'gone')] });
  assert.deepEqual(report.map((x) => x.state), ['created', 'renamed', 'renamed']);
  assert.equal(read(names.projectDir(root, 'memoire.md')), 'm'); assert.equal(read(names.projectDir(wt, 'passation.md')), 'h');
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  assert.doesNotMatch(status, /escadrille|calmdev/, 'neither the folder nor the link shows in git status');
  assert.deepEqual(names.migrateAll({ home, projects: [root] }).map((x) => x.state), ['done', 'done', 'done']);

  assert.equal(read(path.join(root, '.gitignore')), '.escadrille/\n', 'the project’s .gitignore is never touched');
  assert.match(read(path.join(root, '.git', 'info', 'exclude')), /^\.calmdev\/$/m);
  // a project whose .gitignore does not name .escadrille: the same, in .git/info/exclude, never committed
  const other = tmp(); execFileSync('git', ['init', '-q', other]); mkdirSync(names.legacyProjectDir(other));
  names.migrateProject(other);
  assert.match(read(path.join(other, '.git', 'info', 'exclude')), /^\.calmdev\/$/m);
  assert.equal(execFileSync('git', ['-C', other, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('the server migrates at its start: the home config (0600 kept) and each known project', async () => {
  const home = oldHome(); const work = tmp();
  const project = path.join(work, 'proj'); mkdirSync(names.legacyProjectDir(project), { recursive: true });
  writeFileSync(names.legacyProjectDir(project, 'memoire.md'), 'gardée'); writeFileSync(path.join(project, '.gitignore'), '.escadrille/\n');
  const registry = path.join(work, 'projects.json'); writeFileSync(registry, JSON.stringify({ projects: [{ path: project, via: 'app' }] }));
  const PORT = freePort();
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), HOME: home, PORT: String(PORT),
    ESCADRILLE_DB: path.join(work, 'db.sqlite'), ESCADRILLE_PLANS: path.join(work, 'plans'), CALMDEV_PROJECTS: registry, ESCADRILLE_HOME: home,
    ESCADRILLE_TRANSCRIPTS: work, ESCADRILLE_SESSIONS: work, ESCADRILLE_CLAUDE_PROJECTS: work, ESCADRILLE_LEARNING: 'off', ESCADRILLE_GATE: 'off',
    ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_PILOT_WATCH: 'off', CALMDEV_MIGRATE: 'on' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 150 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /listening/, out);
    assert.ok(isLink(names.legacyConfigDirIn(home))); assert.equal(mode(names.configDirIn(home, 'secrets.json')), 0o600);
    assert.equal(read(names.projectDir(project, 'memoire.md')), 'gardée'); assert.ok(isLink(names.legacyProjectDir(project)));
    assert.equal(read(path.join(project, '.gitignore')), '.escadrille/\n', 'the project’s .gitignore is never touched');
  } finally { proc.kill('SIGKILL'); }
});
