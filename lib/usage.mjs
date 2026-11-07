// Usage: what past Claude Code sessions cost, read from their transcripts, and what a planned session
// will likely cost. The contract of the numbers the screen shows is docs/estimation.md.
//
//   scanTranscripts({ db, root })        one aggregate per transcript file, cached in SQLite
//   scanLiveSessions({ dir })             what ~/.claude/sessions says about every session, transcript or not
//   unseenSessions(transcripts, live, …)  the sessions with no transcript (interactive ones): counted, not priced
//   calibrate({ db, sessions })           "1 % of the weekly quota = X $", from the last observed quota
//   estimateSession(session, plan, opts)  tokens, range, cost and weekly share of one planned session
//   estimatePlan(plan, opts)              { sessions, total, calibration }, the estimate of the API
//   usageReport({ db })                   the page of truth: recent sessions, summaries, calibration
//
// Transcripts are ~/.claude/projects/<folder>/<session>.jsonl, read without recursion (some folders
// hold node_modules). Claude Code writes one line per content block, so a single API response shows
// up on several lines with the same message.id and the same usage: each id counts once, the last
// line wins. Sidechain lines (subagents) are left out of the turns but their tokens count: a subagent
// spends the same quota.
//
// Interactive sessions (a terminal, Claude Code 2.1.316) write no transcript: ~/.claude/sessions only
// holds <pid>.json (sessionId, cwd, startedAt…) and <pid>.<hash>.key. Those without a transcript are
// counted as `unseen` so the screen can say what the estimate misses.
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import path from 'node:path';
import { weeklyNow } from './horizon.mjs';
import { vars } from './names.mjs';

export const DEFAULT_ROOT = vars.TRANSCRIPTS || path.join(homedir(), '.claude', 'projects');
export const DEFAULT_SESSIONS = vars.SESSIONS || path.join(homedir(), '.claude', 'sessions');

