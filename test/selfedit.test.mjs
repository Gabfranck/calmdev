// The install firewall (lib/selfedit.mjs): a clone of the official repository is locked, a fork, a checkout without
// origin, the maintainer file and ESCADRILLE_SELF_EDIT=1 are open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selfEdit, UPSTREAM } from '../lib/selfedit.mjs';

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
let gitOk = true; try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }
const repo = (url) => { const r = tmp('escadrille-selfedit-'); execFileSync('git', ['init', '-q'], { cwd: r }); if (url) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: r }); return r; };

test('the official repository is recognised in its usual spellings', () => {
  for (const u of ['https://github.com/Gabfranck/Escadrille', 'https://github.com/Gabfranck/Escadrille.git', 'git@github.com:Gabfranck/Escadrille.git', 'https://github.com/gabfranck/escadrille/']) assert.ok(UPSTREAM.test(u), u);
  for (const u of ['https://github.com/someone/Escadrille.git', 'https://github.com/Gabfranck/Escadrille-fork', '']) assert.ok(!UPSTREAM.test(u), u);
});

test('a plain install is locked; a fork, no origin, the maintainer file and the env are open', { skip: !gitOk && 'git cannot start here' }, () => {
  const guard = tmp('escadrille-selfedit-dir-'); const env = { ESCADRILLE_GUARD_DIR: guard };
  assert.deepEqual(selfEdit(repo('https://github.com/Gabfranck/Escadrille.git'), { env }), { allowed: false, why: 'install' });
  assert.equal(selfEdit(repo('git@github.com:someone/Escadrille.git'), { env }).why, 'fork');
  assert.equal(selfEdit(repo(null), { env }).why, 'no-origin');
  const official = repo('https://github.com/Gabfranck/Escadrille');
  assert.equal(selfEdit(official, { env: { ...env, ESCADRILLE_SELF_EDIT: '1' } }).allowed, true);
  writeFileSync(path.join(guard, 'maintainer'), '');
  assert.deepEqual(selfEdit(official, { env }), { allowed: true, why: 'maintainer' });
});
