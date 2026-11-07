// The limits that can stop the work, and the thresholds the developer sets on each (docs/limits.md).
// Pure functions: the server reads the usage, these say which limit is where and what to do; nothing here stops a
// process or writes the base.
//
//   DEFAULTS                                   { fiveHour, weekly, model, burst, plan }: { soft, hard } in % of the limit
//   validateThresholds(v)                      { value, errors }: each key { soft, hard }, 1..100 or null (off), soft ≤ hard
//   mergeThresholds(stored, sent, value)       a save key by key: a key sent replaces, null clears, the others stay;
//                                              a key with `until` (ISO) keeps the value it replaces in `previous`
//   expireThresholds(stored, now)              { value, expired }: the timed keys past their hour back to `previous`
//   modelKey(id), rowTouches(row, model)       a model's row acts on that model only, the others on all
//   effectiveThresholds(mac, project)          per key the stricter of the Mac's (else the defaults) and the project's
//   rowsOf({ claude, burst, run, thresholds, now })
//                                              one row per limit, in the order that stops the work first, the one closest
//                                              to its threshold moved to the head (lead: true); a row not measured says so
//   verdictOf(rows)                            { level: 'ok' | 'soft' | 'hard', row, line } the worst row
//   createWatch()                              { observe(key, verdict) → 'soft' | 'hard' | 'clear' | null } on a change of level
//   marginsSection(rows)                       the lines the planner reads: the margin under each soft threshold
//   pausable(row), pauseOf(row, line), hardPausable(rows, skip), pauseStep(pause, rows, now, skip)
//                                              the pause at a hard threshold and its resume (« La pause » below)
//   validateShare(v), shareThresholds(max), shareSince(resetsAt), shareRow({ maxPct, spentUsd, dollarsPerPct, resetsAt })
//                                              the share of the week a project may take (« La part de la semaine » below)
import { msg } from './i18n.mjs';

export const KEYS = ['fiveHour', 'weekly', 'model', 'burst', 'plan'];
// No default stops a new user: an account starts far below 80 %, a burst or a plan below its own cap
export const DEFAULTS = Object.freeze({
  fiveHour: Object.freeze({ soft: 90, hard: 98 }),
  weekly: Object.freeze({ soft: 80, hard: 95 }),
  model: Object.freeze({ soft: 80, hard: 95 }),
  burst: Object.freeze({ soft: 90, hard: 100 }),
  plan: Object.freeze({ soft: 90, hard: 100 }),
});
const FIVE_H = 5 * 36e5; const WEEK = 7 * 864e5;

