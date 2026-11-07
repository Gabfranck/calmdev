// Phase 16 PAIR (docs/review.md « Le résumé de fin et le fil »): the end report validated and cut, then against the server
// and the fake claude: a thread message written during a turn waits for the next one and is not lost (the backlog's
// defect), the report and its captures served, a done session reopened by Dev's click only, GitHub comments in the thread.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from './free-port.mjs';
import { fakeClaude } from './fake-claude.mjs';
import { validateState, validateDone } from '../lib/blocks.mjs';
import * as T from '../lib/donethread.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 160)); await new Promise((r) => setTimeout(r, 80)); } };
const procs = []; after(() => { for (const p of procs) p.kill('SIGKILL'); });

test('validateDone: the summary cut to three sentences, ten words per test, captures under .escadrille only', () => {
  const d = validateDone({ summary: 'Un. Deux ! Trois ? Quatre.', journeys: ['Revue › fil', '', 3], tests: ['un deux trois quatre cinq six sept huit neuf dix onze douze'],
    captures: ['.escadrille/captures/1-x/1440.png', './.escadrille/qa/run/captures/a.png', '/etc/x.png', '.escadrille/captures/../../x.png', 'docs/a.png', '.escadrille/captures/a.jpg'] });
  assert.equal(d.summary, 'Un. Deux ! Trois ?');
  assert.deepEqual(d.journeys, ['Revue › fil']);
  assert.deepEqual(d.tests, ['un deux trois quatre cinq six sept huit neuf dix']);
  assert.deepEqual(d.captures, ['.escadrille/captures/1-x/1440.png', '.escadrille/qa/run/captures/a.png']);
  assert.equal(validateDone({ journeys: ['x'] }), null, 'no summary, no report');
  assert.equal(validateDone({ summary: 'x'.repeat(900) }).summary.length, 600);
});

test('validateState: done as an object is done plus the report; done:true alone keeps report null', () => {
  const a = validateState({ stops: [1], done: { summary: 'Fait.', captures: [] } }).state;
  assert.equal(a.done, true); assert.deepEqual(a.report, { summary: 'Fait.', journeys: [], tests: [], captures: [] });
  const b = validateState({ stops: [1], done: true }).state; assert.equal(b.done, true); assert.equal(b.report, null);
  const c = validateState({ stops: [1], done: false }).state; assert.equal(c.done, false); assert.equal(c.report, null);
  assert.equal(validateState({ done: { journeys: [] } }).state.done, true, 'an object without summary still finishes');
});

test('the thread table: written first, sent after, GitHub entries keep file and line; captures resolved inside .escadrille only', () => {
  const db = new DatabaseSync(':memory:'); T.schema(db);
  const e = T.addEntry(db, 'p', 'A', { source: 'qa', body: ' Le bouton ne répond pas. ' });
  assert.deepEqual([e.sent, e.author, e.body], [false, 'qa', 'Le bouton ne répond pas.']);
  assert.equal(T.markSent(db, e.id, { held: true }).held, true);
  const g = T.addEntry(db, 'p', 'A', T.githubEntry({ type: 'review-comment', body: 'Nom flou.', path: 'lib/a.mjs', line: 12, author: 'octo', url: 'https://github.com/o/r/pull/1#discussion_r1' }));
  assert.deepEqual([g.source, g.path, g.line], ['github', 'lib/a.mjs', 12]);
  assert.equal(T.githubEntry({ type: 'other', body: 'x' }), null);
  assert.equal(T.threadOf(db, 'p', 'A').length, 2);
  T.saveDone(db, 'p', 'A', { summary: 'Un.', journeys: [], tests: [], captures: [] }); T.saveDone(db, 'p', 'A', { summary: 'Deux.', journeys: [], tests: [], captures: [] });
  assert.equal(T.doneOf(db, 'p', 'A').summary, 'Deux.', 'a later report replaces the earlier one'); assert.equal(T.doneOf(db, 'p', 'B'), null);
  assert.throws(() => T.addEntry(db, 'p', 'A', { source: 'pilot', body: 'x' }));
  assert.match(T.relayText({ body: 'Corrige.', source: 'dev' }), /^Corrige\.\n\n— fil de la Revue \(Dev\)$/);
  const root = tmp('pair-root-'); mkdirSync(path.join(root, '.calmdev', 'captures', 'x'), { recursive: true }); writeFileSync(path.join(root, '.calmdev', 'captures', 'x', '1440.png'), 'png');
  writeFileSync(path.join(root, 'secret.png'), 'no'); symlinkSync(path.join(root, 'secret.png'), path.join(root, '.calmdev', 'captures', 'x', 'lien.png'));
  assert.ok(T.resolveCapture(root, '.calmdev/captures/x/1440.png'));
  assert.equal(T.resolveCapture(root, '.calmdev/captures/x/lien.png'), null, 'a link out of .escadrille is refused');
  assert.equal(T.resolveCapture(root, '../x.png'), null);
  mkdirSync(path.join(root, '.calmdev', 'qa', 'r1'), { recursive: true }); writeFileSync(path.join(root, '.calmdev', 'qa', 'r1', 'planche.html'), '<p>');
  assert.equal(T.latestBoard(root), '.calmdev/qa/r1/planche.html');
  // a worktree not migrated yet: its .escadrille/ captures still resolve
  const old = tmp('pair-old-'); mkdirSync(path.join(old, '.escadrille', 'captures'), { recursive: true }); writeFileSync(path.join(old, '.escadrille', 'captures', 'a.png'), 'png');
  assert.ok(T.resolveCapture(old, '.escadrille/captures/a.png'));
});

