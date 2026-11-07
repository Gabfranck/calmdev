import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prereview, parseDiff, parseRules, loadRules, globToRegex, addedDeps, tenWords } from '../lib/prereview.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/prereview/${n}`, import.meta.url), 'utf8');
const files = parseDiff(fx('sample.diff'));
const rules = fx('rules.md');
const byPath = (out, p) => out.files.find((f) => f.path === p);

test('parseDiff reads statuses, renames, binaries and line numbers', () => {
  const s = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(files.length, 12);
  assert.equal(s['src/app.js'].status, 'modified');
  assert.equal(s['src/app.js'].additions, 2);
  assert.equal(s['src/app.js'].deletions, 1);
  assert.equal(s['api/users.js'].status, 'added');
  assert.equal(s['docs/readme.md'].status, 'deleted');
  assert.equal(s['src/legacy.js'].status, 'renamed');
  assert.equal(s['src/legacy.js'].oldPath, 'src/old.js');
  assert.equal(s['logo.png'].binary, true);
  assert.equal(s['package-lock.json'].generated, true);
  const log = s['src/app.js'].hunks[0].lines.find((l) => l.text.includes('console.log'));
  assert.deepEqual([log.kind, log.new], ['add', 2]);
});

test('globs', () => {
  assert.ok(globToRegex('src/**').test('src/a/b.js'));
  assert.ok(!globToRegex('src/**').test('lib/src.js'));
  assert.ok(globToRegex('package.json').test('api/package.json'));
  assert.ok(globToRegex('src/*.js').test('src/a.js'));
  assert.ok(!globToRegex('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegex('**/auth/**').test('auth/x.js'));
  assert.ok(globToRegex('migrations/').test('migrations/1.sql'));
});

test('parseRules: patterns, plain bullets, broken patterns, checks', () => {
  const p = parseRules(rules);
  assert.equal(p.rules.length, 7);
  assert.deepEqual(p.rules.map((r) => r.kind), ['deny', 'immutable', 'requires-test', 'deps', null, null, null]);
  assert.equal(p.rules[0].text, 'Pas de console.log dans src/');
  assert.deepEqual(p.rules[0].args.globs, ['src/**']);
  assert.match(p.rules[5].error, /regex/);
  assert.match(p.rules[6].error, /inconnu/);
  assert.deepEqual(p.checks, [`node -e "console.log('ok')"`, 'node -e "process.exit(3)"']);
});

test('deny: added lines in scope, with the new line number', async () => {
  const out = await prereview({ files, rules, guarded: [] });
  const hits = out.rules.filter((r) => r.rule.startsWith('Pas de console.log'));
  assert.deepEqual(hits.map((h) => [h.path, h.line, h.level]), [['src/app.js', 2, 'error']]);
  assert.match(hits[0].text, /console\.log\('debug'/);
});

test('immutable: a modified migration is an error, a new one is not', async () => {
  const out = await prereview({ files, rules, guarded: [] });
  const hits = out.rules.filter((r) => r.rule.startsWith('Une migration'));
  assert.deepEqual(hits.map((h) => h.path), ['migrations/001_init.sql']);
});

test('requires-test: a new api file without a test, the one with a test passes, repoFiles counts', async () => {
  let out = await prereview({ files, rules, guarded: [] });
  let hits = out.rules.filter((r) => r.rule.startsWith('Tout nouveau'));
  assert.deepEqual(hits.map((h) => h.path), ['api/users.js']);
  out = await prereview({ files, rules, guarded: [], repoFiles: ['test/users.test.js'] });
  hits = out.rules.filter((r) => r.rule.startsWith('Tout nouveau'));
  assert.equal(hits.length, 0);
});

test('deps: a new dependency without decisions.md; a version bump or a script is not one', async () => {
  const pkg = files.find((f) => f.path === 'package.json');
  assert.deepEqual(addedDeps(pkg).map((d) => d.name), ['left-pad']);
  let out = await prereview({ files, rules, guarded: [] });
  const hits = out.rules.filter((r) => r.rule.startsWith('Pas de nouvelle'));
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /left-pad/);
  const withDecision = [...files, { path: 'docs/decisions.md', status: 'modified', patch: '@@ -1 +1,2 @@\n a\n+left-pad: oui' }];
  out = await prereview({ files: withDecision, rules, guarded: [] });
  assert.equal(out.rules.filter((r) => r.rule.startsWith('Pas de nouvelle')).length, 0);
});

test('rules without a pattern are warn "à vérifier par la revue"; broken patterns are not lost', async () => {
  const out = await prereview({ files, rules, guarded: [] });
  const warns = out.rules.filter((r) => r.level === 'warn');
  assert.deepEqual(warns.map((w) => w.text), ['à vérifier par la revue', 'motif illisible : regex illisible : ' + warns[1].text.split('regex illisible : ')[1], 'motif illisible : motif inconnu « forbid »']);
  assert.equal(warns[0].rule, 'Les noms de variables sont en anglais');
  assert.equal(warns[0].path, null);
});

test('risk: each heuristic gives its reason', async () => {
  const others = [{ session: 'B', files: ['src/legacy.js'] }];
  const out = await prereview({ files, rules: '', guarded: ['lib/auth/**'], others });
  const r = (p) => byPath(out, p);
  assert.equal(r('lib/auth/session.js').risk, 'high');
  assert.ok(r('lib/auth/session.js').reasons.includes('domaine sous garde (lib/auth/**)'));
  assert.ok(r('lib/auth/session.js').reasons.includes('auth ou sécurité'));
  assert.equal(r('migrations/002_add.sql').risk, 'high');
  assert.deepEqual(r('migrations/002_add.sql').reasons, ['migration']);
  assert.ok(r('package.json').reasons.includes('config ou dépendances'));
  assert.equal(r('package.json').risk, 'medium');
  assert.ok(r('docs/readme.md').reasons[0].startsWith('fichier supprimé'));
  assert.ok(r('src/legacy.js').reasons.includes('aussi modifié par la session B'));
  assert.ok(r('src/app.js').reasons.includes('code touché sans test à côté'));
  assert.ok(!r('api/posts.js').reasons.includes('code touché sans test à côté'));
  assert.deepEqual([r('package-lock.json').risk, r('package-lock.json').generated, r('package-lock.json').reasons], ['low', true, ['généré']]);
  assert.equal(r('logo.png').risk, 'low');
  const domain = await prereview({ rules: '', guarded: [], files: [
    { path: 'server/domains/q/controllers/list.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'server/domains/q/__tests__/sort.int.test.ts', status: 'added', additions: 40, deletions: 0 },
    { path: 'server/domains/z/controllers/other.ts', status: 'modified', additions: 3, deletions: 1 }] });
  assert.equal(byPath(domain, 'server/domains/q/controllers/list.ts').risk, 'low');
  assert.deepEqual(byPath(domain, 'server/domains/z/controllers/other.ts').reasons, ['code touché sans test à côté']);
  const big = await prereview({ files: [{ path: 'src/big.js', status: 'modified', additions: 10, deletions: 140 }], rules: '', guarded: [] });
  assert.ok(big.files[0].reasons.includes('140 lignes supprimées'));
});

test('a broken rule raises the file risk', async () => {
  const out = await prereview({ files, rules, guarded: [] });
  assert.equal(byPath(out, 'src/app.js').risk, 'high');
  assert.equal(byPath(out, 'src/app.js').why, 'règle enfreinte : Pas de console.log dans src/');
});

test('readFirst: at most 5, the riskiest, never generated; flag and why for R', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `migrations/00${i}.sql`, status: 'added', additions: i + 1, deletions: 0 }));
  const out = await prereview({ files: [...files, ...many], rules, guarded: ['lib/auth/**'] });
  assert.equal(out.readFirst.length, 5);
  assert.ok(out.readFirst.every((f) => f.why && byPath(out, f.path).risk === 'high'));
  assert.ok(!out.readFirst.some((f) => f.path === 'package-lock.json'));
  for (const f of out.files) {
    assert.equal(f.flag, out.readFirst.some((x) => x.path === f.path) || f.risk === 'high');
    assert.equal(f.why, f.reasons[0] != null ? tenWords(f.reasons[0]) : null); // ten words at most, the whole reason in reasons (session P)
  }
  const ranks = out.files.map((f) => ({ high: 0, medium: 1, low: 2 })[f.risk]);
  assert.deepEqual(ranks, [...ranks].sort());
});

test('summary: one line of ten words at most', async () => {
  const out = await prereview({ files, rules, guarded: [] });
  assert.ok(!out.summary.includes('\n'));
  assert.ok(out.summary.split(/\s+/).filter((w) => w !== '·').length <= 10, out.summary);
  assert.match(out.summary, /^12 fichiers \+\d+ −\d+ · 4 règles enfreintes · \d+ à risque$/);
});

test('checks run only with run: true, in the worktree, truncated, with a timeout', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'prereview-'));
  let out = await prereview({ repo, files, rules, guarded: [] });
  assert.deepEqual(out.checks, []);
  out = await prereview({ repo, files, rules, guarded: [], run: true });
  assert.deepEqual(out.checks.map((c) => [c.ok, c.output]), [[true, 'ok'], [false, '']]);
  const long = `## Vérifications\n- \`node -e "process.stdout.write('x'.repeat(9000))"\`\n- \`pwd\`\n- \`sleep 5\``;
  out = await prereview({ repo, files: [], rules: long, guarded: [], run: true, timeoutMs: 500 });
  assert.ok(out.checks[0].ok && out.checks[0].output.length <= 4001);
  assert.ok(out.checks[1].output.endsWith(path.basename(repo)));
  assert.equal(out.checks[2].ok, false);
  assert.match(out.checks[2].output, /délai/);
});

test('rules and guarded are read from repo when not passed; CLAUDE.md "Règles" section as fallback', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'prereview-'));
  writeFileSync(path.join(repo, 'CLAUDE.md'), '# P\n\nIntro\n\n## Règles\n\n- Pas de TODO {deny: TODO}\n- Sois clair\n\n## Autre\n\n- pas une règle\n');
  assert.match(loadRules(repo).text, /Pas de TODO/);
  assert.doesNotMatch(loadRules(repo).text, /pas une règle/);
  const f = [{ path: 'a.js', status: 'added', patch: '@@ -0,0 +1 @@\n+// TODO' }];
  let out = await prereview({ repo, base: 'main', head: 'x', files: f });
  assert.deepEqual(out.rules.map((r) => r.level), ['error', 'warn']);
  assert.deepEqual([out.base, out.head], ['main', 'x']);
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'docs', 'regles.md'), '- Rien de rien {deny: zzz}\n');
  out = await prereview({ repo, files: f });
  assert.deepEqual(out.rules, []);
});

test('claude option: entry point only, nothing launched', async () => {
  const out = await prereview({ files, rules, guarded: [], claude: true });
  assert.deepEqual(out.claude, { skipped: true, rules: ['Les noms de variables sont en anglais', 'Un motif cassé', 'Un mot inconnu'] });
  assert.equal((await prereview({ files, rules, guarded: [] })).claude, undefined);
});

test("Escadrille's own docs/regles.md parses and every pattern is readable", () => {
  const own = parseRules(readFileSync(new URL('../docs/regles.md', import.meta.url), 'utf8'));
  assert.ok(own.rules.length >= 8);
  assert.ok(own.rules.some((r) => r.kind));
  assert.ok(own.rules.every((r) => !r.error), own.rules.filter((r) => r.error).map((r) => r.error).join(', '));
  assert.ok(own.checks.includes('node --test test/*.test.mjs'));
});

test('an unsourced claim about a team\'s infra becomes « supposé »; a cited file clears it', async () => {
  const patch = (text) => ({ path: 'docs/equipe.md', status: 'added', additions: 3, deletions: 0,
    patch: `@@ -0,0 +1,3 @@\n+${text.join('\n+')}\n` });
  const out = await prereview({ files: [patch([
    "L'équipe déploie sur AWS avec Docker.",
    "L'équipe déploie avec Docker (voir `docker-compose.yml`).",
    'Le logo est bleu.',
  ])], rules: '', guarded: [] });
  const assumed = out.rules.filter((r) => r.assumed);
  assert.equal(assumed.length, 1);
  assert.equal(assumed[0].level, 'warn');
  assert.equal(assumed[0].line, 1);
  assert.match(assumed[0].text, /^supposé : /);
});
