// The rule that keeps the plans of a developer's other projects out of the repository (.gitignore).
// The install of the README on a clean clone (scripts/fresh-install.mjs) is the publication gate, not a test: it
// stays red while plans are tracked, so it does not run in this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setOrigin, installEnv, selfPlan, OFFICIAL, FORK } from '../scripts/fresh-install.mjs';
import { selfEdit } from '../lib/selfedit.mjs';
import { validatePlan } from '../lib/blocks.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-freshtest-')));

test('a plan of another project is invisible to git, the templates are not', () => {
  const repo = tmp();
  try {
    git(repo, 'init', '-q');
    copyFileSync(path.join(ROOT, '.gitignore'), path.join(repo, '.gitignore'));
    mkdirSync(path.join(repo, 'plans/templates'), { recursive: true });
    writeFileSync(path.join(repo, 'plans/2026-11-02-other-project.json'), JSON.stringify({ id: 'x', project: '/Users/someone/Dev/their-app' }));
    writeFileSync(path.join(repo, 'plans/templates/mine.json'), '{}');
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all');
    assert.ok(!/other-project/.test(status), status);
    assert.match(status, /plans\/templates\/mine\.json/);
    // Escadrille's own plans stay possible: forced in, they are tracked
    git(repo, 'add', '-f', 'plans/2026-11-02-other-project.json');
    assert.match(git(repo, 'status', '--porcelain'), /A\s+plans\/2026-11-02-other-project\.json/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// The firewall checks of the fresh install: the origin is only rewritten, and the firewall reads it as the script expects
test('setOrigin adds then rewrites origin, and the firewall follows it', () => {
  const repo = tmp(); const guard = tmp();
  const env = { ESCADRILLE_GUARD_DIR: guard }; // an empty guard dir: the developer's own maintainer file stays out
  try {
    git(repo, 'init', '-q');
    assert.deepEqual(selfEdit(repo, { env }), { allowed: true, why: 'no-origin' });
    setOrigin(repo, OFFICIAL);
    assert.equal(git(repo, 'remote', 'get-url', 'origin').trim(), OFFICIAL);
    assert.deepEqual(selfEdit(repo, { env }), { allowed: false, why: 'install' });
    setOrigin(repo, FORK);
    assert.equal(git(repo, 'remote', 'get-url', 'origin').trim(), FORK);
    assert.deepEqual(selfEdit(repo, { env }), { allowed: true, why: 'fork' });
    setOrigin(repo, OFFICIAL);
    writeFileSync(path.join(guard, 'maintainer'), '');
    assert.deepEqual(selfEdit(repo, { env }), { allowed: true, why: 'maintainer' });
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(guard, { recursive: true, force: true }); }
});

test('the install env drops the switches that would open the firewall or point at real folders', () => {
  const env = installEnv({ PATH: '/bin', ESCADRILLE_SELF_EDIT: '1', ESCADRILLE_GUARD_DIR: '/x', ESCADRILLE_PLANS: '/y', HOME: '/Users/me' }, { home: '/tmp/h', port: 4242 });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/tmp/h', PORT: '4242' });
});

test('the probe plan is a valid plan on the clone itself', () => {
  const { plan, errors } = validatePlan(selfPlan('/tmp/clone', 'firewall probe'), { project: '/tmp/clone' });
  assert.equal(errors, undefined, String(errors));
  assert.equal(plan.project, '/tmp/clone');
});
