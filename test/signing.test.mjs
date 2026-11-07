// « Avant de signer » (docs/apprendre-en-signant.md): the leads of the pre-review, in domain, outside, none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prereview, parseDiff } from '../lib/prereview.mjs';
import { buildPistes, readProfile, writeProfile } from '../lib/signing.mjs';

const diff = `diff --git a/api/signup.ts b/api/signup.ts
index 1111111..2222222 100644
--- a/api/signup.ts
+++ b/api/signup.ts
@@ -40,3 +40,6 @@ export const signup = async (req) => {
   const user = await create(req.body);
   const id = user.id;
+  log.info({ email: user.email });
+  const q = "SELECT * FROM users WHERE id = " + id;
+  const url = process.env.SIGNUP_HOOK;
   return user;
 };
diff --git a/test/signup.test.ts b/test/signup.test.ts
new file mode 100644
--- /dev/null
+++ b/test/signup.test.ts
@@ -0,0 +1,2 @@
+import { signup } from '../api/signup';
+test('signup', () => {});
`;
const plain = `diff --git a/src/button.css b/src/button.css
index 1111111..2222222 100644
--- a/src/button.css
+++ b/src/button.css
@@ -1,2 +1,2 @@
-.btn { color: red; }
+.btn { color: blue; }
 .x {}
`;
const files = parseDiff(diff);
const run = (profile, extra = {}) => prereview({ files, rules: '', guarded: [], profile, ...extra });

test('detectors find the PII log, the SQL concatenation and the env var, each with its file and line', async () => {
  const r = await run({ domains: null, known: [] });
  const by = (d) => r.pistes.find((p) => p.detector === d);
  assert.deepEqual([by('pii-log').path, by('pii-log').line, by('pii-log').kind], ['api/signup.ts', 42, 'fragile']);
  assert.equal(by('sql-concat').line, 43);
  assert.equal(by('env-var').kind, 'learn');
  assert.ok(by('tests-added'), 'a test next to the code is a reliable lead');
  // fragile first, three open at most, the rest in one line
  assert.equal(r.pistes[0].kind, 'fragile');
  assert.ok(r.pistes.filter((p) => p.open).length <= 3);
  assert.ok(r.counts.foldedReliable >= 1);
  assert.equal(r.counts.fragile, 2);
  // never declared: nothing outside, the declaration line is asked once
  assert.ok(r.pistes.every((p) => !p.outside));
  assert.ok(r.declare && r.declare.recommended.includes('back'));
});

test('in domain: nothing to have validated, the in-domain learn lead stays folded', async () => {
  const r = await run({ domains: ['front', 'back', 'data', 'infra', 'security', 'legal'], known: [] });
  assert.equal(r.asks.length, 0);
  assert.deepEqual(r.counts.outside, []);
  assert.equal(r.declare, null);
  assert.equal(r.pistes.find((p) => p.detector === 'env-var').open, false);
});

test('outside the domain: marked, and the question to a peer cites file, line and the diff', async () => {
  const r = await run({ domains: ['front', 'back'], known: [] }, { branch: 'feat/signup' });
  const pii = r.pistes.find((p) => p.detector === 'pii-log');
  assert.equal(pii.outside, true);
  assert.deepEqual(r.counts.outside, ['security', 'infra']);
  const sec = r.asks.find((a) => a.to === 'security');
  assert.match(sec.question, /^Question sécurité sur `feat\/signup`/);
  assert.match(sec.question, /`api\/signup\.ts:42`/);
  assert.match(sec.question, /log\.info\(\{ email: user\.email \}\)/);
  assert.ok(sec.evidence.length >= 3 && sec.evidence.length <= 10);
  assert.ok(sec.evidence.some((e) => e.line === 42));
});

test('« je connais » folds a lead without removing a fragile one', async () => {
  const r = await run({ domains: ['front', 'back', 'security'], known: ['pii-log'] });
  const pii = r.pistes.find((p) => p.detector === 'pii-log');
  assert.equal(pii.known, true);
  assert.equal(pii.open, false);
  assert.equal(r.counts.fragile, 2, 'still counted');
});

test('no lead: a plain style change gives an empty block', async () => {
  const r = await prereview({ files: parseDiff(plain), rules: '', guarded: [], profile: { domains: null, known: [] } });
  assert.deepEqual(r.pistes, []);
  assert.deepEqual(r.counts, { open: 0, folded: 0, foldedReliable: 0, fragile: 0, outside: [] });
  assert.equal(r.declare, null);
});

test('the one-line texts are in i18n, both languages, never written in the page, the Accès script or the lead summary', () => {
  const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const en = JSON.parse(read('public/i18n/en.json')), fr = JSON.parse(read('public/i18n/fr.json'));
  const keys = ['sign.validate', 'sign.outside', 'sign.barFragile', 'sign.barOutside', 'sign.rest', 'sign.restOther', 'sign.restReliable',
    ...['front', 'back', 'data', 'infra', 'security', 'legal'].map((d) => 'sign.domain.' + d)];
  for (const k of keys) { assert.ok(k in en, `en: ${k}`); assert.ok(k in fr, `fr: ${k}`); }
  assert.equal(en['sign.validate'], 'needs sign-off');
  assert.equal(en['sign.outside'], 'Sign-off needed: {list}');
  const hard = /à faire valider|pas fiable|autres? pistes?|Sécurité|Juridique|Données|needs? sign-off|not reliable|Sign-off needed/;
  for (const p of ['public/review.html', 'public/access.js']) {
    const code = read(p).split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, hard, `${p} writes a sign text instead of T()`);
  }
  // the pre-review gives numbers and domain keys, never these sentences
  const r = buildPistes({ files, profile: { domains: ['front'], known: [] } });
  assert.doesNotMatch(JSON.stringify({ ...r, pistes: [], asks: [] }), hard);
});

test('the session assumptions become learn leads, said by the session', () => {
  const r = buildPistes({ files: [], assume: ['supposé : l\'API amont renvoie toujours un tableau', 'b', 'c', 'd'] });
  assert.equal(r.pistes.length, 3);
  assert.equal(r.pistes[0].source, 'session');
  assert.match(r.pistes[0].title, /^Supposé par la session : l'API amont/);
});

test('the profile keeps the declared domains and the known detectors', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'signing-')), 'signing.json');
  assert.deepEqual(readProfile(file), { domains: null, known: [] });
  writeProfile({ domains: ['front', 'nope', 'back'] }, file);
  writeProfile({ know: 'pii-log' }, file);
  assert.deepEqual(readProfile(file), { domains: ['front', 'back'], known: ['pii-log'] });
  writeProfile({ unknow: 'pii-log' }, file);
  assert.deepEqual(readProfile(file).known, []);
});
