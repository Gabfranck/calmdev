// `npx github:Gabfranck/calmdev`: the package lists what the product reads at run time and nothing private,
// and `calmdev --check` works from an empty folder. No network, nothing published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_CLI = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const packed = () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'calmdev-npm-'));
  const out = execFileSync(process.execPath, [NPM_CLI, 'pack', '--dry-run', '--json', '--offline', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
  return JSON.parse(out)[0].files.map((f) => f.path);
};

// every file reachable from server.mjs by a static or dynamic relative import
const importGraph = () => {
  const seen = new Set(); const todo = ['server.mjs'];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (existsSync(path.join(ROOT, rel)) && statSync(path.join(ROOT, rel)).isFile()) todo.push(rel);
    }
  }
  return [...seen];
};

test('package.json: name, no dependency, node 22.13, bin, private', () => {
  assert.equal(pkg.name, 'calmdev');
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.engines.node, '>=22.13');
  assert.deepEqual(pkg.bin, { calmdev: 'bin/calmdev.mjs' });
  assert.equal(pkg.private, true);
});

test('npm pack --dry-run: no private file, every import of server.mjs, what the product reads', { skip: !existsSync(NPM_CLI) && 'npm of this Node not found' }, () => {
  const files = packed();
  const bad = files.filter((f) => /^(comm|payments|\.escadrille|\.calmdev|site|phone|desktop|launch|test)\//.test(f) || (/^plans\//.test(f) && !/^plans\/templates\//.test(f)) || /sessions\.sqlite|(^|\/)\.env/.test(f) || f === 'team/relay/admin.mjs');
  assert.deepEqual(bad, [], 'private files in the package');
  const missing = importGraph().filter((f) => !files.includes(f));
  assert.deepEqual(missing, [], 'imported by server.mjs but not in the package');
  for (const f of ['server.mjs', 'install.sh', 'run.sh', 'bin/calmdev.mjs', 'scripts/open-app.sh', 'scripts/policy-hook.mjs', '.claude/skills/plan/SKILL.md', 'catalog/capabilities.json', 'public/index.html', 'LICENSE', 'team/LICENSE', 'package.json'])
    assert.ok(files.includes(f), f + ' missing from the package');
  assert.ok(files.some((f) => f.startsWith('plans/templates/')), 'plan templates missing');
});

test('calmdev --check from an empty folder: exit 0, or says what is missing; data folder under ~/.config/calmdev', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'calmdev-empty-')); const home = mkdtempSync(path.join(tmpdir(), 'calmdev-home-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'calmdev.mjs'), '--check'], { cwd: empty, encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 60000 });
  const out = r.stdout + r.stderr;
  assert.match(out, /calmdev: checking what it needs/);
  if (r.status === 0) assert.match(out, /All set/);
  else { assert.equal(r.status, 1, out); assert.match(out, /FAIL {2}\S/, 'a failure must name what is missing'); }
  assert.ok(existsSync(path.join(home, '.config', 'calmdev', 'plans')), 'plans folder not created');
});
