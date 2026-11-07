// The rules of starting a session (docs/sessions.md, « La robustesse (phase 7) »), pure, tested without a server:
//   remaining(budget, spent)          → the dollars a process gets: the plan's cap minus what the session spent, never under 0.50
//                                     (nor above the cap itself when the cap is smaller)
//   queueRule({ parallel, active })   → { ok, why }: the project's queue (no setting, no queue)
//   isFinished(plan, state)           → every session done and merged (or without a worktree)
//   createQueue({ countActive, parallelOf, guards }) → { canStart(plan, session), addGuard(fn) }
// canStart runs the queue first, then each guard `(plan, session) → { ok: false, why } | null` in order; the
// first refusal wins. Session L plugs its guards here (a session to review, the plan's cap, the quota).

export const FLOOR_USD = 0.5;

export const remaining = (budget, spent) => {
  const b = Number(budget); const s = Number(spent) || 0;
  if (!Number.isFinite(b) || b <= 0) return b;
  return Math.max(Math.min(b, FLOOR_USD), Math.round((b - s) * 100) / 100);
};

export const queueText = (n) => `En file : ${n} session${n > 1 ? 's' : ''} tourne${n > 1 ? 'nt' : ''} déjà`;

export const queueRule = ({ parallel, active }) => {
  if (!Number.isInteger(parallel) || parallel < 1) return { ok: true, why: '' };
  return active < parallel ? { ok: true, why: '' } : { ok: false, why: queueText(active) };
};

// FRU (MUET, 6 November): a session holds a place in 'parallel' while its process lives, unless its branch is already merged:
// a merged session still 'waiting' with a live process (its last turn read, nothing left to do) no longer blocks the queue
export const holdsSlot = (row, alive) => !!alive && !row?.worktree?.merged;

export const sessionFinished =(r) => !!r && r.status === 'done' && (!r.worktree || !!r.worktree.merged);
export const isFinished = (plan, state) => {
  const by = new Map((state || []).map((r) => [r.id, r]));
  return !!plan?.sessions?.length && plan.sessions.every((s) => sessionFinished(by.get(s.id)));
};

export const createQueue = ({ countActive = () => 0, parallelOf = () => null, guards = [] } = {}) => {
  const list = [...guards];
  const canStart = (plan, session) => {
    const q = queueRule({ parallel: parallelOf(plan), active: countActive(plan) });
    if (!q.ok) return q;
    for (const g of list) { const r = g(plan, session); if (r && r.ok === false) return { ok: false, why: String(r.why || 'refusé') }; }
    return { ok: true, why: '' };
  };
  return { canStart, addGuard: (fn) => { list.push(fn); } };
};

// What GET /api/plan/:id adds to a session for the page (the state instruction at the end of the prompt, stopMeta, stops as bare
// titles) is not a change: a plan sent back as read must compare equal. Keys are compared whatever their order.
const STATE_TAIL = /\n\n## Suivi, obligatoire à la fin de chaque tour[\s\S]*$/;
const stopTitleOf = (t) => (t && typeof t === 'object' ? String(t.title ?? '') : String(t ?? '')).trim();
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
// The fields of a launched session that differ between the stored version and the new one, by name (empty: unchanged)
export const sessionDiff = (a, b) => {
  const x = { ...a }; const y = { ...b };
  for (const o of [x, y]) { delete o.stopMeta; if (typeof o.prompt === 'string') o.prompt = o.prompt.replace(STATE_TAIL, '').trim(); }
  const xs = Array.isArray(x.stops) ? x.stops : []; const ys = Array.isArray(y.stops) ? y.stops : [];
  // a stop sent back as its bare title lost its kind on the way out: only its title is compared then
  const stopsSame = xs.length === ys.length && xs.every((s, i) => (typeof ys[i] === 'string' || typeof s === 'string' ? stopTitleOf(s) === stopTitleOf(ys[i]) : same(s, ys[i])));
  delete x.stops; delete y.stops;
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  const out = keys.filter((k) => !same(x[k], y[k]));
  if (!stopsSame) out.push('stops');
  return out;
};

// A new version of a plan already launched (POST /api/plan, a planner's escadrille:plan block): it may add sessions
// and change those still 'todo' or 'later'; a launched session (running, waiting, done) is never lost nor changed.
// Returns the refusals, one line each (empty: the version is accepted).
export const planChangeRefusals = (oldPlan, rows, next) => {
  if (!oldPlan) return [];
  const launched = (rows || []).filter((r) => !['todo', 'later'].includes(r.status));
  const before = new Map((oldPlan.sessions || []).map((s) => [s.id, s])); const after = new Map((next?.sessions || []).map((s) => [s.id, s]));
  const out = [];
  for (const r of launched) {
    if (!after.has(r.id)) out.push(`${r.id} est lancée (${r.status}) : elle ne peut pas disparaître du plan`);
    else if (before.has(r.id)) { const diff = sessionDiff(before.get(r.id), after.get(r.id)); if (diff.length) out.push(`${r.id} est lancée (${r.status}) : elle ne peut plus changer (${diff.join(', ')})`); }
  }
  return out;
};