// ---------------------------------------------------------------- the thresholds
const okPct = (x) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 1 && x <= 100);
export const validateThresholds = (v) => {
  if (v === null || v === undefined) return { value: {}, errors: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { value: null, errors: ['limits : un objet { weekly: { soft, hard }, … }'] };
  const out = {}; const errors = [];
  for (const [k, t] of Object.entries(v)) {
    if (!KEYS.includes(k)) { errors.push(`limits.${k} : inconnu (${KEYS.join(', ')})`); continue; }
    if (t === null) continue; // the key cleared: the level above applies
    if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.push(`limits.${k} : { soft, hard }`); continue; }
    const soft = t.soft === undefined || t.soft === '' ? null : Number(t.soft); const hard = t.hard === undefined || t.hard === '' ? null : Number(t.hard);
    if (!okPct(soft)) errors.push(`limits.${k}.soft : de 1 à 100, ou vide`);
    if (!okPct(hard)) errors.push(`limits.${k}.hard : de 1 à 100, ou vide`);
    if (okPct(soft) && okPct(hard) && soft !== null && hard !== null && soft > hard) errors.push(`limits.${k} : le seuil doux sous le dur`);
    out[k] = { soft, hard };
    // « 50 % jusqu'à lundi soir » (Dev, 2 November): an ISO end date; at that hour the previous value comes back alone
    if (t.until !== undefined && t.until !== null && t.until !== '') {
      const end = typeof t.until === 'string' ? Date.parse(t.until) : NaN;
      if (!Number.isFinite(end)) errors.push(`limits.${k}.until : une date ISO (2026-11-09T20:00:00Z), ou vide`);
      else out[k].until = new Date(end).toISOString();
    }
  }
  return errors.length ? { value: null, errors } : { value: out, errors: null };
};
// A save merges key by key (2026-11-02: a weekly sent alone wiped the model's threshold): a key sent replaces the
// stored one, an explicit null clears it, the keys not sent stay. sent: the raw object, value: its validateThresholds.
// A key sent with `until` keeps the value it replaces in `previous` (null: none, the key goes away at the end); a
// timed key replaced by another timed one keeps the first `previous` (the value from before any temporary one).
const bare = (t) => ({ soft: t.soft ?? null, hard: t.hard ?? null });
export const mergeThresholds = (stored = {}, sent = {}, value = {}) => {
  const out = { ...(stored || {}) };
  for (const k of Object.keys(sent || {})) {
    if (sent[k] === null) { delete out[k]; continue; }
    const v = value[k]; if (!v) continue;
    if (!v.until) { out[k] = v; continue; }
    const was = stored && stored[k];
    out[k] = { ...v, previous: !was ? null : was.until ? was.previous ?? null : bare(was) };
  }
  return out;
};
// The timed keys whose hour has come go back to their previous value (or away). Stored settings without `until` (all
// those saved before) pass unchanged. → { value, expired: [{ key, until, from, to }] }, value === stored when none.
export const expireThresholds = (stored = {}, now = Date.now()) => {
  const expired = []; let out = stored || {};
  for (const [k, t] of Object.entries(stored || {})) {
    if (!t || !t.until) continue; const end = Date.parse(t.until);
    if (!Number.isFinite(end) || end > now) continue;
    if (out === stored) out = { ...stored };
    const to = t.previous ? bare(t.previous) : null;
    if (to) out[k] = to; else delete out[k];
    expired.push({ key: k, until: t.until, from: bare(t), to });
  }
  return { value: out, expired };
};
// A model's row acts on that model's sessions and planners only; every other row on all (2026-11-02 13:16: Fable's
// limit cut an Opus planning). The key is the family, found anywhere in the id (2026-11-06): modelKey('claude-fable-5-1')
// → 'fable', 'claude-3-5-sonnet-20241022' → 'sonnet', 'us.anthropic.claude-haiku-…' → 'haiku', « Claude Opus » → 'opus';
// another id keeps its first word. Both sides go through it, the row's model as the session's.
const FAMILY = /\b(fable|opus|sonnet|haiku)\b/i;
export const modelKey = (id) => { const s = String(id || ''); const f = FAMILY.exec(s); if (f) return f[1].toLowerCase(); const m = /^(?:claude-)?([a-z]+)/i.exec(s); return m ? m[1].toLowerCase() : null; };
export const rowTouches = (row, model) => !(row && row.kind === 'model' && row.model) || modelKey(model) === modelKey(row.model);
const stricter = (a, b) => (a === null || a === undefined ? b ?? null : b === null || b === undefined ? a : Math.min(a, b));
// The Mac sets the line (the defaults where it says nothing, null turns a threshold off); a project may only be stricter
export const effectiveThresholds = (mac = {}, project = {}) => {
  const out = {};
  for (const k of KEYS) {
    const base = mac && mac[k] ? mac[k] : DEFAULTS[k]; const own = project && project[k];
    out[k] = own ? { soft: stricter(base.soft, own.soft), hard: stricter(base.hard, own.hard) } : { soft: base.soft ?? null, hard: base.hard ?? null };
    if (PACED.includes(k) && !(mac && mac[k]) && !own) out[k].pace = true; // nobody set it: the pace of the week decides (paceThresholds)
  }
  return out;
};

// ---------------------------------------------------------------- the pace of the week (2026-11-02, Dev)
// « Imagine a developer who arrives on Monday and hands over a big task »: with a fixed 80 %, one night can burn the
// whole week. By default a weekly window follows its pace: the soft threshold is the share of the week already gone
// plus one day (never under 15 %, never over the fixed default), the hard one ten points above. On the first day of
// the week a run may take about two sevenths of the quota; on the last day, everything up to the defaults. A threshold
// the developer sets in Access replaces the pace.
export const PACED = ['weekly', 'model'];
export const paceThresholds = (kind, resetsAt, now = Date.now()) => {
  const end = Date.parse(resetsAt); if (!Number.isFinite(end)) return null;
  const gone = Math.min(1, Math.max(0, 1 - (end - now) / WEEK));
  const soft = Math.round(Math.min(DEFAULTS[kind].soft, Math.max(15, (gone + 1 / 7) * 100)));
  return { soft, hard: Math.min(DEFAULTS[kind].hard, soft + 10), pace: true };
};