// Public prices, USD per million tokens. Source: the claude-api skill bundled with Claude Code 2.1.316
// (model table "cached: 2026-10-06", shared/models.md, shared/prompt-caching.md), read on 2026-11-01.
// Cache writes are 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL. Cache reads: Fable 5.1
// $0.25, Opus 5.5 $0.20, Sonnet 5.5 $0.20 as stated; Haiku 5.5 is not stated and takes the general
// 0.1x of input. Haiku 5.5's long-prompt rate (beyond 100K tokens, $0.50 / $2.50) is ignored.
export const PRICES_DATE = '2026-10-06';
const price = (input, output, cacheRead) => ({ input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 });
export const PRICES = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
};
const ALIASES = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
export const priceOf = (model) => PRICES[model] || PRICES[ALIASES[model]] || PRICES[String(model || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')] || null;
export const canonicalModel = (model) => (PRICES[model] ? model : ALIASES[model] || model || null);

// Token buckets: [input, cacheWrite5m, cacheWrite1h, cacheRead, output]
const KEYS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];
const add = (a, b) => { for (let i = 0; i < 5; i++) a[i] += b[i] || 0; return a; };
export const costOf = (buckets, model) => {
  const p = priceOf(model); if (!p) return null;
  return KEYS.reduce((s, k, i) => s + (buckets[i] || 0) * p[k], 0) / 1e6;
};
const bucketsOf = (u) => {
  const w = u.cache_creation_input_tokens || 0;
  const c = u.cache_creation || {};
  // The TTL split is there on recent versions; without it, writes count as 5-minute ones
  const w1h = typeof c.ephemeral_1h_input_tokens === 'number' ? Math.min(w, c.ephemeral_1h_input_tokens) : 0;
  return [u.input_tokens || 0, w - w1h, w1h, u.cache_read_input_tokens || 0, u.output_tokens || 0];
};

// One transcript file -> its aggregate. `hours` keeps the buckets per model and per UTC hour, so the
// calibration can sum exactly the 7 days before an instant, whatever the session's span.
// `first` is the usage of the first call to the model (the first assistant message out of a sidechain):
// everything the call read, input + cache written + cache read, is the context the session starts with,
// before any work: the system prompt, the tools, CLAUDE.md, MEMORY.md, the skills list, the prompt
// (docs/frugal.md « Le contexte fixe »). The first message.id is kept, whichever line of it wins.
// The parser takes the transcript line by line (`line(l)`), so a file is never held whole in memory: a pilot's
// conversation runs to hundreds of MB, and text.split('\n') on it exhausted the server's heap (2026-11-02).
export const transcriptParser = (file = '') => {
  const msgs = new Map(); // message.id -> { model, buckets, sidechain, at }
  let sessionId = null, project = null, firstAt = null, lastAt = null, promptChars = null, firstId = null;
  const line = (l) => {
    if (!l || l[0] !== '{') return;
    let o; try { o = JSON.parse(l); } catch { return; }
    if (!sessionId && o.sessionId) sessionId = o.sessionId;
    if (!project && typeof o.cwd === 'string') project = o.cwd;
    if (o.timestamp) { if (!firstAt || o.timestamp < firstAt) firstAt = o.timestamp; if (!lastAt || o.timestamp > lastAt) lastAt = o.timestamp; }
    const m = o.message;
    if (promptChars == null && o.type === 'user' && !o.isSidechain && !o.isMeta && m) { const n = textLength(m.content); if (n > 0) promptChars = n; }
    if (o.type !== 'assistant' || !m || !m.usage || !m.id || m.model === '<synthetic>') return;
    msgs.delete(m.id); // the last occurrence wins, and keeps its place at the end
    msgs.set(m.id, { model: m.model, buckets: bucketsOf(m.usage), sidechain: o.isSidechain === true, at: o.timestamp || lastAt });
    if (!firstId && o.isSidechain !== true) firstId = m.id;
  };
  const result = () => finish({ msgs, sessionId, project, firstAt, lastAt, promptChars, firstId, file });
  return { line, result };
};
export const parseTranscript = (text, file = '') => {
  const p = transcriptParser(file);
  for (const l of text.split('\n')) p.line(l);
  return p.result();
};
// A file fed to the parser by chunks of 1 MB: bounded memory whatever the transcript's size
const CHUNK = 1 << 20;
export const parseTranscriptFile = (fp) => {
  const p = transcriptParser(fp);
  const fd = openSync(fp, 'r'); const buf = Buffer.allocUnsafe(CHUNK); const dec = new StringDecoder('utf8');
  let rest = '';
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null); if (n === 0) break;
      const parts = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      for (const l of parts) p.line(l);
    }
    rest += dec.end();
    if (rest) p.line(rest);
  } finally { closeSync(fd); }
  return p.result();
};
const finish = ({ msgs, sessionId, project, firstAt, lastAt, promptChars, firstId, file }) => {
  const f = firstId ? msgs.get(firstId) : null;
  const first = f ? { input: f.buckets[0], cacheWrite: f.buckets[1] + f.buckets[2], cacheRead: f.buckets[3], context: f.buckets[0] + f.buckets[1] + f.buckets[2] + f.buckets[3], model: f.model, at: f.at } : null;
  const total = [0, 0, 0, 0, 0]; const byModel = {}; const hours = {}; const modelCount = {};
  let turns = 0;
  for (const x of msgs.values()) {
    add(total, x.buckets);
    add(byModel[x.model] ||= [0, 0, 0, 0, 0], x.buckets);
    const h = String(x.at || '').slice(0, 13); // 2026-10-31T23
    add((hours[h] ||= {})[x.model] ||= [0, 0, 0, 0, 0], x.buckets);
    if (!x.sidechain) { turns++; modelCount[x.model] = (modelCount[x.model] || 0) + 1; }
  }
  const model = Object.entries(modelCount).sort((a, b) => b[1] - a[1])[0]?.[0] || Object.keys(byModel)[0] || null;
  const input = total[0] + total[1] + total[2] + total[3];
  return { v: AGG_VERSION, file, sessionId: sessionId || path.basename(file, '.jsonl'), project, model, input, output: total[4], tokens: input + total[4], turns, firstAt, lastAt, promptChars, first, buckets: total, byModel, hours };
};
// The text of a user message, tool results left out: a string, or the text blocks of an array
const textLength = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b && b.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0) : 0);
// Bumped when the aggregate gains a field, so the SQLite cache re-reads older rows (3: `first`)
const AGG_VERSION = 3;

