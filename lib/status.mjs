// The status beside the Conversation (docs/phase9/direction.md §4): can the developer launch work right now?
// Pure functions over data the server already has, plus one measurer for the limits the sessions do not tell.
// Read-only: nothing here writes the base, nothing is invented (a limit the base does not hold is null, never a figure).
//
//   windowsOf(ev)                               the windows of a rate_limit_event, those present only: { weekly, fiveHour, models }
//   measureLimits({ claude, cwd, timeoutMs })   one minimal Haiku call in -p, its rate_limit_event → { at, weekly, fiveHour, models } or null
//   createMeasurer({ measure, everyMs, now })   { read(), pending() }: measures at most every everyMs, only when read() is called
//                                               (a client looking), never waits: read() gives what is known and refreshes behind
//   limitsOf({ quota, measured, now })          the « Claude » block: the newest reading wins, stale after STALE_MS
//   costWindows({ sessions, project, now })     the « Coût » block: today (local midnight) and the last 7 days, from the transcripts
//   lastRun(plans)                              the last launched plan of the project and the cost of its sessions
//   withRun(cost, run, { now })                 today and the week never under the run that falls in them (the max, no double count)
//   nowOf(nodes, plans)                         the « Maintenant » block: running, waiting for the developer, queued; 5 rows at most (running, waiting, errors, then queued with `after`)
//   guardOf({ autonomy, plan, burst })          the « Garde » line: the mode, the domains, the burst, the auto merge
//   measureAll(opts)                            Haiku, then Fable when Haiku's event lacks Fable's window; the windows merged
//   statusOf({ ... })                           the whole object of GET /api/status?project=, with limits: { rows, verdict }
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { vars, projectDir } from './names.mjs';
import { costOf, repoRoot } from './usage.mjs';
import { rowsOf, verdictOf, effectiveThresholds } from './limits.mjs';

export const MEASURE_EVERY_MS = 10 * 60e3; // one measure at most every ten minutes
export const STALE_MS = 30 * 60e3; // a reading older than this is said stale on the screen
export const MEASURE_MODEL = 'claude-haiku-5-5';
export const FABLE_MODEL = 'claude-fable-5-1'; // its own weekly window, asked of a Fable call when the Haiku one does not carry it
export const MEASURE_TIMEOUT_MS = 45e3;
const DAY = 864e5;
const round2 = (x) => Math.round(x * 100) / 100;
const pctOf = (u) => Math.round(u * 1000) / 10; // 0.742 → 74.2

