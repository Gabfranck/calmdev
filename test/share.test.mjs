// The share of the week per project (phase 11 PS, lib/limits.mjs « La part de la semaine »).
//  1. pure: no share, no row; no calibration or no reset, « not measured »; 90 % of the share is the soft line, the share
//     the hard one; not held to « stricter than the Mac »; a share raised lifts its pause under the hard line;
//  2. a simulated stream, two projects: X (share 5 %) passes it and its session pauses, a new one of X waits in the
//     queue, Y (share 50 %) goes on; the share raised in Access resumes X.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rowsOf, verdictOf, validateShare, shareRow, shareSince, pauseStep, pauseOf, hardPausable, effectiveThresholds, marginsSection } from '../lib/limits.mjs';
import { statusOf } from '../lib/status.mjs';
import { plain } from '../lib/i18n.mjs';
import { fakeClaude } from './fake-claude.mjs';
import { freePort } from './free-port.mjs';

const NOW = Date.parse('2026-11-04T12:00:00Z'); const RESET = '2026-11-08T13:00:00.000Z';
const claude = (pct = 10) => ({ weekly: { pct, resetsAt: RESET, rawResetsAt: RESET, at: new Date(NOW).toISOString() } });

test('no share set, no row: nobody is stopped by default', () => {
  const rows = rowsOf({ claude: claude(), now: NOW });
  assert.equal(rows.some((r) => r.kind === 'share'), false);
  assert.equal(shareRow({ maxPct: null, spentUsd: 99, dollarsPerPct: 1, resetsAt: RESET }), null);
  assert.equal(validateShare(null).value, null); assert.equal(validateShare('').value, null);
  assert.equal(validateShare(25).value, 25); assert.ok(validateShare(0).errors); assert.ok(validateShare(101).errors); assert.ok(validateShare('x').errors);
});

test('the share: dollars since the reset over the value of a point, 90 % soft, the share hard, never invented', () => {
  assert.equal(shareSince(RESET), '2026-11-01T13:00:00.000Z');
  // 12 $ at 0.5 $ a point: 24 points of a 50 % share → ok, the soft line at 45
  let r = rowsOf({ claude: claude(), share: { maxPct: 50, spentUsd: 12, dollarsPerPct: 0.5 }, now: NOW }).find((x) => x.kind === 'share');
  assert.equal(r.pct, 24); assert.equal(r.soft, 45); assert.equal(r.hard, 50); assert.equal(r.level, 'ok'); assert.equal(r.resetsAt, RESET); assert.equal(r.usd, 12);
  r = rowsOf({ claude: claude(), share: { maxPct: 50, spentUsd: 23, dollarsPerPct: 0.5 }, now: NOW }).find((x) => x.kind === 'share');
  assert.equal(r.level, 'soft');
  const rows = rowsOf({ claude: claude(), share: { maxPct: 25, spentUsd: 13, dollarsPerPct: 0.5 }, now: NOW });
  r = rows.find((x) => x.kind === 'share'); assert.equal(r.pct, 26); assert.equal(r.level, 'hard');
  assert.equal(plain(verdictOf(rows).line), 'Part de la semaine à 26 %, seuil dur 25 %');
  assert.deepEqual(hardPausable(rows).map((x) => x.id), ['share'], 'the share pauses, like a window that resets');
  assert.match(marginsSection(rows, NOW), /Part de la semaine du projet : 26 % utilisés/);
  // no calibration, no reset read: « not measured », no figure, never a stop
  for (const [share, c, why] of [[{ maxPct: 25, spentUsd: 13, dollarsPerPct: null }, claude(), 'uncalibrated'], [{ maxPct: 25, spentUsd: 13, dollarsPerPct: 0.5 }, null, 'unmeasured']]) {
    const rr = rowsOf({ claude: c, share, now: NOW }); const x = rr.find((y) => y.kind === 'share');
    assert.equal(x.pct, null); assert.equal(x.reason, why); assert.equal(x.level, 'unmeasured'); assert.equal(verdictOf(rr).level, 'ok');
  }
  // not held to « stricter than the Mac »: a Mac weekly at 95 does not move the share, the share does not move the Mac
  const t = effectiveThresholds({ weekly: { soft: 90, hard: 95 } }, {});
  r = rowsOf({ claude: claude(), share: { maxPct: 30, spentUsd: 1, dollarsPerPct: 0.5 }, thresholds: t, now: NOW });
  assert.equal(r.find((x) => x.kind === 'share').hard, 30); assert.equal(r.find((x) => x.kind === 'weekly').hard, 95);
  // the status panel carries the row
  const s = statusOf({ project: '/tmp/x', quota: null, measure: { last: { at: new Date(NOW).toISOString(), weekly: { pct: 10, resetsAt: RESET } } }, share: { maxPct: 50, spentUsd: 5, dollarsPerPct: 0.5 }, account: null, now: NOW });
  assert.equal(s.limits.rows.find((x) => x.kind === 'share').pct, 10);
});

