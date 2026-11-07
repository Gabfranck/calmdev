// Every script of every page parses (2026-11-01: a « // i18n-ok » comment in the middle of a one-line function
// commented out its end, and the Review page died on « Unexpected end of input »).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
test('every inline script and every script file of public/ parses', () => {
  for (const f of fs.readdirSync(PUB)) {
    const p = path.join(PUB, f);
    if (f.endsWith('.js')) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(p, 'utf8'), { filename: f }), `${f} does not parse`);
    if (!f.endsWith('.html')) continue;
    const html = fs.readFileSync(p, 'utf8'); const re = /<script(?![^>]*src)([^>]*)>([\s\S]*?)<\/script>/g; let m; let i = 0;
    while ((m = re.exec(html))) {
      i++; if (/type="(application\/json|importmap|module)"/.test(m[1])) continue;
      assert.doesNotThrow(() => new vm.Script(m[2], { filename: `${f}#${i}` }), `${f}, inline script ${i}, does not parse`);
    }
  }
});
