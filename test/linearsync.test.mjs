// The Linear sync (docs/connectors.md, « La synchro »; lib/linearsync.mjs) against the fake Linear of test/fake-gh.mjs:
// every transition, the idempotence (two merges, one comment), never Done, off without a key or with the setting off,
// the key never returned nor logged, the alert once a day, the Accès view and « À toi ».
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeLinear, LINEAR_KEY } from './fake-gh.mjs';
import * as pilotlog from '../lib/pilotlog.mjs';
import * as secrets from '../lib/secrets.mjs';
import { items } from '../lib/todo.mjs';
import { connectorsOf, accessReport } from '../lib/access.mjs';

const lin = await fakeLinear();
process.env.ESCADRILLE_LINEAR_URL = lin.url;
const linear = await import('../lib/linear.mjs');
const sync = await import('../lib/linearsync.mjs');
after(() => lin.close());

const PROJECT = '/tmp/escadrille-sync-project';
const db = new DatabaseSync(':memory:'); pilotlog.schema(db);
const keys = { [PROJECT]: LINEAR_KEY }; const stored = { [PROJECT]: {} };
let clock = new Date('2026-11-02T10:00:00Z');
sync.init({ db, keyOf: (p) => keys[p] || null, settingsOf: (p) => stored[p] || {}, log: (r) => pilotlog.record(db, { ...r, project: r.project }), now: () => clock });
const logTexts = () => pilotlog.list(db, { project: PROJECT }).actions.map((a) => a.text + '\n' + a.detail);
const plan = { id: 'p1', title: 'Sprint', base: 'main', project: PROJECT };
const S = (id, name, prompt, tickets) => ({ id, name, prompt, ...(tickets ? { tickets } : {}) });
const updates = () => lin.requests.filter((r) => /issueUpdate/.test(r.query));
const DONE = (t) => lin.stateId(t, 'Done');

test('ticketsOf: the identifiers of the name, the prompt, the summary and the tickets list, once each, without the false positives', () => {
  const s = S('A', 'ORC-88 et ORC-91 : le tableau', 'Fais ORC-88 (voir ORC-91, OPS-3). Encode en UTF-8, hash SHA-256, norme ISO-8601, RFC-2119, HTTP-2, le modèle claude-sonnet-5-5, les kits R02-R07, le chemin docs/ORC-12.md, ORC-07 non plus.', ['OPS2-3']);
  assert.deepEqual(sync.ticketsOf(s, { summary: 'Fait : ORC-88 livré, RAW-1 aussi.\nReste : rien.' }), ['OPS2-3', 'ORC-88', 'ORC-91', 'OPS-3', 'RAW-1']);
  assert.deepEqual(sync.ticketsOf({ name: 'x' }, {}), []);
  assert.deepEqual(sync.ticketsOf({ tickets: ['bad-1', 'ORC-2'] }, null), ['ORC-2'], 'a badly formed declared ticket is skipped');
});

test('the setting: on by default with a key, off by false, refused otherwise; the public view never carries the key', () => {
  const st = {};
  assert.deepEqual(sync.publicView(st, true), { sync: true }); assert.deepEqual(sync.publicView(st, false), { sync: false }, 'no key: off');
  sync.applySetting(st, false); assert.deepEqual(st, { linearSync: false }); assert.deepEqual(sync.publicView(st, true), { sync: false });
  sync.applySetting(st, null); assert.deepEqual(st, {}); sync.applySetting(st, true); assert.deepEqual(st, {});
  assert.throws(() => sync.applySetting(st, 'oui'), /true ou false/);
  assert.ok(!JSON.stringify(sync.publicView({ linearSync: false }, true)).includes(LINEAR_KEY));
  assert.equal(sync.isOn({ project: PROJECT }), true); assert.equal(sync.isOn({ project: '/other' }), false, 'no key');
  assert.equal(sync.isProductionBase('main'), true); assert.equal(sync.isProductionBase('Master'), true); assert.equal(sync.isProductionBase('dev'), false); assert.equal(sync.isProductionBase(null), false);
});

