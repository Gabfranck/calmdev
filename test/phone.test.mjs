// The phone's contract (docs/phone.md), against the server on a spare port with a throwaway database and
// the fake claude, the LAN simulated by the `x-escadrille-remote` header (ESCADRILLE_TEST_REMOTE=1), and a
// fake Expo push service (a node:http that records the bodies): 401 without a token, pairing good and bad,
// the 5 tries, the expired code, the phone's three POSTs, 403 elsewhere, the five kinds of push, the 15 s
// rule, DeviceNotRegistered, forget.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-phone-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake Expo push service: records every body, answers a ticket per message, DeviceNotRegistered for the token "dead"
const pushed = []; // every message received, flattened
const fakePush = createServer((req, res) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { const msgs = JSON.parse(s); pushed.push(...msgs); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: msgs.map((m, i) => (m.to === 'ExponentPushToken[dead]' ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket-' + i })) })); }); });
await new Promise((r) => fakePush.listen(0, '127.0.0.1', r));
const PUSH_URL = `http://127.0.0.1:${fakePush.address().port}/push`;

const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude(); const DB = path.join(tmp('escadrille-db-'), 'db.sqlite'); const root = repo();
// The push title starts with the project's short name (phase 6, docs/multiproject.md): the plan's project is the repo's git root
const P = path.basename(root);
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_PUSH_URL: PUSH_URL, ESCADRILLE_TEST_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let err = ''; server.stdout.on('data', (d) => { out += d; }); server.stderr.on('data', (d) => { err += d; });
after(() => { server.kill('SIGINT'); fakePush.close(); });

const REMOTE = { 'x-escadrille-remote': '1' };
const auth = (token) => (token ? { authorization: 'Bearer ' + token } : {});
// mac(): from this Mac; remote(): from the LAN, with or without a token
const call = async (p, { method = 'GET', body, token, remote = false, headers = {} } = {}) => { const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(remote ? REMOTE : {}), ...auth(token), ...headers }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text, headers: r.headers }; };
const mac = (p, body) => call(p, { method: body !== undefined ? 'POST' : 'GET', body });
const remote = (p, token, body) => call(p, { method: body !== undefined ? 'POST' : 'GET', body, token, remote: true });
const sessionA = async () => (await mac('/api/plan/tel')).body.state.find((s) => s.id === 'A');
const seenAgo = (id, ms) => new DatabaseSync(DB).prepare('update devices set last_seen = ? where id = ?').run(new Date(Date.now() - ms).toISOString(), id);
const kinds = () => pushed.map((m) => `${m.data.kind}:${m.to.slice(18, -1)}`);

test('the guard: 401 from the LAN without a token, pages included; OPTIONS and CORS pass', async () => {
  await until(async () => { try { await mac('/api/plans'); return true; } catch { return false; } });
  assert.match(out, /0 phones? paired, push to http:\/\/127\.0\.0\.1/);
  for (const p of ['/api/plans', '/', '/plan/x', '/app.css', '/api/phone', '/api/running', '/api/pilot/brief?project=/x']) { const r = await remote(p); assert.equal(r.status, 401, p); assert.deepEqual(r.body, { error: 'appairage requis' }); }
  assert.equal((await remote('/api/plan/tel/session/A/answer', null, { id: 'x', allow: true })).status, 401);
  assert.equal((await remote('/api/events?plan=tel&token=nope')).status, 401, 'a bad token on the SSE');
  const o = await fetch(BASE + '/api/plans', { method: 'OPTIONS', headers: { ...REMOTE, origin: 'http://localhost:8081' } });
  assert.equal(o.status, 204); assert.equal(o.headers.get('access-control-allow-origin'), 'http://localhost:8081'); assert.match(o.headers.get('access-control-allow-headers'), /authorization/);
  const m = await call('/api/plans', { headers: { origin: 'http://localhost:8081' } }); assert.equal(m.headers.get('access-control-allow-origin'), 'http://localhost:8081'); assert.equal(m.headers.get('vary'), 'origin');
  assert.equal((await call('/api/plans')).headers.get('access-control-allow-origin'), '*', 'no Origin, the old star');
  assert.equal((await remote('/api/pair/code', null, {})).status, 401, 'the code is asked from the Mac only');
});

let T1, D1, T2, D2;
test('pairing: a code from the Mac, 5 wrong tries cancel it, a spent code is gone, a good one gives a token', async () => {
  let c = (await mac('/api/pair/code', {})).body;
  assert.match(c.code, /^\d{6}$/); assert.ok(Date.parse(c.expires) > Date.now() + 9 * 60000); assert.equal(c.lan, false); assert.ok(c.address === null || /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(c.address));
  assert.deepEqual((await mac('/api/devices')).body.code.code, c.code, 'the code in force comes with the devices');
  const wrong = String((Number(c.code) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < 4; i++) { const r = await remote('/api/pair', null, { code: wrong, name: 'x' }); assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'code faux' }); }
  let r = await remote('/api/pair', null, { code: wrong }); assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'trop d’essais, redemande un code' });
  r = await remote('/api/pair', null, { code: c.code }); assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'code expiré ou absent' });
  c = (await mac('/api/pair/code', {})).body;
  r = await remote('/api/pair', null, { code: c.code.slice(0, 3) + ' ' + c.code.slice(3), name: 'iPhone de test' });
  assert.equal(r.status, 200); assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(r.body.device.name, 'iPhone de test'); assert.match(r.body.device.id, /^d-[0-9a-f]{8}$/); assert.ok(r.body.device.created);
  T1 = r.body.token; D1 = r.body.device.id;
  r = await remote('/api/pair', null, { code: c.code }); assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'code expiré ou absent' }, 'single use');
  assert.equal((await mac('/api/devices')).body.code, null);
  // the phone's home, its heartbeat
  const h = await remote('/api/phone', T1); assert.equal(h.status, 200); assert.deepEqual(h.body.device, { id: D1, name: 'iPhone de test' }); assert.deepEqual(h.body.plans, []); assert.ok(h.body.now);
  const d = (await mac('/api/devices')).body; assert.equal(d.devices.length, 1); assert.deepEqual({ id: d.devices[0].id, name: d.devices[0].name, push: d.devices[0].push }, { id: D1, name: 'iPhone de test', push: false }); assert.ok(d.devices[0].last_seen);
  // the push token, checked
  assert.equal((await remote('/api/phone/push-token', T1, { expoPushToken: 'nope' })).status, 400);
  assert.deepEqual((await remote('/api/phone/push-token', T1, { expoPushToken: 'ExponentPushToken[d1]' })).body, { ok: true });
  assert.equal((await mac('/api/devices')).body.devices[0].push, true);
  // a second device, whose token Expo will reject
  c = (await mac('/api/pair/code', {})).body; r = await remote('/api/pair', null, { code: c.code }); T2 = r.body.token; D2 = r.body.device.id; assert.equal(r.body.device.name, 'iPhone');
  assert.deepEqual((await remote('/api/phone/push-token', T2, { expoPushToken: 'ExponentPushToken[dead]' })).body, { ok: true });
  // the SSE with ?token=
  const es = await fetch(`${BASE}/api/events?plan=tel&token=${T1}`, { headers: REMOTE }); assert.equal(es.status, 200); assert.match(es.headers.get('content-type'), /event-stream/); await es.body.cancel();
});

