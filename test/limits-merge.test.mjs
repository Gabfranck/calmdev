// POST /api/limits merges key by key (2026-11-02, backlog l. 53): a weekly sent alone once reset the model's threshold
// to its default and Fable stayed stopped 10 minutes. A key sent replaces that key, null clears it, the others stay.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const none = tmp('escadrille-limm-none-');
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-limm-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-limm-plans-'), ESCADRILLE_TRANSCRIPTS: none, ESCADRILLE_SESSIONS: none, ESCADRILLE_CLAUDE: '/nonexistent/claude' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill('SIGINT'));
const post = async (body) => { const r = await fetch(BASE + '/api/limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('the Mac: a weekly sent alone keeps model and the other thresholds; null clears one key', async () => {
  await until(async () => { try { return (await fetch(BASE + '/api/plans')).status === 200; } catch { return false; } });
  // the Mac's settings of 2 November (docs/decisions.md): weekly hard 100, model soft 94 hard 97
  let r = await post({ scope: 'mac', limits: { weekly: { soft: 80, hard: 100 }, model: { soft: 94, hard: 97 }, fiveHour: { soft: 90, hard: 98 } } });
  assert.equal(r.status, 200);
  r = await post({ scope: 'mac', limits: { weekly: { soft: 85, hard: 100 } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.mac, { weekly: { soft: 85, hard: 100 }, model: { soft: 94, hard: 97 }, fiveHour: { soft: 90, hard: 98 } }, 'weekly alone must not wipe model nor fiveHour');
  assert.deepEqual(r.body.effective.model, { soft: 94, hard: 97 });
  r = await post({ scope: 'mac', limits: { fiveHour: null } });
  assert.deepEqual(r.body.mac, { weekly: { soft: 85, hard: 100 }, model: { soft: 94, hard: 97 } }, 'an explicit null clears that key only');
  r = await post({ scope: 'mac', limits: null });
  assert.deepEqual(r.body.mac, {}, 'limits: null still clears them all');
});

test('a project: the same merge', async () => {
  const project = tmp('escadrille-limm-proj-');
  let r = await post({ scope: 'project', project, limits: { weekly: { soft: 50, hard: 60 }, model: { soft: 70, hard: 80 } } });
  assert.equal(r.status, 200);
  r = await post({ scope: 'project', project, limits: { weekly: { soft: 55, hard: 60 } } });
  assert.deepEqual(r.body.project, { weekly: { soft: 55, hard: 60 }, model: { soft: 70, hard: 80 } });
  r = await post({ scope: 'project', project, limits: { model: null } });
  assert.deepEqual(r.body.project, { weekly: { soft: 55, hard: 60 } });
});
