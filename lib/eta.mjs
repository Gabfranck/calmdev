// The estimated end of each card and each phase of the Flot (docs/flot.md, « Les ETA »), from the real history and
// nothing else: the table log holds one line per change of state of a session, so the time it worked is the sum of its
// intervals in `running`, and the time it waited for the developer (or the pilot) is the sum of its intervals in
// `waiting` or `paused`, counted apart and never included. The durations are grouped by kind of task and model, the
// same cut as lib/learning.mjs (kindOf, canonicalModel), and a median is taken; without history the ETA is null and
// the screen shows « — », never an invented figure.
//   spansOf(rows, now)                      one session's log rows → { start, end, worked, waited, done }
//   historyOf(db, project, { now })         every session of the project's plans: [{ plan, session, kind, model, own, tests, ...spans }],
//                                           plus the finished sessions of the other projects of the base (own: false), to borrow from
//   testSpansOf(rows)                       the server's test runs of one session (session_messages, system) → ms
//   groupsOf(history)                       Map 'kind|model' → { n, median, p25, p75 }, plus 'kind|*' and '*|*'; the other projects
//                                           under 'o:kind|model', 'o:kind|*', 'o:*|*'. A qa session (integration, verification)
//                                           counts its worked time plus the server's test runs (TESTED_KINDS, realOf)
//   durationFor(groups, kind, model)        { median, p25, p75, n, basis: 'kind+model' | 'kind' | 'all', source: 'project' | 'others' } | null:
//                                           the project's kind+model, the same kind+model elsewhere, the project's kind, the kind
//                                           elsewhere, every session of the project, every session elsewhere; else null
//   etaOf({ nodes, edges, history, now })   { nodes: { id → eta | null }, plans: { plan → eta | null } }
//     eta = { at, low, high, basis, n, late }: ISO times, n the sessions behind the median; a running session: its start plus its waits plus the median
//     (what it has already worked is spent); a queued one: the end of what it waits for, plus the median; a phase: the
//     farthest end of its cards (the longest path, since each card waits for its predecessors).
import { kindOf } from './learning.mjs';
import { canonicalModel, median, quantile } from './usage.mjs';

export const MIN_GROUP = 2; // a group of fewer sessions falls back to the kind alone, then to every session
export const TESTED_KINDS = new Set(['qa']); // integration and verification: the server's test runs are part of their real time
// The server's messages around its test runs (server.mjs autoTests; public/i18n srv.s.verifyStart, srv.s.verifyCode)
const TEST_START = /^(Tests de la branche fusionnée à blanc|Tests of the branch merged dry)/;
const TEST_END = /^Tests ?: code /;
const inProject = (project) => (p) => p === project || (!!p && !!project && p.startsWith(String(project).replace(/\/$/, '') + '/.claude/worktrees/'));
const parse = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const WORK = new Set(['running']);
const WAIT = new Set(['waiting', 'paused']);

// The spans of one session from its log rows (any order; the rows are sorted here). An open last interval runs to now.
export const spansOf = (rows, now = Date.now()) => {
  const list = (rows || []).map((r) => ({ at: ms(r.at), status: r.status })).filter((r) => r.at != null).sort((a, b) => a.at - b.at);
  let worked = 0, waited = 0, start = null, end = null, done = false;
  for (let i = 0; i < list.length; i++) {
    const r = list[i]; const next = list[i + 1];
    if (start == null && WORK.has(r.status)) start = r.at;
    if (r.status === 'done') { end = r.at; done = true; break; }
    const to = next ? next.at : now; const len = Math.max(0, to - r.at);
    if (WORK.has(r.status)) worked += len; else if (WAIT.has(r.status)) waited += len;
  }
  return { start: start == null ? null : new Date(start).toISOString(), end: end == null ? null : new Date(end).toISOString(), worked, waited, done };
};

