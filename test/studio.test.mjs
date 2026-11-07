// The Studio and the MacBook (docs/studio.md): two local servers on two ports, each with its own database. The
// Studio is the one that runs the sessions; the MacBook's browser is played by requests carrying
// `x-escadrille-remote: 1` (ESCADRILLE_TEST_REMOTE=1, the LAN), an Origin, and the cookie the pairing gave.
// Nothing leaves 127.0.0.1.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import * as poste from '../lib/poste.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-studio-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const fake = fakeClaude();
const start = (name) => {
  const port = freePort(); const db = path.join(tmp(`escadrille-${name}-db-`), 'db.sqlite');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: db, ESCADRILLE_PLANS: tmp(`escadrille-${name}-plans-`), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-none-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/none', ESCADRILLE_TEST_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  return { port, db, proc, base: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, err: () => err };
};
const studio = start('studio'); const macbook = start('macbook');
after(() => { studio.proc.kill('SIGINT'); macbook.proc.kill('SIGINT'); });

// call(server, path, { body, lan, cookie, token, origin, accept })
const call = async (S, p, { method, body, lan = false, cookie, token, origin, accept } = {}) => {
  const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(lan ? { 'x-escadrille-remote': '1' } : {}), ...(cookie ? { cookie: `${poste.COOKIE}=${cookie}` } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(origin ? { origin } : {}), ...(accept ? { accept } : {}) };
  const r = await fetch(S.base + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
};
// the MacBook's browser on the Studio: from the LAN, with its cookie and the Studio's own Origin
let COOKIE = null; let POSTE = null;
const book = (p, body, extra = {}) => call(studio, p, { body, lan: true, cookie: COOKIE, origin: body !== undefined ? studio.origin : undefined, ...extra });

test('two servers answer; from the LAN without a token nothing does (401), the pairing page excepted', async () => {
  for (const S of [studio, macbook]) await until(async () => { try { return (await call(S, '/api/plans')).status === 200; } catch { return false; } });
  for (const p of ['/api/plans', '/', '/plan/x', '/app.css', '/remote.js', '/api/whoami', '/api/limits', '/api/events?plan=x']) {
    const r = await call(studio, p, { lan: true }); assert.equal(r.status, 401, p); assert.deepEqual(r.body, { error: 'appairage requis' }, p);
  }
  assert.equal((await call(studio, '/api/plan', { lan: true, body: { id: 'x' }, origin: studio.origin })).status, 401);
  const page = await call(studio, '/', { lan: true, accept: 'text/html,*/*' });
  assert.equal(page.status, 401, 'a browser asking a page still gets 401'); assert.match(page.text, /Appairer ce poste/, '…with the pairing page in it');
  const pair = await call(studio, '/pair', { lan: true }); assert.equal(pair.status, 200); assert.match(pair.text, /Code de poste/);
  assert.equal((await call(studio, '/api/pair/code', { lan: true, body: { kind: 'poste' }, origin: studio.origin })).status, 401, 'the code is asked from the Studio only');
  const who = await call(studio, '/api/whoami'); assert.equal(who.body.mac, true); assert.equal(who.body.poste, null); assert.ok(who.body.host);
});

test('pairing a poste: a code on the Studio, an Origin, then an HttpOnly cookie and no token in the body', async () => {
  const c = (await call(studio, '/api/pair/code', { body: { kind: 'poste' } })).body;
  assert.match(c.code, /^\d{6}$/); assert.equal(c.kind, 'poste');
  let r = await call(studio, '/api/pair', { lan: true, body: { code: c.code, name: 'MacBook' } });
  assert.equal(r.status, 403, 'no Origin: refused'); assert.deepEqual(r.body, { error: 'origine refusée' });
  r = await call(studio, '/api/pair', { lan: true, body: { code: c.code, name: 'MacBook' }, origin: 'http://evil.example' });
  assert.equal(r.status, 403, 'another site: refused');
  r = await call(studio, '/api/pair', { lan: true, body: { code: c.code, name: 'MacBook' }, origin: studio.origin });
  assert.equal(r.status, 200, 'the code was not spent by the refusals'); assert.equal(r.body.token, undefined, 'the token never reaches the JavaScript');
  assert.equal(r.body.device.kind, 'poste'); assert.equal(r.body.device.name, 'MacBook'); POSTE = r.body.device.id;
  const sc = r.headers.get('set-cookie');
  assert.match(sc, new RegExp(`^${poste.COOKIE}=[\\w-]{43};`)); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=2592000/);
  COOKIE = /=([\w-]+);/.exec(sc)[1];
  const d = (await call(studio, '/api/devices')).body; assert.deepEqual(d.devices.map((x) => [x.name, x.kind]), [['MacBook', 'poste']]);
});

