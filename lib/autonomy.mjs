// The autonomy of an escadrille (docs/autonomy.md): what waits for a human, what follows its fallback, pure and
// tested without a server. server.mjs applies the decisions; lib/policy.mjs gives the permission verdicts.
//   validateAutonomy(v)                 → { value } | { errors }: a project's setting or a plan's field, defaults filled
//   hardenErrors(cur, next, { sumBudget }) → []: a plan's autonomy may only get stricter
//   waitsForHuman({ mode, waitKinds, stop }) → bool
//   decideReply({ plan, session, pending }) → { action: 'wait' | 'fallback', text, afterMs, kind }
//   decidePermission({ mode, suggest }) → 'allow' | 'deny' | 'wait'
//   guardedFiles(files, patterns), inQuietHours(q, date), noticeAllowed(level, kind), quotaRefusal(weekly, resetAt, now)

export const MODES = ['surveille', 'guide', 'autonome'];
import { msg } from './i18n.mjs';
// The names on screen are markers, decoded by the language of the request; what reaches Claude goes through plain()
export const MODE_NAMES = { surveille: msg('mode.surveille'), guide: msg('mode.guide'), autonome: msg('mode.autonome') };
export const KINDS = ['taste', 'review', 'data', 'security', 'release', 'info'];
export const MODE_WAITS = { surveille: KINDS, guide: ['taste', 'security', 'release'], autonome: ['security', 'release'] };
export const NOTIFY_LEVELS = ['all', 'waiting', 'none'];
export const DEFAULTS = Object.freeze({ mode: 'surveille', guardedPaths: ['.github/**', '**/*.env*', '**/migrations/**'], planCapUsd: null, askAboveUsd: 20, autoMergeIfGreen: false, testCommand: null, quietHours: null, notifyLevel: 'waiting', fallbackDelayMin: 10, stopAtQuotaLimit: true });

// A stop of a plan: a string (kind info, no fallback) or { title, kind, fallback }
export const stopTitle = (stop) => (stop && typeof stop === 'object' ? String(stop.title ?? '').trim() : String(stop ?? '').trim());
export const stopKind = (stop) => (stop && typeof stop === 'object' && KINDS.includes(stop.kind) ? stop.kind : 'info');
export const stopFallback = (stop) => (stop && typeof stop === 'object' && typeof stop.fallback === 'string' && stop.fallback.trim() ? stop.fallback.trim() : null);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const money = (v, k, errors) => { if (v === null) return null; const n = Number(v); if (typeof v === 'boolean' || v === '' || !Number.isFinite(n) || n <= 0) { errors.push(`${k} : un nombre de dollars > 0, ou null`); return null; } return n; };

