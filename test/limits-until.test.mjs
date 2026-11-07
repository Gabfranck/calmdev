// A threshold with an end date (Dev, 2 November: « 50 % jusqu'à lundi soir »): POST /api/limits takes `until` (ISO) per
// key, keeps the value it replaces, and at that hour the previous value comes back alone, with a line in the pilot's
// journal. Settings stored before (no `until`) pass unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testEnv } from './test-env.mjs';
import { freePort } from './free-port.mjs';
import * as limits from '../lib/limits.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

test('validate, merge and expire: the previous value kept, then back; old settings unchanged', () => {
  assert.ok(limits.validateThresholds({ weekly: { soft: 50, hard: 60, until: 'lundi soir' } }).errors, 'a date that is not one: refused');
  const sent = { weekly: { soft: 50, hard: 60, until: '2026-11-09T19:00:00Z' } };
  const { value } = limits.validateThresholds(sent);
  assert.equal(value.weekly.until, '2026-11-09T19:00:00.000Z');
  const old = { weekly: { soft: 80, hard: 95 }, fiveHour: { soft: 90, hard: 98 } };
  const m = limits.mergeThresholds(old, sent, value);
  assert.deepEqual(m.weekly, { soft: 50, hard: 60, until: '2026-11-09T19:00:00.000Z', previous: { soft: 80, hard: 95 } });
  // a second timed value keeps the value from before any temporary one
  const again = { weekly: { soft: 40, hard: 50, until: '2026-11-10T19:00:00Z' } };
  assert.deepEqual(limits.mergeThresholds(m, again, limits.validateThresholds(again).value).weekly.previous, { soft: 80, hard: 95 });
  // before the hour nothing moves; after it, the previous value comes back
  assert.equal(limits.expireThresholds(m, Date.parse('2026-11-09T18:59:00Z')).value, m);
  const e = limits.expireThresholds(m, Date.parse('2026-11-09T19:00:01Z'));
  assert.deepEqual(e.value, old);
  assert.deepEqual(e.expired, [{ key: 'weekly', until: '2026-11-09T19:00:00.000Z', from: { soft: 50, hard: 60 }, to: { soft: 80, hard: 95 } }]);
  // nothing before: the key goes away (the level above applies again)
  const fresh = limits.mergeThresholds({}, sent, value);
  assert.deepEqual(limits.expireThresholds(fresh, Date.parse('2026-11-10T00:00:00Z')).value, {});
  // stored before this change: untouched, and the effective thresholds read the timed one as a plain one
  assert.equal(limits.expireThresholds(old).value, old);
  assert.deepEqual(limits.effectiveThresholds(m).weekly, { soft: 50, hard: 60 });
});

test('the server: a timed Mac threshold comes back alone at its hour, the journal says it', async () => {
  const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
  const project = tmp('escadrille-until-proj-');
  const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-until-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-until-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-until-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-until-none-'), ESCADRILLE_PAUSE_TICK_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; server.stderr.on('data', (d) => { err += d; });
  after(() => server.kill('SIGINT'));
  const get = async (p) => (await fetch(BASE + p)).json();
  const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  await until(async () => { try { return (await fetch(BASE + '/api/plans')).status === 200; } catch { return false; } });

  assert.equal((await post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 20, hard: 25 } } })).status, 200);
  assert.equal((await post('/api/limits', { scope: 'project', project, limits: { fiveHour: { soft: 60, hard: 70 } } })).status, 200);
  assert.equal((await post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 50, hard: 60, until: 'demain' } } })).status, 400);
  const end = new Date(Date.now() + 1500).toISOString();
  let r = await post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 50, hard: 60, until: end } } });
  assert.equal(r.status, 200, JSON.stringify(r.body) + err);
  assert.deepEqual(r.body.mac.weekly, { soft: 50, hard: 60, until: end, previous: { soft: 20, hard: 25 } });
  assert.deepEqual(r.body.effective.weekly, { soft: 50, hard: 60 });
  r = await post('/api/limits', { scope: 'project', project, limits: { model: { soft: 30, hard: 40, until: end } } });
  assert.equal(r.status, 200);

  const back = await until(async () => { const g = await get('/api/limits?project=' + encodeURIComponent(project)); return g.mac.weekly && !g.mac.weekly.until && !g.project.model ? g : null; }, 8000);
  assert.deepEqual(back.mac, { weekly: { soft: 20, hard: 25 } }, 'the Mac value from before');
  assert.deepEqual(back.project, { fiveHour: { soft: 60, hard: 70 } }, 'nothing before on the project: the key goes away, the others stay');
  const log = await until(async () => { const l = await get('/api/pilot/log?project=' + encodeURIComponent(project)); return l.actions && l.actions.some((a) => /Seuil model/.test(a.text)) ? l : null; });
  assert.ok(log.actions.some((a) => a.kind === 'note' && /Seuil model \(ce projet\) revenu/.test(a.text)), JSON.stringify(log.actions));
});
