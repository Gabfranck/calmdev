// The single entry conversation (docs/entry.md): routing without a model, the question when in doubt, the correction,
// a fake model for the rest; the HTTP routes mounted on a node:http of the test's own (server.mjs is not needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import * as entry from '../lib/entry.mjs';
import * as mainchat from '../lib/mainchat.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
const mk = (name, { readme, remote } = {}) => {
  const dir = path.join(tmp, name); fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), remote ? `[remote "origin"]\n\turl = git@github.com:${remote}.git\n` : '');
  if (readme) fs.writeFileSync(path.join(dir, 'README.md'), readme);
  return dir;
};
const AQ = mk('Orchard', { readme: '# Orchard\n\nDes quiz en classe, en direct, pour les professeurs.\n', remote: 'Gabfranck/orchard-server' });
const ESC = mk('escadrille', { readme: '# Escadrille\n\nPiloter des sessions Claude Code en parallèle.\n' });
const HP = mk('Harbor', { readme: '# Harbor\n\nLe site de la mission, ses mails de support.\n' });
const PROJECTS = [{ path: AQ }, { path: ESC }, { path: HP }];

const setup = ({ answer = null, fail = false, settings = {}, pilot = true } = {}) => {
  const db = new DatabaseSync(':memory:'); mainchat.schema(db);
  const asked = []; const said = []; let clock = Date.parse('2026-11-02T21:00:00Z');
  const e = entry.create({
    db, projects: () => PROJECTS, settingsOf: (p) => settings[p] || {},
    memoryOf: (p) => ({ lines: p === AQ ? [{ n: 1, text: '- Les groupes se suppriment depuis le tableau de bord' }] : [] }),
    ask: async (o) => { asked.push(o); if (fail) throw new Error('hors ligne'); return { text: typeof answer === 'function' ? answer(o) : answer, cost: 0.004 }; },
    forward: (project, text) => mainchat.addMessage(db, { project, role: 'dev', text, source: 'entry' }),
    say: (project, text) => { said.push({ project, text }); mainchat.addMessage(db, { project, role: 'system', text, source: 'entry' }); },
    pilotOn: () => pilot, now: () => new Date(clock),
  });
  return { db, e, asked, said, tick: (ms) => { clock += ms; } };
};
const mainOf = (db, p) => db.prepare('select role, text, source from main_messages where project = ? order by seq').all(p).map((r) => ({ ...r }));

test('without a model: a name, an alias, a path, a repository', async () => {
  const { e, db, asked } = setup({ settings: { [HP]: { aliases: ['la mission'] } } });
  let m = await e.post('Dans Orchard, corrige la suppression de groupe');
  assert.equal(m.project, AQ); assert.equal(m.how, 'name'); assert.equal(m.status, 'sent');
  assert.deepEqual(mainOf(db, AQ), [{ role: 'dev', text: 'Dans Orchard, corrige la suppression de groupe', source: 'entry' }]);
  m = await e.post('Réponds aux mails de support de la mission'); assert.equal(m.project, HP); assert.equal(m.how, 'alias');
  m = await e.post(`regarde ${ESC}/lib/pilot.mjs, la ligne 40`); assert.equal(m.project, ESC); assert.equal(m.how, 'path');
  m = await e.post('le build de Gabfranck/orchard-server casse'); assert.equal(m.project, AQ); assert.equal(m.how, 'repo');
  assert.equal(asked.length, 0, 'aucun appel de modèle');
});

test('without a model: the obvious follow-up keeps the last project, for ten minutes', async () => {
  const { e, asked, tick } = setup({ answer: '{"project":"none","confidence":0.9,"answer":"ok"}' });
  await e.post('Dans Harbor, ajoute les mails à l’accueil');
  tick(60000); let m = await e.post('et aussi le lien de désinscription'); assert.equal(m.project, HP); assert.equal(m.how, 'follow');
  tick(11 * 60000); m = await e.post('et aussi le pied de page'); assert.notEqual(m.how, 'follow'); assert.equal(asked.length, 1);
});

