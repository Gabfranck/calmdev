// The guessed reply (lib/suggest.mjs): the order of the sources, the learning, the route, on a throwaway database
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as suggest from '../lib/suggest.mjs';
import { seed, PLAN } from './seed-suggest.mjs';

const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'suggest-'));
  const db = new DatabaseSync(path.join(dir, 's.sqlite'));
  const plan = seed(db, path.join(dir, 'Mots'));
  const planOf = (id) => { const r = db.prepare('select json from plans where id = ?').get(id); return r && JSON.parse(r.json); };
  return { dir, db, plan, planOf, project: plan.project, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
};
const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();

test('rank: the stop\'s fallback comes first, before any history', () => {
  const r = suggest.rank({ current: { kind: 'review', fallback: ' Validé,  continue. ' }, history: [{ kind: 'review', sent: 'autre', outcome: 'none', at: H(1) }] });
  assert.deepEqual(r, { text: 'Validé, continue.', source: 'fallback', kind: 'review' });
});

test('rank: no fallback → the most frequent reply of the same kind, weighted by recency; long replies never', () => {
  const history = [
    ...[700, 710, 720, 730].map((h) => ({ kind: 'taste', sent: 'Refais la planche', outcome: 'none', at: H(h) })),
    ...[5, 30].map((h) => ({ kind: 'taste', sent: 'termine sur preuves', outcome: 'none', at: H(h) })),
    { kind: 'taste', sent: 'Termine sur preuves.', outcome: 'none', at: H(3) },
    { kind: 'review', sent: 'oui fais-le', outcome: 'none', at: H(1) },
    { kind: 'review', sent: 'oui fais-le', outcome: 'none', at: H(1) },
    { kind: 'taste', sent: 'x'.repeat(suggest.MAX_REPLY + 1), outcome: 'none', at: H(0) },
  ];
  const r = suggest.rank({ current: { kind: 'taste', fallback: null }, history });
  assert.equal(r.source, 'history'); assert.equal(r.text, 'Termine sur preuves.'); // the latest spelling of the winner
});

test('rank: nothing known → nothing, never an invented text', () => {
  assert.equal(suggest.rank({ current: { kind: 'security', fallback: null }, history: [{ kind: 'taste', sent: 'ok', outcome: 'none', at: H(1) }] }), null);
  assert.equal(suggest.rank({ current: null, history: [] }), null);
  assert.equal(suggest.rank({ current: { kind: 'taste' }, history: [{ kind: 'taste', sent: '   ', outcome: 'none', at: H(1) }] }), null);
});

test('learning: three corrections in a row of the same guess yield to the correction; two do not', () => {
  const cur = { kind: 'data', fallback: 'Oui, fais-le.' };
  const corr = (h, sent = 'Non, garde la base', outcome = 'corrected') => ({ kind: 'data', suggestion: 'Oui, fais-le.', sent, outcome, at: H(h) });
  assert.equal(suggest.rank({ current: cur, history: [corr(3), corr(2)] }).source, 'fallback');
  assert.deepEqual(suggest.rank({ current: cur, history: [corr(3), corr(2), corr(1)] }), { text: 'Non, garde la base', source: 'learned', kind: 'data' });
  // typed over (ignored) counts as a correction; an acceptance in between breaks the run
  assert.equal(suggest.rank({ current: cur, history: [corr(3), corr(2, 'Non, garde la base', 'ignored'), corr(1)] }).source, 'learned');
  assert.equal(suggest.rank({ current: cur, history: [corr(4), corr(3), { kind: 'data', suggestion: 'Oui, fais-le.', sent: 'Oui, fais-le.', outcome: 'accepted', at: H(2) }, corr(1)] }).source, 'fallback');
  // another kind's corrections never move this one
  assert.equal(suggest.rank({ current: cur, history: [1, 2, 3].map((h) => ({ ...corr(h), kind: 'taste' })) }).source, 'fallback');
});

