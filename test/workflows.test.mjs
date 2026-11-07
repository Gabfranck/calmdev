// The GitHub workflows that leave with the public repository (docs/ci.md), read without GitHub: a small YAML reader for
// the subset the workflows use (block mappings and lists, flow lists, quoted scalars, block scalars), then the rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

export const parseYaml = (src) => {
  const L = src.split('\n'); let i = 0;
  const strip = (s) => {
    let q = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
      else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
    }
    return s.trimEnd();
  };
  const ind = (s) => s.match(/^ */)[0].length;
  const skip = () => { while (i < L.length && !strip(L[i]).trim()) i++; };
  const scalar = (v) => {
    v = v.trim();
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map(scalar);
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(v)) return JSON.parse(v);
    if (v === 'true' || v === 'false') return v === 'true';
    return v === '' ? null : v;
  };
  const block = (parent) => {
    const out = [];
    while (i < L.length && (!L[i].trim() || ind(L[i]) > parent)) out.push(L[i++]);
    while (out.length && !out.at(-1).trim()) out.pop();
    const m = Math.min(...out.filter((s) => s.trim()).map(ind));
    return out.map((s) => s.slice(m)).join('\n') + '\n';
  };
  const isItem = (t) => t === '-' || t.startsWith('- ');
  const value = (rest, indent) => {
    if (rest === '|' || rest === '>') return block(indent);
    if (rest !== '') return scalar(rest);
    skip();
    if (i >= L.length) return null;
    const n = ind(L[i]); const t = strip(L[i]).trim();
    if (n > indent || (n === indent && isItem(t))) return node(n);
    return null;
  };
  const node = (indent) => (isItem(strip(L[i]).trim()) ? list(indent) : map(indent));
  const map = (indent) => {
    const o = {};
    for (;;) {
      skip();
      if (i >= L.length || ind(L[i]) !== indent) break;
      const t = strip(L[i]).trim();
      if (isItem(t)) break;
      const m = t.match(/^("[^"]*"|'[^']*'|[^:'"]+?):(?:\s+(.*))?$/);
      if (!m) throw new Error(`YAML line ${i + 1}: ${t}`);
      i++;
      const k = scalar(m[1]);
      if (Object.hasOwn(o, k)) throw new Error(`YAML line ${i}: duplicate key ${k}`);
      o[k] = value(m[2] ?? '', indent);
    }
    return o;
  };
  const list = (indent) => {
    const a = [];
    for (;;) {
      skip();
      if (i >= L.length || ind(L[i]) !== indent) break;
      const t = strip(L[i]).trim();
      if (!isItem(t)) break;
      const rest = t.slice(2);
      if (/^("[^"]*"|'[^']*'|[^:'"[\]]+?):(\s|$)/.test(rest)) { L[i] = ' '.repeat(indent + 2) + rest; a.push(map(indent + 2)); }
      else { i++; a.push(scalar(rest)); }
    }
    return a;
  };
  if (/\t/.test(src)) throw new Error('YAML: a tab character');
  skip();
  const doc = map(0);
  skip();
  if (i < L.length) throw new Error(`YAML line ${i + 1}: unexpected indentation`);
  return doc;
};

const steps = (job) => job.steps || [];
const allSteps = (wf) => Object.values(wf.jobs).flatMap(steps);
const runs = (job) => steps(job).map((s) => s.run || '').join('\n');
const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;

test('the reader: mappings, lists, flow lists, block scalars, comments, errors', () => {
  const y = parseYaml('a: 1 # c\nb:\n  - x\n  - k: v\n    l: [m, \'n\']\nc: |\n  line one\n  # kept\nd: "q # not a comment"\n');
  assert.deepEqual(y, { a: '1', b: ['x', { k: 'v', l: ['m', 'n'] }], c: 'line one\n# kept\n', d: 'q # not a comment' });
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tab/);
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /indentation/);
});