test('the fake model routes when it is sure; its prompt holds the projects, their summary and memory, never more', async () => {
  const { e, asked } = setup({ answer: 'Voici : {"project":"Orchard","second":"Harbor","confidence":0.86}' });
  const m = await e.post('corrige la suppression de groupe');
  assert.equal(m.project, AQ); assert.equal(m.how, 'model'); assert.equal(m.waiting, true);
  const o = asked[0]; assert.equal(o.model, entry.MODEL); assert.ok(o.budget <= 0.02);
  assert.match(o.prompt, /Des quiz en classe/); assert.match(o.prompt, /Les groupes se suppriment/); assert.match(o.prompt, /### Harbor/);
  assert.match(o.systemPrompt, /aucun outil/);
});

test('in doubt: one question, the two likely projects, the first recommended; nothing leaves before the click', async () => {
  const { e, db } = setup({ answer: '{"project":"Harbor","second":"Orchard","confidence":0.55}' });
  const m = await e.post('ajoute les mails à l’accueil');
  assert.equal(m.status, 'ask'); assert.deepEqual(m.choices.map((c) => c.name), ['Harbor', 'Orchard']);
  assert.equal(mainOf(db, HP).length + mainOf(db, AQ).length, 0);
  const c = e.choose(m.seq, HP); assert.equal(c.status, 'sent'); assert.equal(c.how, 'asked');
  assert.equal(mainOf(db, HP)[0].source, 'entry');
});

test('two projects named: no choice without a model; the model unreachable: still one question, never a lost request', async () => {
  const { e, asked } = setup({ fail: true });
  const m = await e.post('copie le thème de Harbor dans Orchard');
  assert.equal(asked.length, 1); assert.match(asked[0].prompt, /cite plusieurs projets : Orchard, Harbor/);
  assert.equal(m.status, 'ask'); assert.deepEqual(m.choices.map((c) => c.name).sort(), ['Orchard', 'Harbor'].sort()); // sorted both sides: the public export renames them
});

test('a name outside the list is « not sure »; a general question stays in the entry with its answer', async () => {
  let s = setup({ answer: '{"project":"Inconnu","confidence":0.99}' });
  assert.equal((await s.e.post('fais le truc')).status, 'ask');
  s = setup({ answer: '{"project":"none","confidence":0.9,"answer":"Opus pour le code difficile, Haiku pour le tri."}' });
  const m = await s.e.post('quel modèle pour quoi ?');
  assert.equal(m.status, 'general'); assert.equal(m.project, null); assert.match(m.answer, /Haiku pour le tri/);
});

test('the answer comes back from the project main conversation, until the next developer message', async () => {
  const { e, db } = setup({ pilot: false });
  const m = await e.post('Dans Orchard, corrige la suppression de groupe');
  assert.equal(m.pilotOff, true);
  mainchat.addMessage(db, { project: AQ, role: 'claude', text: 'Corrigé : la suppression vérifie le propriétaire.', source: 'pilot:x' });
  mainchat.addMessage(db, { project: AQ, role: 'dev', text: 'autre chose', source: 'page' });
  mainchat.addMessage(db, { project: AQ, role: 'claude', text: 'réponse à autre chose', source: 'pilot:x' });
  const v = e.view(m.seq);
  assert.deepEqual(v.replies.map((r) => r.text), ['Corrigé : la suppression vérifie le propriétaire.']); assert.equal(v.waiting, false);
});

test('the correction: « pas ce projet » sends it to the right one, notes it in the old thread, and teaches the next routing', async () => {
  const { e, db, said, asked } = setup({ answer: '{"project":"Orchard","confidence":0.8}' });
  const m = await e.post('ajoute les mails à l’accueil');
  assert.equal(m.project, AQ);
  const c = e.choose(m.seq, HP);
  assert.equal(c.project, HP); assert.equal(c.how, 'corrected');
  assert.equal(said[0].project, AQ); assert.match(said[0].text, /déplacée vers Harbor/);
  assert.equal(mainOf(db, HP)[0].text, 'ajoute les mails à l’accueil');
  await e.post('ajoute un mail de bienvenue');
  assert.match(asked[1].prompt, /Corrections du développeur[\s\S]*pas Orchard, mais Harbor/);
  assert.throws(() => e.choose(m.seq, '/nulle/part'), /projet inconnu/);
});

test('the HTTP routes: POST, GET, choose, refusals', async () => {
  const { e } = setup({ answer: '{"project":"Harbor","second":"Orchard","confidence":0.4}' });
  const srv = http.createServer((req, res) => e.route(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', body: JSON.stringify(body) } : {}); return { code: r.status, j: await r.json() }; };
  try {
    assert.equal((await call('/api/entry', { text: '  ' })).code, 400);
    const a = await call('/api/entry', { text: 'ajoute les mails' }); assert.equal(a.j.message.status, 'ask');
    const b = await call('/api/entry/choose', { seq: a.j.message.seq, project: HP }); assert.equal(b.j.message.name, 'Harbor');
    const g = await call('/api/entry'); assert.equal(g.j.messages[0].project, HP); assert.equal(g.j.projects.length, 3); assert.equal(g.j.more, false);
    assert.equal((await call('/api/entry/choose', { seq: 999, project: HP })).code, 404);
  } finally { srv.close(); }
});

test('reposOf and summaryOf read the project folder only', () => {
  assert.deepEqual(entry.reposOf(AQ), ['Gabfranck/orchard-server', 'orchard-server']);
  assert.equal(entry.summaryOf(ESC), 'Piloter des sessions Claude Code en parallèle.');
  assert.equal(entry.summaryOf(path.join(tmp, 'absent')), '');
});