// ---------------------------------------------------------------- the share of the week (phase 11 PS, Dev)
// « Bloque à 50 % pour la semaine pour Escadrille, et 25 % pour Orchard »: a project may get a share of the account's
// weekly quota, measured on what its own sessions cost since the last weekly reset, in points of the quota (the dollars
// divided by the value of a point, /api/usage dollarsPerPct). It exists only when the project sets one (nothing by
// default: no new user is stopped). Its soft threshold is 90 % of the share, its hard one the share itself; it is not
// held to « stricter than the Mac » (a share, not a threshold of the account's counter): the Mac's weekly threshold
// stays above it. Without a calibration or a known reset the row is « not measured », never an invented figure.
export const SHARE_SOFT = 0.9;
export const validateShare = (v) => {
  if (v === null || v === undefined || v === '') return { value: null, errors: null };
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? { value: Math.round(n * 10) / 10, errors: null } : { value: null, errors: ['share : de 1 à 100 (% du quota hebdo), ou vide'] };
};
export const shareThresholds = (max) => ({ soft: Math.round(max * SHARE_SOFT * 10) / 10, hard: max });
// The start of the week the share counts: the weekly reset ahead, minus seven days
export const shareSince = (resetsAt) => { const t = Date.parse(resetsAt); return Number.isFinite(t) ? new Date(t - WEEK).toISOString() : null; };
export const shareRow = ({ maxPct, spentUsd = 0, dollarsPerPct = null, resetsAt = null } = {}) => {
  if (!(maxPct > 0)) return null;
  const base = { id: 'share', kind: 'share', label: 'share', maxPct, resetsAt: resetsAt || null, usd: Math.round((spentUsd || 0) * 100) / 100, own: shareThresholds(maxPct) };
  if (!resetsAt) return { ...base, pct: null, reason: 'unmeasured' };
  if (!(typeof dollarsPerPct === 'number' && dollarsPerPct > 0)) return { ...base, pct: null, reason: 'uncalibrated' };
  return { ...base, pct: r1((spentUsd || 0) / dollarsPerPct) };
};

// ---------------------------------------------------------------- the rows
// A window reading is true until its reset: read before a reset already past, it no longer says the window (the
// window restarted since): the row is « not measured », never last period's figure. Read after the reset, it holds,
// and the reset moves forward by whole periods (never a date in the past).
const forward = (iso, period, now) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return null; return t > now ? new Date(t).toISOString() : new Date(t + Math.ceil((now - t + 1) / period) * period).toISOString(); };
const windowRow = (id, kind, label, w, period, now) => {
  if (!w || typeof w.pct !== 'number') return { id, kind, label, pct: null, resetsAt: null, reason: 'unmeasured' };
  const raw = w.rawResetsAt || w.resetsAt; const t = raw ? Date.parse(raw) : NaN; const at = w.at ? Date.parse(w.at) : NaN;
  if (Number.isFinite(t) && t <= now && Number.isFinite(at) && at < t) return { id, kind, label, pct: null, resetsAt: forward(raw, period, now), reason: 'reset', at: w.at || null };
  return { id, kind, label, pct: w.pct, resetsAt: raw ? forward(raw, period, now) : null, at: w.at || null };
};
const MODEL_NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
export const modelName = (k) => MODEL_NAMES[k] || k.charAt(0).toUpperCase() + k.slice(1);
const levelOf = (pct, t) => (pct === null ? 'unmeasured' : t.hard !== null && pct >= t.hard ? 'hard' : t.soft !== null && pct >= t.soft ? 'soft' : 'ok');
const r1 = (x) => Math.round(x * 10) / 10;