test('a session launched: backlog or unstarted → the team\'s started state; started, done kept; no started state → an error that stops nothing', async () => {
  lin.issueState['ORC-5'] = lin.stateId('t1', 'À revoir'); lin.issueState['ORC-7'] = DONE('t1');
  const s = S('A', 'Le tableau', 'ORC-88, ORC-5, ORC-7, OPS-3 et RAW-1');
  const before = lin.requests.length;
  const r = await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} });
  assert.equal(r.on, true);
  assert.deepEqual(r.tickets.map((t) => [t.identifier, t.result || 'error']), [['ORC-88', 'In Progress'], ['ORC-5', 'gardé : À revoir'], ['ORC-7', 'gardé : Done'], ['OPS-3', 'In Review'], ['RAW-1', 'error']]);
  assert.equal(lin.stateName('ORC-88'), 'In Progress', 'unstarted → the first started state');
  assert.equal(lin.stateName('OPS-3'), 'In Review', 'the team\'s only started state');
  assert.equal(lin.stateName('ORC-5'), 'À revoir', 'already started: kept'); assert.equal(lin.stateName('ORC-7'), 'Done', 'done: kept');
  assert.equal(lin.stateName('RAW-1'), 'Backlog', 'no started state: nothing moved');
  assert.match(r.tickets[4].error, /aucun statut de type started dans l’équipe RAW/);
  assert.ok(lin.requests.slice(before).every((x) => x.auth === LINEAR_KEY), 'the key in Authorization only');
  // the error: one line in the pilot's log, one alert for the day, the key nowhere
  const texts = logTexts();
  assert.equal(texts.length, 1); assert.match(texts[0], /^Linear : RAW-1 non mis à jour \(lancement\)/); assert.ok(!texts.join().includes(LINEAR_KEY));
  const alert = sync.alertOf(db, PROJECT); assert.ok(alert); assert.match(alert.text, /^RAW-1 : Linear : aucun statut/); assert.ok(!alert.text.includes(LINEAR_KEY));
  // the same launch again (a handoff restarts the process): nothing asked again, not even for the ticket in error
  const n = lin.requests.length;
  const again = await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} });
  assert.deepEqual(again.tickets, []); assert.equal(lin.requests.length, n, 'idempotent');
  assert.equal(logTexts().length, 1, 'no second line');
});

test('a ticket unknown to Linear: one line, never asked again for this session', async () => {
  const s = S('Z', 'Le fantôme ZZZ-1', 'rien');
  const r = await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} });
  assert.match(r.tickets[0].error, /introuvable|not found/);
  const n = lin.requests.length;
  await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} }); await sync.onDelivered({ project: PROJECT, plan, session: s, row: {}, how: 'merged' });
  assert.equal(lin.requests.length, n, 'remembered as missing');
  assert.equal(logTexts().length, 2);
});

test('a session merged, then merged again, then delivered in a kit: one comment of state and cost per ticket; the body says what is done, what is left, the cost', async () => {
  const s = S('B', 'Le score (ORC-91)', 'p');
  const row = { summary: 'Fait : le score et ses tests.\nReste : la capture 390.', usage: { cost: 3.2 } };
  const r = await sync.onDelivered({ project: PROJECT, plan, session: s, row, how: 'merged' });
  assert.deepEqual(r.tickets.map((t) => t.identifier), ['ORC-91']); assert.match(r.tickets[0].result, /^c\d+$/, 'the comment id kept');
  const c = lin.comments['ORC-91']; assert.equal(c.length, 1);
  assert.equal(c[0].body, 'État au 2 novembre 2026 (calmdev) : le score et ses tests. Reste : la capture 390. Coût ≈ 3,20 $.\n\nSession B du plan p1, fusionnée dans la base du plan.');
  const n = lin.requests.length;
  assert.deepEqual((await sync.onDelivered({ project: PROJECT, plan, session: s, row, how: 'merged' })).tickets, [], 'a second merge: nothing');
  assert.deepEqual((await sync.onDelivered({ project: PROJECT, plan, session: s, row, how: 'kit' })).tickets, [], 'the kit after the merge: nothing');
  assert.equal(lin.comments['ORC-91'].length, 1); assert.equal(lin.requests.length, n);
  assert.equal(lin.stateName('ORC-91'), 'Todo', 'a merge moves no state');
  // another session on the same ticket comments once too; a kit says so, a summary without Fait/Reste is taken whole
  const r2 = await sync.onDelivered({ project: PROJECT, plan, session: S('C', 'ORC-91 encore', 'p'), row: { summary: 'tout est là', usage: null }, how: 'kit' });
  assert.equal(r2.tickets.length, 1);
  assert.equal(lin.comments['ORC-91'][1].body, 'État au 2 novembre 2026 (calmdev) : tout est là Reste : rien de noté Coût ≈ 0,00 $.\n\nSession C du plan p1, livrée en kit.');
});

test('the kept PR merged in production: one comment per PR, none on another base, none while open', async () => {
  const s = S('D', 'OPS-3 en prod', 'p');
  const open = { pr: { url: 'https://github.com/acme/demo/pull/7', base: 'main', merged: false } };
  assert.deepEqual((await sync.onPrMerged({ project: PROJECT, plan, session: s, row: open })).tickets, [], 'open: nothing');
  const dev = { pr: { url: 'https://github.com/acme/demo/pull/8', base: 'dev', merged: true } };
  assert.deepEqual((await sync.onPrMerged({ project: PROJECT, plan, session: s, row: dev })).tickets, [], 'merged into dev: not production');
  const prod = { pr: { url: 'https://github.com/acme/demo/pull/7', base: 'main', merged: true } };
  const r = await sync.onPrMerged({ project: PROJECT, plan, session: s, row: prod });
  assert.equal(r.tickets.length, 1);
  assert.deepEqual(lin.comments['OPS-3'].map((c) => c.body), ['Fusionné en production par la PR https://github.com/acme/demo/pull/7 (calmdev).']);
  const n = lin.requests.length;
  await sync.onPrMerged({ project: PROJECT, plan, session: s, row: prod });
  assert.equal(lin.requests.length, n, 'the refresh seen again: nothing');
  assert.equal(lin.stateName('OPS-3'), 'In Review', 'never Done, even in production');
});