// ---------------------------------------------------------------- the windows of a rate_limit_event
// Claude Code 2.1: rate_limit_info.unifiedWindows.<seven_day | five_hour | seven_day_<model> …> = { utilization, resetsAt (unix s) }.
// Only what exists is read: a window absent from the event is null, a model window is kept under its name.
const iso = (s) => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : typeof s === 'string' && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
const window_ = (w) => (w && typeof w.utilization === 'number' ? { utilization: w.utilization, pct: pctOf(w.utilization), resetsAt: iso(w.resetsAt) } : null);
export const windowsOf = (ev) => {
  const info = (ev && ev.rate_limit_info) || {};
  const uw = { ...(info.unifiedWindows || {}) };
  // The older shape (one window per event): { rateLimitType: 'five_hour' | 'seven_day' | 'seven_day_<model>', utilization, resetsAt }
  if (typeof info.rateLimitType === 'string' && typeof info.utilization === 'number' && !uw[info.rateLimitType]) uw[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
  const out = { weekly: null, fiveHour: null, models: {} };
  for (const [key, w] of Object.entries(uw)) {
    const m = /^(seven_day|five_hour)(?:_([a-z0-9]+))?$/i.exec(key); if (!m) continue;
    const v = window_(w); if (!v) continue;
    const slot = m[1].toLowerCase() === 'seven_day' ? 'weekly' : 'fiveHour';
    if (!m[2]) out[slot] = v; else (out.models[m[2].toLowerCase()] ||= { weekly: null, fiveHour: null })[slot] = v;
  }
  const ov = overageOf(info); if (ov) out.overage = ov;
  return out;
};
// The usage credits as the event says them (docs/usage-unit.md): `errorCode`, `canUserPurchaseCredits` are published
// (Agent SDK, SDKRateLimitEvent); `overageStatus`, `isUsingOverage`, `overageDisabledReason` are observed in the stream
// (« rejected », « out_of_credits » on 4 November), not published. Absent fields stay absent.
export const overageOf = (info = {}) => {
  const o = {};
  if (typeof info.overageStatus === 'string') o.status = info.overageStatus;
  if (typeof info.isUsingOverage === 'boolean') o.using = info.isUsingOverage;
  if (typeof info.overageDisabledReason === 'string') o.disabledReason = info.overageDisabledReason;
  if (info.errorCode === 'credits_required') o.creditsRequired = true;
  if (typeof info.canUserPurchaseCredits === 'boolean') o.canPurchase = info.canUserPurchaseCredits;
  return Object.keys(o).length ? o : null;
};
export const hasWindows = (w) => !!(w && (w.weekly || w.fiveHour || Object.keys(w.models || {}).length));

// ---------------------------------------------------------------- the measure without a token: claude -p /usage
// Since Claude Code 2.1, `claude -p /usage` prints the limits of the subscription without calling a model (2026-11-02):
//   Current week (all models): 18% used · resets Nov 8 at 2pm (Europe/Paris)
//   Current week (Fable): 29% used · resets Nov 8 at 2pm (Europe/Paris)
// The only real output kept (test/fixtures/usage-2026-11-02.txt, the pilot's reading) has no five-hour line. Its
// plausible forms are read (docs/limits.md): « Current session », « Current 5-hour window », parentheses or not, a
// reset as a date, an hour alone (the next such instant, today or tomorrow) or relative (« in 2h 10m »). It is the
// only source of the Fable window found so far (rate_limit_event carries seven_day alone). Read first; the Haiku call
// stays the fallback. A line that does not parse is skipped, never guessed; a reset that does not parse is null.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const hour12 = (h, ampm) => { const n = Number(h); if (!ampm) return n; if (n < 1 || n > 12) return NaN; return n % 12 + (ampm.toLowerCase() === 'pm' ? 12 : 0); };
export const parseResetText = (s, now = Date.now()) => {
  const txt = String(s || '').trim();
  // « Nov 8 at 2pm », « Nov 8, 2026 at 14:00 »: the weekly form
  let m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(txt);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo < 0) return null;
    let h = Number(m[4]) % 12; if ((m[6] || '').toLowerCase() === 'pm') h += 12; if (!m[6] && Number(m[4]) === 12) h = 12;
    const year = m[3] ? Number(m[3]) : new Date(now).getFullYear();
    let d = new Date(year, mo, Number(m[2]), h, Number(m[5] || 0)); // the machine's time zone: the one /usage prints for this user
    if (!m[3] && d.getTime() < now - 86400e3) d = new Date(year + 1, mo, Number(m[2]), h, Number(m[5] || 0));
    return d.toISOString();
  }
  // « in 2h 10m », « in 45 min », « in 3 hours »: from now
  m = /^in\s+(?:(\d+)\s*(?:h|hrs?|hours?)\b)?\s*(?:(\d+)\s*(?:m|mins?|minutes?)\b)?/i.exec(txt);
  if (m && (m[1] || m[2])) return new Date(now + (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60e3).toISOString();
  // « 7pm », « at 7:30pm », « 19:00 », « tomorrow at 1am »: the next such instant, today or tomorrow
  m = /^(?:(today|tomorrow)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=$|[\s(])/i.exec(txt);
  if (m && (m[3] || m[4])) {
    const h = hour12(m[2], m[4]); const min = Number(m[3] || 0); if (!(h >= 0 && h <= 23) || min > 59) return null;
    const d = new Date(now); d.setHours(h, min, 0, 0);
    if ((m[1] || '').toLowerCase() === 'tomorrow' || d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return null;
};
// slot: the week, or the five-hour window under any of its plausible names; the parentheses: « all models » or a model
const USAGE_LINE = /^\s*(?:current\s+)?(week|session|(?:5|five)[- ]?h(?:ours?)?(?:\s+(?:window|session|limit))?)\s*(?:\(([^)]*)\))?\s*:\s*(\d+(?:[.,]\d+)?)\s*%\s*used\b(?:\s*[·•|,–-]\s*resets?\s+(.+?))?\s*$/gim;
const modelKey = (who) => { const w = who.trim().toLowerCase(); if (!w || /^(all|5|five|\d|session|window|current)/.test(w)) return null; return w.split(/\s+/)[0]; };
export const parseUsageText = (text, now = Date.now()) => {
  const out = { weekly: null, fiveHour: null, models: {} };
  for (const m of String(text || '').matchAll(USAGE_LINE)) {
    const pct = Number(m[3].replace(',', '.')); if (!(pct >= 0 && pct <= 100)) continue;
    const v = { utilization: pct / 100, pct, resetsAt: m[4] ? parseResetText(m[4], now) : null };
    const slot = m[1].toLowerCase() === 'week' ? 'weekly' : 'fiveHour'; const who = modelKey(m[2] || '');
    if (!who) { if (!out[slot]) out[slot] = v; } else (out.models[who] ||= { weekly: null, fiveHour: null })[slot] ||= v;
  }
  const cr = parseCreditsText(text); if (cr) out.credits = cr;
  return out;
};
// The usage-credits row of /usage (docs/usage-unit.md): its exact text is not published; the forms read are an amount
// spent « of » / « / » a limit, or « Unlimited ». The currency is the symbol printed (€, $, £). A row that does not parse
// is skipped, never guessed. Amounts become minor units, like SDKUsageReport.extra_usage.
const CUR = { '€': 'EUR', '$': 'USD', '£': 'GBP' };
const amount = (s) => { const n = Number(String(s).replace(/\s/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
export const parseCreditsText = (text) => {
  const line = String(text || '').split('\n').find((l) => /(usage credits|extra usage)/i.test(l) && /([€$£]|unlimited)/i.test(l)); if (!line) return null;
  const sym = (line.match(/[€$£]/) || [])[0]; const currency = sym ? CUR[sym] : null;
  const nums = [...line.matchAll(/[€$£]\s?([\d\s.,]*\d)|([\d\s.,]*\d)\s?[€$£]/g)].map((m) => amount(m[1] || m[2])).filter((x) => x != null);
  const unlimited = /unlimited/i.test(line);
  if (!nums.length && !unlimited) return null;
  return { enabled: !/\b(off|disabled)\b/i.test(line), usedMinor: nums[0] ?? null, limitMinor: unlimited ? null : nums[1] ?? null, currency, unlimited };
};
// The raw answer of the last /usage that gave no five-hour window, kept for the next session to see the real form:
// .escadrille/usage-raw.txt of the repository (gitignored, never committed), redacted, 4 kB at most.
export const USAGE_RAW_FILE = projectDir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), 'usage-raw.txt');
export const redactUsage = (text, { home = homedir(), user = process.env.USER || '' } = {}) => {
  let s = String(text || '');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '•••@•••');
  if (home && home.length > 1) s = s.split(home).join('~');
  s = s.replace(/\/(Users|home)\/[^/\s"']+/g, '/$1/•••');
  if (user && user.length > 2) s = s.split(user).join('•••');
  s = s.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g, '•••');
  return s.slice(0, 4000);
};
export const keepRawUsage = (text, { file = vars.USAGE_RAW || USAGE_RAW_FILE, now = Date.now() } = {}) => {
  if (!String(text || '').trim()) return false;
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `# claude -p /usage, ${new Date(now).toISOString()}, no five-hour window read\n${redactUsage(text)}\n`); return true; } catch { return false; }
};
export const measureUsage = ({ claude = vars.CLAUDE || 'claude', cwd = tmpdir(), env = process.env, timeoutMs = MEASURE_TIMEOUT_MS, now = Date.now, rawFile } = {}) => new Promise((resolve) => {
  let child; let done = false; let buf = '';
  const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill('SIGTERM'); } catch {} resolve(v); };
  const timer = setTimeout(() => finish(null), timeoutMs);
  try { child = spawn(claude, ['-p', '/usage', '--output-format', 'json'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return finish(null); }
  child.on('error', () => finish(null));
  child.stdout.on('data', (c) => { buf += c; });
  child.on('exit', () => {
    let text = buf; try { text = JSON.parse(buf).result ?? buf; } catch {}
    const w = parseUsageText(text, now());
    // /usage answered (« … used »), no five-hour window in it: its raw text is kept
    if (!w.fiveHour && /\bused\b/i.test(text)) keepRawUsage(text,{ ...(rawFile ? { file: rawFile } : {}), now: now() });
    finish(hasWindows(w) ? { at: new Date(now()).toISOString(), source: 'usage', ...w } : null);
  });
});

// ---------------------------------------------------------------- the measure: one minimal Haiku call
// `claude -p ok` with no tool, one turn, a cent of cap: Claude Code prints its rate_limit_event before the answer.
// Resolves at the first event (the process is then stopped), null on a failure or a timeout; never throws.
export const measureArgs = (model = MEASURE_MODEL) => ['-p', 'ok', '--model', model, '--output-format', 'stream-json', '--verbose', '--tools', '', '--permission-mode', 'dontAsk', '--max-turns', '1', '--max-budget-usd', '0.05'];
export const measureLimits = async (o = {}) => (await measureUsage(o)) || measureModel(o);
export const measureModel = ({ claude = vars.CLAUDE || 'claude', cwd = tmpdir(), env = process.env, timeoutMs = MEASURE_TIMEOUT_MS, model = MEASURE_MODEL, now = Date.now } = {}) => new Promise((resolve) => {
  let child; let done = false; let buf = '';
  const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill('SIGTERM'); } catch {} resolve(v); };
  const timer = setTimeout(() => finish(null), timeoutMs);
  try { child = spawn(claude, measureArgs(model), { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return finish(null); }
  child.on('error', () => finish(null));
  child.on('exit', () => finish(null));
  child.stdout.on('data', (chunk) => {
    buf += chunk; const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== 'rate_limit_event') continue;
      const w = windowsOf(ev); if (hasWindows(w)) return finish({ at: new Date(now()).toISOString(), ...w });
    }
  });
});