// claude: limitsOf of lib/status.mjs ({ weekly, fiveHour, models, measuredAt }); burst: the active burst
// ({ capUsd, spentUsd, until }); run: the live plan ({ title, usd, capUsd }); thresholds: effectiveThresholds.
// share: { maxPct, spentUsd, dollarsPerPct } when the project has a share (its reset is the weekly window's)
export const rowsOf = ({ claude = null, burst = null, run = null, share = null, thresholds = effectiveThresholds(), now = Date.now() } = {}) => {
  const c = claude || {}; const rows = [];
  const fh = c.fiveHour ? { ...c.fiveHour, at: c.fiveHour.at || c.measuredAt } : null;
  rows.push(windowRow('fiveHour', 'fiveHour', 'fiveHour', fh, FIVE_H, now));
  rows.push(windowRow('weekly', 'weekly', 'weekly', c.weekly, WEEK, now));
  const models = { fable: null, ...(c.models || {}) };
  for (const [k, v] of Object.entries(models)) {
    const w = v && v.weekly ? { ...v.weekly, at: v.weekly.at || c.measuredAt } : null;
    rows.push({ ...windowRow('model:' + k, 'model', modelName(k), w, WEEK, now), model: k });
  }
  if (burst && burst.capUsd > 0) rows.push({ id: 'burst', kind: 'burst', label: 'burst', pct: r1(Math.min(100, (burst.spentUsd || 0) / burst.capUsd * 100)), resetsAt: burst.until || null, usd: burst.spentUsd || 0, capUsd: burst.capUsd, end: true });
  const sh = share && shareRow({ ...share, resetsAt: rows.find((r) => r.id === 'weekly').resetsAt || share.resetsAt || null }); if (sh) rows.push(sh);
  if (run && run.capUsd > 0) rows.push({ id: 'plan', kind: 'plan', label: run.title || 'plan', pct: r1(Math.min(100, (run.usd || 0) / run.capUsd * 100)), resetsAt: null, usd: run.usd || 0, capUsd: run.capUsd });
  for (const r of rows) { let t = r.own || thresholds[r.kind] || { soft: null, hard: null }; delete r.own; if (t.pace && r.resetsAt) t = paceThresholds(r.kind, r.resetsAt, now) || t; r.pace = !!t.pace; r.soft = t.soft; r.hard = t.hard; r.level = levelOf(r.pct, t); r.margin = r.pct === null ? null : r1((t.soft ?? t.hard ?? 100) - r.pct); }
  // The head: the measured row closest to its threshold (the smallest margin; a crossed one first)
  let lead = null; for (const r of rows) if (r.margin !== null && (!lead || r.margin < lead.margin)) lead = r;
  if (lead) { lead.lead = true; rows.splice(rows.indexOf(lead), 1); rows.unshift(lead); }
  return rows;
};

// ---------------------------------------------------------------- the verdict
const RANK = { ok: 0, unmeasured: 0, soft: 1, hard: 2 };
export const rowName = (r) => (r.kind === 'share' ? msg('lim.share') : r.kind === 'model' ? msg('lim.model', { name: r.label }) : r.kind === 'plan' ? msg('lim.planOf', { name: r.label }) : msg('lim.' + r.kind));
export const verdictOf = (rows = []) => {
  let worst = null; for (const r of rows) if (RANK[r.level] > 0 && (!worst || RANK[r.level] > RANK[worst.level] || (r.level === worst.level && r.pct - (r[r.level]) > worst.pct - worst[worst.level]))) worst = r;
  if (!worst) return { level: 'ok', row: null, line: null };
  return { level: worst.level, row: worst.id, line: msg(worst.level === 'hard' ? 'lim.hardLine' : 'lim.softLine', { name: rowName(worst), pct: worst.pct, at: worst[worst.level] }) };
};
// A level per key (a project): reports a change only, so an action runs once per crossing
export const createWatch = () => {
  const last = new Map();
  return {
    observe: (key, v) => { const was = last.get(key) || 'ok'; const now = v.level; last.set(key, now); if (now === was) return null; return now === 'ok' ? 'clear' : now; },
    level: (key) => last.get(key) || 'ok',
  };
};

