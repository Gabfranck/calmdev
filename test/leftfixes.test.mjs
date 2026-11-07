// A fix left to apply by hand (Dev, 2026-11-03 19:45): seen in a folder, open until its status line says it is handled,
// a line of « À toi » (public/todo.js) and of the Flot (lib/projectflow.mjs storyParts), the text that holds a session's end,
// and the rule every session receives (lib/planner.mjs BUTTON_RULE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidatesIn, fixesIn, openFixesIn, statusOf, leftFixesOf, fixesRefusal } from '../lib/leftfixes.mjs';
import { items } from '../lib/todo.mjs';
import { storyParts } from '../lib/projectflow.mjs';
import { BUTTON_RULE } from '../lib/planner.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'fixes-'));

test('the status line: open by default, applied or handed to the pilot, in French or English, only in a patch preamble', () => {
  assert.equal(statusOf('# Correctif\n\nTrois lignes à changer.'), 'open');
  assert.equal(statusOf('# C\n\nStatut : appliqué (8eb9924)'), 'applied');
  assert.equal(statusOf('# C\n\n**Statut** : confié au pilote'), 'pilot');
  assert.equal(statusOf('Status: applied in abc'), 'applied');
  assert.equal(statusOf('Status: handed to the pilot'), 'pilot');
  assert.equal(statusOf('Subject: x\n\ndiff --git a/x b/x\n+Statut : appliqué'), 'open', 'a line inside the diff is code, not a status');
  assert.equal(statusOf('Le statut sera appliqué demain'), 'open', 'prose is not a status line');
});

test('a folder: docs/correctif-*.md and the patches of .escadrille/, one folder deep; the rest ignored', () => {
  const d = tmp();
  put(d, 'docs/correctif-server.md', '# Correctif server\n');
  put(d, 'docs/correctif-old.md', '# Ancien\n\nStatut : appliqué (abc1234)\n');
  put(d, 'docs/notes.md', '# Pas un correctif\n');
  put(d, '.escadrille/route.patch', 'Subject: [PATCH] the route\n\ndiff --git a/s b/s\n');
  put(d, '.escadrille/nom/server.patch', 'Statut : confié au pilote\ndiff --git a/s b/s\n');
  put(d, '.escadrille/a/b/deep.patch', 'diff --git a/s b/s\n');
  assert.deepEqual(candidatesIn(d), ['.escadrille/nom/server.patch', '.escadrille/route.patch', 'docs/correctif-old.md', 'docs/correctif-server.md']);
  assert.deepEqual(fixesIn(d).map((f) => [f.file, f.status]), [['.escadrille/nom/server.patch', 'pilot'], ['.escadrille/route.patch', 'open'], ['docs/correctif-old.md', 'applied'], ['docs/correctif-server.md', 'open']]);
  assert.deepEqual(openFixesIn(d).map((f) => f.title), ['the route', 'Correctif server']);
  assert.deepEqual(fixesIn(path.join(d, 'nowhere')), []);
});

test('a project and its worktrees: the root tells a shared file once, a worktree adds its own with its session', () => {
  const root = tmp(); const wt = tmp();
  put(root, 'docs/correctif-a.md', '# A\n'); put(wt, 'docs/correctif-a.md', '# A\n');
  put(root, 'docs/correctif-b.md', '# B\nStatut : appliqué (1)\n'); put(wt, 'docs/correctif-b.md', '# B\n'); // handled at the root wins
  put(wt, '.escadrille/c.patch', 'Subject: C\n');
  assert.deepEqual(leftFixesOf({ root, worktrees: [{ plan: 'p', session: 'S', path: wt }, { plan: 'p', session: 'T' }] }), [
    { file: 'docs/correctif-a.md', title: 'A', plan: null, session: null },
    { file: '.escadrille/c.patch', title: 'C', plan: 'p', session: 'S' },
  ]);
});

const NOM = path.join(HERE, '..', 'docs', 'correctif-server-nom-projet.md');
test('the fix left by the session NOM is said applied: Escadrille itself shows no open fix in docs/', { skip: !existsSync(NOM) && 'the fix file stays in the private repository' }, () => {
  assert.equal(statusOf(readFileSync(path.join(HERE, '..', 'docs', 'correctif-server-nom-projet.md'), 'utf8')), 'applied');
  assert.deepEqual(openFixesIn(path.join(HERE, '..')).filter((f) => f.file.startsWith('docs/')), []);
});

test('« À toi » has one line per open fix, even with a pilot; the Flot says how many wait', () => {
  const fixes = [{ file: 'docs/correctif-a.md', title: 'A', plan: 'p', session: 'S' }, { file: '.escadrille/c.patch', title: 'C', plan: null, session: null }];
  const lines = items({ fixes, pilot: true }).filter((i) => i.kind === 'fix');
  assert.deepEqual(lines, [{ kind: 'fix', s: 'S', plan: 'p', file: 'docs/correctif-a.md', title: 'A', act: 'open' }, { kind: 'fix', s: null, plan: null, file: '.escadrille/c.patch', title: 'C', act: 'open' }]);
  assert.deepEqual(items({}).filter((i) => i.kind === 'fix'), []);
  const story = storyParts({ plans: [], nodes: [], edges: [], fixes });
  assert.equal(story.length, 1); assert.match(story[0], /2/);
  assert.deepEqual(storyParts({ plans: [], nodes: [], edges: [] }), []);
  for (const lang of ['fr', 'en']) { const d = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', `${lang}.json`), 'utf8')); for (const k of ['srv.f.fix1', 'srv.f.fixN', 'main.todo.fix', 'main.todo.whyFix']) assert.ok(d[k], `${lang} ${k}`); }
});

test('a session that says itself done with an open fix is told which, and how to hand it over', () => {
  const t = fixesRefusal([{ file: 'docs/correctif-a.md' }]);
  assert.match(t, /docs\/correctif-a\.md/); assert.match(t, /Statut : confié au pilote/); assert.match(t, /Statut : appliqué/);
  assert.match(fixesRefusal([{ file: 'a' }, { file: 'b' }]), /2 correctifs/);
});

test('every session is told: a visible button works or is hidden, the review and the robot check it', () => {
  assert.match(BUTTON_RULE, /Chaque bouton visible est relié à un comportement qui marche, sinon il est caché/);
  assert.match(BUTTON_RULE, /revue/); assert.match(BUTTON_RULE, /BOUTON MORT/);
  const skill = readFileSync(path.join(HERE, '..', '.claude', 'skills', 'plan', 'SKILL.md'), 'utf8');
  assert.match(skill, /chaque bouton visible est relié à un comportement qui marche, sinon il est caché/);
  assert.ok(readFileSync(path.join(HERE, '..', 'lib', 'planner.mjs'), 'utf8').includes("systemPrompt ? BUTTON_RULE : ''"), 'the rule rides every session prompt');
});