export const validateAutonomy = (v) => {
  if (v === undefined || v === null) return { value: { ...DEFAULTS } };
  if (typeof v !== 'object' || Array.isArray(v)) return { errors: ['autonomy : un objet { mode, … }'] };
  const errors = []; const out = { ...DEFAULTS };
  const known = new Set([...Object.keys(DEFAULTS), 'waitKinds']);
  for (const k of Object.keys(v)) if (!known.has(k)) errors.push(`autonomy.${k} : champ inconnu`);
  if (v.mode !== undefined) { if (MODES.includes(v.mode)) out.mode = v.mode; else errors.push('autonomy.mode : surveille, guide ou autonome'); }
  if (v.waitKinds !== undefined && v.waitKinds !== null) {
    if (!Array.isArray(v.waitKinds) || v.waitKinds.some((k) => !KINDS.includes(k))) errors.push(`autonomy.waitKinds : une liste parmi ${KINDS.join(', ')}`);
    else out.waitKinds = [...new Set(v.waitKinds)];
  }
  if (v.guardedPaths !== undefined) {
    if (!Array.isArray(v.guardedPaths) || v.guardedPaths.some((p) => typeof p !== 'string' || !p.trim() || p.length > 200)) errors.push('autonomy.guardedPaths : une liste de motifs non vides (.github/**)');
    else out.guardedPaths = [...new Set(v.guardedPaths.map((p) => p.trim()))];
  }
  if (v.planCapUsd !== undefined) out.planCapUsd = money(v.planCapUsd, 'autonomy.planCapUsd', errors);
  if (v.askAboveUsd !== undefined) out.askAboveUsd = money(v.askAboveUsd, 'autonomy.askAboveUsd', errors);
  for (const k of ['autoMergeIfGreen', 'stopAtQuotaLimit']) if (v[k] !== undefined) { if (typeof v[k] === 'boolean') out[k] = v[k]; else errors.push(`autonomy.${k} : true ou false`); }
  if (v.testCommand !== undefined) { if (v.testCommand === null || (typeof v.testCommand === 'string' && !v.testCommand.trim())) out.testCommand = null; else if (typeof v.testCommand !== 'string' || v.testCommand.length > 500 || /[\r\n]/.test(v.testCommand)) errors.push('autonomy.testCommand : une commande d’une ligne, ou null'); else out.testCommand = v.testCommand.trim(); }
  if (v.quietHours !== undefined) { if (v.quietHours === null) out.quietHours = null; else if (!v.quietHours || !HHMM.test(v.quietHours.from) || !HHMM.test(v.quietHours.to)) errors.push('autonomy.quietHours : { from: "HH:MM", to: "HH:MM" }, ou null'); else out.quietHours = { from: v.quietHours.from, to: v.quietHours.to }; }
  if (v.notifyLevel !== undefined) { if (NOTIFY_LEVELS.includes(v.notifyLevel)) out.notifyLevel = v.notifyLevel; else errors.push('autonomy.notifyLevel : all, waiting ou none'); }
  if (v.fallbackDelayMin !== undefined) { const n = Number(v.fallbackDelayMin); if (typeof v.fallbackDelayMin === 'boolean' || !Number.isFinite(n) || n < 0 || n > 24 * 60) errors.push('autonomy.fallbackDelayMin : des minutes, de 0 à 1440'); else out.fallbackDelayMin = n; }
  return errors.length ? { errors } : { value: out };
};

// The kinds that wait for a human under an autonomy
export const waitSet = (a) => new Set(a?.waitKinds ?? MODE_WAITS[a?.mode] ?? KINDS);
const rank = (m) => MODES.indexOf(m);

// A plan's autonomy may only get stricter: the refusals, one line each
export const hardenErrors = (cur, next, { sumBudget = null } = {}) => {
  const out = [];
  if (rank(next.mode) > rank(cur.mode)) out.push(`mode : ${MODE_NAMES[next.mode]} est moins surveillé que ${MODE_NAMES[cur.mode]}`);
  const cw = waitSet(cur); const nw = waitSet(next);
  const lost = [...cw].filter((k) => !nw.has(k)); if (lost.length) out.push(`genres qui attendent : ${lost.join(', ')} ne peut pas être retiré`);
  const gone = cur.guardedPaths.filter((p) => !next.guardedPaths.includes(p)); if (gone.length) out.push(`domaines sous garde : ${gone.join(', ')} ne peut pas être retiré`);
  const capOf = (a) => a.planCapUsd ?? sumBudget;
  if (capOf(cur) !== null && (capOf(next) === null || capOf(next) > capOf(cur))) out.push('planCapUsd : seulement plus bas');
  if (cur.askAboveUsd !== null && (next.askAboveUsd === null || next.askAboveUsd > cur.askAboveUsd)) out.push('askAboveUsd : seulement plus bas');
  if (next.fallbackDelayMin < cur.fallbackDelayMin) out.push('fallbackDelayMin : seulement plus long');
  if (next.autoMergeIfGreen && !cur.autoMergeIfGreen) out.push('autoMergeIfGreen : seulement éteinte');
  if (next.autoMergeIfGreen && next.testCommand !== cur.testCommand) out.push('testCommand : ne change pas tant que la fusion auto est allumée');
  if (!next.stopAtQuotaLimit && cur.stopAtQuotaLimit) out.push('stopAtQuotaLimit : seulement allumé');
  return out;
};