// Every transcript, from the cache when the file has not changed (same mtime and size)
export const ensureTable = (db) => db.exec('create table if not exists transcripts (path text primary key, mtime real, size integer, json text)');
export const scanTranscripts = ({ db, root = DEFAULT_ROOT } = {}) => {
  if (db) ensureTable(db);
  const get = db?.prepare('select mtime, size, json from transcripts where path = ?');
  const put = db?.prepare('insert into transcripts (path, mtime, size, json) values (?, ?, ?, ?) on conflict(path) do update set mtime = excluded.mtime, size = excluded.size, json = excluded.json');
  const out = []; const seen = new Set();
  let dirs = []; try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch { return out; }
  for (const dir of dirs) {
    let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f); let st; try { st = statSync(fp); } catch { continue; }
      if (!st.isFile()) continue;
      seen.add(fp);
      const row = get?.get(fp);
      if (row && row.mtime === st.mtimeMs && row.size === st.size) { const c = JSON.parse(row.json); if (c.v === AGG_VERSION) { out.push(c); continue; } }
      let agg; try { agg = parseTranscriptFile(fp); } catch { continue; }
      put?.run(fp, st.mtimeMs, st.size, JSON.stringify(agg));
      out.push(agg);
    }
  }
  if (db) for (const r of db.prepare('select path from transcripts').all()) if (r.path.startsWith(root + path.sep) && !seen.has(r.path)) db.prepare('delete from transcripts where path = ?').run(r.path);
  return out.filter((s) => s.tokens > 0).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
};

// The public-price cost of a session, every model it used
export const sessionCost = (s) => Object.entries(s.byModel || {}).reduce((sum, [m, b]) => sum + (costOf(b, m) ?? 0), 0);

// ---------------------------------------------------------------- sessions without a transcript
// ~/.claude/sessions: <pid>.json (pid, sessionId, cwd, startedAt in ms, entrypoint…) and <pid>.<hash>.key.
// A .json names its session; a .key alone only dates it (its mtime). Nothing here holds usage.
export const scanLiveSessions = ({ dir = DEFAULT_SESSIONS } = {}) => {
  let names = []; try { names = readdirSync(dir); } catch { return []; }
  const byPid = new Map();
  for (const f of names) {
    const fp = path.join(dir, f);
    if (/^\d+\.json$/.test(f)) {
      let o; try { o = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }
      const pid = f.split('.')[0];
      const at = typeof o.startedAt === 'number' ? o.startedAt : Date.parse(o.startedAt);
      byPid.set(pid, { pid: Number(pid), sessionId: o.sessionId || null, cwd: typeof o.cwd === 'string' ? o.cwd : null, startedAt: Number.isFinite(at) ? at : null, entrypoint: o.entrypoint || null });
    }
  }
  for (const f of names) {
    const m = f.match(/^(\d+)\..+\.key$/); if (!m || byPid.has(m[1])) continue;
    let st; try { st = statSync(path.join(dir, f)); } catch { continue; }
    byPid.set(m[1], { pid: Number(m[1]), sessionId: null, cwd: null, startedAt: st.mtimeMs, entrypoint: null });
  }
  return [...byPid.values()].filter((s) => s.startedAt != null);
};
// The live sessions started in [from, to) with no transcript: by sessionId when the .json gives one,
// else (a .key alone) no transcript starting within two minutes of the .key.
export const KEY_MATCH_MS = 2 * 60e3;
export const unseenSessions = (transcripts, live, from, to) => {
  const ids = new Set(transcripts.map((t) => t.sessionId));
  const starts = transcripts.map((t) => Date.parse(t.firstAt)).filter(Number.isFinite);
  return live
    .filter((s) => s.startedAt >= from && s.startedAt < to)
    .filter((s) => (s.sessionId ? !ids.has(s.sessionId) : !starts.some((t) => Math.abs(t - s.startedAt) <= KEY_MATCH_MS)))
    .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, startedAt: new Date(s.startedAt).toISOString(), entrypoint: s.entrypoint }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};
