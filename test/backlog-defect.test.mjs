// The defect mode of POST /api/project/backlog (lib/burst.mjs appendDefect): appended to an existing file, created when
// missing, empty text refused, one line and cut, the 409 of the other modes kept. Only throwaway projects in $TMPDIR.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as burst from '../lib/burst.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const project = (backlog) => { const root = tmp('escadrille-defect-'); if (backlog !== undefined) { mkdirSync(path.join(root, 'docs')); writeFileSync(path.join(root, 'docs', 'backlog.md'), backlog); } return root; };
const fileOf = (root) => readFileSync(path.join(root, 'docs', 'backlog.md'), 'utf8');
const HEAD = "# Backlog\n\nUne tâche par ligne, dans l'ordre ; « - [x] » quand elle est faite.\n\n";

test('appendDefect: appends to an existing file, with and without a screen', () => {
  const root = project('# Backlog\n\n- [ ] Une tâche\n');
  const r = burst.appendDefect(root, { text: 'Le bouton ne répond pas', screen: 'Accueil' });
  burst.appendDefect(root, { text: 'Sans écran' });
  assert.equal(fileOf(root), '# Backlog\n\n- [ ] Une tâche\n- [ ] Défaut (Accueil) : Le bouton ne répond pas\n- [ ] Défaut : Sans écran\n');
  assert.equal(r.exists, true); assert.equal(r.tasks.length, 2); assert.equal(r.tasks[1].text, 'Défaut (Accueil) : Le bouton ne répond pas');
});

test('appendDefect: a file without a final newline gets one before the line', () => {
  const root = project('- [ ] a');
  burst.appendDefect(root, { text: 'b' });
  assert.equal(fileOf(root), '- [ ] a\n- [ ] Défaut : b\n');
});

test('appendDefect: creates the file with the header of createBacklog', () => {
  const root = project();
  const r = burst.appendDefect(root, { text: 'premier', screen: '' });
  assert.equal(fileOf(root), HEAD + '- [ ] Défaut : premier\n');
  assert.deepEqual(r.tasks.map((t) => t.text), ['Défaut : premier']);
  const via = project(); writeFileSync(path.join(via, 'ROADMAP.md'), '## Phase 1\n- un\n'); burst.createBacklog(via, { from: 'roadmap' });
  assert.ok(fileOf(via).startsWith(HEAD), 'same header');
});

test('appendDefect: empty text throws and writes nothing', () => {
  const root = project('- [ ] a\n');
  for (const text of [undefined, null, '', '  \n\t ']) assert.throws(() => burst.appendDefect(root, { text }), /vide/);
  assert.equal(fileOf(root), '- [ ] a\n');
  const none = project(); assert.throws(() => burst.appendDefect(none, { text: ' ' })); assert.throws(() => fileOf(none));
});

test('appendDefect: newlines become spaces, text cut at 300, screen at 40', () => {
  const root = project('');
  burst.appendDefect(root, { text: 'ligne un\nligne deux\r\n\nligne trois', screen: 'a\nb' });
  burst.appendDefect(root, { text: 'x'.repeat(500), screen: 'é'.repeat(80) });
  const lines = fileOf(root).trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '- [ ] Défaut (a b) : ligne un ligne deux ligne trois');
  assert.equal(lines[1], `- [ ] Défaut (${'é'.repeat(40)}) : ${'x'.repeat(300)}`);
});

test('the route: defect appends, never 409; empty text 400; the other modes keep their 409', async () => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const own = tmp('escadrille-defect-srv-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(own, 'db.sqlite'), ESCADRILLE_PLANS: own, ESCADRILLE_TRANSCRIPTS: own, ESCADRILLE_SESSIONS: own }, stdio: 'ignore' });
  after(() => proc.kill('SIGKILL'));
  const post = async (body) => { const r = await fetch(base + '/api/project/backlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/plans'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const root = project();
  let r = await post({ project: root, from: 'defect', text: 'Un défaut', screen: 'Réglages' });
  assert.equal(r.status, 200); assert.equal(r.body.exists, true); assert.equal(r.body.file, path.join(root, 'docs', 'backlog.md'));
  assert.deepEqual(r.body.tasks.map((t) => t.text), ['Défaut (Réglages) : Un défaut']);
  r = await post({ project: root, from: 'defect', text: 'Deux\navec retour' });
  assert.equal(r.status, 200); assert.equal(r.body.tasks.length, 2);
  assert.equal(fileOf(root).endsWith('- [ ] Défaut : Deux avec retour\n'), true);
  assert.equal((await post({ project: root, from: 'defect', text: '  ' })).status, 400);
  assert.equal((await post({ project: root, from: 'defect' })).status, 400);
  for (const from of ['text', 'roadmap', 'memory']) assert.equal((await post({ project: root, from, text: 'x' })).status, 409, from);
  assert.equal(r.body.tasks.length, 2);
});