test('outcomeOf: accepted as is, corrected after Tab, ignored when typed over, none without a guess', () => {
  assert.equal(suggest.outcomeOf({ suggestion: 'Validé.', sent: 'validé', tabbed: true }), 'accepted');
  assert.equal(suggest.outcomeOf({ suggestion: 'Validé.', sent: 'Validé, mais refais le test', tabbed: true }), 'corrected');
  assert.equal(suggest.outcomeOf({ suggestion: 'Validé.', sent: 'Non', tabbed: false }), 'ignored');
  assert.equal(suggest.outcomeOf({ suggestion: null, sent: 'Non' }), 'none');
});

test('suggestFor on the seeded base: the three typical stops and the main thread', () => {
  const t = fresh();
  try {
    const of = (session) => suggest.suggestFor(t.db, { project: t.project, plan: PLAN, session, planOf: t.planOf });
    assert.deepEqual([of('A').text, of('A').source], ['Validé, continue.', 'fallback']);
    assert.deepEqual([of('B').text, of('B').source], ['Termine sur preuves', 'history']);
    assert.equal(of('C').text, null); assert.equal(of('C').kind, 'security'); // no guess, the kind still comes back for the learning
    assert.deepEqual([of('D').text, of('D').source], ['Non, garde la base', 'learned']);
    const main = suggest.suggestFor(t.db, { project: t.project, planOf: t.planOf }); // the oldest stop waiting
    assert.equal(main.session, 'A'); assert.equal(main.text, 'Validé, continue.');
    assert.equal(suggest.suggestFor(t.db, { project: '/ailleurs', planOf: t.planOf }).text, null);
  } finally { t.done(); }
});

test('record then rank: accepting the learned guess keeps it; the table stays in the local base', () => {
  const t = fresh();
  try {
    assert.equal(suggest.record(t.db, { project: t.project, plan: PLAN, session: 'B', kind: 'taste', suggestion: 'Termine sur preuves', sent: 'Termine sur preuves', tabbed: true }).outcome, 'accepted');
    assert.equal(suggest.record(t.db, { kind: 'taste', sent: '  ' }).outcome, 'skipped');
    assert.equal(suggest.record(t.db, { sent: 'ok' }).outcome, 'skipped');
    const last = t.db.prepare('select kind, suggestion, sent, outcome from suggest_replies order by seq desc limit 1').get();
    assert.deepEqual({ ...last }, { kind: 'taste', suggestion: 'Termine sur preuves', sent: 'Termine sur preuves', outcome: 'accepted' });
    for (let i = 0; i < 3; i++) suggest.record(t.db, { kind: 'taste', suggestion: 'Termine sur preuves', sent: 'Montre la planche', tabbed: false });
    assert.deepEqual(suggest.suggestFor(t.db, { project: t.project, plan: PLAN, session: 'B', planOf: t.planOf }).text, 'Montre la planche');
  } finally { t.done(); }
});

test('route: GET answers one guess per opening, POST records the outcome', async () => {
  const t = fresh();
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await suggest.route(req, res, url, { db: t.db, json, readBody, projectArg: (v) => v, planOf: t.planOf }))) json(res, 404, {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const q = new URLSearchParams({ project: t.project, plan: PLAN, session: 'A' });
    let r = await (await fetch(`${base}/api/suggest?${q}`)).json();
    assert.equal(r.text, 'Validé, continue.'); assert.equal(r.kind, 'review'); assert.equal(r.source, 'fallback');
    r = await (await fetch(`${base}/api/suggest?project=${encodeURIComponent(t.project)}`)).json();
    assert.equal(r.session, 'A');
    assert.equal((await fetch(`${base}/api/suggest?plan=${PLAN}`)).status, 400);
    const post = await fetch(`${base}/api/suggest`, { method: 'POST', body: JSON.stringify({ project: t.project, plan: PLAN, session: 'A', kind: 'review', suggestion: 'Validé, continue.', sent: 'Validé, continue.', tabbed: true }) });
    assert.deepEqual(await post.json(), { ok: true, outcome: 'accepted' });
    assert.equal((await fetch(`${base}/api/other`)).status, 404);
  } finally { server.close(); t.done(); }
});
