// The usage estimate against synthetic transcripts (test/fixtures/projects): duplicated lines per
// message.id, a sidechain, two models, two projects, a subfolder the scan must not enter; first user
// messages of 200, 100 and 400 characters; and a fake ~/.claude/sessions (test/fixtures/sessions) whose
// .json and .key files name sessions with and without a transcript.
import { freePort } from './free-port.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, utimesSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanTranscripts, parseTranscript, parseTranscriptFile, costOf, calibrate, estimateSession, estimatePlan, median, quantile, PRICES, usageReport, scanLiveSessions, unseenSessions, promptFactor, lastQuota } from '../lib/usage.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, 'fixtures', 'projects');
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const tmpDb = () => new DatabaseSync(path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-usage-'))), 'db.sqlite'));
const byId = (list) => Object.fromEntries(list.map((s) => [s.sessionId, s]));
// The quota the server would have seen: 1 % at midnight, the 7 days before hold a1 and a2, not b1
const QUOTA = { weekly: 0.01, resetsAt: '2026-11-01T13:00:00.000Z', at: '2026-11-01T00:00:00.000Z' };
// The fake sessions folder: git keeps no mtime, so the two lone .key files get theirs here
const SESSIONS = path.join(HERE, 'fixtures', 'sessions');
const touch = (f, iso) => utimesSync(path.join(SESSIONS, f), new Date(iso), new Date(iso));
touch('104.dd44.key', '2026-10-30T09:59:30.000Z'); // a1 starts at 09:59: seen
touch('105.ee55.key', '2026-10-31T22:00:00.000Z'); // no transcript near: unseen
for (const f of ['101.aa11.key', '102.bb22.key', '103.cc33.key', '106.ff66.key']) touch(f, '2026-10-31T23:00:00.000Z'); // paired with a .json: ignored
const LIVE = scanLiveSessions({ dir: SESSIONS });

test('scan aggregates each file once per message.id, counts sidechain tokens but not its turns', () => {
  const s = byId(scanTranscripts({ root: ROOT }));
  assert.deepEqual(Object.keys(s).sort(), ['a1', 'a2', 'b1'], 'three sessions, the subfolder is not read');
  // a1: m1 three times (counted once), m2, the sidechain s1; the <synthetic> line and the broken line are ignored
  assert.equal(s.a1.project, '/fx/alpha');
  assert.equal(s.a1.model, 'claude-opus-5-5');
  assert.equal(s.a1.input, (10 + 100 + 1000) + (5 + 2000) + (1 + 500));
  assert.equal(s.a1.output, 50 + 20 + 10);
  assert.equal(s.a1.tokens, 3616 + 80);
  assert.equal(s.a1.turns, 2);
  assert.deepEqual(s.a1.buckets, [16, 60, 40, 3500, 80]);
  assert.equal(s.a1.firstAt, '2026-10-30T09:59:00.000Z');
  assert.equal(s.a1.lastAt, '2026-10-30T10:03:00.000Z');
  assert.equal(s.a2.model, 'claude-fable-5-1');
  assert.equal(s.a2.tokens, 3120);
  assert.equal(s.b1.project, '/fx/beta');
  assert.equal(s.b1.tokens, 2000);
  // the first user message, text only: a1's meta line is skipped and its image block left out
  assert.deepEqual([s.a1.promptChars, s.a2.promptChars, s.b1.promptChars], [200, 100, 400]);
});

test('the live sessions folder: .json name their session, a lone .key is dated by its mtime', () => {
  const byPid = Object.fromEntries(LIVE.map((x) => [x.pid, x]));
  assert.deepEqual(Object.keys(byPid).map(Number).sort(), [101, 102, 103, 104, 105, 106]);
  assert.deepEqual(byPid[102], { pid: 102, sessionId: 'live-1', cwd: '/fx/alpha', startedAt: Date.parse('2026-10-31T20:00:00.000Z'), entrypoint: 'cli' });
  assert.equal(byPid[105].sessionId, null); assert.equal(byPid[105].startedAt, Date.parse('2026-10-31T22:00:00.000Z'));
  assert.deepEqual(scanLiveSessions({ dir: path.join(SESSIONS, 'missing') }), []);
});

test('unseen: a session with no transcript, by sessionId or by a .key with no transcript within two minutes', () => {
  const t = scanTranscripts({ root: ROOT });
  const at = Date.parse(QUOTA.at);
  const u = unseenSessions(t, LIVE, at - 7 * 864e5, at);
  // 101 has a2's transcript, 104 sits 30 s after a1's start, 106 is out of the window
  assert.deepEqual(u.map((x) => x.sessionId), [null, 'live-2', 'live-1']);
  assert.deepEqual(u.map((x) => x.cwd), [null, '/fx/gamma', '/fx/alpha']);
  assert.equal(u[0].startedAt, '2026-10-31T22:00:00.000Z');
  assert.equal(unseenSessions(t, LIVE, at, at + 864e5).length, 0, 'an empty window');
});


test('a transcript file is parsed by chunks: lines across a chunk edge, multi-byte text, a file past 1 MB, same result as the whole text', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-chunks-')));
  const fp = path.join(dir, 'big.jsonl');
  const row = (i) => JSON.stringify({ type: 'assistant', sessionId: 'big', cwd: '/fx/alpha', timestamp: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, message: { id: 'm' + i, model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'é'.repeat(700) + 'ü'.repeat(300) }] } });
  const lines = []; for (let i = 0; i < 1500; i++) lines.push(row(i)); // ≈ 3 MB, three chunk edges inside lines
  const text = lines.join('\n') + '\n';
  writeFileSync(fp, text);
  assert.ok(statSync(fp).size > 2 * (1 << 20));
  const a = parseTranscriptFile(fp), b = parseTranscript(text, fp);
  assert.equal(a.turns, 1500); assert.equal(a.input, 1500 * 11); assert.equal(a.output, 3000);
  assert.deepEqual(a, b);
});