// The folders of the unseen sessions, the most frequent first
const foldersOf = (unseen) => {
  const n = new Map(); for (const u of unseen) if (u.cwd) n.set(u.cwd, (n.get(u.cwd) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
};

// ---------------------------------------------------------------- calibration
// The newest weekly utilization the server saw, planners (escadrilles.weekly, from rate_limit_event) and sessions
// (sessions.usage.weekly) alike: lib/horizon.mjs weeklyNow. A reading taken before the last weekly reset says last
// week's share and is dropped (pilot, 2026-11-02: the estimate said 74 %, read at 11:42 before the 13:00 reset,
// while the Flot said 33 %): the newest reading since the reset, else null.
export const lastQuota = (db, now = Date.now()) => { try { return weeklyNow(db, now); } catch { return null; } };
// The newest planner reading whatever its age: the value of a point (dollars per % of the quota) does not change at
// the reset, so the ratio keeps calibrating the estimates between a reset and the next reading.
export const lastObservation = (db) => {
  try { const r = db.prepare('select weekly, reset_at, at from escadrilles where weekly is not null order by at desc limit 1').get(); return r ? { weekly: r.weekly, resetsAt: r.reset_at || null, at: r.at } : null; } catch { return null; }
};
const DAY = 864e5;
// The public-price cost of every transcript in [from, to), by UTC hour
export const costBetween = (sessions, from, to) => {
  const a = new Date(from).toISOString().slice(0, 13), b = new Date(to).toISOString().slice(0, 13);
  let cost = 0; let n = 0;
  for (const s of sessions) {
    let used = false;
    for (const [h, models] of Object.entries(s.hours || {})) {
      if (h < a || h > b) continue;
      for (const [m, bk] of Object.entries(models)) { const c = costOf(bk, m); if (c != null) { cost += c; used = true; } }
    }
    if (used) n++;
  }
  return { cost, sessions: n };
};
let calCache = null;
// `unseen`: the sessions of the same 7 days (before the observation, or before now without one) that
// left no transcript. Their cost is missing from cost7d, so dollarsPerPct is too low and weeklyPct too high.
// `quota`: the newest reading since the last weekly reset (weeklyNow, resetsAt), null when every reading predates it.
// `observation`: the reading the ratio is computed from (the 7 days of cost before it), the quota when given, else
// the newest planner reading whatever its age: a reset changes the share, not what a point is worth.
export const calibrate = ({ db, sessions, quota: given, observation: obsGiven, live, sessionsDir = DEFAULT_SESSIONS, now = Date.now(), cacheMs = 60e3 } = {}) => {
  const quota = given !== undefined ? given : db ? lastQuota(db, now) : null;
  const observation = obsGiven !== undefined ? obsGiven : given !== undefined ? given : quota || (db ? lastObservation(db) : null);
  const key = JSON.stringify([quota, observation]) + (sessions ? sessions.length : 'x') + (live ? 'L' + live.length : sessionsDir);
  if (cacheMs && calCache && calCache.key === key && now - calCache.t < cacheMs) return calCache.value;
  const observed = observation && typeof observation.weekly === 'number' && observation.weekly > 0;
  const end = observed ? new Date(observation.at).getTime() : now;
  const unseen = unseenSessions(sessions || [], live || scanLiveSessions({ dir: sessionsDir }), end - 7 * DAY, end + (observed ? 0 : 1));
  const seen = { unseen: unseen.length, unseenDirs: foldersOf(unseen), unseenSessions: unseen };
  const fresh = quota && typeof quota.weekly === 'number' ? quota.weekly : null;
  let value;
  if (!observed) {
    value = { calibrated: false, dollarsPerPct: null, weeklyNow: fresh, observedAt: observation?.at || null, resetsAt: quota?.resetsAt || null, days: 7, sessions: 0, cost7d: null, ...seen };
  } else {
    const { cost, sessions: n } = costBetween(sessions || [], end - 7 * DAY, end);
    const ok = cost > 0;
    value = { calibrated: ok, dollarsPerPct: ok ? cost / (observation.weekly * 100) : null, weeklyNow: fresh, observedAt: observation.at, resetsAt: quota?.resetsAt || null, days: 7, sessions: n, cost7d: cost, ...seen };
  }
  if (cacheMs) calCache = { key, t: now, value };
  return value;
};

// ---------------------------------------------------------------- estimation
const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y); const i = (a.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
};
export const median = (xs) => quantile(xs, 0.5);
export { quantile };

// The repository a folder belongs to: the nearest parent with .git; a worktree (.git is a file)
// resolves to its main repository, so /Dev/escadrille-usage and /Dev/escadrille are one project.
const rootCache = new Map();
export const repoRoot = (p) => {
  if (!p) return null;
  if (rootCache.has(p)) return rootCache.get(p);
  let dir = p, found = null;
  for (let i = 0; i < 40 && dir; i++) {
    const g = path.join(dir, '.git');
    try {
      const st = statSync(g);
      if (st.isDirectory()) { found = dir; break; }
      const m = readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) { const gd = path.resolve(dir, m[1].trim()); const i2 = gd.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`); found = i2 > 0 ? gd.slice(0, i2) : dir; break; }
    } catch {}
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  const r = found || p; rootCache.set(p, r); return r;
};
const sameProject = (a, b) => a === b || repoRoot(a) === repoRoot(b);

export const MIN_PROJECT_SESSIONS = 3;
// The prompt factor: the planned prompt's length over the median length of the first user messages of
// the base, held in [0.5, 2]; 1 when either is unknown. A longer brief tends to mean a longer session,
// but the relation is loose (the files a session reads weigh more than its prompt): hence the bounds.
export const FACTOR_MIN = 0.5, FACTOR_MAX = 2;
export const promptFactor = (promptChars, pool) => {
  const known = pool.map((s) => s.promptChars).filter((n) => typeof n === 'number' && n > 0);
  const baseChars = known.length ? Math.round(median(known)) : null;
  const factor = promptChars > 0 && baseChars ? round(Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, promptChars / baseChars)), 3) : 1;
  return { promptChars, baseChars, factor };
};
// One planned session: the median of the total tokens of past sessions of the same project (same
// folder or same repository), or of every project when there are fewer than three; p25..p75 as the
// range; everything times the prompt factor. The cost is the median of the past sessions' costs
// re-priced at the planned session's model (it keeps their mix of cache reads, cache writes and
// output, which plain tokens x price would lose). `unseen`: the sessions of the same scope that left
// no transcript (calibration.unseenSessions), so the base is missing them.
export const estimateSession = (session, plan = {}, { sessions = [], calibration = null } = {}) => {
  const model = canonicalModel(session.model || plan.model || null);
  const where = session.path || plan.path || null;
  const mine = where ? sessions.filter((s) => s.project && sameProject(s.project, where)) : [];
  const scope = mine.length >= MIN_PROJECT_SESSIONS ? 'project' : sessions.length ? 'all' : 'none';
  const pool = scope === 'project' ? mine : scope === 'all' ? sessions : [];
  const { promptChars, baseChars, factor } = promptFactor(typeof session.prompt === 'string' ? session.prompt.length : 0, pool);
  const tokens = pool.map((s) => s.tokens);
  const p = priceOf(model);
  const cost = p && pool.length ? median(pool.map((s) => costOf(s.buckets, model))) * factor : null;
  const calibrated = !!(calibration && calibration.calibrated && calibration.dollarsPerPct);
  const unseenAll = calibration?.unseenSessions || [];
  const unseen = scope === 'project' ? unseenAll.filter((u) => u.cwd && sameProject(u.cwd, where)).length : unseenAll.length;
  const x = (v) => Math.round(v * factor);
  return {
    tokens: x(median(tokens)), low: x(quantile(tokens, 0.25)), high: x(quantile(tokens, 0.75)),
    input: x(median(pool.map((s) => s.input))), output: x(median(pool.map((s) => s.output))),
    cost: cost == null ? null : round(cost, 4),
    weeklyPct: calibrated && cost != null ? round(cost / calibration.dollarsPerPct / 100, 6) : null,
    basis: { sessions: pool.length, scope, model, calibrated, unseen, promptChars, baseChars, factor },
  };
};
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// The estimate of a whole plan, as the API returns it (docs/estimation.md)
// adjust(session, plan): the learned gap of that kind of task on that model (lib/learning.mjs adjusterOf),
// { kind, ratio, sessions } or null; the cost and the weekly share are multiplied by its ratio, basis.learned says it
// and basis.rawCost keeps the cost before it (docs/learning.md « L'écart d'estimation »).
export const applyGap = (e, gap, calibration = null) => {
  if (!gap || !(gap.ratio > 0) || e.cost == null) return { ...e, basis: { ...e.basis, learned: null, rawCost: e.cost } };
  const cost = round(e.cost * gap.ratio, 4);
  const calibrated = !!(calibration && calibration.calibrated && calibration.dollarsPerPct);
  return { ...e, cost, weeklyPct: calibrated ? round(cost / calibration.dollarsPerPct / 100, 6) : e.weeklyPct, basis: { ...e.basis, learned: { kind: gap.kind, ratio: gap.ratio, sessions: gap.sessions }, rawCost: e.cost } };
};
export const estimatePlan = (plan, { db, sessions = db ? scanTranscripts({ db }) : [], calibration, adjust = null } = {}) => {
  const cal = calibration || calibrate({ db, sessions });
  const out = {};
  for (const s of plan.sessions || []) { const e = estimateSession(s, plan, { sessions, calibration: cal }); out[s.id] = adjust ? applyGap(e, adjust(s, plan), cal) : e; }
  const list = Object.values(out);
  const sum = (k) => list.reduce((a, x) => a + (x[k] || 0), 0);
  const costs = list.map((x) => x.cost);
  const cost = costs.length && costs.every((c) => c != null) ? round(sum('cost'), 4) : null;
  const weeklyPct = cal.calibrated && list.length && list.every((x) => x.weeklyPct != null) ? round(sum('weeklyPct'), 6) : null;
  return {
    sessions: out,
    total: { tokens: sum('tokens'), low: sum('low'), high: sum('high'), cost, weeklyPct, weeklyNow: cal.weeklyNow, weeklyAfter: weeklyPct != null && cal.weeklyNow != null ? round(cal.weeklyNow + weeklyPct, 6) : null, resetsAt: cal.resetsAt || null },
    calibration: { calibrated: cal.calibrated, dollarsPerPct: cal.dollarsPerPct == null ? null : round(cal.dollarsPerPct, 4), weeklyNow: cal.weeklyNow, observedAt: cal.observedAt, days: 7, sessions: cal.sessions, unseen: cal.unseen ?? 0, unseenDirs: cal.unseenDirs || [] },
  };
};

// ---------------------------------------------------------------- the page of truth
const summarize = (sessions, keyOf) => {
  const groups = new Map();
  for (const s of sessions) { const k = keyOf(s) || '?'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  return [...groups].map(([key, xs]) => ({ key, sessions: xs.length, median: Math.round(median(xs.map((s) => s.tokens))), p25: Math.round(quantile(xs.map((s) => s.tokens), 0.25)), p75: Math.round(quantile(xs.map((s) => s.tokens), 0.75)), tokens: xs.reduce((a, s) => a + s.tokens, 0), cost: round(xs.reduce((a, s) => a + sessionCost(s), 0), 2) })).sort((a, b) => b.tokens - a.tokens);
};
export const publicSession = (s) => ({ sessionId: s.sessionId, project: s.project, model: s.model, tokens: s.tokens, input: s.input, output: s.output, cacheRead: s.buckets[3], cacheWrite: s.buckets[1] + s.buckets[2], turns: s.turns, promptChars: s.promptChars ?? null, firstContext: s.first?.context ?? null, cost: round(sessionCost(s), 4), firstAt: s.firstAt, lastAt: s.lastAt });
export const usageReport = ({ db, root, sessionsDir = DEFAULT_SESSIONS, limit = 50 } = {}) => {
  const t0 = Date.now();
  const sessions = scanTranscripts({ db, root });
  const scanMs = Date.now() - t0;
  const calibration = calibrate({ db, sessions, sessionsDir });
  return {
    scanned: { sessions: sessions.length, ms: scanMs, root: root || DEFAULT_ROOT, sessionsDir, prices: PRICES_DATE },
    calibration,
    byProject: summarize(sessions, (s) => repoRoot(s.project)),
    byModel: summarize(sessions, (s) => s.model),
    sessions: sessions.slice(0, limit).map(publicSession),
  };
};
