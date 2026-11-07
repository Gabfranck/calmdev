// The phone's two dictionaries (phone/src/locales): same keys, same placeholders, no key used in the code that is missing,
// no key left unused, and no French left in the source outside the dictionary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../phone/', import.meta.url).pathname;
const en = JSON.parse(fs.readFileSync(root + 'src/locales/en.json', 'utf8'));
const fr = JSON.parse(fs.readFileSync(root + 'src/locales/fr.json', 'utf8'));

const sources = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  if (e.name === 'node_modules' || e.name === 'locales' || e.name === 'dev' || e.name.startsWith('.')) continue;
  const f = path.join(dir, e.name);
  if (e.isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(e.name)) sources.push([f, fs.readFileSync(f, 'utf8')]);
} };
walk(root);
const code = sources.map(([, s]) => s).join('\n');

test('en.json and fr.json have the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
});

test('each key has the same {placeholders} in both languages and no empty text', () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of Object.keys(en)) {
    assert.ok(en[k].trim() && fr[k].trim(), `${k} is empty`);
    assert.equal(ph(en[k]), ph(fr[k]), `${k}: placeholders differ`);
  }
});

test('plural keys come as _one and _other pairs', () => {
  for (const d of [en, fr]) for (const k of Object.keys(d)) {
    if (k.endsWith('_one')) assert.ok(d[k.replace(/_one$/, '_other')], `${k} has no _other`);
    if (k.endsWith('_other')) assert.ok(d[k.replace(/_other$/, '_one')], `${k} has no _one`);
  }
});

test('every key used by the code exists, and every key is used', () => {
  // a key is any quoted dotted word the code mentions (t('a.b'), or 'a.b' in a ternary handed to t())
  const used = new Set([...code.matchAll(/'([A-Za-z]+\.\w+)'/g)].map((m) => m[1]));
  const called = [...code.matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]);
  for (const k of called) assert.ok(k in en || `${k}_other` in en, `${k} is used but missing`);
  // keys built at run time: tool.<Name>, status.<s>, health.<h>
  const dynamic = /^(tool|status|health)\./;
  for (const k of Object.keys(en)) {
    const base = k.replace(/_(one|other)$/, '');
    assert.ok(used.has(base) || dynamic.test(base), `${k} is never used`);
  }
});

test('no French left in the source: every visible text goes through t()', () => {
  const accents = /[àâçéèêëîïôùûœÀÉ]/;
  for (const [f, s] of sources) {
    const lines = s.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\/\/.*$/, ''));
    lines.forEach((l, i) => assert.ok(!accents.test(l), `${path.relative(root, f)}: accented text outside the dictionary: ${l.trim()}`));
  }
});

test('JSX text and string props are not left bare', () => {
  for (const [f, s] of sources.filter(([f]) => f.endsWith('.tsx'))) {
    const bare = [...s.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}[^<>{}\n]*)<\/Text>/g)].map((m) => m[1].trim()).filter((x) => x !== 'Escadrille'); // the name is not translated
    assert.deepEqual(bare, [], `${path.relative(root, f)}: bare text in <Text>`);
    const props = [...s.matchAll(/\b(?:label|placeholder|accessibilityLabel)="([^"]*[A-Za-z]{3,}[^"]*)"/g)].map((m) => m[1]).filter((x) => !/^https?:/.test(x)); // addresses and digits are not words
    assert.deepEqual(props, [], `${path.relative(root, f)}: bare string props`);
  }
});