test('with a token, the LAN reaches the phone routes only: 403 on launch, settings, running, pages', async () => {
  for (const [p, body] of [['/api/launch', { plan: 'tel' }], ['/api/plan/tel/settings', { autoMerge: true }], ['/api/running/stop-all', {}], ['/api/plan', {}], ['/api/note', {}], ['/api/escadrille', {}], ['/api/plan/tel/session/A/merge', {}], ['/api/plan/tel/session/A/stop', {}], ['/api/pair/code', {}], ['/api/devices/x/forget', {}]]) { const r = await remote(p, T1, body); assert.equal(r.status, 403, p); assert.deepEqual(r.body, { error: 'depuis le Mac seulement' }); }
  for (const p of ['/', '/plan/tel', '/app.css', '/api/running', '/api/projects', '/api/usage', '/api/devices', '/api/escadrilles']) assert.equal((await remote(p, T1)).status, 403, p);
});

test('the five kinds of push, once each, to the devices not seen in 15 s; DeviceNotRegistered forgets a token', async () => {
  seenAgo(D1, 60000); // D1 called /api/phone a minute ago: it gets the pushes; D2 never called it
  const plan = { id: 'tel', title: 'Téléphone', sessions: [{ id: 'A', name: 'Seule', path: path.join(root, 'app'), model: 'claude-sonnet-5-5', stops: ['Le fichier', 'La fin'], prompt: 'Écris docs/essai.txt.', budget: 0.035 }] };
  // every kind of push: the project's autonomy says 'all' (its default, 'waiting', keeps only what waits; docs/autonomy.md)
  assert.equal((await mac('/api/project/settings', { project: root, autonomy: { notifyLevel: 'all' } })).status, 200);
  assert.equal((await mac('/api/plan', plan)).status, 200);
  assert.deepEqual((await remote('/api/phone', T1)).body.plans.map((p) => p.id), ['tel']); seenAgo(D1, 60000);
  assert.deepEqual((await mac('/api/launch', { plan: 'tel' })).body, { ok: true, launched: ['A'], queued: [] });
  // the permission: one push per device; Expo rejects D2's token, which is forgotten
  let A = await until(async () => { const s = await sessionA(); return s.pending.some((p) => p.kind === 'permission') ? s : null; });
  await until(() => pushed.length >= 2);
  assert.deepEqual(kinds().sort(), ['permission:d1', 'permission:dead']);
  assert.deepEqual(pushed.find((m) => m.to === 'ExponentPushToken[d1]'), { to: 'ExponentPushToken[d1]', title: `${P} · A demande : Bash curl -s http://x`, body: 'Téléphone', sound: 'default', data: { plan: 'tel', session: 'A', kind: 'permission', id: A.pending[0].id } });
  await until(async () => (await mac('/api/devices')).body.devices.find((d) => d.id === D2).push === false);
  assert.match(out, /DeviceNotRegistered/);
  // the error: the process dies mid-turn
  const pid = (await mac('/api/running')).body.ours.find((x) => x.kind === 'session').pid; process.kill(pid, 'SIGKILL');
  await until(async () => (await sessionA()).health === 'error');
  await until(() => pushed.length >= 3);
  assert.deepEqual(pushed[2].data, { plan: 'tel', session: 'A', kind: 'error', id: 'processus arrêté avant la fin du tour' }); assert.equal(pushed[2].title, `${P} · A : processus arrêté avant la fin du tour`);
  // the 15 s rule: the app just called /api/phone, so the next permission and the wait go without a push
  await remote('/api/phone', T1);
  const before = Date.now() - 1; // the dead process's request is still listed, with the same id: wait for a newer one
  assert.deepEqual((await mac('/api/plan/tel/session/A/message', { text: 'Encore' })).body, { ok: true });
  A = await until(async () => { const s = await sessionA(); return s.pending.some((p) => p.kind === 'permission' && Date.parse(p.at) >= before) ? s : null; });
  const ask = A.pending.find((p) => p.kind === 'permission' && Date.parse(p.at) >= before);
  assert.deepEqual((await remote(`/api/plan/tel/session/A/answer`, T1, { id: ask.id, allow: true })).body, { ok: true }, 'the phone answers');
  A = await until(async () => { const s = await sessionA(); return s.status === 'waiting' ? s : null; });
  await sleep(300); assert.equal(pushed.length, 3, 'no push while the app is open');
  assert.equal((await mac('/api/plan/tel/session/A/messages')).body.messages.filter((m) => m.role === 'system').pop().text, 'Autorisé : curl -s http://x');
  // seen a minute ago again: the permission, then the wait
  seenAgo(D1, 60000);
  assert.deepEqual((await mac('/api/plan/tel/session/A/message', { text: 'Encore' })).body, { ok: true });
  A = await until(async () => { const s = await sessionA(); return s.pending.some((p) => p.kind === 'permission') ? s : null; });
  await until(() => pushed.length >= 4); assert.equal(pushed[3].title, `${P} · A demande : Bash curl -s http://y`);
  assert.deepEqual((await remote(`/api/plan/tel/session/A/answer`, T1, { id: A.pending.find((p) => p.kind === 'permission').id, allow: true })).body, { ok: true });
  A = await until(async () => { const s = await sessionA(); return s.status === 'waiting' ? s : null; });
  await until(() => pushed.length >= 5);
  assert.deepEqual(pushed[4], { to: 'ExponentPushToken[d1]', title: `${P} · A attend ta réponse`, body: 'Téléphone', sound: 'default', data: { plan: 'tel', session: 'A', kind: 'waiting', id: A.pending.find((p) => p.kind === 'reply').id } });
  // turn 3 costs 0.03 of 0.035: the budget alert; the phone dismisses it
  assert.deepEqual((await remote('/api/plan/tel/session/A/message', T1, { text: 'Encore' })).body, { ok: true }, 'the phone writes to the session');
  A = await until(async () => { const s = await sessionA(); return s.pending.some((p) => p.kind === 'permission') ? s : null; });
  assert.deepEqual((await remote(`/api/plan/tel/session/A/answer`, T1, { id: A.pending.find((p) => p.kind === 'permission').id, allow: true, always: true })).body, { ok: true });
  A = await until(async () => { const s = await sessionA(); return s.pending.some((p) => p.kind === 'alert') ? s : null; });
  await until(() => pushed.length >= 8);
  assert.deepEqual(kinds().slice(5), ['permission:d1', 'budget:d1', 'waiting:d1']);
  assert.equal(pushed[6].title, `${P} · A : 86 % du plafond`); assert.equal(pushed[6].data.id, 'alert');
  assert.deepEqual((await remote('/api/plan/tel/session/A/dismiss', T1, { id: A.pending.find((p) => p.kind === 'alert').id })).body, { ok: true });
  assert.ok(!(await sessionA()).pending.some((p) => p.kind === 'alert'));
  // the last turn: done, the plan is finished
  assert.deepEqual((await mac('/api/plan/tel/session/A/message', { text: 'Fin' })).body, { ok: true });
  A = await until(async () => { const s = await sessionA(); return s.status === 'done' ? s : null; });
  await until(() => pushed.length >= 9);
  assert.deepEqual(pushed[8], { to: 'ExponentPushToken[d1]', title: `${P} · Plan fini : Téléphone`, body: 'Téléphone', sound: 'default', data: { plan: 'tel', session: null, kind: 'done', id: 'tel' } });
  await sleep(300); assert.equal(pushed.length, 9, 'nothing pushed twice');
  assert.ok(A.pushed.includes('done:tel') && A.pushed.includes('budget:alert'), 'the marks are kept in the row');
  assert.equal(err.trim(), '', err);
});

test('forget: from the phone, then from the Mac; a forgotten token is 401', async () => {
  assert.deepEqual((await remote('/api/phone/forget', T1, {})).body, { ok: true });
  assert.equal((await remote('/api/phone', T1)).status, 401);
  assert.deepEqual((await mac('/api/devices')).body.devices.map((d) => d.id), [D2]);
  assert.deepEqual((await mac(`/api/devices/${D2}/forget`, {})).body, { ok: true });
  assert.equal((await mac(`/api/devices/${D2}/forget`, {})).status, 404);
  assert.deepEqual((await mac('/api/devices')).body.devices, []);
  assert.equal((await remote('/api/phone', T2)).status, 401);
});