test('the last occurrence of a message.id wins', () => {
  const line = (out) => JSON.stringify({ type: 'assistant', sessionId: 'x', timestamp: '2026-10-30T10:00:00.000Z', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out } } });
  assert.equal(parseTranscript([line(5), line(7)].join('\n')).output, 7);
});

test('scan caches in SQLite and invalidates on mtime', () => {
  const db = tmpDb();
  const first = scanTranscripts({ db, root: ROOT });
  assert.equal(db.prepare('select count(*) as n from transcripts').get().n, 3);
  db.prepare("update transcripts set json = json_set(json, '$.turns', 99) where path like '%a2.jsonl'").run();
  assert.equal(byId(scanTranscripts({ db, root: ROOT })).a2.turns, 99, 'served from the cache');
  const f = path.join(ROOT, '-fx-alpha', 'a2.jsonl'); const st = statSync(f);
  utimesSync(f, st.atime, new Date(st.mtimeMs + 1000));
  assert.equal(byId(scanTranscripts({ db, root: ROOT })).a2.turns, 1, 're-read after a change');
  assert.equal(first.length, 3);
});

test('median and quartiles', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([2000, 3120, 3696], 0.25), 2560);
  assert.equal(quantile([2000, 3120, 3696], 0.75), 3408);
  assert.equal(median([]), 0);
});