// Haiku first; a second minimal call to Fable only when the first did not carry Fable's window (docs/limits.md)
export const mergeWindows = (a, b) => (!a ? b : !b ? a : { ...a, weekly: a.weekly || b.weekly, fiveHour: a.fiveHour || b.fiveHour, models: { ...(b.models || {}), ...(a.models || {}) }, overage: a.overage || b.overage || null, credits: a.credits || b.credits || null });
export const measureAll = async (opts = {}, one = measureLimits) => {
  const a = await one(opts);
  if (a && a.models && a.models.fable && a.models.fable.weekly) return a;
  const b = await one({ ...opts, model: FABLE_MODEL });
  return mergeWindows(a, b);
};

// ---------------------------------------------------------------- the measurer: cached, capped, only when someone looks
export const createMeasurer = ({ measure = measureLimits, everyMs = MEASURE_EVERY_MS, now = Date.now, enabled = true, onChange = () => {} } = {}) => {
  let last = null; let lastTry = null; let inflight = null; let tries = 0;
  const read = () => {
    const t = now();
    if (enabled && !inflight && (lastTry === null || t - lastTry >= everyMs)) {
      lastTry = t; tries++;
      inflight = Promise.resolve().then(() => measure()).then((m) => { if (m && hasWindows(m)) last = { ...m, at: m.at || new Date(t).toISOString() }; }).catch(() => {}).then(() => { inflight = null; onChange(last); });
    }
    return { last, measuring: !!inflight, tries, nextAt: lastTry === null ? null : new Date(lastTry + everyMs).toISOString() };
  };
  return { read, pending: () => inflight || Promise.resolve(), last: () => last };
};

