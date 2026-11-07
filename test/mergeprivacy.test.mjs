// The merge net (lib/mergeprivacy.mjs): a branch adding a private trace is refused, passes once corrected, a clean one
// passes fast. A temporary repository; the home folder of the check is a fictitious one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkBranch, reason } from '../lib/mergeprivacy.mjs';
import { context } from '../lib/privacy.mjs';

const HOME = '/Users/jdupont-factice';
const ctx = context({ home: HOME });
const repo = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mergeprivacy-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(root, 'lib')); mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'lib/a.mjs'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-q', '-m', 'base');
  return { root, git, done: () => rmSync(root, { recursive: true, force: true }) };
};
const commit = (r, file, text, msg) => { writeFileSync(path.join(r.root, file), text); r.git('add', '.'); r.git('commit', '-q', '-m', msg); };

test('a branch adding a personal path is refused, then passes once corrected', (t) => {
  const r = repo(); t.after(r.done);
  r.git('checkout', '-q', '-b', 'session');
  commit(r, 'lib/a.mjs', `export const a = 1;\nexport const cfg = '${HOME}/Dev/secret-projet/config.json';\n`, 'leak');
  const bad = checkBranch({ root: r.root, base: 'main', branch: 'session', ctx });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.findings, [{ file: 'lib/a.mjs', line: 2, kind: 'home' }]);
  const why = reason(bad.findings);
  assert.match(why, /lib\/a\.mjs:2 \(home\)/);
  assert.ok(!why.includes('jdupont') && !why.includes('secret-projet'), 'the value found never appears');
  console.log('refus :', why);

  commit(r, 'lib/a.mjs', "export const a = 1;\nexport const cfg = process.env.CFG;\n", 'fix');
  const good = checkBranch({ root: r.root, base: 'main', branch: 'session', ctx });
  assert.deepEqual(good, { ok: true, findings: [] });
  console.log('après correction : passe');
});

test('a clean branch passes without notable delay; decisions and backlog are excluded', (t) => {
  const r = repo(); t.after(r.done);
  r.git('checkout', '-q', '-b', 'clean');
  const body = Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i}; // ~/Dev/projet, 127.0.0.1:3078`).join('\n');
  commit(r, 'lib/big.mjs', body + '\n', 'big');
  commit(r, 'docs/decisions.md', `- chemin ${HOME}/notes, écrit en direct sur main\n`, 'decision');
  commit(r, 'docs/backlog.md', `- ${HOME}/x\n`, 'backlog');
  const t0 = performance.now();
  const res = checkBranch({ root: r.root, base: 'main', branch: 'clean', ctx });
  const ms = performance.now() - t0;
  assert.deepEqual(res, { ok: true, findings: [] });
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  console.log(`branche propre (2000 lignes) : passe en ${ms.toFixed(0)} ms`);
});

test('kinds and lines: a phone, a LAN address, a secret; an added « ++ » line is not a file header', (t) => {
  const r = repo(); t.after(r.done);
  r.git('checkout', '-q', '-b', 'mix');
  commit(r, 'lib/b.mjs', ['// ok', '++ looks like a header', "const tel = '06 12 34 56 78';", "const host = '192.168.1.20';", "const k = 'sk-" + 'a'.repeat(24) + "';"].join('\n') + '\n', 'mix');
  const res = checkBranch({ root: r.root, base: 'main', branch: 'mix', ctx });
  assert.deepEqual(res.findings.map((f) => `${f.file}:${f.line}:${f.kind}`), ['lib/b.mjs:3:phone', 'lib/b.mjs:4:lan', 'lib/b.mjs:5:secret']);
  assert.ok(!reason(res.findings).includes('192.168'));
});

test('an unreadable diff throws (the caller refuses the merge)', (t) => {
  const r = repo(); t.after(r.done);
  assert.throws(() => checkBranch({ root: r.root, base: 'main', branch: 'nope', ctx }));
});
