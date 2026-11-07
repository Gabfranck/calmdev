// The gate of the server (docs/gate.md, lib/gate.mjs, phase 12 SEC): a session on 127.0.0.1 gets 403 on every route that acts,
// the developer's guard cookie, a paired device and the pilot's token open them, the session routes stay open, and the table
// covers every route of server.mjs (a forgotten one breaks this file).
//   1. lib/gate.mjs alone: classify, opened, refusal, gateOff, pilotToken, tokenMatches;
//   2. the routes of server.mjs, read from its source (pathname === '…', p === '…', seg[N] === '…' by family), each probed as a
//      POST against the table: an unlisted write is the default row, and the test fails on it;
//   3. the server on a spare port with ESCADRILLE_GATE=on (isolated-env.mjs puts 'off' for every other test): each 'act' row
//      without anything → 403, JSON, a French message naming the gesture (reviewed keeps srv.s.guardKey); with the cookie → not 403;
//      with the pilot's token → not 403 (reviewed still 403); a phone's Bearer from the Mac → not 403; POST /api/memory open;
//      an unlisted POST → 403; GET open; the LAN guard unchanged.
import { freePort } from './free-port.mjs';
import { isolatedEnv } from './isolated-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as gate from '../lib/gate.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 80)); } };
const fill = (pattern) => pattern.replace(/:id/g, 'x').replace(/:sid/g, 'y').replace(/:cid/g, 'c');
const ACT = gate.TABLE.filter((r) => r.kind === 'act');

// ---------------------------------------------------------------- 1. the module alone
test('classify: the table, first match wins, the defaults', () => {
  assert.equal(gate.classify('POST', '/api/launch').gesture, 'launch');
  assert.deepEqual(gate.classify('POST', '/api/plan/p/session/s/reviewed').opens, ['cookie'], 'the browser alone approves a guardrail');
  assert.deepEqual(gate.classify('POST', '/api/plan/p/session/s/terminal').opens, ['cookie', 'pilot'], 'what the Studio keeps: no device');
  const unit = gate.classify('POST', '/api/unit'); assert.equal(unit.gesture, 'settings');
  assert.deepEqual(unit.opens, ['cookie', 'device'], 'a price is the developer\'s setting: the cookie and a paired device, never the pilot');
  assert.equal(gate.opened(unit, { pilot: true }), false); assert.equal(gate.opened(unit, { device: true }), true); assert.equal(gate.opened(unit, { cookie: true }), true);
  assert.equal(gate.classify('POST', '/api/memory').kind, 'session');
  assert.equal(gate.classify('GET', '/api/memory').kind, 'read');
  assert.equal(gate.classify('POST', '/api/policy/check').kind, 'read', 'POL: a check changes nothing, open to every local caller');
  assert.equal(gate.classify('GET', '/api/plans').kind, 'read'); assert.equal(gate.classify('POST', '/api/plans').kind, 'read', 'a read that takes any verb');
  assert.equal(gate.classify('GET', '/').kind, 'read'); assert.equal(gate.classify('GET', '/plan/x').kind, 'read'); assert.equal(gate.classify('get', '/api/events/').kind, 'read');
  assert.equal(gate.classify('POST', '/api/pair').kind, 'open'); assert.equal(gate.classify('POST', '/api/phone/forget').kind, 'device');
  assert.equal(gate.classify('POST', '/api/nope'), gate.DEFAULT_WRITE, 'an unlisted write is refused by default');
  assert.equal(gate.classify('PUT', '/api/launch'), gate.DEFAULT_WRITE); assert.equal(gate.classify('POST', '/api/launch/x'), gate.DEFAULT_WRITE, 'a longer path is another route');
  assert.equal(gate.classify('POST', '/api/plan/p/session/s/message/x'), gate.DEFAULT_WRITE);
  for (const row of gate.TABLE) assert.ok(['act', 'read', 'session', 'open', 'device'].includes(row.kind), row.pattern);
  for (const row of ACT) { assert.ok(row.gesture, row.pattern); assert.ok(row.opens.length >= 1 && row.opens.every((o) => ['cookie', 'device', 'pilot'].includes(o)), row.pattern); }
  // a session route that carried a session id must say how the session proves itself (docs/gate.md §5)
  for (const row of gate.TABLE.filter((r) => r.kind === 'session')) assert.ok(!/:sid/.test(row.pattern) || row.scoped, `${row.pattern}: a session route with :sid needs \`scoped\``);
});