// ---------------------------------------------------------------- the « Claude » block
// quota: the newest reading of the sessions ({ weekly, resetsAt, at }, lib/horizon.mjs weeklyNow), the weekly share only;
// measured: the measurer's last reading, every window it found. Per window the newest reading wins; a model window
// or the 5-hour window exist only when measured: absent, the screen says « non mesuré », never a figure.
// A weekly window restarts every seven days at the same hour: a reset date already past (a reading of last week) moves
// forward by whole weeks, so the screen never says a reset is imminent when it is days away (2026-11-01, Dev).
const WEEK_MS = 7 * 24 * 3600 * 1000;
export const nextWeeklyReset = (iso, now = Date.now()) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return null; if (t > now) return new Date(t).toISOString(); return new Date(t + Math.ceil((now - t + 1) / WEEK_MS) * WEEK_MS).toISOString(); };
export const limitsOf = ({ quota = null, measured = null, measuring = false, nextAt = null, now = Date.now() } = {}) => {
  const fromSession = quota && typeof quota.weekly === 'number' ? { pct: pctOf(quota.weekly), resetsAt: quota.resetsAt || null, at: quota.at || null, source: 'session' } : null;
  // `rawResetsAt`: the reset as read, for lib/limits.mjs (a reading older than a past reset no longer says the window)
  const fromMeasure = measured && measured.weekly ? { pct: measured.weekly.pct, resetsAt: measured.weekly.resetsAt, at: measured.at, source: 'measure' } : null;
  const weekly0 = fromSession && fromMeasure ? (String(fromMeasure.at) >= String(fromSession.at) ? fromMeasure : fromSession) : fromMeasure || fromSession;
  const weekly = weekly0 && weekly0.resetsAt ? { ...weekly0, rawResetsAt: weekly0.resetsAt, resetsAt: nextWeeklyReset(weekly0.resetsAt, now) } : weekly0;
  const fiveHour = measured && measured.fiveHour ? { pct: measured.fiveHour.pct, resetsAt: measured.fiveHour.resetsAt, at: measured.at } : null;
  const models = {}; for (const [k, v] of Object.entries((measured && measured.models) || {})) models[k] = { weekly: v.weekly ? { pct: v.weekly.pct, rawResetsAt: v.weekly.resetsAt || null, resetsAt: v.weekly.resetsAt ? nextWeeklyReset(v.weekly.resetsAt, now) : null, at: measured.at } : null, fiveHour: v.fiveHour ? { pct: v.fiveHour.pct, resetsAt: v.fiveHour.resetsAt, at: measured.at } : null };
  const measuredAt = measured ? measured.at : null;
  const age = (at) => (at ? now - Date.parse(at) : null);
  const stale = !!(measuredAt && age(measuredAt) > STALE_MS) || !!(weekly && weekly.at && age(weekly.at) > STALE_MS && !measuredAt);
  return { weekly, fiveHour, models, measuredAt, stale, measuring, nextAt };
};

