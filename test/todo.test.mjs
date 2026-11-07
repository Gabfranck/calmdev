// Phase 11 X: who has to act (public/todo.js, lib/todo.mjs), the presence of an external pilot, the « À toi » lines
// written by Escadrille, the project's logo (lib/projectlogo.mjs), a session said running with no process
// (lib/running.mjs orphans), a branch already in its base (lib/projectflow.mjs inBase, waitingForOf with a pilot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { needsDev, items, createPresence, EXTERNAL_TTL_MS } from '../lib/todo.mjs';
import { findLogo, contentType } from '../lib/projectlogo.mjs';
import { orphans } from '../lib/running.mjs';
import { inBase, waitingForOf, humanOf, forgetAncestors, oneLine } from '../lib/projectflow.mjs';
import { nowOf } from '../lib/status.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

test('the developer never sees a notice by mistake: with a pilot, a reply, a permission, a review are silent; a human stop, a guard, a design review always reach him', () => {
  for (const kind of ['reply', 'permission', 'review', 'waiting']) { assert.equal(needsDev({ kind, pilot: true }), false, kind + ' with a pilot'); assert.equal(needsDev({ kind, pilot: false }), true, kind + ' without'); }
  assert.equal(needsDev({ kind: 'reply', pilot: true, human: true }), true, 'a taste stop');
  assert.equal(needsDev({ kind: 'review', pilot: true, guard: true }), true, 'a guard with the key');
  assert.equal(needsDev({ kind: 'review', pilot: true, design: true }), true, 'a design review');
  for (const kind of ['done', 'error', 'ask-budget', 'budget', 'install', 'planning', 'proposal']) assert.equal(needsDev({ kind, pilot: true }), true, kind + ' is never the pilot\'s');
});

test('an external pilot declares itself, is renewed by its calls and goes out alone after the TTL', () => {
  let t = 1000; const pr = createPresence({ now: () => t });
  assert.equal(pr.present('/p'), false); assert.equal(pr.present('/p', true), true, 'the built-in pilot on');
  pr.touch('/p'); assert.equal(pr.external('/p'), true); assert.equal(pr.present('/p'), true); assert.equal(pr.until('/p'), new Date(1000 + EXTERNAL_TTL_MS).toISOString());
  t += EXTERNAL_TTL_MS - 1; assert.equal(pr.present('/p'), true); pr.touch('/p'); t += EXTERNAL_TTL_MS - 1; assert.equal(pr.present('/p'), true, 'renewed');
  t += 2; assert.equal(pr.present('/p'), false, 'out after the TTL'); assert.equal(pr.until('/p'), null);
  pr.touch('/q'); pr.forget('/q'); assert.equal(pr.external('/q'), false);
});

const RAW = 'TEXTE BRUT DE LA SESSION: rm -rf /';
const nodes = [
  { plan: 'p1', session: 'B', name: 'b', status: 'waiting', waitingFor: 'dev', human: false, now: RAW },
  { plan: 'p1', session: 'T', name: 't', status: 'waiting', waitingFor: 'dev', human: true, now: RAW },
  { plan: 'p1', session: 'S', name: 's', status: 'running', waitingFor: 'permission', now: RAW },
  { plan: 'p1', session: 'D', name: 'd', status: 'done', waitingFor: 'review', now: RAW },
  { plan: 'p1', session: 'M', name: 'm', status: 'merged', waitingFor: null, now: RAW },
];
const perms = { 'p1/S': { id: 'perm-1', tool: 'Bash', text: RAW, network: ['registry.npmjs.org'] } };
const reviews = [{ id: 'r1', session: 'D', plan: 'p1', additions: 100, deletions: 10 }, { id: 'r2', session: 'G', plan: 'p1', guard: ['lib/policy.mjs'] }];
const escs = [{ id: 'e1', status: 'waiting', stale: false, title: 'Phase 12' }, { id: 'e2', status: 'waiting', stale: true, title: 'old' }];

test('« À toi » without a pilot: every wait, one line each, written by Escadrille, never the session\'s own words', () => {
  const list = items({ nodes, perms, escs, reviews, proposals: [{ seq: 7, title: 'Plan X' }], pilot: false });
  assert.deepEqual(list.map((i) => i.kind + ':' + (i.s || i.id || i.seq || '')), ['reply:B', 'design:T', 'permission:S', 'review:D', 'guard:G', 'planning:e1', 'proposal:7']);
  assert.ok(!JSON.stringify(list).includes(RAW), 'no raw text of a session');
  assert.deepEqual(list[2].perm, { id: 'perm-1', tool: 'Bash', network: 'registry.npmjs.org' }, 'the permission says the tool and the domain, not the session\'s text');
});