test('with its cookie the MacBook reads and pilots the Studio: pages, plans, launch, permission, stop, SSE', async () => {
  const home = await book('/'); assert.equal(home.status, 200); assert.match(home.text, /\/remote\.js/);
  assert.equal((await book('/remote.js')).status, 200);
  const who = (await book('/api/whoami')).body; assert.equal(who.mac, false); assert.deepEqual(who.poste, { id: POSTE, name: 'MacBook' });
  assert.equal((await book('/api/limits')).status, 200, 'a (Mac) route is open to a poste');
  const root = repo();
  const plan = { id: 'studio', title: 'Le Studio', sessions: [{ id: 'A', name: 'Seule', path: path.join(root, 'app'), model: 'claude-sonnet-5-5', stops: ['Le fichier'], prompt: 'Écris docs/essai.txt.', budget: 0.05 }] };
  assert.equal((await book('/api/plan', plan)).status, 200, 'the MacBook writes a plan on the Studio');
  assert.equal((await book('/api/plans')).body.plans?.[0]?.id ?? (await book('/api/plans')).body[0]?.id, 'studio');
  // the SSE carries the cookie (EventSource does)
  const ac = new AbortController();
  const sse = await fetch(`${studio.base}/api/events?plan=studio`, { headers: { 'x-escadrille-remote': '1', cookie: `${poste.COOKIE}=${COOKIE}` }, signal: ac.signal });
  assert.equal(sse.status, 200); assert.match(sse.headers.get('content-type'), /text\/event-stream/); ac.abort();
  assert.deepEqual((await book('/api/launch', { plan: 'studio' })).body, { ok: true, launched: ['A'], queued: [] });
  const ask = await until(async () => (await book('/api/plan/studio')).body.state.find((s) => s.id === 'A')?.pending?.find((p) => p.kind === 'permission'));
  assert.deepEqual((await book('/api/plan/studio/session/A/answer', { id: ask.id, allow: true })).body, { ok: true }, 'the MacBook answers the permission');
  await until(async () => { const s = (await book('/api/plan/studio')).body.state.find((x) => x.id === 'A'); return s.status === 'waiting' && s.stops.includes(0); });
  assert.equal((await book('/api/plan/studio/session/A/stop', {})).status, 200, 'and stops the session');
  assert.ok((await call(studio, '/api/running')).body.ours.every((o) => o.kind !== 'session'), 'no claude left running on the Studio');
});

test('a poste: writes need the Studio Origin, and what acts on the Studio’s screen stays there', async () => {
  for (const origin of [undefined, 'http://evil.example', `http://127.0.0.1:${macbook.port}`]) {
    const r = await call(studio, '/api/plan/studio/session/A/message', { lan: true, cookie: COOKIE, body: { text: 'x' }, origin }); assert.equal(r.status, 403, String(origin)); assert.deepEqual(r.body, { error: 'origine refusée' });
  }
  for (const [p, body] of [['/api/devices'], ['/api/pair/code', { kind: 'poste' }], ['/api/devices/x/forget', {}], ['/api/plan/studio/session/A/terminal', {}], ['/api/plan/studio/session/A/open', {}], ['/api/plan/studio/session/A/devserver', {}], ['/guard?k=x']]) {
    const r = await book(p, body); assert.equal(r.status, 403, p); assert.deepEqual(r.body, { error: 'sur le Studio seulement' }, p);
  }
  assert.equal((await call(studio, '/api/devices')).status, 200, 'the Studio itself keeps them');
});

test('the token is the Studio’s: the MacBook’s own server does not know it; a phone token stays a phone', async () => {
  assert.equal((await call(macbook, '/api/plans', { lan: true, cookie: COOKIE })).status, 401);
  const c = (await call(studio, '/api/pair/code', { body: {} })).body; assert.equal(c.kind, 'phone');
  const ph = (await call(studio, '/api/pair', { lan: true, body: { code: c.code, name: 'iPhone' } })).body;
  assert.match(ph.token, /^[\w-]{43}$/); assert.equal(ph.device.kind, 'phone');
  assert.equal((await call(studio, '/api/plans', { lan: true, token: ph.token })).status, 200);
  assert.equal((await call(studio, '/api/limits', { lan: true, token: ph.token })).status, 403, 'a phone has no (Mac) route');
  assert.equal((await call(studio, '/', { lan: true, cookie: ph.token })).status, 403, 'a phone token in a cookie is still a phone');
});

test('a poste lasts 30 days, can forget itself, and the Studio can forget it', async () => {
  const db = new DatabaseSync(studio.db);
  db.prepare('update devices set created = ? where id = ?').run(new Date(Date.now() - 31 * 864e5).toISOString(), POSTE);
  assert.equal((await book('/api/plans')).status, 401, '31 days: gone');
  db.prepare('update devices set created = ? where id = ?').run(new Date().toISOString(), POSTE);
  assert.equal((await book('/api/plans')).status, 200);
  const f = await book('/api/phone/forget', {}); assert.deepEqual(f.body, { ok: true }); assert.match(f.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await book('/api/plans')).status, 401, 'forgotten by itself');
  // a second poste, forgotten by the Studio
  const c = (await call(studio, '/api/pair/code', { body: { kind: 'poste' } })).body;
  const r = await call(studio, '/api/pair', { lan: true, body: { code: c.code }, origin: studio.origin }); assert.equal(r.body.device.name, 'MacBook', 'the default name of a poste');
  COOKIE = /=([\w-]+);/.exec(r.headers.get('set-cookie'))[1];
  assert.equal((await book('/api/plans')).status, 200);
  assert.deepEqual((await call(studio, `/api/devices/${r.body.device.id}/forget`, { body: {} })).body, { ok: true });
  assert.equal((await book('/api/plans')).status, 401, 'forgotten by the Studio');
  assert.doesNotMatch(studio.err(), /TypeError|ReferenceError/);
});