// ---------------------------------------------------------------- the « Coût » block
// The transcripts of the project (same folder or same repository: a worktree counts), priced by hour (lib/usage.mjs keeps
// the buckets per UTC hour): the hour that holds the window's start counts whole. `dayStart`: the local midnight by default.
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const costWithin = (sessions, from, to) => {
  const a = hourKey(from), b = hourKey(to); let cost = 0; let n = 0;
  for (const s of sessions) { let used = false;
    for (const [h, models] of Object.entries(s.hours || {})) { if (h < a || h > b) continue; for (const [m, bk] of Object.entries(models)) { const c = costOf(bk, m); if (c != null) { cost += c; used = true; } } }
    if (used) n++; }
  return { usd: round2(cost), sessions: n };
};
export const localMidnight = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const costWindows = ({ sessions = [], project = null, now = Date.now(), dayStart = localMidnight(now), dollarsPerPct = null } = {}) => {
  const root = project ? repoRoot(project) : null;
  const mine = root ? sessions.filter((s) => s.project && (s.project === project || repoRoot(s.project) === root)) : [];
  const pct = (usd) => (typeof dollarsPerPct === 'number' && dollarsPerPct > 0 ? Math.round(usd / dollarsPerPct * 10) / 10 : null);
  const today = costWithin(mine, dayStart, now); const week = costWithin(mine, now - 7 * DAY, now);
  return { today: { ...today, pct: pct(today.usd) }, week: { ...week, pct: pct(week.usd) }, calibrated: typeof dollarsPerPct === 'number' && dollarsPerPct > 0 };
};