test('never Done: no update ever targeted a completed state, and the connector refuses one by name', async () => {
  const dones = new Set(['t1', 't2', 't3'].map(DONE));
  assert.ok(updates().length >= 2); assert.ok(updates().every((u) => !dones.has(u.variables.s)));
  await assert.rejects(linear.moveToState({ key: LINEAR_KEY, identifier: 'ORC-88', stateName: 'Done' }), /ne passe jamais en « Done »/);
  assert.equal(lin.stateName('ORC-88'), 'In Progress');
  for (const v of Object.values(lin.issueState)) if (dones.has(v)) assert.equal(v, DONE('t1'), 'only the preset ORC-7');
});

test('off: without a key, or with the setting off, nothing is called; the setting back on works again', async () => {
  const s = S('E', 'ORC-88 off', 'p'); const n = lin.requests.length;
  stored[PROJECT] = { linearSync: false };
  assert.deepEqual(await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} }), { on: false, tickets: [] });
  assert.deepEqual(await sync.onDelivered({ project: PROJECT, plan, session: s, row: {}, how: 'merged' }), { on: false, tickets: [] });
  stored[PROJECT] = {}; delete keys[PROJECT];
  assert.deepEqual(await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} }), { on: false, tickets: [] });
  assert.equal(lin.requests.length, n, 'nothing left');
  keys[PROJECT] = LINEAR_KEY;
  assert.equal((await sync.onLaunched({ project: PROJECT, plan, session: s, row: {} })).on, true);
});

test('the alert: one a day per project, then a new one the next day; « À toi » carries it as one line, the Flot gives it', async () => {
  assert.equal(db.prepare("select count(*) as n from linear_sync where kind = 'alert'").get().n, 1, 'three errors so far, one alert');
  clock = new Date('2026-11-03T10:30:00Z');
  assert.equal(sync.alertOf(db, PROJECT), null, 'the day after: gone');
  const r = await sync.onLaunched({ project: PROJECT, plan, session: S('F', 'RAW-1 demain', 'p'), row: {} });
  assert.ok(r.tickets[0].error);
  assert.equal(db.prepare("select count(*) as n from linear_sync where kind = 'alert'").get().n, 2);
  const alert = sync.alertOf(db, PROJECT); assert.equal(alert.at, '2026-11-03T10:30:00.000Z');
  assert.deepEqual(items({ linear: alert }), [{ kind: 'linear', at: alert.at, text: alert.text, act: 'open' }]);
  assert.deepEqual(items({ linear: null }), []);
  assert.equal(sync.alertOf(new DatabaseSync(':memory:'), PROJECT), null, 'no table: no alert, no throw');
  assert.ok(!JSON.stringify(alert).includes(LINEAR_KEY));
});

test('Accès: with a key the sync is said on and api.linear.app reached on its own (amber); with the setting off, on click only as before', () => {
  const file = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-sync-'))), 'secrets.json'); secrets.set(PROJECT, 'linear', LINEAR_KEY, file);
  const env = { PATH: '/nonexistent' };
  const on = connectorsOf({ project: PROJECT, env, secretsFile: file });
  assert.deepEqual(on.map((c) => [c.name, c.ready, c.key, c.sync]), [['GitHub', false, false, undefined], ['Linear', true, true, true]]);
  assert.match(on[1].scope, /In Progress|srv\.lin\.scopeSync/);
  const off = connectorsOf({ project: PROJECT, env, secretsFile: file, linearSync: false });
  assert.equal(off[1].sync, false); assert.equal(connectorsOf({ project: '/none', env, secretsFile: file })[1].sync, false, 'no key: no sync');
  const server = { host: '127.0.0.1', port: 3078, lan: false, address: null, devices: [], pushUrl: 'https://exp.host/--/api/v2/push/send' };
  const a = accessReport({ project: PROJECT, env, server, connectors: on, home: '/nonexistent' });
  const lin1 = a.out.filter((h) => h.host === 'api.linear.app'); assert.equal(lin1.length, 1); assert.equal(lin1[0].onClick, false); assert.equal(a.summary.level.out, 'amber');
  const b = accessReport({ project: PROJECT, env, server, connectors: off, home: '/nonexistent' });
  const lin2 = b.out.filter((h) => h.host === 'api.linear.app'); assert.equal(lin2.length, 1); assert.equal(lin2[0].onClick, true); assert.equal(b.summary.level.out, 'green');
  assert.ok(!JSON.stringify([a, b]).includes(LINEAR_KEY));
});