test('cost at public prices, cache writes split by TTL', () => {
  // a1 on Opus 5.5: 16 in x $4, 60 5m-writes x $5, 40 1h-writes x $8, 3500 reads x $0.20, 80 out x $20
  near(costOf([16, 60, 40, 3500, 80], 'claude-opus-5-5'), (64 + 300 + 320 + 700 + 1600) / 1e6);
  near(costOf([20, 0, 0, 3000, 100], 'claude-fable-5-1'), (200 + 750 + 5000) / 1e6);
  assert.equal(costOf([1, 0, 0, 0, 0], 'gpt-4'), null);
  assert.deepEqual(Object.keys(PRICES).sort(), ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
});

test('calibration: 7 days of cost before the observed quota', () => {
  const sessions = scanTranscripts({ root: ROOT });
  const cal = calibrate({ sessions, quota: QUOTA, live: LIVE, cacheMs: 0 });
  const cost7d = (2984 + 5950) / 1e6; // a1 + a2; b1 is 12 days old
  assert.equal(cal.calibrated, true);
  assert.equal(cal.sessions, 2);
  near(cal.cost7d, cost7d);
  near(cal.dollarsPerPct, cost7d / 1);
  assert.equal(cal.unseen, 3);
  assert.deepEqual(cal.unseenDirs, ['/fx/alpha', '/fx/gamma']);
  const none = calibrate({ sessions, quota: null, live: LIVE, now: Date.parse(QUOTA.at), cacheMs: 0 });
  assert.equal(none.calibrated, false); assert.equal(none.dollarsPerPct, null); assert.equal(none.weeklyNow, null);
  assert.equal(none.unseen, 3, 'without a quota, the 7 days before now');
  assert.equal(calibrate({ sessions, quota: QUOTA, live: [], cacheMs: 0 }).unseen, 0);
});

test('prompt factor: planned length over the median first message of the base, held in [0.5, 2]', () => {
  const pool = [{ promptChars: 200 }, { promptChars: 100 }, { promptChars: 400 }, { promptChars: null }];
  assert.deepEqual(promptFactor(300, pool), { promptChars: 300, baseChars: 200, factor: 1.5 });
  assert.equal(promptFactor(50, pool).factor, 0.5, 'floor');
  assert.equal(promptFactor(5000, pool).factor, 2, 'ceiling');
  assert.deepEqual(promptFactor(0, pool), { promptChars: 0, baseChars: 200, factor: 1 }, 'no prompt');
  assert.deepEqual(promptFactor(300, [{ promptChars: null }]), { promptChars: 300, baseChars: null, factor: 1 }, 'no known length');
});

test('the factor multiplies tokens, range, input, output and cost', () => {
  const sessions = scanTranscripts({ root: ROOT });
  const cal = calibrate({ sessions, quota: QUOTA, live: LIVE, cacheMs: 0 });
  const plain = estimateSession({ id: 'A', path: '/fx/alpha', model: 'claude-sonnet-5-5' }, {}, { sessions, calibration: cal });
  const long = estimateSession({ id: 'A', path: '/fx/alpha', model: 'claude-sonnet-5-5', prompt: 'p'.repeat(300) }, {}, { sessions, calibration: cal });
  assert.deepEqual([long.basis.promptChars, long.basis.baseChars, long.basis.factor], [300, 200, 1.5]);
  for (const k of ['tokens', 'low', 'high', 'input', 'output']) assert.equal(long[k], Math.round(plain[k] * 1.5), k);
  near(long.cost, Math.round(1842e-6 * 1.5 * 1e4) / 1e4);
  near(long.weeklyPct, Math.round((1842e-6 * 1.5 / cal.dollarsPerPct / 100) * 1e6) / 1e6);
  const short = estimateSession({ id: 'A', path: '/fx/alpha', model: 'claude-sonnet-5-5', prompt: 'p'.repeat(20) }, {}, { sessions, calibration: cal });
  assert.equal(short.basis.factor, 0.5); assert.equal(short.tokens, 1560);
});

test('estimateSession: all projects under three sessions, project scope from three, cost at the planned model', () => {
  const sessions = scanTranscripts({ root: ROOT });
  const cal = calibrate({ sessions, quota: QUOTA, live: LIVE, cacheMs: 0 });
  const e = estimateSession({ id: 'A', path: '/fx/alpha', model: 'claude-sonnet-5-5' }, {}, { sessions, calibration: cal });
  assert.deepEqual(e.basis, { sessions: 3, scope: 'all', model: 'claude-sonnet-5-5', calibrated: true, unseen: 3, promptChars: 0, baseChars: 200, factor: 1 });
  assert.equal(e.tokens, 3120); assert.equal(e.low, 2560); assert.equal(e.high, 3408);
  assert.equal(e.input, 3020); assert.equal(e.output, 100);
  // re-priced at Sonnet 5.5: a1 1842e-6, a2 1640e-6, b1 12000e-6 -> median 1842e-6
  assert.equal(e.cost, 0.0018);
  near(e.weeklyPct, Math.round((1842e-6 / cal.dollarsPerPct / 100) * 1e6) / 1e6);

  const a1 = sessions.find((s) => s.sessionId === 'a1');
  const many = [...Array.from({ length: 5 }, (_, i) => ({ ...a1, sessionId: 'a' + i })), sessions.find((s) => s.sessionId === 'b1')];
  const two = estimateSession({ id: 'A', path: '/fx/alpha', model: 'opus' }, {}, { sessions: [...many.slice(0, 2), many[5]], calibration: cal });
  assert.equal(two.basis.scope, 'all'); // two sessions of the project: not enough
  const three = estimateSession({ id: 'A', path: '/fx/alpha', model: 'opus' }, {}, { sessions: [...many.slice(0, 3), many[5]], calibration: cal });
  assert.deepEqual([three.basis.scope, three.basis.sessions], ['project', 3]); // three is enough
  const p = estimateSession({ id: 'A', path: '/fx/alpha', model: 'opus' }, {}, { sessions: many, calibration: cal });
  assert.deepEqual(p.basis, { sessions: 5, scope: 'project', model: 'claude-opus-5-5', calibrated: true, unseen: 1, promptChars: 0, baseChars: 200, factor: 1 }); // one unseen session in /fx/alpha
  assert.equal(p.tokens, 3696);

  const empty = estimateSession({ id: 'A', path: '/fx/alpha', model: 'claude-opus-5-5' }, {}, { sessions: [], calibration: null });
  assert.deepEqual(empty.basis, { sessions: 0, scope: 'none', model: 'claude-opus-5-5', calibrated: false, unseen: 0, promptChars: 0, baseChars: null, factor: 1 });
  assert.equal(empty.cost, null); assert.equal(empty.weeklyPct, null);
});

test('estimatePlan sums the sessions and says weeklyAfter', () => {
  const sessions = scanTranscripts({ root: ROOT });
  const calibration = calibrate({ sessions, quota: QUOTA, live: LIVE, cacheMs: 0 });
  const plan = { id: 'p', sessions: [{ id: 'A', path: '/fx/alpha', model: 'claude-opus-5-5' }, { id: 'B', path: '/fx/beta', model: 'claude-fable-5-1' }] };
  const est = estimatePlan(plan, { sessions, calibration });
  near(est.total.cost, est.sessions.A.cost + est.sessions.B.cost, 1e-4);
  near(est.total.weeklyPct, est.sessions.A.weeklyPct + est.sessions.B.weeklyPct, 1e-5);
  near(est.total.weeklyAfter, 0.01 + est.total.weeklyPct, 1e-6);
  assert.equal(est.total.resetsAt, QUOTA.resetsAt);
  const raw = estimatePlan({ id: 'p', sessions: [{ id: 'A' }] }, { sessions, calibration });
  assert.equal(raw.sessions.A.cost, null, 'no model, no price');
  assert.equal(raw.total.cost, null); assert.equal(raw.total.weeklyPct, null);
  assert.equal(est.calibration.unseen, 3); assert.deepEqual(est.calibration.unseenDirs, ['/fx/alpha', '/fx/gamma']);
});

test('usageReport lists sessions with their cost and summaries', () => {
  const r = usageReport({ db: tmpDb(), root: ROOT, sessionsDir: SESSIONS });
  assert.equal(r.scanned.sessions, 3);
  assert.equal(r.sessions[0].sessionId, 'a2', 'the most recent first');
  assert.deepEqual(r.byModel.map((x) => x.key).sort(), ['claude-fable-5-1', 'claude-opus-5-5']);
  assert.equal(r.calibration.calibrated, false, 'no escadrille table, no quota');
  assert.equal(r.sessions.find((s) => s.sessionId === 'a1').promptChars, 200);
});

// ---------------------------------------------------------------- the contract, through the server
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => v === null || num(v);
const keys = (o, expected, where) => assert.deepEqual(Object.keys(o).sort(), [...expected].sort(), `keys of ${where}`);
const checkSession = (s, where) => {
  keys(s, ['tokens', 'low', 'high', 'input', 'output', 'cost', 'weeklyPct', 'basis'], where);
  for (const k of ['tokens', 'low', 'high', 'input', 'output']) assert.ok(Number.isInteger(s[k]), `${where}.${k} is an integer`);
  assert.ok(numOrNull(s.cost), `${where}.cost`); assert.ok(numOrNull(s.weeklyPct), `${where}.weeklyPct`);
  keys(s.basis, ['sessions', 'scope', 'model', 'calibrated', 'unseen', 'promptChars', 'baseChars', 'factor'], where + '.basis');
  for (const k of ['unseen', 'promptChars']) assert.ok(Number.isInteger(s.basis[k]), `${where}.basis.${k}`);
  assert.ok(s.basis.baseChars === null || Number.isInteger(s.basis.baseChars));
  assert.ok(s.basis.factor >= 0.5 && s.basis.factor <= 2);
  assert.ok(Number.isInteger(s.basis.sessions)); assert.ok(['project', 'all', 'none'].includes(s.basis.scope));
  assert.ok(s.basis.model === null || typeof s.basis.model === 'string'); assert.equal(typeof s.basis.calibrated, 'boolean');
};

test('GET /api/plan/:id and /api/usage follow docs/estimation.md, key by key', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-srv-')));
  const dbFile = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('create table escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text)');
  db.prepare("insert into escadrilles (id, title, project, model, status, weekly, reset_at, created, at) values ('e', 't', '/fx/alpha', 'claude-opus-5-5', 'stopped', ?, ?, ?, ?)").run(QUOTA.weekly, QUOTA.resetsAt, QUOTA.at, QUOTA.at);
  db.close();
  const port = freePort();
  const srv = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: dbFile, ESCADRILLE_PLANS: path.join(HERE, 'fixtures', 'plans'), ESCADRILLE_TRANSCRIPTS: ROOT, ESCADRILLE_SESSIONS: SESSIONS }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((resolve, reject) => { srv.stdout.on('data', (d) => /escadrille on/.test(String(d)) && resolve()); srv.on('exit', (c) => reject(new Error('server exited ' + c))); });

  const body = await (await fetch(`http://localhost:${port}/api/plan/exemple`)).json();
  keys(body, ['plan', 'state', 'log', 'estimate', 'formulas', 'metrics'], 'response');
  const est = body.estimate;
  keys(est, ['sessions', 'total', 'calibration'], 'estimate');
  keys(est.sessions, body.plan.sessions.map((s) => s.id), 'estimate.sessions');
  for (const [id, s] of Object.entries(est.sessions)) checkSession(s, 'sessions.' + id);
  keys(est.total, ['tokens', 'low', 'high', 'cost', 'weeklyPct', 'weeklyNow', 'weeklyAfter', 'resetsAt'], 'total');
  for (const k of ['tokens', 'low', 'high']) assert.ok(Number.isInteger(est.total[k]));
  for (const k of ['cost', 'weeklyPct', 'weeklyNow', 'weeklyAfter']) assert.ok(numOrNull(est.total[k]), 'total.' + k);
  // the base's only reading (2026-11-01 00:00) predates the 13:00 reset: the share is unknown, the point's value still holds
  assert.equal(est.total.weeklyNow, null); assert.equal(est.total.resetsAt, null); assert.equal(est.total.weeklyAfter, null);
  keys(est.calibration, ['calibrated', 'dollarsPerPct', 'weeklyNow', 'observedAt', 'days', 'sessions', 'unseen', 'unseenDirs'], 'calibration');
  assert.equal(est.calibration.unseen, 3); assert.deepEqual(est.calibration.unseenDirs, ['/fx/alpha', '/fx/gamma']);
  assert.equal(est.calibration.calibrated, true); assert.ok(num(est.calibration.dollarsPerPct));
  assert.equal(est.calibration.days, 7); assert.equal(est.calibration.sessions, 2); assert.equal(est.calibration.observedAt, QUOTA.at);
  const A = est.sessions.A;
  assert.equal(A.basis.scope, 'all'); assert.equal(A.basis.baseChars, 200);
  assert.equal(A.basis.factor, Math.round(Math.min(2, Math.max(0.5, A.basis.promptChars / 200)) * 1000) / 1000);
  assert.equal(A.tokens, Math.round(3120 * A.basis.factor));

  const usage = await (await fetch(`http://localhost:${port}/api/usage`)).json();
  keys(usage, ['scanned', 'calibration', 'byProject', 'byModel', 'sessions', 'metrics'], '/api/usage');
  assert.equal(usage.sessions.length, 3);
  assert.equal(usage.calibration.unseen, 3); assert.equal(usage.calibration.unseenSessions.length, 3);
  keys(usage.sessions[0], ['sessionId', 'project', 'model', 'tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'promptChars', 'firstContext', 'cost', 'firstAt', 'lastAt'], 'usage session');
  assert.equal(usage.sessions.find((s) => s.sessionId === 'a1').firstContext, 1110, 'input + cache written + cache read of the first call');
});

// The pilot's defect of 2026-11-02: the plans said 74 % (read at 11:42, before the 13:00 reset) while the Flot said 33 %
test('a quota reading older than the last weekly reset no longer counts: the newest source since the reset, else null', () => {
  const db = tmpDb();
  db.exec('create table escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text)');
  db.exec('create table sessions (plan text, id text, status text, usage text, at text)');
  const ins = db.prepare("insert into escadrilles (id, title, project, model, status, weekly, reset_at, created, at) values (?, 't', '/fx/alpha', 'claude-opus-5-5', 'stopped', ?, ?, ?, ?)");
  ins.run('old', 0.74, '2026-11-01T13:00:00.000Z', '2026-11-01T11:42:00.000Z', '2026-11-01T11:42:00.000Z');
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  assert.equal(lastQuota(db, Date.parse('2026-11-01T12:00:00.000Z')).weekly, 0.74, 'before the reset, the 11:42 reading is the truth');
  assert.equal(lastQuota(db, now), null, 'the 11:42 reading predates the 13:00 reset');
  const sessions = scanTranscripts({ root: ROOT });
  let cal = calibrate({ db, sessions, live: LIVE, now, cacheMs: 0 });
  assert.equal(cal.weeklyNow, null); assert.equal(cal.resetsAt, null);
  assert.equal(cal.calibrated, true, 'the ratio still comes from the stale reading'); assert.equal(cal.observedAt, '2026-11-01T11:42:00.000Z');
  near(cal.dollarsPerPct, (2984 + 5950) / 1e6 / 74);
  assert.equal(estimatePlan({ sessions: [{ id: 'A', model: 'claude-opus-5-5' }] }, { db, sessions, calibration: cal }).total.weeklyNow, null);
  // a session's event after the reset is the newest source: its share, the reset a week after the last known one
  db.prepare("insert into sessions (plan, id, status, usage, at) values ('p', 'A', 'running', ?, ?)").run(JSON.stringify({ input: 1, output: 1, cost: 0, weekly: 0.33 }), '2026-11-01T14:00:00.000Z');
  assert.deepEqual(lastQuota(db, now), { weekly: 0.33, resetsAt: '2026-11-08T13:00:00.000Z', at: '2026-11-01T14:00:00.000Z' });
  cal = calibrate({ db, sessions, live: LIVE, now, cacheMs: 0 });
  assert.equal(cal.weeklyNow, 0.33); assert.equal(cal.resetsAt, '2026-11-08T13:00:00.000Z');
  // a planner reading after the reset wins over an older session event
  ins.run('new', 0.35, '2026-11-08T13:00:00.000Z', '2026-11-01T15:00:00.000Z', '2026-11-01T15:00:00.000Z');
  assert.equal(lastQuota(db, now).weekly, 0.35);
  assert.equal(calibrate({ db, sessions, live: LIVE, now, cacheMs: 0 }).weeklyNow, 0.35);
});

// The defect of 2026-11-07: the weekly gauge stuck at 100 % while the cost kept rising gave 44 $ a point
test('a saturated reading (utilization 1) never calibrates: the newest unsaturated one does, else not calibrated', () => {
  const db = tmpDb();
  db.exec('create table escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text)');
  db.exec('create table sessions (plan text, id text, status text, usage text, at text)');
  const ins = db.prepare("insert into escadrilles (id, title, project, model, status, weekly, reset_at, created, at) values (?, 't', '/fx/alpha', 'claude-opus-5-5', 'stopped', ?, ?, ?, ?)");
  const sessions = scanTranscripts({ root: ROOT });
  const now = Date.parse('2026-11-01T01:00:00.000Z');
  ins.run('full', 1, '2026-11-08T13:00:00.000Z', '2026-11-01T00:30:00.000Z', '2026-11-01T00:30:00.000Z');
  let cal = calibrate({ db, sessions, live: LIVE, now, cacheMs: 0 });
  assert.equal(cal.calibrated, false, 'a gauge at 100 % says nothing about the value of a point');
  assert.equal(cal.dollarsPerPct, null); assert.equal(cal.saturated, true);
  assert.equal(cal.weeklyNow, 1, 'the share shown stays the truth: 100 %');
  ins.run('half', 0.5, '2026-11-08T13:00:00.000Z', '2026-10-31T23:00:00.000Z', '2026-10-31T23:00:00.000Z');
  cal = calibrate({ db, sessions, live: LIVE, now, cacheMs: 0 });
  assert.equal(cal.calibrated, true); assert.equal(cal.observedAt, '2026-10-31T23:00:00.000Z');
  assert.equal(cal.weeklyNow, 1);
  const given = calibrate({ sessions, quota: { weekly: 1, resetsAt: null, at: QUOTA.at }, live: LIVE, cacheMs: 0 });
  assert.equal(given.calibrated, false, 'a saturated quota given by the caller does not calibrate either');
});

test('repoRoot: a worktree counts for its main repository', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { repoRoot } = await import('../lib/usage.mjs');
  const base = mkdtempSync(join(tmpdir(), 'wt-'));
  const main = join(base, 'repo'), wt = join(base, 'repo-feature');
  mkdirSync(join(main, '.git', 'worktrees', 'repo-feature'), { recursive: true }); mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'repo-feature')}\n`);
  assert.equal(repoRoot(wt), main); assert.equal(repoRoot(main), main);
  const sub = join(wt, 'src'); mkdirSync(sub); assert.equal(repoRoot(sub), main);
});