// ---------------------------------------------------------------- the last run
// plans: [{ id, title, created, state: [{ id, status, usage }] }], a plan is launched once it has state rows; the newest wins
export const lastRun = (plans = [], dollarsPerPct = null) => {
  const launched = plans.filter((p) => Array.isArray(p.state) && p.state.length).sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const p = launched[0]; if (!p) return null;
  const usd = round2(p.state.reduce((a, r) => a + (r.usage && Number.isFinite(r.usage.cost) ? r.usage.cost : 0), 0));
  const live = p.state.some((r) => r.status === 'running' || r.status === 'waiting');
  return { plan: p.id, title: p.title || p.id, usd, capUsd: Number(p.capUsd) > 0 ? Number(p.capUsd) : null, pct: typeof dollarsPerPct === 'number' && dollarsPerPct > 0 ? Math.round(usd / dollarsPerPct * 10) / 10 : null, live, created: p.created || null };
};
// A run of today is part of today (and of the week): the sessions' own figures (their stream) are the floor of the window
// when the transcripts say less or nothing (not read yet, another folder); the max, never a sum that would count the same
// dollars twice. `cost` is the object of costWindows; the pct follows the same rule.
export const withRun = (cost, run, { now = Date.now(), dayStart = localMidnight(now), dollarsPerPct = null } = {}) => {
  if (!run || !run.created || !(run.usd > 0)) return cost;
  const t = Date.parse(run.created); if (!Number.isFinite(t) || t > now) return cost;
  const lift = (w) => (w.usd >= run.usd ? w : { ...w, usd: run.usd, pct: typeof dollarsPerPct === 'number' && dollarsPerPct > 0 ? Math.round(run.usd / dollarsPerPct * 10) / 10 : null });
  return { ...cost, today: t >= dayStart ? lift(cost.today) : cost.today, week: t >= now - 7 * DAY ? lift(cost.week) : cost.week };
};

// ---------------------------------------------------------------- « Maintenant »
// nodes: the project's flow (lib/projectflow.mjs): status, waitingFor, cost, budget, plan, session, name.
// Waiting = what needs a person (the developer, or the pilot in his place); queued = the todo sessions of a running plan.
// « t'attend » counts only what the developer himself has to do (dev, permission, review: public/todo.js; with a pilot
// present lib/projectflow.mjs already says 'pilot' for what the pilot handles); a session waiting for the pilot is a row
// of the card (« attend le pilote ») and the `pilot` count, never the developer's figure (Dev, 2026-11-02 04:45)
const MINE = new Set(['dev', 'permission', 'review']);
export const ROWS = 5;
export const nowOf = (nodes = [], plans = []) => {
  const runningPlans = new Set(plans.filter((p) => p.status === 'running').map((p) => p.id));
  const running = nodes.filter((n) => n.status === 'running');
  const waiting = nodes.filter((n) => n.status !== 'running' && MINE.has(n.waitingFor));
  // a node that carries nextStep (lib/projectflow.mjs `next`) is the pilot's only when nextStep says so (ATOI, 7 Nov.)
  const forPilot = nodes.filter((n) => n.status !== 'running' && !MINE.has(n.waitingFor) && (n.next ? n.waitingFor === 'pilot' : n.status === 'waiting' || n.waitingFor === 'pilot'));
  const queued = nodes.filter((n) => (n.status === 'todo' || n.status === 'later') && runningPlans.has(n.plan));
  const errors = nodes.filter((n) => n.status === 'error');
  // The queued sessions follow, with what they wait for (`after`, the sessions before them): the home's floating card
  // says « à venir · après D » (phase 11, the mock-up); five rows, then « et n autres · Flot »
  const row = (n) => ({ plan: n.plan, session: n.session, name: n.name || n.session, status: n.status, waitingFor: n.waitingFor || null, cost: Number.isFinite(n.cost) ? n.cost : 0, budget: Number.isFinite(n.budget) ? n.budget : null, after: Array.isArray(n.after) ? n.after : [] });
  const list = [...running, ...waiting, ...errors, ...forPilot, ...queued];
  return { running: running.length, waiting: waiting.length, pilot: forPilot.length, queued: queued.length, errors: errors.length, rows: list.slice(0, ROWS).map(row), more: Math.max(0, list.length - ROWS) };
};