// The time of the server's test runs of one session: each start message paired with the next end message
export const testSpansOf = (rows) => {
  const list = (rows || []).filter((r) => r.role == null || r.role === 'system').map((r) => ({ at: ms(r.at), text: String(r.text || '') })).filter((r) => r.at != null).sort((a, b) => a.at - b.at);
  let total = 0, open = null;
  for (const r of list) { if (TEST_START.test(r.text)) open = r.at; else if (open != null && TEST_END.test(r.text)) { total += Math.max(0, r.at - open); open = null; } }
  return total;
};
const keyed = (rows) => { const m = new Map(); for (const r of rows) { const k = r.plan + '\0' + r.session; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
// Every launched session of the project's plans, with its kind and model and its spans; the finished ones feed the medians.
// The finished sessions of the other projects come too (own: false): a project without history borrows from them.
export const historyOf = (db, project, { now = Date.now() } = {}) => {
  const mine = inProject(project);
  const plans = db.prepare('select id, json, project from plans').all().map((r) => ({ id: r.id, plan: parse(r.json, {}) || {}, own: mine(r.project) }));
  if (!plans.length) return [];
  const byId = new Map(plans.map((p) => [p.id, p]));
  const rows = db.prepare('select plan, session, at, status from log').all().filter((r) => byId.has(r.plan));
  let msgs = []; try { msgs = db.prepare("select plan, session, role, text, at from session_messages where role = 'system' and text like 'Tests%'").all(); } catch {}
  const tests = keyed(msgs);
  const out = [];
  for (const [k, list] of keyed(rows)) {
    const [planId, session] = k.split('\0'); const p = byId.get(planId);
    const s = (p.plan.sessions || []).find((x) => x.id === session) || { id: session, name: session };
    const spans = spansOf(list, now); if (spans.start == null || (!p.own && !spans.done)) continue;
    out.push({ plan: planId, session, kind: kindOf(s), model: canonicalModel(s.model || p.plan.model || null), own: p.own, tests: testSpansOf(tests.get(k)), ...spans });
  }
  return out;
};

const stat = (xs) => ({ n: xs.length, median: median(xs), p25: quantile(xs, 0.25), p75: quantile(xs, 0.75) });
// The real time of a finished session: what it worked, plus the server's test runs for an integration or a verification
export const realOf = (h) => (h.worked || 0) + (TESTED_KINDS.has(h.kind) && Number.isFinite(h.tests) ? h.tests : 0);
// The medians of real time by kind and model, then by kind alone ('kind|*'), then over every finished session ('*|*');
// the other projects' sessions under the same keys prefixed 'o:'
export const groupsOf = (history) => {
  const fin = (history || []).filter((h) => h.done && Number.isFinite(h.worked) && h.worked > 0);
  const groups = new Map(); const add = (k, v) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); };
  for (const h of fin) { const o = h.own === false ? 'o:' : ''; const v = realOf(h); add(`${o}${h.kind}|${h.model}`, v); add(`${o}${h.kind}|*`, v); add(o + '*|*', v); }
  return new Map([...groups].map(([k, xs]) => [k, stat(xs)]));
};
export const durationFor = (groups, kind, model) => {
  const tries = [[`${kind}|${model}`, 'kind+model', 'project'], [`o:${kind}|${model}`, 'kind+model', 'others'], [`${kind}|*`, 'kind', 'project'],
    [`o:${kind}|*`, 'kind', 'others'], ['*|*', 'all', 'project'], ['o:*|*', 'all', 'others']];
  for (const [k, basis, source] of tries) { const g = groups.get(k); if (g && (g.n >= MIN_GROUP || basis === 'all')) return { ...g, basis, source }; }
  return null;
};

const FINISHED = new Set(['done', 'merged']);
const iso = (t) => new Date(t).toISOString();
// The ETA of every node of a flow (lib/projectflow.mjs nodes: id, plan, session, status, after, startedAt, kind, model)
// and of every plan. `history` is historyOf(); the spans of the nodes themselves (worked, waited so far) are read from it.
export const etaOf = ({ nodes = [], edges = [], history = [], now = Date.now() } = {}) => {
  const groups = groupsOf(history);
  const spans = new Map(history.map((h) => [`${h.plan}/${h.session}`, h]));
  const deps = new Map(); for (const e of edges) { if (e.kind === 'merge') continue; if (!deps.has(e.to)) deps.set(e.to, []); deps.get(e.to).push(e.from); }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map();
  // the three ends of a node: [low, at, high] in ms, or null when nothing can be said
  const endsOf = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const n = byId.get(id); if (!n || seen.has(id)) return null; seen.add(id);
    let out = null;
    if (!FINISHED.has(n.status)) {
      const d = durationFor(groups, n.kind || kindOf(n), canonicalModel(n.model || null));
      if (d) {
        const sp = spans.get(id);
        if (sp && sp.start) { // launched: what it already worked is spent, what it waited is pushed back
          const base = Date.parse(sp.start) + sp.waited;
          out = [base + d.p25, base + d.median, base + d.p75].map((t, i) => ({ t, late: i === 1 && t < now }));
        } else { // in the queue: the farthest end of what it waits for (a finished dependency is already there), then its own time
          let from = [now, now, now]; let known = true;
          for (const dep of deps.get(id) || []) { const dn = byId.get(dep); if (!dn || FINISHED.has(dn.status)) continue; const e = endsOf(dep, seen); if (!e) { known = false; break; } from = from.map((x, i) => Math.max(x, e[i].t)); }
          if (known) out = from.map((t, i) => ({ t: t + [d.p25, d.median, d.p75][i], late: false }));
        }
        if (out) { out.basis = d.basis; out.n = d.n; out.source = d.source; }
      }
    }
    memo.set(id, out); return out;
  };
  const shape = (e) => (e ? { at: iso(Math.max(now, e[1].t)), low: iso(Math.max(now, e[0].t)), high: iso(Math.max(now, e[2].t)), basis: e.basis, source: e.source || 'project', n: e.n ?? null, late: !!e[1].late } : null);
  const outNodes = {}; for (const n of nodes) outNodes[n.id] = shape(endsOf(n.id));
  const outPlans = {};
  for (const plan of new Set(nodes.map((n) => n.plan))) {
    const mine = nodes.filter((n) => n.plan === plan && !FINISHED.has(n.status));
    if (!mine.length) { outPlans[plan] = null; continue; }
    const ends = mine.map((n) => endsOf(n.id));
    if (ends.some((e) => !e)) { outPlans[plan] = null; continue; }
    const far = [0, 1, 2].map((i) => ends.reduce((a, e) => Math.max(a, e[i].t), 0));
    const basis = ends.every((e) => e.basis === 'kind+model') ? 'kind+model' : ends.some((e) => e.basis === 'all') ? 'all' : 'kind';
    const e = far.map((t, i) => ({ t, late: i === 1 && ends.some((x) => x[1].late) })); e.basis = basis; e.source = ends.some((x) => x.source === 'others') ? 'others' : 'project'; e.n = Math.min(...ends.map((x) => x.n || 0)); outPlans[plan] = shape(e);
  }
  return { nodes: outNodes, plans: outPlans, groups: Object.fromEntries(groups) };
};