test('ci.yml: PR and pushes to main and dev, Linux and macOS, Node 22.13, read-only, tests under CI=true, trace scan', () => {
  const wf = parseYaml(read('.github/workflows/ci.yml'));
  assert.ok(Object.hasOwn(wf.on, 'pull_request'));
  assert.deepEqual(wf.on.push.branches, ['main', 'dev']);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  for (const job of Object.values(wf.jobs)) assert.ok(!job.permissions, 'no job widens the read-only permissions');
  const t = wf.jobs.test;
  assert.deepEqual(t.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  assert.equal(t['runs-on'], '${{ matrix.os }}');
  assert.equal(t.env.CI, 'true');
  assert.match(runs(t), /node --test 'test\/\*\.test\.mjs'/);
  assert.match(runs(wf.jobs['trace-scan']), /node scripts\/trace-scan\.mjs --fixtures --words/);
  assert.match(runs(wf.jobs['trace-scan']), /node scripts\/trace-scan\.mjs --fixtures$/m);
  assert.equal(wf.jobs['trace-scan'].if, "github.repository == 'Gabfranck/calmdev'");
  for (const job of Object.values(wf.jobs)) {
    const setup = steps(job).filter((s) => String(s.uses).startsWith('actions/setup-node@'));
    assert.equal(setup.length, 1);
    assert.equal(setup[0].with['node-version'], '22.13');
  }
});

test('release.yml: a v* tag builds the .dmg on macOS into a DRAFT release; Apple signing only with its secrets', () => {
  const wf = parseYaml(read('.github/workflows/release.yml'));
  assert.deepEqual(wf.on.push.tags, ['v*']);
  assert.ok(!wf.on.push.branches, 'no branch push releases anything');
  assert.deepEqual(wf.permissions, { contents: 'read' });
  const d = wf.jobs.desktop;
  assert.equal(d['runs-on'], 'macos-latest');
  assert.match(d.if, /refs\/tags\/v/);
  assert.deepEqual(d.permissions, { contents: 'write' });
  const r = runs(d);
  assert.match(r, /gh release create [^\n]*--draft/);
  assert.doesNotMatch(r, /gh release (edit|create)[^\n]*--draft=false/);
  assert.match(r, /tauri build --bundles dmg/);
  assert.doesNotMatch(r, /npm publish/);
  const signed = steps(d).find((s) => s.name === 'Build (signed and notarized)');
  const unsigned = steps(d).find((s) => s.name === 'Build (unsigned)');
  assert.equal(signed.if, "steps.apple.outputs.signed == 'true'");
  assert.equal(unsigned.if, "steps.apple.outputs.signed != 'true'");
  assert.ok(!unsigned.env, 'the unsigned build gets no Apple secret');
  for (const k of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'])
    assert.equal(signed.env[k], `\${{ secrets.${k} }}`);
  assert.match(steps(d).find((s) => s.id === 'apple').run, /::warning::/);
});

test('release.yml: npm publishes only on a manual run, behind the release environment and NPM_TOKEN, never on a tag', () => {
  const wf = parseYaml(read('.github/workflows/release.yml'));
  assert.equal(wf.on.workflow_dispatch.inputs.npm.default, false);
  const n = wf.jobs.npm;
  assert.equal(n.if, "github.repository == 'Gabfranck/calmdev' && github.event_name == 'workflow_dispatch' && inputs.npm");
  assert.equal(n.environment, 'release');
  const pub = steps(n).find((s) => /npm publish/.test(s.run || ''));
  assert.equal(pub.env.NODE_AUTH_TOKEN, '${{ secrets.NPM_TOKEN }}');
  const publishing = Object.entries(wf.jobs).filter(([, j]) => /npm publish/.test(runs(j))).map(([k]) => k);
  assert.deepEqual(publishing, ['npm']);
});

test('every workflow: actions pinned to a commit, no secret value written, pages.yml left private', () => {
  for (const f of ['ci.yml', 'release.yml']) // the private repository runs none of them: its minutes are billed
    for (const [k, job] of Object.entries(parseYaml(read(`.github/workflows/${f}`)).jobs))
      assert.match(job.if, /^github\.repository == 'Gabfranck\/calmdev'/, `${f}: ${k}`);
  // pages.yml and public-manifest.json stay in the private repository: checked there, absent from the public one
  for (const f of ['ci.yml', 'release.yml', 'pages.yml']) {
    if (f === 'pages.yml' && !existsSync(path.join(ROOT, '.github/workflows', f))) continue;
    const src = read(`.github/workflows/${f}`);
    const wf = parseYaml(src);
    assert.ok(wf.jobs && Object.keys(wf.jobs).length, f);
    assert.doesNotMatch(src, /gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|-----BEGIN/, f);
    if (f === 'pages.yml') continue;
    for (const s of allSteps(wf)) if (s.uses) assert.match(s.uses, PINNED, `${f}: ${s.uses}`);
  }
  if (!existsSync(path.join(ROOT, 'public-manifest.json'))) return;
  const m = JSON.parse(read('public-manifest.json'));
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml', 'docs/ci.md', 'desktop/**']) assert.ok(m.include.includes(f), f);
  assert.ok(!m.include.some((g) => g.startsWith('.github/') && !g.endsWith('ci.yml') && !g.endsWith('release.yml')), 'pages.yml stays in the private repository');
});