export const waitsForHuman = ({ mode, waitKinds, stop }) => {
  if (!stopFallback(stop)) return true;
  return waitSet({ mode, waitKinds }).has(stopKind(stop));
};

// A 'reply' entry: the stop the session reached is session.stops[pending.stop]; no stop known → wait
export const decideReply = ({ plan, session, pending }) => {
  const a = plan?.autonomy || DEFAULTS;
  const stop = Number.isInteger(pending?.stop) ? session?.stops?.[pending.stop] : undefined;
  if (stop === undefined) return { action: 'wait', text: null, afterMs: null, kind: null };
  const kind = stopKind(stop);
  if (waitsForHuman({ mode: a.mode, waitKinds: a.waitKinds, stop })) return { action: 'wait', text: null, afterMs: null, kind };
  return { action: 'fallback', text: stopFallback(stop), afterMs: Math.round((a.fallbackDelayMin ?? DEFAULTS.fallbackDelayMin) * 60000), kind };
};

export const decidePermission = ({ mode, suggest }) => {
  if (mode !== 'guide' && mode !== 'autonome') return 'wait';
  if (suggest?.allow === true) return 'allow';
  if (suggest?.allow === false) return 'deny';
  return 'wait';
};

// A glob of paths, dots like any other character: ** any depth (zero included), * one segment's part, ? one character
const globRe = (g) => new RegExp('^' + String(g).split(/(\*\*\/|\*\*|\*|\?)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
export const matchesGlob = (file, glob) => globRe(glob).test(String(file).replace(/^\.\//, ''));
export const guardedFiles = (files, patterns) => [...new Set(files)].filter((f) => (patterns || []).some((g) => matchesGlob(f, g))).sort();

// Quiet hours: from 22:00 to 07:00 crosses midnight; from === to is never quiet
export const inQuietHours = (q, date = new Date()) => {
  if (!q) return false;
  const m = date.getHours() * 60 + date.getMinutes(); const at = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const f = at(q.from); const t = at(q.to);
  return f < t ? m >= f && m < t : f > t ? m >= f || m < t : false;
};
export const WAITING_KINDS = ['waiting', 'permission', 'review', 'ask-budget', 'budget'];
export const noticeAllowed = (level, kind) => (level === 'none' ? false : level === 'all' ? true : WAITING_KINDS.includes(kind));

// The weekly quota at 100 % before its reset: the refusal's text, else null. Extra usage allowed by Anthropic
// (overage.status 'allowed': the developer bought credits) is no stop: Anthropic limits the sessions itself (Dev, 7 November)
export const overageAllowed = (overage) => overage?.status === 'allowed';
export const quotaRefusal = (weekly, resetAt, now = Date.now(), { overage = null } = {}) => {
  if (!(Number(weekly) >= 1)) return null;
  if (overageAllowed(overage)) return null;
  const r = Date.parse(resetAt); if (Number.isFinite(r) && r <= now) return null;
  return Number.isFinite(r) ? msg('srv.au.quotaUntil', { t: new Date(r).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) }) : msg('srv.au.quota');
};

// One line for the views: « Guidé · 3 domaines sous garde · fusion auto éteinte »
export const summaryLine = (a) => {
  const n = a.guardedPaths.length;
  const merge = msg(a.autoMergeIfGreen ? (a.testCommand ? 'srv.au.mergeGreen' : 'srv.au.mergeNoCmd') : 'srv.au.mergeOff');
  return msg('srv.au.line', { mode: MODE_NAMES[a.mode], n, merge });
};
export const NOTIFY_NAMES = { all: msg('srv.au.n.all'), waiting: msg('srv.au.n.waiting'), none: msg('srv.au.n.none') };

// The hook of R (lib/review.mjs, docs/review.md): the guarded paths of a project force its strict review level.
// The server gives the resolver (the project's setting); without one, the defaults
let guardedResolver = null;
export const setGuardedResolver = (fn) => { guardedResolver = fn; };
export const guardedPaths = async (project) => (guardedResolver ? guardedResolver(project) : [...DEFAULTS.guardedPaths]);
