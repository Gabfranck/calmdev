// The backlog page (lib/backlog.mjs, docs/backlog-page.md): the file read and written back without losing a line nor a
// section, check / add / move, and « Ajouter à un plan »: a session in the wave after the launched ones, the launched
// sessions unchanged, the line keeping the link of its session and checked at the merge. Throwaway projects in $TMPDIR.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as bl from '../lib/backlog.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REAL = readFileSync(path.join(HERE, '..', 'docs', 'backlog.md'), 'utf8');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const SAMPLE = '# Backlog\n\nIntro.\n\n- [ ] Un\n- [ ] Deux\n  suite de deux\n- [x] Fait\n\n## Repris\n\n### Le fil · `plans/retired/2026-11-02-le-fil.json`\n\n- [ ] (session MD, todo) Le Markdown du fil\n- [ ] Trois\n';

test('the real docs/backlog.md: every line and section survives a read, a check and its undo', () => {
  const d = bl.parseDoc(REAL);
  // the sizes are the private backlog's (public-manifest.json never leaves); the public one is a short rewrite
  if (existsSync(path.join(HERE, '..', 'public-manifest.json'))) {
    assert.ok(d.items.filter((x) => !x.done).length > 100); assert.ok(d.sections.length > 10);
    assert.ok(d.items.some((x) => x.link?.startsWith('plans/retired/')));
  } else assert.ok(Array.isArray(d.items)); // the public backlog may hold no line at all
  for (const it of d.items.slice(0, 40)) assert.equal(bl.toggle(bl.toggle(REAL, it.line, it.md), it.line, bl.parseDoc(bl.toggle(REAL, it.line, it.md)).items.find((x) => x.line === it.line).md), REAL);
  for (const it of d.items.filter((x) => !x.done).slice(0, 30)) { const down = bl.move(REAL, it.line, 'down', it.md); assert.equal(down.split('\n').length, REAL.split('\n').length); assert.deepEqual([...down.split('\n')].sort(), [...REAL.split('\n')].sort()); }
});

test('check, add, move: one line changes, sections stay, a stale line is refused', () => {
  const d = bl.parseDoc(SAMPLE);
  assert.deepEqual(d.sections.map((s) => [s.level, s.text, s.link]), [[2, 'Repris', null], [3, 'Le fil', 'plans/retired/2026-11-02-le-fil.json']]);
  assert.equal(d.items[1].end - d.items[1].line, 2); // the wrapped line stays with its bullet
  const un = d.items[0];
  assert.match(bl.toggle(SAMPLE, un.line, un.md), /^- \[x\] Un$/m);
  assert.throws(() => bl.toggle(SAMPLE, un.line, '- [ ] autre'), (e) => e.code === 409);
  const added = bl.add(SAMPLE, '  Quatre\n idée ');
  assert.equal(added, SAMPLE.replace('- [x] Fait\n', '- [x] Fait\n- [ ] Quatre idée\n'));
  assert.throws(() => bl.add(SAMPLE, '  '), (e) => e.code === 400);
  const moved = bl.move(SAMPLE, d.items[1].line, 'up', d.items[1].md);
  assert.match(moved, /- \[ \] Deux\n {2}suite de deux\n- \[ \] Un\n/);
  assert.equal(bl.move(moved, 0 + bl.parseDoc(moved).items[2].line, 'down', bl.parseDoc(moved).items[2].md), moved, 'never across a heading');
  const md = d.items.find((x) => x.text.startsWith('(session MD'));
  assert.equal(bl.move(SAMPLE, md.line, 'up', md.md), SAMPLE, 'the first of its section stays');
});

test('attach and tick: the link written on the line, checked at the merge of its session only', () => {
  const it = bl.parseDoc(SAMPLE).items[0];
  const t = bl.attach(SAMPLE, it.line, it.md, { plan: 'p1', session: 'UN' });
  const a = bl.parseDoc(t).items[0];
  assert.deepEqual(a.attached, { plan: 'p1', session: 'UN' }); assert.equal(a.text, 'Un');
  assert.equal(bl.tickAttached(t, 'p1', 'OTHER'), t);
  assert.equal(bl.parseDoc(bl.tickAttached(t, 'p1', 'UN')).items[0].done, true);
});

