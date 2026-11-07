// No personal trace in a tracked file (publication on 10 November): scripts/trace-scan.mjs over the whole repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTracked, scanLine, traceContext, EXEMPT } from '../scripts/trace-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no tracked file carries a personal trace', () => {
  const found = scanTracked({ root: ROOT, exempt: EXEMPT });
  assert.deepEqual(found, [], found.map((f) => `${f.file}:${f.line} ${f.kind} ${f.sample}`).join('\n'));
});

test('reserved names (RFC 2606, RFC 6761) are no trace; a real-looking address still is', () => {
  const ctx = traceContext(ROOT);
  for (const l of ["const to = 'lea@example.test';", "fetch('https://u:p@x.example/')", 'a@b.localhost, x@y.invalid, z@example.net, w@example.org.', 'dev@example.com'])
    assert.deepEqual(scanLine(l, ctx, ''), [], l);
  const real = ['someone', 'mailbox.fr'].join('@'); // assembled, or this file would carry it
  assert.notDeepEqual(scanLine(`write to ${real}`, ctx, ''), []);
  assert.notDeepEqual(scanLine(`write to ${['w', 'example.com.mailbox.fr'].join('@')}`, ctx, ''), []);
});

test('a retina image name and the one-letter fake home are no trace; a real home and e-mail next to them still are', () => {
  const ctx = traceContext(ROOT);
  const x = ['', 'Users', 'x'].join('/');
  for (const l of ['"icons/128x128@2x.png",', `const ROOT = '${x}/Dev/proj';`, `app('${x}/other', 8)`])
    assert.deepEqual(scanLine(l, ctx, ''), [], l);
  const real = ['', 'Users', 'xavier'].join('/'); // assembled, or this file would carry it
  assert.deepEqual(scanLine(`cd ${real}/Dev`, ctx, '').map((f) => f.kind), ['home']);
  assert.deepEqual(scanLine(`${x}/a and ${['someone', 'mailbox.fr'].join('@')}`, ctx, '').map((f) => f.kind), ['email']);
  assert.deepEqual(scanLine(`logo@2x.png.${['me', 'mailbox.fr'].join('@')}`, ctx, '').length > 0, true);
});

test('a trace planted in a throwaway repository is seen; the allowlist and binaries are not reported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-scan-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  const home = ['', 'Users', 'someone'].join('/'); // assembled, or this very file would be a trace
  const lan = ['192.168.1', '7'].join('.');
  writeFileSync(path.join(dir, 'notes.md'), `# Notes\nOrchard stays, github.com/Gabfranck/Escadrille too.\nThe project lives in ${home}/Dev/app.\nOpen http://${lan}:3078 on the phone.\n`);
  writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${home}/x`)]));
  git('add', '.');
  const found = scanTracked({ root: dir });
  assert.deepEqual(found.map((f) => [f.file, f.line, f.kind]), [['notes.md', 3, 'home'], ['notes.md', 4, 'lan']]);
  assert.deepEqual(scanTracked({ root: dir, exempt: ['notes.md'] }), []);
});
