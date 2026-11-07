// Phase 16 TIX, the two routes (docs/connectors.md « Partir des tickets »): GET /api/tickets and POST
// /api/plan/from-tickets on a real server, a fake claude, a fake gh and a fake Linear. No network, read only.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeGh, fakeLinear, LINEAR_KEY } from './fake-gh.mjs';
import { fakeClaude } from './fake-claude.mjs';
import * as secrets from '../lib/secrets.mjs';
import { CONSIGNE } from '../lib/tickets.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const gh = fakeGh(); const lin = await fakeLinear();
const withKey = tmp('escadrille-tix-a-'); const noKey = tmp('escadrille-tix-b-');
const SECRETS = path.join(tmp('escadrille-secrets-'), 'escadrille', 'secrets.json');
secrets.set(withKey, 'linear', LINEAR_KEY, SECRETS);
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fakeClaude().file, ESCADRILLE_GH: gh.file, ESCADRILLE_LINEAR_URL: lin.url, ESCADRILLE_SECRETS: SECRETS, ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', (d) => { logs += d; }); server.stderr.on('data', (d) => { logs += d; });
after(() => { server.kill('SIGINT'); lin.close(); });
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const q = encodeURIComponent;
await until(async () => { try { return (await fetch(BASE + '/api/plans')).ok; } catch { return false; } });

test('GET /api/tickets: Linear by the project key, GitHub as GH-<n>, the sentence and the gesture otherwise', async () => {
  const l = await get(`/api/tickets?project=${q(withKey)}&source=linear`);
  assert.equal(l.status, 200); assert.equal(l.body.length, 50);
  assert.deepEqual(Object.keys(l.body[0]).sort(), ['id', 'source', 'state', 'title', 'url']);
  assert.deepEqual((await get(`/api/tickets?project=${q(withKey)}&source=linear&q=ops`)).body.map((t) => t.id), ['OPS-3']);
  assert.deepEqual((await get(`/api/tickets?project=${q(withKey)}&source=github`)).body.map((t) => t.id), ['GH-12', 'GH-13', 'GH-14']);
  const none = await get(`/api/tickets?project=${q(noKey)}&source=linear`);
  assert.equal(none.status, 400); assert.match(none.body.error, /aucune clé pour ce projet ; colle ta clé personnelle dans Réglages du projet/);
  gh.setMode('unauth');
  try { const u = await get(`/api/tickets?project=${q(withKey)}&source=github`); assert.equal(u.status, 400); assert.match(u.body.error, /lance gh auth login/); } finally { gh.setMode(''); }
  assert.ok(!JSON.stringify(l.body).includes(LINEAR_KEY) && !logs.includes(LINEAR_KEY), 'the key never comes back');
});

test('POST /api/plan/from-tickets: the planning starts with the tickets in its first message, read only', async () => {
  const mutations = () => lin.requests.filter((r) => /mutation/.test(r.query)).length; const before = mutations();
  const r = await post('/api/plan/from-tickets', { project: withKey, ids: ['ORC-88', 'GH-12', 'GH-14'], idea: 'Le lot de novembre' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.id);
  const e = await until(async () => { const x = (await get(`/api/escadrille/${r.body.id}`)).body; return x.messages?.length ? x : null; });
  const first = e.messages.find((m) => m.role === 'user').text;
  assert.ok(first.startsWith(`Le lot de novembre\n\n## Les tickets\n\n${CONSIGNE}\n\n### ORC-88 · Ticket ORC-88`));
  assert.equal(first.split(/\n(?=### )/).length - 1, 3);
  assert.match(first, /### GH-12 · Issue 12/); assert.match(first, /### GH-14 · Issue 14/);
  assert.equal(mutations(), before, 'no state, no comment changed');
  assert.equal((await post('/api/plan/from-tickets', { project: withKey, ids: Array.from({ length: 9 }, (_, i) => `GH-${i + 1}`) })).status, 400);
  assert.match((await post('/api/plan/from-tickets', { project: noKey, ids: ['ORC-88'] })).body.error, /Réglages du projet/);
});
