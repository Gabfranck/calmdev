// The Communication screen (lib/comm.mjs): the index of comm/, the recap figures, and the file route that refuses
// every path outside comm/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { resolveIn, indexOf, phasesOf, plansOf, saleOf, route } from '../lib/comm.mjs';

const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'comm-')));
  const c = path.join(root, 'comm');
  mkdirSync(path.join(c, 'visuals', 'src'), { recursive: true }); mkdirSync(path.join(c, 'pdf'));
  writeFileSync(path.join(c, 'PUBLIER.md'), '# Publier\n\n- [ ] le push\n- [x] la landing\n');
  writeFileSync(path.join(c, 'article.fr.md'), '# Le titre FR\n\nLa première ligne.\nLa deuxième.\n\nPlus loin.\n');
  writeFileSync(path.join(c, 'article.en.md'), '# The EN title\n\nFirst line.\n');
  writeFileSync(path.join(c, 'x.md'), '## 1\n\nSaturday night <script>alert(1)</script> I gave **Claude** one paragraph.\n');
  writeFileSync(path.join(c, 'visuals', 'x-fr.png'), 'png'); writeFileSync(path.join(c, 'visuals', 'x-fr-dark.png'), 'png');
  writeFileSync(path.join(c, 'visuals', 'og-en.png'), 'png'); writeFileSync(path.join(c, 'visuals', 'src', 'x-fr.html'), '<p>x</p>');
  writeFileSync(path.join(c, 'pdf', 'article.fr.pdf'), '%PDF');
  writeFileSync(path.join(root, 'secret.txt'), 'secret');
  symlinkSync(path.join(root, 'secret.txt'), path.join(c, 'link.txt'));
  return { root, c };
};

test('resolveIn keeps a path inside comm/ and refuses the rest', () => {
  const { c } = fixture();
  assert.ok(resolveIn(c, 'visuals/x-fr.png').endsWith('/comm/visuals/x-fr.png'));
  for (const bad of ['../secret.txt', 'visuals/../../secret.txt', '/etc/passwd', '', 'link.txt', 'visuals', 'nope.png', 'a\0b', null]) assert.equal(resolveIn(c, bad), null, String(bad));
});

test('indexOf: channels in publishing order with their languages, visuals paired by theme, head docs first', () => {
  const { c } = fixture();
  const ix = indexOf(c);
  assert.equal(ix.exists, true);
  assert.deepEqual(ix.head.map((h) => h.file), ['PUBLIER.md']);
  assert.deepEqual(ix.channels.map((x) => x.id), ['article', 'x']);
  assert.deepEqual(Object.keys(ix.channels[0].langs).sort(), ['en', 'fr']);
  assert.equal(ix.channels[0].langs.fr.title, 'Le titre FR');
  assert.equal(ix.channels[0].langs.fr.excerpt, 'La première ligne. La deuxième. Plus loin.', 'short paragraphs read on to about 120 characters');
  assert.ok(!ix.channels[1].langs.any.html.includes('<script>'), 'the Markdown is escaped');
  assert.deepEqual(ix.visuals.map((g) => g.id), ['x', 'og']);
  assert.deepEqual(ix.visuals[0].pairs, [{ lang: 'fr', light: 'visuals/x-fr.png', dark: 'visuals/x-fr-dark.png' }]);
  assert.deepEqual(ix.sources, ['visuals/src/x-fr.html']);
  assert.equal(ix.pdfs[0].lang, 'fr');
  assert.equal(indexOf(path.join(c, 'none')).exists, false);
});

test('phasesOf: ROADMAP headings marked done, « Phase N: » commits and merged phase branches', () => {
  const roadmap = '## Phase 0 : la graine (faite le 2026-10-31)\n## Phase 1 : le nom\n## Phase 2 : le flot, faite le 2026-11-01\n## Phase 15 : plus tard\n';
  assert.deepEqual(phasesOf(roadmap, ['Phase 1: the chat', 'Merge escadrille/2026-11-05-phase-14-le-pilote/RAF: x', 'Merge branch main']), [0, 1, 2, 14]);
});

test('plansOf and saleOf read the base: launched, merged, and a sale plan prepared but not launched', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table plans (id text primary key, title text, created text, json text, project text); create table sessions (plan text, id text, status text, session_id text, worktree text)');
  db.prepare('insert into plans values (?,?,?,?,?)').run('p1', 'Phase 1', '', '{}', '/p');
  db.prepare('insert into plans values (?,?,?,?,?)').run('2026-11-06-vendre-escadrille-equipe', 'Vendre Escadrille', '', '{}', '/p');
  db.prepare('insert into sessions values (?,?,?,?,?)').run('p1', 'A', 'done', 'u1', JSON.stringify({ merged: true }));
  db.prepare('insert into sessions values (?,?,?,?,?)').run('p1', 'B', 'running', 'u2', JSON.stringify({ merged: false }));
  db.prepare('insert into sessions values (?,?,?,?,?)').run('2026-11-06-vendre-escadrille-equipe', 'A', 'todo', null, null);
  assert.deepEqual(plansOf(db, '/p'), { launched: 1, merged: 1, sessions: 2, sessionsMerged: 1 });
  assert.deepEqual(saleOf(db, '/p', null), { state: 'planned', plan: '2026-11-06-vendre-escadrille-equipe', title: 'Vendre Escadrille', onSale: false });
  assert.equal(saleOf(db, '/other', null).state, 'unknown', 'no plan of the project in the base: unknown');
  assert.equal(plansOf(db, '/other').sessions, null, 'no plan: unknown, never 0');
});

test('the file route serves comm/ only, and only for a known project', async () => {
  const { root } = fixture();
  const srv = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); route(req, res, url, { db: null, publicDir: '/nowhere', plansDir: null, known: (p) => p === root, sessions: [] }); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, project = root) => fetch(`${base}/api/comm/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(p)}`);
  try {
    const ok = await get('visuals/x-fr.png'); assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/png');
    const html = await get('visuals/src/x-fr.html'); assert.equal(html.headers.get('content-security-policy'), 'sandbox');
    for (const bad of ['../secret.txt', '..%2Fsecret.txt', '/etc/passwd', 'link.txt', 'visuals/../../secret.txt']) assert.equal((await get(bad)).status, 403, bad);
    const raw = await fetch(`${base}/api/comm/file?project=${encodeURIComponent(root)}&path=../secret.txt`); assert.equal(raw.status, 403);
    assert.equal((await get('PUBLIER.md', '/etc')).status, 404, 'an unknown project is refused');
    assert.equal((await get('PUBLIER.md', 'relative')).status, 400);
    assert.equal((await fetch(`${base}/api/comm/file?project=${encodeURIComponent(root)}&path=PUBLIER.md`, { method: 'POST' })).status, 405);
    const ix = await (await fetch(`${base}/api/comm?project=${encodeURIComponent(root)}`)).json();
    assert.equal(ix.exists, true); assert.equal(ix.recap.sale.onSale, false); assert.equal(ix.recap.cost, null, 'no commit, no cost: never invented');
  } finally { srv.close(); }
});
