// « Ce qui t'attend » shows only what really waits (lib/waiting.mjs): a planning with no answer for more than 12 h is
// marked stale by GET /api/escadrilles and folded on the home into one line « n anciennes », nothing deleted.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isStalePlanning, STALE_PLANNING_MS } from '../lib/waiting.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

test('the rule: waiting for more than 12 h is stale, anything else is not', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const ago = (h) => new Date(now - h * 36e5).toISOString();
  assert.equal(STALE_PLANNING_MS, 12 * 36e5);
  assert.equal(isStalePlanning({ status: 'waiting', at: ago(13) }, now), true);
  assert.equal(isStalePlanning({ status: 'waiting', at: ago(11) }, now), false);
  assert.equal(isStalePlanning({ status: 'waiting', at: ago(12) }, now), false, 'exactly 12 h is not more than 12 h');
  assert.equal(isStalePlanning({ status: 'thinking', at: ago(30) }, now), false, 'only a planning that waits for an answer');
  assert.equal(isStalePlanning({ status: 'waiting', at: null, created: ago(20) }, now), true, 'created when at is missing');
  assert.equal(isStalePlanning({ status: 'waiting', at: 'x' }, now), false);
});

test('GET /api/escadrilles marks the old plannings stale, keeps them all', async () => {
  const PORT = freePort(); const db = path.join(tmp('escadrille-db-'), 'db.sqlite'); const empty = tmp('escadrille-none-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: db, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty }, stdio: 'ignore' });
  servers.push(proc);
  const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
  await until(async () => { try { await get('/api/plans'); return true; } catch { return false; } });
  const d = new DatabaseSync(db); const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
  const ins = d.prepare('insert into escadrilles (id, title, project, model, status, created, at) values (?, ?, ?, ?, ?, ?, ?)');
  ins.run('e-night', 'La nuit', '/p', 'claude-opus-5-5', 'waiting', ago(20), ago(18));
  ins.run('e-now', 'Maintenant', '/p', 'claude-opus-5-5', 'waiting', ago(1), ago(1));
  ins.run('e-old-done', 'Vieille finie', '/p', 'claude-opus-5-5', 'stopped', ago(40), ago(40));
  d.close();
  const list = await get('/api/escadrilles?project=' + encodeURIComponent('/p'));
  const by = Object.fromEntries(list.map((e) => [e.id, e]));
  assert.equal(list.length, 3, 'nothing is deleted');
  assert.equal(by['e-night'].stale, true); assert.equal(by['e-now'].stale, undefined); assert.equal(by['e-old-done'].stale, undefined);
  proc.kill('SIGKILL');
});

test('the home folds the stale plannings into one line, in both languages', () => {
  const js = readFileSync(path.join(HERE, '..', 'public', 'mainchat.js'), 'utf8');
  assert.match(readFileSync(path.join(HERE, '..', 'public', 'todo.js'), 'utf8'), /e\.status === 'waiting' && !e\.stale/, 'a stale planning leaves « À toi » (public/todo.js, phase 11 X)');
  assert.match(js, /<details class="await-old"/, 'one folded line shows them on a click');
  for (const lang of ['en', 'fr']) {
    const d = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', lang + '.json'), 'utf8'));
    for (const k of ['main.oldPlannings', 'main.older', 'main.olderTitle', 'main.planningOld', 'burst.bst.ended', 'srv.b.endTime', 'srv.b.atEnd', 'srv.b.sessionEnded', 'srv.b.notResumed']) assert.ok(d[k], `${lang} ${k}`);
  }
  const fr = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', 'fr.json'), 'utf8'));
  assert.equal(fr['main.oldPlannings'].other, '{n} anciennes');
  assert.equal(fr['main.older'], 'Messages plus anciens', "the thread's key stays untouched");
});