test('the server: a thread message during a turn waits and is not lost; report and captures served; reopen by Dev only; GitHub comments', async () => {
  const report = { summary: 'Le fil marche. Une deuxième phrase. Une troisième. Une quatrième de trop.', journeys: ['Revue › le fil'], tests: ['un message pendant un tour attend le suivant'], captures: ['.calmdev/captures/1-revue/1440.png'] };
  const turns = [{ stops: [0], claude: 'Premier arrêt', hold: 1500 }, { stops: [0, 1], claude: 'Fini', done: report }];
  const fake = fakeClaude(); const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`; const empty = tmp('pair-none-'); const guardDir = tmp('pair-guard-');
  const proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('pair-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('pair-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_GUARD_DIR: guardDir, ESCADRILLE_SECRETS: path.join(tmp('pair-sec-'), 's.json'), FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc); let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
  const post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const prompts = () => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  await until(async () => { try { await fetch(base + '/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + err); });
  const cookie = { cookie: 'escadrille_guard=' + readFileSync(path.join(guardDir, 'guard-key'), 'utf8').trim() };
  const root = tmp('pair-repo-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  const P = 'pair'; const q = `plan=${P}&session=A`;
  assert.equal((await post('/api/plan', { id: P, title: P, project: root, sessions: [{ id: 'A', name: 'Le fil', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, stops: ['Format', 'Fin'] }] })).status, 200);
  await post('/api/launch', { plan: P });
  // the consigne asks for the report, in its lines
  await until(() => prompts().length === 1);
  assert.match(prompts()[0].text, /au dernier tour, done devient \{"summary"/);
  // turn 1 is running (1.5 s): a QA return now waits for the next turn
  let r = await post('/api/review/thread', { plan: P, session: 'A', source: 'qa', text: 'Le bouton Envoyer ne répond pas.' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.sent, true); assert.equal(r.body.held, 1); assert.equal(r.body.entry.held, true);
  // a session without report keeps today's view: done null
  assert.equal((await get('/api/review/done?' + q)).body.done, null);
  // the message is not lost: it leads turn 2
  await until(() => prompts().length === 2);
  assert.match(prompts()[1].text, /Le bouton Envoyer ne répond pas\.\n\n— fil de la Revue \(QA\)/);
  const st = async () => (await get('/api/plan/' + P)).body.state.find((x) => x.id === 'A');
  await until(async () => (await st()).status === 'done');
  // the report, cut to three sentences, and its capture served from the worktree
  const wt = (await st()).worktree; const cap = path.join(wt.path, '.calmdev', 'captures', '1-revue'); mkdirSync(cap, { recursive: true }); writeFileSync(path.join(cap, '1440.png'), 'PNG');
  const d = (await get('/api/review/done?' + q)).body;
  assert.equal(d.done.summary, 'Le fil marche. Une deuxième phrase. Une troisième.');
  assert.deepEqual(d.done.tests, ['un message pendant un tour attend le suivant']);
  assert.equal(d.captures[0].path, '.calmdev/captures/1-revue/1440.png'); assert.ok(d.captures[0].url);
  assert.equal((await get(d.captures[0].url)).body, 'PNG'); assert.equal(d.board, null); assert.equal(d.thread.length, 1);
  assert.equal((await get('/api/review/done/file?' + q + '&path=' + encodeURIComponent('a.txt'))).status, 404);
  // done: a QA return is kept, not sent; Dev without cookie is refused; with the cookie and reopen the session runs again
  r = await post('/api/review/thread', { plan: P, session: 'A', source: 'qa', text: 'Encore un défaut.' }); assert.equal(r.body.sent, false);
  r = await post('/api/review/thread', { plan: P, session: 'A', text: 'Corrige le libellé.', reopen: true }); assert.equal(r.status, 403);
  r = await post('/api/review/thread', { plan: P, session: 'A', text: 'Corrige le libellé.' }, cookie); assert.equal(r.body.sent, false, 'a done session waits for reopen');
  r = await post('/api/review/thread', { plan: P, session: 'A', text: 'Corrige le libellé.', reopen: true }, cookie); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.reopened, true);
  await until(() => prompts().length === 3); assert.match(prompts()[2].text, /^Corrige le libellé\.\n\n— fil de la Revue \(Dev\)/);
  // the fake claude is relaunched by --resume and plays its first turn again: the session left done and stops at a turn
  await until(async () => (await st()).status === 'waiting');
  // GitHub: the connector's review-comment enters the thread with file and line, never relaunches
  r = await post('/api/review/thread', { plan: P, session: 'A', type: 'review-comment', body: 'Ce nom ne dit rien.', path: 'lib/a.mjs', line: 7, author: 'octocat', url: 'https://github.com/o/r/pull/1#discussion_r1' }); assert.equal(r.status, 403);
  r = await post('/api/review/thread', { plan: P, session: 'A', type: 'review-comment', body: 'Ce nom ne dit rien.', path: 'lib/a.mjs', line: 7, author: 'octocat', url: 'https://github.com/o/r/pull/1#discussion_r1' }, cookie);
  assert.equal(r.body.sent, false); assert.deepEqual([r.body.entry.source, r.body.entry.path, r.body.entry.line], ['github', 'lib/a.mjs', 7]);
  const th = (await get('/api/review/thread?' + q)).body.thread;
  assert.deepEqual(th.map((e) => [e.source, e.sent]), [['qa', true], ['qa', false], ['dev', false], ['dev', true], ['github', false]]);
  assert.equal(prompts().length, 3, 'nothing sent for the GitHub comment');
  assert.equal((await get('/api/review/done?plan=pair&session=Z')).status, 404);
});
