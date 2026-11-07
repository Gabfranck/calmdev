// The product's own name is never « another project » (7 November): the public export found 339 « project » traces,
// every one the word calmdev, because the developer's registry holds the product's own checkout (~/Dev/CalmDev).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as privacy from '../lib/privacy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('privacy.context: the product, under its old and new names, is no other project; a client project still is', () => {
  const ctx = privacy.context({ home: '', projects: ['/x/Dev/CalmDev', '/x/Dev/escadrille', '/x/Dev/ClientShop'] });
  assert.deepEqual(ctx.others, ['ClientShop']);
  assert.equal(privacy.redact('calmdev plans parallel sessions', ctx), 'calmdev plans parallel sessions');
  assert.equal(privacy.redact('a fix for ClientShop', ctx), 'a fix for <autre-projet>');
});

test('trace-scan: a registry holding the product checkout does not turn « calmdev » into a trace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-product-'));
  const reg = path.join(dir, 'projects.json');
  writeFileSync(reg, JSON.stringify({ projects: [{ path: '/x/Dev/CalmDev' }, { path: '/x/Dev/ClientShop' }] }));
  const code = "import('./scripts/trace-scan.mjs').then((m) => { const c = m.traceContext(process.cwd()); process.stdout.write(JSON.stringify(c.others)); })";
  const out = execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, CALMDEV_PROJECTS: reg, ESCADRILLE_PROJECTS: reg } }).toString();
  const others = JSON.parse(out);
  assert.ok(!others.some((n) => /calmdev/i.test(n)), out);
  assert.ok(others.includes('ClientShop'), out);
});