test('nearest plan and brief: shared files first; a retired line takes its session prompt', () => {
  const plans = [{ id: 'a', title: 'Les réglages', sessions: [{ name: 's', where: 'public/access.js', prompt: '' }] }, { id: 'b', title: 'Le fil et les mots', sessions: [{ name: 'Markdown', where: 'public/md.js', prompt: '' }] }];
  const near = bl.nearestPlans({ text: 'Le Markdown du fil : public/md.js rend mal les tableaux' }, plans);
  assert.equal(near[0].id, 'b'); assert.match(near[0].why, /public\/md\.js/);
  const bySection = bl.nearestPlans({ text: '(session DEV, waiting) La réponse devinée' }, [plans[1], plans[0]], 'Le fil et les mots, en quatre sessions');
  assert.equal(bySection[0].id, 'b', 'the section title counts'); assert.ok(bySection[0].score > 0); assert.equal(bySection[1].score, 0);
  const item = bl.parseDoc(SAMPLE).items.find((x) => x.text.startsWith('(session MD'));
  const retired = { sessions: [{ id: 'MD', name: 'Markdown du fil', prompt: 'LE RÉSULTAT. Les tableaux.\n\n## Suivi, obligatoire à la fin\nbloc' }] };
  const { session } = bl.sessionFor({ id: 'b', sessions: [{ id: 'A', wave: 1, path: '/p' }] }, [{ id: 'A', status: 'running' }], item, { retired });
  assert.equal(session.id, 'MD'); assert.equal(session.wave, 2); assert.equal(session.prompt, 'LE RÉSULTAT. Les tableaux.');
  const plain = bl.sessionFor({ id: 'b', sessions: [{ id: 'A', wave: 1, path: '/p' }] }, [{ id: 'A', status: 'running' }], bl.parseDoc(SAMPLE).items[0]).session;
  for (const h of ['LE RÉSULTAT.', 'LE POURQUOI.', 'LES FAITS.', 'LE TERRAIN.', 'LES EXIGENCES.', 'LES CRITÈRES DE FIN.', "LA LIVRAISON ET L'ARRÊT."]) assert.ok(plain.prompt.includes(h), h);
});

test('the routes: page edits, and a line attached to a launched plan adds a wave-2 session without touching the launched one', async () => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const own = tmp('escadrille-bkl-srv-'); const root = tmp('escadrille-bkl-');
  mkdirSync(path.join(root, 'docs')); writeFileSync(path.join(root, 'docs', 'backlog.md'), SAMPLE);
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(own, 'db.sqlite'), ESCADRILLE_PLANS: own, ESCADRILLE_TRANSCRIPTS: own, ESCADRILLE_SESSIONS: own }, stdio: 'ignore' });
  after(() => proc.kill('SIGKILL'));
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/plans'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const get = async (p) => (await fetch(base + p)).json();
  const file = () => readFileSync(path.join(root, 'docs', 'backlog.md'), 'utf8');

  let doc = await get('/api/project/backlog/doc?project=' + encodeURIComponent(root));
  assert.equal(doc.exists, true); assert.equal(doc.items.length, 5); assert.equal(doc.sections.length, 2);
  let r = await post('/api/project/backlog/edit', { project: root, op: 'toggle', line: doc.items[0].line, md: doc.items[0].md });
  assert.equal(r.status, 200); assert.equal(r.body.items[0].done, true);
  r = await post('/api/project/backlog/edit', { project: root, op: 'toggle', line: doc.items[0].line, md: doc.items[0].md });
  assert.equal(r.status, 409, 'the page saw an older line');
  r = await post('/api/project/backlog/edit', { project: root, op: 'toggle', line: doc.items[0].line, md: '- [x] Un' });
  assert.equal(file(), SAMPLE, 'checked then unchecked: the file is byte for byte the same');
  r = await post('/api/project/backlog/edit', { project: root, op: 'add', text: 'Cinq' }); assert.equal(r.body.items.length, 6);
  r = await post('/api/project/backlog/edit', { project: root, op: 'move', line: r.body.items[1].line, md: r.body.items[1].md, dir: 'up' });
  assert.deepEqual(r.body.items.slice(0, 2).map((x) => x.text), ['Deux suite de deux', 'Un']);

  const plan = { project: root, title: 'Le fil et les mots', goal: 'g', sessions: [{ id: 'A', wave: 1, name: 'Le fil', where: 'public/md.js', path: root, budget: 3, stops: ['Fin'], prompt: 'Touche public/md.js' }] };
  r = await post('/api/plan', plan); assert.equal(r.status, 200); const pid = r.body.id;
  const db = new DatabaseSync(path.join(own, 'db.sqlite')); db.prepare('update sessions set status = ? where plan = ? and id = ?').run('running', pid, 'A'); db.close();
  doc = await get('/api/project/backlog/doc?project=' + encodeURIComponent(root));
  assert.deepEqual(doc.plans.map((p) => p.id), [pid]);
  const line = doc.items.find((x) => x.text.startsWith('(session MD'));
  const near = await get(`/api/project/backlog/nearest?project=${encodeURIComponent(root)}&line=${line.line}`);
  assert.equal(near.plans[0].id, pid);
  r = await post('/api/project/backlog/attach', { project: root, line: line.line, md: line.md, plan: pid });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.wave, 2);
  const saved = JSON.parse(readFileSync(path.join(own, pid + '.json'), 'utf8'));
  assert.deepEqual(saved.sessions.map((s) => [s.id, s.wave]), [['A', 1], [r.body.session, 2]]);
  assert.equal(saved.sessions[0].prompt, 'Touche public/md.js', 'the launched session is unchanged');
  assert.match(file(), new RegExp(`\\(session MD, todo\\) Le Markdown du fil · session \`${r.body.session}\` du plan \`${pid}\``));
  assert.deepEqual(r.body.items.find((x) => x.line === line.line).attached, { plan: pid, session: r.body.session });
  assert.equal((await post('/api/project/backlog/attach', { project: root, line: line.line, plan: pid })).status, 409, 'attached once');
  // a launched plan refuses any change of its launched session
  r = await post('/api/plan', { ...saved, project: root, sessions: [{ ...saved.sessions[0], prompt: 'autre' }, saved.sessions[1]] });
  assert.equal(r.status, 409);
});