test('opened, refusal, gateOff, tokenMatches', () => {
  const launch = gate.classify('POST', '/api/launch'); const reviewed = gate.classify('POST', '/api/plan/p/session/s/reviewed');
  assert.equal(gate.opened(launch, {}), false); assert.equal(gate.opened(launch, { cookie: true }), true); assert.equal(gate.opened(launch, { device: true }), true); assert.equal(gate.opened(launch, { pilot: true }), true);
  assert.equal(gate.opened(reviewed, { pilot: true, device: true }), false); assert.equal(gate.opened(reviewed, { cookie: true }), true);
  assert.equal(gate.opened(gate.classify('GET', '/api/plans'), {}), true); assert.equal(gate.opened(gate.classify('POST', '/api/memory'), {}), true);
  const r = gate.refusal(launch, 'post', '/api/launch'); assert.deepEqual(r, { messageKey: 'srv.gate.closed', vars: { gesture: 'srv.gate.g.launch' }, gate: { route: 'POST /api/launch', opens: ['cookie', 'device', 'pilot'] } });
  const g = gate.refusal(reviewed, 'POST', '/api/plan/p/session/s/reviewed', { guardLinkFile: '/k/guard-link' }); assert.equal(g.messageKey, 'srv.s.guardKey'); assert.deepEqual(g.vars, { file: '/k/guard-link' }); assert.deepEqual(g.gate.opens, ['cookie']);
  assert.equal(gate.refusal(gate.DEFAULT_WRITE, 'POST', '/api/nope').vars.gesture, 'srv.gate.g.write');
  assert.equal(gate.gateOff({}), false, 'the real server: on'); assert.equal(gate.gateOff({ ESCADRILLE_GATE: 'off' }), true); assert.equal(gate.gateOff({ NODE_TEST_CONTEXT: 'child' }), true, 'a server under node --test');
  assert.equal(gate.gateOff({ NODE_TEST_CONTEXT: 'child', ESCADRILLE_GATE: 'on' }), false, 'this file'); assert.equal(gate.gateOff({ ESCADRILLE_GATE: 'nope' }), false, 'anything else is on');
  assert.equal(gate.tokenMatches('a'.repeat(64), 'a'.repeat(64)), true); assert.equal(gate.tokenMatches('a'.repeat(64), 'b'.repeat(64)), false); assert.equal(gate.tokenMatches('', ''), false); assert.equal(gate.tokenMatches(undefined, 'x'), false);
});

test('pilotToken: the environment first, else the file next to the key (0600, reused), else memory for a test server', () => {
  assert.equal(gate.pilotToken({ env: { ESCADRILLE_PILOT_TOKEN: 'E'.repeat(40) } }), 'E'.repeat(40));
  const dir = path.join(tmp('escadrille-gate-'), 'cfg');
  const t1 = gate.pilotToken({ env: { ESCADRILLE_PILOT_TOKEN: 'short' }, dir }); assert.match(t1, /^[0-9a-f]{64}$/, 'a token under 32 characters is ignored');
  assert.equal(readFileSync(path.join(dir, 'pilot-token'), 'utf8'), t1 + '\n'); assert.equal(statSync(path.join(dir, 'pilot-token')).mode & 0o777, 0o600);
  assert.equal(gate.pilotToken({ env: {}, dir }), t1, 'the same token next time');
  writeFileSync(path.join(dir, 'pilot-token'), 'garbage\n'); assert.notEqual(gate.pilotToken({ env: {}, dir }), 'garbage', 'a bad file is replaced');
  const mem = gate.pilotToken({ env: { NODE_TEST_CONTEXT: '1' } }); assert.match(mem, /^[0-9a-f]{64}$/); assert.notEqual(gate.pilotToken({ env: { NODE_TEST_CONTEXT: '1' } }), mem);
});