// ---------------------------------------------------------------- the pause (phase 10 P, docs/limits.md « La pause »)
// A window that resets (5 h, weekly, a model's weekly) above its hard threshold pauses the sessions instead of
// stopping them: each keeps its Claude session and resumes alone with --resume. A dollar cap (burst, plan) never
// resets on its own: it still stops. The share of the week pauses the project's sessions alone (the others run on).
export const PAUSABLE = ['fiveHour', 'weekly', 'model', 'share'];
export const pausable = (row) => !!row && PAUSABLE.includes(row.kind);
export const pauseOf = (row, line, at = new Date().toISOString()) => ({ limit: row.id, kind: row.kind, label: row.label, line, until: row.resetsAt || null, at });
// The pausable rows above their hard threshold, the most crossed first; `skip(row)` leaves out those forced by the developer
export const hardPausable = (rows = [], skip = () => false) => rows.filter((r) => r.level === 'hard' && pausable(r) && !skip(r)).sort((a, b) => (b.pct - b.hard) - (a.pct - a.hard));
// What a paused session does at a reading: hold while any pausable window is above its hard threshold (the cause moves
// to it when it is another one, or the same with a new reset); else resume at the reset of its limit (the hour passed,
// or a reading older than the reset) or when a reading puts that limit back under its soft threshold. A limit not
// measured before its reset holds: no figure is never a green light.
export const pauseStep = (pause, rows = [], now = Date.now(), skip = () => false) => {
  const [hard] = hardPausable(rows, skip);
  if (hard) {
    // the same limit read without its reset (the base's share after a restart) keeps the hour already known
    if (hard.id === pause.limit && (!hard.resetsAt || hard.resetsAt === pause.until)) return { action: 'hold', pause };
    return { action: 'hold', pause: pauseOf(hard, verdictOf([hard]).line, pause.at), changed: true };
  }
  const end = Date.parse(pause.until); const r = rows.find((x) => x.id === pause.limit);
  if ((Number.isFinite(end) && now >= end) || (r && r.reason === 'reset')) return { action: 'resume', why: 'reset' };
  if (r && r.level === 'ok') return { action: 'resume', why: 'below' };
  // a share raised in Access lets the project run again once back under the hard line (the soft one only holds new sessions)
  if (r && r.kind === 'share' && r.level === 'soft') return { action: 'resume', why: 'below' };
  return { action: 'hold', pause };
};

// ---------------------------------------------------------------- what the planner reads
const NAMES_FR = { fiveHour: 'Fenêtre de 5 h', weekly: 'Quota hebdo', burst: 'Plafond de la rafale', share: 'Part de la semaine du projet' };
const nameFr = (r) => (r.kind === 'model' ? `Quota hebdo ${r.label}` : r.kind === 'plan' ? `Plafond du plan « ${r.label} »` : NAMES_FR[r.kind]);
const inH = (iso, now) => { const ms = Date.parse(iso) - now; if (!Number.isFinite(ms)) return ''; const h = ms / 36e5; return h < 1 ? `, remise dans ${Math.max(1, Math.round(ms / 6e4))} min` : h < 48 ? `, remise dans ${Math.round(h)} h` : `, remise dans ${Math.round(h / 24)} j`; };
export const marginsSection = (rows = [], now = Date.now()) => {
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    if (r.pct === null) return `- ${nameFr(r)} : non mesuré${r.soft !== null ? ` (seuil doux ${r.soft} %)` : ''}`;
    const soft = r.soft ?? r.hard; const end = r.kind === 'burst' ? (r.resetsAt ? `, fin ${new Date(r.resetsAt).toISOString().slice(11, 16)} UTC` : '') : r.resetsAt ? inH(r.resetsAt, now) : '';
    if (soft === null) return `- ${nameFr(r)} : ${r.pct} %, aucun seuil${end}`;
    const m = r1(soft - r.pct);
    return `- ${nameFr(r)} : ${r.pct} % utilisés, seuil doux ${soft} % → ${m > 0 ? `marge ${m} points` : 'franchi : rien de nouveau ne se lance'}${end}`;
  });
  return `\n\n## Les marges\n\nAu-delà d'un seuil doux, calmdev ne lance plus de session ni de vague ; au-delà du dur, il arrête tout. Taille le plan dans la plus petite marge ci-dessous (la première ligne), et dis-le dans le plan si une vague risque de la dépasser.\n\n${lines.join('\n')}`;
};
