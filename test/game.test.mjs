// The progression (docs/game.md): points from a fixture database, a retroactive achievement, the setting that switches it off
import { freePort } from './free-port.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { levelOf, planXp, rankOf, streakOf, XP } from '../lib/game.mjs';

const fixture = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, session_id text, mode text, worktree text, usage text, pending text, handoffs text, summary text, alerted text, pushed text, primary key (plan, id));
    create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
    create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
    create table escadrilles (id text primary key, title text, project text, created text, at text);
    create table reviews (id text primary key, project text, plan text, session text, level text, verdict text, verdict_at text);
    create table review_comments (id integer primary key autoincrement, review text, at text, resolved integer default 0);
    create table review_viewed (review text, path text, blob text, at text, primary key (review, path));`);
  const P = '/tmp/proj';
  db.prepare('insert into escadrilles values (?, ?, ?, ?, ?)').run('e1', 'Phase 1', P, '2026-11-01T00:30:00.000Z', '2026-11-01T00:30:00.000Z');
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('p1', 'Plan 1', '2026-11-01T00:00:00Z', JSON.stringify({ id: 'p1', sessions: [{ id: 'A', budget: 2 }, { id: 'B', budget: 2 }] }), P);
  // A at 02:10 local, B at 03:20 local: both finished in the night, both merged, $1 spent on a $4 budget
  const night = (h, m) => new Date(2026, 10, 1, h, m).toISOString();
  for (const [sid, at] of [['A', night(2, 10)], ['B', night(3, 20)]]) {
    db.prepare("insert into sessions (plan, id, status, stops, health, at, worktree, usage, handoffs) values ('p1', ?, 'done', '[]', 'ok', ?, ?, ?, ?)")
      .run(sid, at, JSON.stringify({ merged: true }), JSON.stringify({ cost: 0.5 }), sid === 'A' ? JSON.stringify([{ n: 1, at }]) : '[]');
    db.prepare("insert into log (plan, session, at, status, health, claude) values ('p1', ?, ?, 'running', 'ok', 'Lancée')").run(sid, night(1, 0));
    db.prepare("insert into log (plan, session, at, status, health, claude) values ('p1', ?, ?, 'done', 'ok', 'Fini')").run(sid, at);
    db.prepare("insert into log (plan, session, at, status, health, claude) values ('p1', ?, ?, 'done', 'ok', 'Fusionnée dans /tmp/proj')").run(sid, night(9, 0));
  }
  db.prepare("insert into reviews values ('r1', ?, 'p1', 'A', 'strict', 'approve', ?)").run(P, night(8, 0));
  db.prepare("insert into review_comments (review, at, resolved) values ('r1', ?, 1)").run(night(8, 0));
  db.prepare("insert into review_viewed values ('r1', 'a.js', 'x', ?), ('r1', 'b.js', 'y', ?)").run(night(7, 0), night(7, 5));
  return { db, P };
};

test('points: merges, strict review, viewed, resolved, plan under budget, unattended, handoff, rule; nothing for lines', () => {
  const { db, P } = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), 'game-')); mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'regles.md'), '# Règles\n\n- Pas de dépendance\n- Un test par route\n');
  const g = levelOf(db, { project: P, rulesFile: path.join(dir, 'docs', 'regles.md'), now: new Date(2026, 10, 1, 12) });
  const expected = 2 * XP.merge + XP.reviewStrict + 2 * XP.viewed + XP.resolved + (XP.underBudget + XP.savedCap) + XP.unattended + XP.handoff + 2 * XP.rule;
  assert.equal(g.xp, expected);
  assert.equal(g.rank, rankOf(expected).rank);
  assert.equal(g.week.quests.find((q) => q.id === 'rule').done, 1);
  assert.equal(g.week.streak.days, 1);
});

test('achievements are retroactive: the night of November 1st shows', () => {
  const { db, P } = fixture();
  const g = levelOf(db, { project: P, now: new Date(2026, 10, 2, 12) });
  const won = (id) => g.badges.find((b) => b.id === id).at;
  assert.ok(won('night'), 'Nuit blanche'); assert.ok(won('first-escadrille')); assert.ok(won('first-merge'));
  assert.ok(won('frugal')); assert.ok(won('strict')); assert.ok(won('architect')); assert.ok(won('relay')); assert.ok(won('autopilot'));
  assert.equal(won('reviewer'), null); assert.equal(won('zero-red'), null);
  assert.equal(g.badges.length, 15);
  assert.ok(g.badges.every((b) => b.why.split(' ').length <= 10));
  // another project sees none of it
  assert.equal(levelOf(db, { project: '/tmp/other' }).xp, 0);
  assert.equal(planXp(db, 'p1').earned, 2 * XP.merge + XP.underBudget + XP.savedCap + XP.unattended + XP.handoff);
});

test('the streak forgives one empty day per week and never goes below what was done', () => {
  const days = ['2026-10-26', '2026-10-27', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
  assert.deepEqual(streakOf(days, new Date(2026, 10, 1, 20)), { days: 6, frozen: 1 });
  assert.equal(streakOf([], new Date(2026, 10, 1)).days, 0);
});

test("GET /api/game, and 'game': false in the project's settings switches it off", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'game-srv-')); const proj = path.join(tmp, 'proj'); mkdirSync(proj);
  const port = freePort();
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: path.join(import.meta.dirname, '..'), env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: path.join(tmp, 'x.sqlite'), ESCADRILLE_PLANS: path.join(tmp, 'plans'), ESCADRILLE_CLAUDE: process.execPath }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) { try { await fetch(base + '/api/models'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const on = await (await fetch(`${base}/api/game?project=${encodeURIComponent(proj)}`)).json();
    assert.equal(on.xp, 0); assert.equal(on.rank, 'Élève pilote'); assert.equal(on.week.quests.length, 3);
    const set = await fetch(base + '/api/project/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: proj, game: false }) });
    assert.equal((await set.json()).settings.game, false);
    assert.deepEqual(await (await fetch(`${base}/api/game?project=${encodeURIComponent(proj)}`)).json(), { off: true });
  } finally { srv.kill(); }
});
