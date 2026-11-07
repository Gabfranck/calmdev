// One approval, not two (Dev, 7 novembre: « CI · La CI et la release du dépôt public » approved in the Revue, then refused,
// « à relire : .github/workflows/ci.yml » and a second agreement named nowhere). The Revue's approve now grants the session's
// review through sessionReviewed (the plan page's own path) before the merge: a file « à relire » at once; a protected
// guardrail only with the browser's key (the page's cookie) and the commit seen; a moved branch grants nothing.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
// escadrille: the repository has the shape of Escadrille (lib/guardrails.mjs and server.mjs), so lib/policy.mjs is protected
const repo = (escadrille = false) => {
  const root = tmp('escadrille-accord-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  const files = { 'a.txt': 'un\n', ...(escadrille ? { 'lib/policy.mjs': 'export const rules = ["no push"];\n', 'lib/guardrails.mjs': '// guard\n', 'server.mjs': '// server\n' } : {}) };
  for (const [f, txt] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), txt); }
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root;
};
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

const boot = (turns) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-'), keys: tmp('escadrille-keys-') };
  S.proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_GUARD_DIR: S.keys, ESCADRILLE_TESTBOX: 'none', FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  // the browser's key: the link of guard-link hands it as a cookie
  S.cookie = async () => { const k = new URL(readFileSync(path.join(S.keys, 'guard-link'), 'utf8').trim()).searchParams.get('k'); const r = await fetch(base + '/guard?k=' + k, { redirect: 'manual' }); assert.equal(r.status, 303); return r.headers.get('set-cookie').split(';')[0]; };
  return S;
};
const sess = (root, extra) => ({ name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, ...extra });
// a plan of one session A, launched, done with its review waiting; its code review (id, headSha)
const done = async (S, id, root, check) => {
  assert.equal((await S.post('/api/plan', { id, title: id, sessions: [sess(root, { id: 'A', stops: ['Fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: id });
  const a = await until(async () => { const s = await S.session(id, 'A'); return s.status === 'done' && check(s) ? s : null; });
  const rv = await S.get(`/api/review?plan=${id}&session=A`); assert.match(rv.headSha, /^[0-9a-f]{40}$/);
  return { a, rv };
};

test('a file « à relire » (.github/workflows/ci.yml): one approve in the Revue grants it and merges, no second call', async () => {
  const S = boot([{ write: '.github/workflows/ci.yml', stops: [0], claude: 'CI', done: true }]); await S.ready();
  const root = repo(); const cookie = await S.cookie();
  const { a, rv } = await done(S, 'ci', root, (s) => s.review);
  assert.deepEqual(a.review.files, ['.github/workflows/ci.yml']); assert.equal(a.review.seen, false);
  const r = await S.post(`/api/review/${rv.id}/submit`, { verdict: 'approve', head: rv.headSha }, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, true, JSON.stringify(r.body)); assert.ok(!r.body.mergeBlocked);
  const s = await S.session('ci', 'A'); assert.equal(s.worktree.merged, true); assert.equal(s.review.seen, true);
  assert.ok(sh(root, ['ls-tree', '-r', '--name-only', 'main']).split('\n').includes('.github/workflows/ci.yml'));
});

// The agreement « à relire » is the browser's alone, a protected file or not (revue-accord, defects 1 and 2, Dev 7 novembre):
// a device's Bearer and the pilot's header grant nothing on .github/workflows/ci.yml, and no head sent is a 409, never the
// server's headSha in its place
test('a file « à relire » not protected: Bearer and pilot header refused, no head refused, the cookie with its head merges', async () => {
  const S = boot([{ write: '.github/workflows/ci.yml', stops: [0], claude: 'CI', done: true }]); await S.ready();
  const root = repo(); const cookie = await S.cookie();
  const { rv } = await done(S, 'nonprot', root, (s) => s.review);
  const unseen = async () => { const s = await S.session('nonprot', 'A'); assert.equal(s.worktree.merged, false); assert.equal(s.review.seen, false); };
  for (const h of [{ authorization: 'Bearer ' + 'd'.repeat(64) }, { 'x-escadrille-pilot': 'x' }]) {
    const no = await S.post('/api/plan/nonprot/session/A/reviewed', { head: rv.headSha }, h); assert.equal(no.status, 403, JSON.stringify(h)); assert.match(no.body.error, /guard-link/);
    const r = await S.post(`/api/review/${rv.id}/submit`, { verdict: 'approve', head: rv.headSha }, h);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, false); assert.equal(r.body.mergeBlocked?.kind, 'guard', JSON.stringify(r.body));
    const d = await S.post(`/api/review/${rv.id}/decide`, { path: '.github/workflows/ci.yml', action: 'accept', head: rv.headSha }, h);
    assert.equal(d.body.merged, false, JSON.stringify(d.body)); assert.equal(d.body.mergeBlocked?.kind, 'guard');
    await unseen();
  }
  // with the cookie but no head: 409 on /reviewed; the approve keeps its verdict, grants nothing (kind moved), the decide too
  const nh = await S.post('/api/plan/nonprot/session/A/reviewed', {}, { cookie }); assert.equal(nh.status, 409, JSON.stringify(nh.body)); assert.match(nh.body.error, /commit/);
  const sub = await S.post(`/api/review/${rv.id}/submit`, { verdict: 'approve' }, { cookie });
  assert.equal(sub.body.merged, false, JSON.stringify(sub.body)); assert.equal(sub.body.mergeBlocked?.kind, 'moved', JSON.stringify(sub.body)); assert.match(sub.body.mergeBlocked.why, /commit/);
  const dec = await S.post(`/api/review/${rv.id}/decide`, { path: '.github/workflows/ci.yml', action: 'accept' }, { cookie });
  assert.equal(dec.body.merged, false, JSON.stringify(dec.body)); assert.equal(dec.body.mergeBlocked?.kind, 'moved');
  await unseen();
  for (const lang of ['fr', 'en']) assert.ok(JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', lang + '.json'), 'utf8'))['srv.s.reviewNoHead'], lang + ' srv.s.reviewNoHead');
  // the page's cookie and the commit it showed: granted and merged
  const ok = await S.post(`/api/review/${rv.id}/decide`, { path: '.github/workflows/ci.yml', action: 'accept', head: rv.headSha }, { cookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.merged, true, JSON.stringify(ok.body));
  assert.equal((await S.session('nonprot', 'A')).review.seen, true);
});

test('the pages send the commit seen: review.html on /submit and /decide (queue items too), plan.html opens the diff first', () => {
  const rev = readFileSync(path.join(HERE, '..', 'public', 'review.html'), 'utf8');
  const dec = rev.split('\n').find((l) => l.includes('/decide`')); assert.ok(dec, 'the decide call');
  assert.equal((dec.match(/head:/g) || []).length, 2, 'both branches of /decide send head: ' + dec);
  for (const l of rev.split('\n').filter((x) => x.includes('/submit`'))) assert.match(l, /head: R\.headSha/);
  const plan = readFileSync(path.join(HERE, '..', 'public', 'plan.html'), 'utf8');
  assert.match(plan, /if \(!diffs\[sid\]\?\.head\) \{/, 'any « à relire », not only a guardrail, loads its diff before the agreement');
});

test('a protected guardrail with the browser’s cookie: the approve grants it for the commit seen, then merges', async () => {
  const S = boot([{ write: 'lib/policy.mjs', stops: [0], claude: 'Fait', done: true }]); await S.ready();
  const root = repo(true); const cookie = await S.cookie();
  const { rv } = await done(S, 'garde', root, (s) => s.review?.guard?.length);
  const r = await S.post(`/api/review/${rv.id}/submit`, { verdict: 'approve', head: rv.headSha }, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, true, JSON.stringify(r.body));
  const s = await S.session('garde', 'A'); assert.equal(s.worktree.merged, true); assert.equal(s.review.guardHead, rv.headSha);
  assert.match(sh(root, ['show', 'main:lib/policy.mjs']), /écrit au tour/);
});

test('a commit after the page was shown: the approve grants nothing and says « moved »', async () => {
  const S = boot([{ write: 'lib/policy.mjs', stops: [0], claude: 'Fait', done: true }]); await S.ready();
  const root = repo(true); const cookie = await S.cookie();
  const { a, rv } = await done(S, 'bouge', root, (s) => s.review?.guard?.length);
  sh(a.worktree.path, ['commit', '-q', '--allow-empty', '-m', 'later']);
  const r = await S.post(`/api/review/${rv.id}/submit`, { verdict: 'approve', head: rv.headSha }, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, false);
  assert.equal(r.body.mergeBlocked?.kind, 'moved', JSON.stringify(r.body)); assert.match(r.body.mergeBlocked.why, /La branche a changé.*approuver\.$/);
  const s = await S.session('bouge', 'A'); assert.equal(s.worktree.merged, false); assert.equal(s.review.seen, false); assert.ok(!s.review.guardHead, 'nothing granted');
  for (const lang of ['fr', 'en']) assert.ok(JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', lang + '.json'), 'utf8'))['rev.blocked.moved'], lang + ' rev.blocked.moved');
});

test('without the cookie: /reviewed stays 403, the approve keeps its verdict and grants nothing (kind guard, the way of guard-link)', async () => {
  const S = boot([{ write: 'lib/policy.mjs', stops: [0], claude: 'Fait', done: true }]); await S.ready();
  const root = repo(true);
  const { rv } = await done(S, 'sanscle', root, (s) => s.review?.guard?.length);
  const no = await S.post('/api/plan/sanscle/session/A/reviewed', { head: rv.headSha }); assert.equal(no.status, 403); assert.match(no.body.error, /guard-link/);
  // the pilot's header and a body key are not the page's cookie
  const r = await S.post(`/api/review/${rv.id}/submit`, { verdict: 'approve', head: rv.headSha, key: 'f'.repeat(64) }, { 'x-escadrille-pilot': 'x' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, false);
  assert.equal(r.body.mergeBlocked?.kind, 'guard', JSON.stringify(r.body)); assert.match(r.body.mergeBlocked.why, /guard-link/);
  const s = await S.session('sanscle', 'A'); assert.equal(s.worktree.merged, false); assert.equal(s.review.seen, false); assert.ok(!s.review.guardHead);
  assert.equal((await S.get(`/api/review?plan=sanscle&session=A`)).verdict?.verdict, 'approve', 'the verdict is kept');
  assert.equal(readFileSync(path.join(root, 'lib/policy.mjs'), 'utf8'), 'export const rules = ["no push"];\n');
});

test('a merge from the Flot with files « à relire »: the refusal names /plan/<id> and the button', async () => {
  const S = boot([{ write: '.github/workflows/ci.yml', stops: [0], claude: 'CI', done: true }]); await S.ready();
  const root = repo();
  await done(S, 'flot', root, (s) => s.review);
  const m = await S.post('/api/plan/flot/session/A/merge');
  assert.notEqual(m.status, 200, JSON.stringify(m.body));
  assert.match(m.body.error, /\/plan\/flot/); assert.match(m.body.error, /Vu, continuer|Seen, continue/); assert.match(m.body.error, /\.github\/workflows\/ci\.yml/);
  assert.equal((await S.session('flot', 'A')).worktree.merged, false);
});