test('« À toi » with a pilot present: only what the developer alone can do (a taste stop, a guard, a planning, a plan to launch)', () => {
  const list = items({ nodes, perms, escs, reviews, proposals: [{ seq: 7, title: 'Plan X' }], pilot: true });
  assert.deepEqual(list.map((i) => i.kind), ['design', 'guard', 'planning', 'proposal']);
  assert.deepEqual(items({ nodes: [], pilot: true }), [], 'nothing waits: nothing');
  // a finished branch waits for the developer's merge, pilot or not; a plan merged whole whose next plan waits for the click
  const merge = items({ nodes: [{ waitingFor: 'merge', session: 'FIX', plan: 'p' }], ends: [{ id: 'p/main', plan: 'p', waitingFor: 'dev', verb: 'launch', next: { id: 'q', title: 'Phase 13', status: 'todo' } }, { id: 'r/main', plan: 'r', waitingFor: null, next: null }], pilot: true });
  assert.deepEqual(merge, [{ kind: 'merge', s: 'FIX', plan: 'p', act: 'merge' }, { kind: 'launch', plan: 'p', next: { id: 'q', title: 'Phase 13', status: 'todo' }, act: 'launch' }]);
});

test('the home writes each line as a verb and its object, with its why; a session\'s text never reaches the DOM (test/mainchat-home.test.mjs renders it)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/mainchat.js', import.meta.url), 'utf8');
  assert.ok(src.includes('escadrilleTodo.items('), 'the home uses the shared list');
  assert.ok(!/text: `\$\{esc\(n\.now/.test(src) && !/esc\(p\.text\)/.test(src.slice(src.indexOf('todoLine'), src.indexOf('const waiting'))), 'no raw session text in a line');
});

test('the project\'s logo: favicon, Expo app.json, a manifest, logo.svg at the root; nothing in an empty folder; never a file outside the project', () => {
  const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'logo-')));
  const a = tmp(); mkdirSync(path.join(a, 'public')); writeFileSync(path.join(a, 'public', 'favicon.svg'), '<svg/>');
  assert.deepEqual(findLogo(a), { path: path.join(a, 'public', 'favicon.svg'), type: 'image/svg+xml' });
  const b = tmp(); mkdirSync(path.join(b, 'assets')); writeFileSync(path.join(b, 'assets', 'logo.png'), 'png'); writeFileSync(path.join(b, 'app.json'), JSON.stringify({ expo: { icon: './assets/logo.png' } }));
  assert.equal(findLogo(b).path, path.join(b, 'assets', 'logo.png')); assert.equal(findLogo(b).type, 'image/png');
  const c = tmp(); mkdirSync(path.join(c, 'public')); writeFileSync(path.join(c, 'public', 'manifest.webmanifest'), JSON.stringify({ icons: [{ src: '/icons/x.png' }, { src: 'https://x/y.png' }] })); mkdirSync(path.join(c, 'public', 'icons')); writeFileSync(path.join(c, 'public', 'icons', 'x.png'), 'png');
  assert.equal(findLogo(c).path, path.join(c, 'public', 'icons', 'x.png'));
  const d = tmp(); writeFileSync(path.join(d, 'logo.svg'), '<svg/>'); assert.equal(findLogo(d).path, path.join(d, 'logo.svg'));
  const e = tmp(); writeFileSync(path.join(e, 'README.md'), 'x'); assert.equal(findLogo(e), null, 'no icon: null, the dot stays');
  const f = tmp(); writeFileSync(path.join(f, 'app.json'), JSON.stringify({ expo: { icon: '../../etc/passwd' } })); assert.equal(findLogo(f), null, 'a path leaving the folder is refused');
  assert.equal(findLogo(path.join(e, 'absent')), null); assert.equal(contentType('x.txt'), null); assert.equal(contentType('x.ICO'), 'image/x-icon');
});

test('a session said running with no process goes back to waiting: orphans() names it, a terminal session is left alone', () => {
  const rows = [{ plan: 'p', id: 'A', status: 'running', mode: 'page' }, { plan: 'p', id: 'B', status: 'running', mode: 'page' }, { plan: 'p', id: 'C', status: 'waiting', mode: 'page' }, { plan: 'p', id: 'T', status: 'running', mode: 'terminal' }];
  assert.deepEqual(orphans(rows, (p, s) => s === 'A').map((r) => r.id), ['B']);
  assert.deepEqual(orphans([], () => false), []);
});

test('a done session whose branch is already in its base is merged, not « waiting for your review »; a true answer is cached, a false one asked again after the TTL', () => {
  forgetAncestors(); const calls = [];
  const isAncestor = (root, branch, base) => { calls.push(branch); return branch === 'escadrille/p/A'; };
  const wt = (s) => ({ root: '/r', branch: 'escadrille/p/' + s, base: 'main', path: '/r/.claude/worktrees/p-' + s });
  assert.equal(inBase(wt('A'), { isAncestor, now: 0 }), true); assert.equal(inBase(wt('A'), { isAncestor, now: 10 }), true); assert.equal(calls.length, 1, 'a true answer is final');
  assert.equal(inBase(wt('B'), { isAncestor, now: 0 }), false); inBase(wt('B'), { isAncestor, now: 1000 }); assert.equal(calls.length, 2, 'a false answer is kept a minute');
  inBase(wt('B'), { isAncestor, now: 70e3 }); assert.equal(calls.length, 3, 'then asked again');
  assert.equal(inBase({ root: '/r', branch: 'x' }, { isAncestor }), false, 'no base known: not merged'); assert.equal(inBase(null, { isAncestor }), false);
});

test('waitingForOf: with a pilot present, a reply, a permission and a review are the pilot\'s; a human stop stays the developer\'s; a closed plan or a kit asks no review', () => {
  const reply = { pending: [{ kind: 'reply', stop: 0 }], status: 'waiting' }; const perm = { pending: [{ kind: 'permission' }], status: 'running' };
  assert.equal(waitingForOf(reply, 'waiting', true), 'dev'); assert.equal(waitingForOf(reply, 'waiting', true, { pilot: true }), 'pilot'); assert.equal(waitingForOf(reply, 'waiting', true, { pilot: true, human: true }), 'dev');
  assert.equal(waitingForOf(perm, 'running', true), 'permission'); assert.equal(waitingForOf(perm, 'running', true, { pilot: true }), 'pilot');
  assert.equal(waitingForOf({ pending: [], status: 'done' }, 'done', true), 'review'); assert.equal(waitingForOf({ pending: [], status: 'done' }, 'done', true, { pilot: true }), 'pilot'); assert.equal(waitingForOf({ pending: [], status: 'done' }, 'done', false), null, 'a kit or a closed plan');
  assert.equal(humanOf(reply, [{ title: 'Valide l\'écran', kind: 'taste' }]), true); assert.equal(humanOf(reply, ['un arrêt']), false); assert.equal(humanOf({ pending: [] }, []), false);
});

test('« Maintenant »: t\'attend counts the developer\'s waits only; a session waiting for the pilot is its own count and a row', () => {
  const n = nowOf([{ plan: 'p', session: 'A', status: 'waiting', waitingFor: 'pilot', cost: 1, budget: 5 }, { plan: 'p', session: 'B', status: 'waiting', waitingFor: 'dev', cost: 1, budget: 5 }, { plan: 'p', session: 'C', status: 'done', waitingFor: 'pilot', cost: 1, budget: 5 }], [{ id: 'p', status: 'running' }]);
  assert.equal(n.waiting, 1); assert.equal(n.pilot, 2); assert.deepEqual(n.rows.map((r) => r.session), ['B', 'A', 'C']);
});

test('the « Now » line of a node never cuts an i18n marker: cut, it reached the screen raw (Flot at 390, 2026-11-02)', () => {
  const marker = `⟦srv.s.launchedWt|{"cwd":"${USERS}/dev/Dev/escadrille/.claude/worktrees/2026-11-02-phase-11-une-ux-qui-repond-X","branch":"escadrille/2026-11-02-phase-11-une-ux-qui-repond/X"}⟧`;
  assert.equal(oneLine(marker), marker); assert.equal(oneLine('a'.repeat(200)).length, 140); assert.equal(oneLine('  deux   mots '), 'deux mots');
});

// 6 Nov.: « 0 t'attend · 6 pour le pilote » over nine waiting sessions, the pilot off
test('« À toi »: a turn ended goes to the developer when no pilot; what a pilot keeps stays listed, marked kept, once', () => {
  assert.equal(waitingForOf({ status: 'waiting', pending: [] }, 'waiting', 'merge'), 'dev', 'pilot off: nothing is the pilot\'s');
  assert.equal(waitingForOf({ status: 'waiting', pending: [] }, 'waiting', 'merge', { pilot: true }), 'pilot');
  const nodes = [
    { plan: 'p', session: 'A', status: 'waiting', waitingFor: 'pilot', kept: 'reply' },
    { plan: 'p', session: 'B', status: 'waiting', waitingFor: 'pilot', kept: 'permission' },
    { plan: 'p', session: 'C', status: 'waiting', waitingFor: 'dev', human: true },
    { plan: 'p', session: 'R', status: 'done', waitingFor: 'pilot', kept: 'review' },
  ];
  const reviews = [{ id: 'rv', plan: 'p', session: 'R', additions: 10, deletions: 0 }];
  assert.deepEqual(items({ nodes, reviews, pilot: true }).map((x) => x.s), ['C'], 'without withKept: as before');
  const all = items({ nodes, reviews, pilot: true, withKept: true });
  assert.deepEqual(all.filter((x) => !x.kept).map((x) => x.s), ['C']);
  assert.deepEqual(all.filter((x) => x.kept).map((x) => [x.s, x.kind]), [['A', 'reply'], ['B', 'permission'], ['R', 'review']], 'each once');
  // pilot off: the server says 'dev' and the same nodes are the developer's, nothing kept
  const offNodes = [{ plan: 'p', session: 'A', status: 'waiting', waitingFor: 'dev' }, { plan: 'p', session: 'C', status: 'waiting', waitingFor: 'dev', human: true }];
  const off = items({ nodes: offNodes, reviews: [], pilot: false, withKept: true });
  assert.deepEqual(off.map((x) => [x.s, !!x.kept]), [['A', false], ['C', false]]);
});