// ---------------------------------------------------------------- 2. every route of server.mjs is in the table
// The routes are read from the source: `url.pathname === '/api/x'` and `p === '/api/x'` (resourcesRoute), `startsWith('/x/')` when the
// line answers itself, and `seg[N] === 'lit'` (or ['a', 'b'].includes(seg[N])) inside a family block (seg[1] === 'plan' …).
// A line that names 'GET' only is a read, probed as a GET; every other line is probed as a POST (and DELETE when named).
const routesOfServer = () => {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const lines = src.split('\n'); const found = new Map(); let family = null;
  const add = (method, p, n) => { if (!found.has(method + ' ' + p)) found.set(method + ' ' + p, n + 1); };
  const methodsOf = (l) => { const m = []; if (/'POST'/.test(l)) m.push('POST'); if (/'DELETE'/.test(l)) m.push('DELETE'); if (!m.length && !/'GET'/.test(l)) m.push('POST'); return m; };
  const SEG = { plan: { 3: (x) => (x === 'session' ? null : `/api/plan/x/${x}`), 5: (x) => `/api/plan/x/session/y/${x}` }, escadrille: { 3: (x) => `/api/escadrille/x/${x}` }, review: { 3: (x) => `/api/review/x/${x}`, 5: (x) => `/api/review/x/comment/c/${x}` }, main: { 2: (x) => `/api/main/${x}` }, burst: { 3: (x) => `/api/burst/x/${x}` }, phone: { 2: (x) => `/api/phone/${x}` }, devices: { 3: (x) => `/api/devices/x/${x}` } };
  lines.forEach((l, n) => {
    const fam = /seg\[0\] === 'api' && seg\[1\] === '(\w+)'/.exec(l); if (fam) family = fam[1];
    for (const m of l.matchAll(/(?:url\.pathname|\bp) === '(\/api\/[^']*)'/g)) for (const method of methodsOf(l)) add(method, m[1], n); // the pages (/, /flow…) are reads served whatever the verb
    for (const m of l.matchAll(/startsWith\('(\/[^']*)'\)/g)) if (/res\.end\(|return json\(/.test(l) && m[1].endsWith('/')) for (const method of methodsOf(l)) add(method, m[1] + 'x', n);
    if (family && SEG[family]) {
      if (/!seg\[2\]/.test(l) && /'POST'/.test(l)) add('POST', `/api/${family}`, n); // the family's bare route (POST /api/main)
      const lits = [...l.matchAll(/seg\[(\d)\] === '([\w-]+)'/g)].map((m) => [m[1], m[2]]).concat([...l.matchAll(/\[((?:'[\w-]+', ?)*'[\w-]+')\]\.includes\(seg\[(\d)\]\)/g)].flatMap((m) => m[1].split(',').map((s) => [m[2], s.trim().slice(1, -1)])));
      for (const [i, lit] of lits) { const build = SEG[family][i]; const p = build && build(lit); if (p) for (const method of methodsOf(l)) add(method, p, n); }
    }
  });
  // The families server.mjs hands whole to a module (dock.handle, demo.route, ghroutes.handle): their `seg[2] === 'lit'` and `url.pathname === '/api/…'` lines, read there
  for (const [file, fam] of DELEGATED) readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((l) => {
    for (const m of l.matchAll(/seg\[(\d)\] === '([\w-]+)'/g)) { const p = fam[m[1]] && fam[m[1]](m[2]); if (p) for (const method of methodsOf(l)) add(method, p, -1); }
    for (const m of l.matchAll(/url\.pathname === '(\/api\/[^']*)'/g)) for (const method of methodsOf(l)) add(method, m[1], -1);
    // replies.handle matches its writes by one regex: /^\/api\/replies\/([^/]+)\/(edit|send|…)$/, each verb a POST
    const rx = /\/\^\\\/api\\\/(\w+)\\\/\(\[\^\/\]\+\)\\\/\(([\w|]+)\)\$\//.exec(l); if (rx) for (const v of rx[2].split('|')) add('POST', `/api/${rx[1]}/x/${v}`, -1);
  });
  return found;
};
const DELEGATED = [['lib/docker.mjs', { 2: (x) => `/api/docker/${x}` }], ['lib/demo.mjs', {}], ['lib/ghroutes.mjs', { 4: (x) => `/api/github/pr/x/${x}` }], ['lib/replies.mjs', {}]]; // demo.route reads url.pathname itself
test('every route of server.mjs is in the table: a forgotten write would be refused by default, and this test says which', () => {
  const routes = routesOfServer(); assert.ok(routes.size > 60, `routes read from server.mjs: ${routes.size} (77 on 2026-11-03: the scanner broke, not the server)`);
  const missing = [];
  for (const [key, line] of routes) { const [method, p] = key.split(' '); const row = gate.classify(method, p); if (row === gate.DEFAULT_WRITE) missing.push(`${key} (server.mjs:${line})`); }
  assert.deepEqual(missing, [], 'routes of server.mjs absent from lib/gate.mjs TABLE: ' + missing.join(', '));
  // a literal write caught by a wide read (`* /api/plan/:id` took POST /api/plan/from-tickets, 2026-11-03): it would pass ungated
  const swallowed = [...routes.keys()].filter((k) => { const [method, p] = k.split(' '); const row = gate.classify(method, p); return method !== 'GET' && row.kind === 'read' && row.pattern.includes(':') && fill(row.pattern) !== p && !/\/x(\/|$)/.test(p); });
  assert.deepEqual(swallowed, [], 'writes of server.mjs read through a wide `*` row: give them their own line before it');
  // and the table has nothing server.mjs lacks (a route removed from the server leaves the table)
  const served = new Set([...routes.keys()].map((k) => k.split(' ')[1]));
  const stale = ACT.filter((r) => !served.has(fill(r.pattern))).map((r) => r.pattern);
  assert.deepEqual(stale, [], 'rows of TABLE without a route in server.mjs');
  const expected = ['launch', 'merge', 'stop', 'settings', 'limits', 'burst', 'pilot', 'projects', 'plan', 'review', 'answer', 'note', 'devices', 'resources', 'main'];
  for (const g of expected) assert.ok(ACT.some((r) => r.gesture === g), `a gesture ${g}`);
});

// ---------------------------------------------------------------- 3. the server, gate on
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const env = isolatedEnv({ PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-gate-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-gate-plans-'), ESCADRILLE_CLAUDE: '/usr/bin/false', ESCADRILLE_TEST_REMOTE: '1', ESCADRILLE_GATE: 'on' });
const server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let err = ''; server.stdout.on('data', (d) => { out += d; }); server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const call = async (p, { method = 'GET', body, headers = {} } = {}) => { const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text, headers: r.headers }; };
const post = (p, body = {}, headers = {}) => call(p, { method: 'POST', body, headers });
let COOKIE, PILOT, PHONE;

test('the server starts with the gate on (nothing on its line), and hands the cookie through /guard', async () => {
  await until(async () => { try { await call('/api/plans'); return true; } catch { return false; } });
  assert.doesNotMatch(out, /GATE OFF/); assert.equal(err, '');
  const link = readFileSync(path.join(env.ESCADRILLE_GUARD_DIR, 'guard-link'), 'utf8').trim();
  const r = await call('/guard?k=' + new URL(link).searchParams.get('k')); assert.equal(r.status, 303); COOKIE = r.headers.get('set-cookie').split(';')[0];
  PILOT = readFileSync(path.join(env.ESCADRILLE_GUARD_DIR, 'pilot-token'), 'utf8').trim(); assert.match(PILOT, /^[0-9a-f]{64}$/, 'the pilot token written next to the key');
  assert.equal(statSync(path.join(env.ESCADRILLE_GUARD_DIR, 'pilot-token')).mode & 0o777, 0o600);
});

test('a session (no cookie, no token): 403 on every act route, JSON, a French message that names the gesture', async () => {
  const fr = JSON.parse(readFileSync(path.join(ROOT, 'public', 'i18n', 'fr.json'), 'utf8'));
  for (const row of ACT) {
    const p = fill(row.pattern); const method = row.method; const r = await call(p, { method, body: {} });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text.slice(0, 120)}`);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(r.body.gate, { route: `${method} ${p}`, opens: row.opens }, p);
    assert.doesNotMatch(r.body.error, /⟦/, 'decoded for the request');
    if (row.refuse) assert.equal(r.body.error, fr[row.refuse], `${p}: its own way out`);
    else if (row.opens.length === 1) { assert.match(r.body.error, /guard-link/, 'reviewed keeps srv.s.guardKey'); assert.match(r.body.error, /garde-fou/); }
    else { assert.ok(r.body.error.startsWith(fr['srv.gate.g.' + row.gesture]), `${p}: ${r.body.error}`); assert.match(r.body.error, /jamais depuis une session/); }
  }
  const en = await post('/api/launch', {}, { cookie: 'escadrille-lang=en' }); assert.equal(en.status, 403); assert.match(en.body.error, /^Launching a session is done from your browser/);
  const un = await post('/api/nope'); assert.equal(un.status, 403); assert.match(un.body.error, /^Écrire sur le serveur/); assert.deepEqual(un.body.gate, { route: 'POST /api/nope', opens: ['cookie', 'device', 'pilot'] });
  assert.equal((await post('/api/launch', {}, { cookie: 'escadrille_guard=' + 'a'.repeat(64) })).status, 403, 'a guessed cookie');
  assert.equal((await post('/api/launch', {}, { 'x-escadrille-pilot': 'b'.repeat(64) })).status, 403, 'a guessed pilot token');
});

test('the developer\'s cookie opens every act route (the business answer, never 403); reads and the session route need nothing', async () => {
  for (const row of ACT) { const p = fill(row.pattern); const r = await call(p, { method: row.method, body: {}, headers: { cookie: COOKIE } }); assert.notEqual(r.status, 403, `${row.method} ${p}: ${r.text.slice(0, 160)}`); assert.ok(r.status < 500, `${p}: ${r.status}`); }
  assert.equal((await call('/api/plans')).status, 200); assert.equal((await call('/api/limits')).status, 200); assert.equal((await call('/')).status, 200);
  // POST /api/memory: open to a session, and it writes (a throwaway project)
  const project = tmp('escadrille-gate-proj-');
  const m = await post('/api/memory', { project, line: 'une ligne de session' }); assert.equal(m.status, 200, m.text); assert.ok(m.body.ok);
  assert.match(readFileSync(path.join(project, '.calmdev', 'memoire.md'), 'utf8'), /une ligne de session/);
  assert.equal((await post('/api/memory', {})).status, 400, 'its own validation, not the gate');
});

test('the pilot\'s token opens the act routes, never the approval of a guardrail', async () => {
  const H = { 'x-escadrille-pilot': PILOT };
  assert.equal((await post('/api/launch', {}, H)).status, 400, 'launch: the business error (no plan)');
  assert.equal((await post('/api/plan/x/session/y/merge', {}, H)).status, 404, 'unknown plan, not 403');
  assert.equal((await post('/api/limits', {}, H)).status, 400); assert.equal((await post('/api/pilot', { project: '/nope', external: true }, H)).status, 400);
  const rv = await post('/api/plan/x/session/y/reviewed', {}, H); assert.equal(rv.status, 403); assert.match(rv.body.error, /guard-link/); assert.deepEqual(rv.body.gate.opens, ['cookie']);
  assert.equal((await post('/api/plan/x/session/y/terminal', {}, H)).status, 404, 'what the Studio keeps: the pilot passes, a device would not');
});

test('POST /api/policy/check: open without proof (it changes nothing), the same answer shape with the pilot\'s token', async () => {
  assert.equal(gate.classify('POST', '/api/policy/check').kind, 'read');
  const outside = tmp('escadrille-gate-mac-');
  const r = await post('/api/policy/check', { cwd: outside, tool: 'Read', input: { file_path: path.join(outside, 'a.txt') } });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.decision, 'allow'); assert.equal(r.body.target.kind, 'mac');
  const push = await post('/api/policy/check', { cwd: outside, tool: 'Bash', input: { command: 'git push origin dev' } }, { 'x-escadrille-pilot': PILOT });
  assert.equal(push.status, 200); assert.equal(push.body.decision, 'deny', 'no pilot-push file: no push, even for the pilot'); assert.ok(push.body.path, 'the way that works');
  assert.equal((await post('/api/policy/check', {})).body.decision, 'ask', 'a bad call asks, never refuses');
});

test('a paired device: its Bearer opens its routes from the Mac too; the LAN guard is unchanged', async () => {
  const code = await post('/api/pair/code', {}, { cookie: COOKIE }); assert.equal(code.status, 200, code.text);
  const paired = await post('/api/pair', { code: code.body.code, name: 'tel' }, { 'x-escadrille-remote': '1' }); assert.equal(paired.status, 200, paired.text); PHONE = paired.body.token;
  const B = { authorization: 'Bearer ' + PHONE };
  assert.equal((await post('/api/plan/x/session/y/answer', { id: 'q', allow: true }, B)).status, 404, 'from the Mac with the token: the business answer');
  assert.equal((await post('/api/launch', {}, B)).status, 400, 'a device opens launch from the Mac');
  assert.equal((await post('/api/plan/x/session/y/terminal', {}, B)).status, 403, 'what the Studio keeps to the browser and the pilot');
  const lan = await post('/api/launch', {}, { ...B, 'x-escadrille-remote': '1' }); assert.equal(lan.status, 403); assert.deepEqual(lan.body, { error: 'depuis le Mac seulement' }, 'the LAN guard first, unchanged');
  assert.equal((await post('/api/plan/x/session/y/answer', { id: 'q' }, { ...B, 'x-escadrille-remote': '1' })).status, 404, 'the phone\'s route from the LAN');
  assert.equal((await post('/api/launch', {}, { 'x-escadrille-remote': '1' })).status, 401, 'nothing from the LAN without a token');
  assert.equal((await post('/api/phone/forget', {}, B)).status, 200); assert.equal((await post('/api/launch', {}, B)).status, 403, 'a forgotten device is a session');
});

// The demo of 4 November said « nothing is pushed without you »: the only git push of the server (sessionPr → pushBranch) opens to the cookie alone
test('POST …/session/:sid/pr: the cookie pushes; a paired device and the pilot get the way that works', async () => {
  const row = gate.classify('POST', '/api/plan/p/session/s/pr'); assert.deepEqual(row.opens, ['cookie']); assert.equal(row.refuse, 'srv.gate.push');
  assert.equal(gate.opened(row, { device: true, pilot: true }), false); assert.equal(gate.opened(row, { cookie: true }), true);
  const code = await post('/api/pair/code', {}, { cookie: COOKIE }); const paired = await post('/api/pair', { code: code.body.code, name: 'tel-pr' }, { 'x-escadrille-remote': '1' }); assert.equal(paired.status, 200, paired.text);
  const P = '/api/plan/x/session/y/pr';
  const byCookie = await post(P, {}, { cookie: COOKIE }); assert.notEqual(byCookie.status, 403, byCookie.text); assert.ok(byCookie.status < 500, byCookie.text);
  for (const [who, H] of [['device', { authorization: 'Bearer ' + paired.body.token }], ['pilot', { 'x-escadrille-pilot': PILOT }]]) {
    const r = await post(P, {}, H); assert.equal(r.status, 403, `${who}: ${r.text}`);
    assert.match(r.body.error, /^Le push part du bouton dans l'app, sur le Mac/, who); assert.deepEqual(r.body.gate, { route: 'POST ' + P, opens: ['cookie'] });
  }
  const en = await post(P, {}, { 'x-escadrille-pilot': PILOT, cookie: 'escadrille-lang=en' }); assert.match(en.body.error, /^The push leaves from the button in the app, on the Mac/);
  await post('/api/phone/forget', {}, { authorization: 'Bearer ' + paired.body.token });
});