test('a paused share holds over the share, resumes at the reset or once raised over what was used', () => {
  const over = rowsOf({ claude: claude(), share: { maxPct: 25, spentUsd: 13, dollarsPerPct: 0.5 }, now: NOW });
  const pause = pauseOf(over.find((x) => x.kind === 'share'), 'line', new Date(NOW).toISOString());
  assert.equal(pause.until, RESET);
  assert.equal(pauseStep(pause, over, NOW).action, 'hold');
  // raised to 28: 26 is above its 90 % (25.2) but under the share: the sessions go on
  const raised = rowsOf({ claude: claude(), share: { maxPct: 28, spentUsd: 13, dollarsPerPct: 0.5 }, now: NOW });
  assert.equal(raised.find((x) => x.kind === 'share').level, 'soft');
  assert.deepEqual(pauseStep(pause, raised, NOW), { action: 'resume', why: 'below' });
  assert.deepEqual(pauseStep(pause, over, Date.parse(RESET) + 1000).action, 'hold', 'still over at the next reading: the new week holds it again');
  assert.deepEqual(pauseStep(pause, [], Date.parse(RESET) + 1000), { action: 'resume', why: 'reset' });
});

// ---------------------------------------------------------------- the simulated stream, two projects
const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-share-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
after(() => { for (const s of servers) s.kill('SIGINT'); });

test('two projects: the one past its share pauses alone, the other goes on; raising the share resumes it', async () => {
  const fake = fakeClaude(); const X = repo(); const Y = repo();
  const port = freePort(); const base = `http://127.0.0.1:${port}`;
  // each turn costs 0.06 $; a point is worth 0.01 $: one turn is 6 points of the week
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: path.join(tmp('escadrille-share-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-share-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-share-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-share-none-'), ESCADRILLE_CLAUDE: fake.file, FAKE_CLAUDE_TURNS: JSON.stringify([{ hold: 300, stops: [0], claude: 'Tour 1' }]), FAKE_CLAUDE_WEEKLY: '0.10', FAKE_CLAUDE_TURN_COST: '0.06', ESCADRILLE_DOLLARS_PER_PCT: '0.01', ESCADRILLE_PAUSE_TICK_MS: '200', ESCADRILLE_BURST_TICK_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; }); servers.push(proc);
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const row = async (plan, id) => (await get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  const session = (root, id) => ({ id, name: id, path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 5 });
  await until(async () => { try { return (await fetch(base + '/api/plans')).status === 200; } catch { return false; } });

  // the shares: X 5 %, Y 50 %; a share is a project's, never the Mac's; out of range is refused
  const sx = await post('/api/limits', { project: X, share: 5 }); assert.equal(sx.status, 200); assert.equal(sx.body.share.max, 5);
  assert.equal((await post('/api/limits', { project: Y, share: 50 })).status, 200);
  assert.equal((await post('/api/limits', { project: X, share: 150 })).status, 400);
  assert.equal((await get('/api/limits?project=' + encodeURIComponent(X))).share.max, 5);
  assert.equal((await get('/api/limits')).share, null);

  for (const [plan, root, id] of [['p-x', X, 'A'], ['p-y', Y, 'B']]) {
    assert.equal((await post('/api/plan', { id: plan, title: plan, sessions: [session(root, id)] })).status, 200);
    assert.deepEqual((await post('/api/launch', { plan })).body, { ok: true, launched: [id], queued: [] });
  }
  // X: 6 points of a 5 % share → paused, the limit is the share, until the weekly reset
  const a = await until(async () => { const r = await row('p-x', 'A'); return r.status === 'paused' ? r : null; });
  assert.equal(a.pause.limit, 'share'); assert.ok(a.pause.until, 'until the weekly reset');
  assert.match(a.claude, /Part de la semaine à 6 %, seuil dur 5 %/);
  const lx = await get('/api/limits?project=' + encodeURIComponent(X));
  assert.equal(lx.share.row.pct, 6); assert.equal(lx.share.row.level, 'hard');
  const st = await get('/api/status?project=' + encodeURIComponent(X));
  assert.equal(st.limits.rows.find((r) => r.kind === 'share').pct, 6);
  // Y: 6 points of 50 %, not touched
  await sleep(800);
  const b = await row('p-y', 'B'); assert.notEqual(b.status, 'paused'); assert.equal(b.health, 'ok');
  assert.equal((await get('/api/limits?project=' + encodeURIComponent(Y))).share.row.level, 'ok');
  // a new session of X waits in the queue, one of Y starts
  assert.equal((await post('/api/plan', { id: 'p-x2', title: 'x2', sessions: [session(X, 'C')] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'p-x2' })).body, { ok: true, launched: [], queued: ['C'] });
  assert.equal((await post('/api/plan', { id: 'p-y2', title: 'y2', sessions: [session(Y, 'D')] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'p-y2' })).body, { ok: true, launched: ['D'], queued: [] });
  // the share of X raised to 50: A resumes, C leaves the queue
  assert.equal((await post('/api/limits', { project: X, share: 50 })).status, 200);
  await until(async () => (await row('p-x', 'A')).status !== 'paused');
  await until(async () => ['running', 'waiting'].includes((await row('p-x2', 'C')).status));
  // removed: no row any more
  assert.equal((await post('/api/limits', { project: X, share: null })).body.share.max, null);
  assert.equal((await get('/api/limits?project=' + encodeURIComponent(X))).share.row, null);
  assert.equal(err.includes('limits Error'), false, err);
});
