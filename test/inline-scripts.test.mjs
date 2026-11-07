// Every inline <script> of public/*.html parses (7 November): a `//` comment pasted in the middle of a line of
// public/plan.html (d498e3f) swallowed the rest of the line, and the whole plan page died on « Unexpected token ',' ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('every inline script of every page parses', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inline-js-'));
  const bad = [];
  for (const f of readdirSync(PUB).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(path.join(PUB, f), 'utf8');
    let i = 0;
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      const attrs = m[1];
      if (/type="(application\/(ld\+)?json|importmap|text\/template)"/.test(attrs)) continue;
      const file = path.join(dir, `${f}.${i++}.${/type="module"/.test(attrs) ? 'mjs' : 'js'}`);
      writeFileSync(file, m[2]);
      try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (e) { bad.push(`${f} script ${i}: ${String(e.stderr).split('\n').slice(0, 4).join(' | ')}`); }
    }
  }
  assert.deepEqual(bad, []);
});