// ---------------------------------------------------------------- « Garde »
// network: the project's one list of domains ([{ host, scope }] or host names), never a plan's announcement (lib/domains.mjs)
export const guardOf = ({ autonomy = null, plan = null, burst = null, network = null } = {}) => ({
  mode: (autonomy && autonomy.mode) || 'surveille',
  network: Array.isArray(network) ? network.map((e) => (e && typeof e === 'object' ? e.host : String(e))).filter(Boolean) : [],
  plan: plan ? { id: plan.id, title: plan.title || plan.id } : null,
  burst: burst && (burst.status === 'running' || burst.status === 'draining') ? { id: burst.id, status: burst.status, capUsd: burst.capUsd ?? null, spentUsd: burst.spentUsd ?? 0 } : null,
  autoMerge: !!((plan && plan.autoMerge) || (autonomy && autonomy.autoMergeIfGreen && autonomy.testCommand)),
});

// ---------------------------------------------------------------- the whole object
// The plan and the account Claude Code is logged in with (~/.claude.json, oauthAccount: written by `claude login`;
// no token there). The address is masked on screen (d•••@gmail.com, whole on hover): the panel ends up in captures.
export const maskEmail = (e) => { const m = /^([^@])[^@]*(@.+)$/.exec(String(e || "")); return m ? m[1] + "•••" + m[2] : null; };
export const accountOf = (home = vars.HOME || homedir()) => {
  try { const o = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).oauthAccount; if (!o) return null;
    return { plan: o.planDisplayName || null, email: o.emailAddress || null, masked: maskEmail(o.emailAddress), tier: o.organizationRateLimitTier || o.userRateLimitTier || null };
  } catch { return null; }
};
export const statusOf = ({ project, now = Date.now(), sessions = [], quota = null, measure = null, nodes = [], plans = [], autonomy = null, burst = null, dollarsPerPct = null, account = undefined, thresholds = undefined, share = null, network = null } = {}) => {
  const run = lastRun(plans, dollarsPerPct);
  const last = run ? plans.find((p) => p.id === run.plan) : plans[0] || null;
  const claude = limitsOf({ quota, measured: measure && measure.last, measuring: !!(measure && measure.measuring), nextAt: measure ? measure.nextAt : null, now });
  // Every limit that can stop the work, one row each, its thresholds drawn on it (lib/limits.mjs, docs/limits.md)
  const active = burst && (burst.status === 'running' || burst.status === 'draining') ? burst : null;
  const rows = rowsOf({ claude, burst: active, run: run && run.live ? run : null, share, thresholds: thresholds || effectiveThresholds(), now });
  return {
    project, at: new Date(now).toISOString(),
    now: nowOf(nodes, plans),
    limits: { rows, verdict: verdictOf(rows) },
    claude: { ...claude, account: account === undefined ? accountOf() : account },
    cost: { ...withRun(costWindows({ sessions, project, now, dollarsPerPct }), run, { now, dollarsPerPct }), run },
    guard: guardOf({ autonomy, plan: last, burst, network }),
  };
};
