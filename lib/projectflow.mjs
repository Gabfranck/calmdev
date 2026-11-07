// The flow of a project (docs/projectflow.md): every session of its plans still in flight, on one canvas,
// with what each one costs and what is happening behind the scenes. Computed from the tables plans, sessions,
// log and the last 'activity' message of session_messages; nothing new is stored.
//   flowOf(db, project, { all, defaultBudget, calibration, quota, reviewLevel }) → { project, plans, nodes, edges, totals, story, storyFull, folded, finished }
//   storyOf({ plans, nodes, edges }) → the one sentence that tells what is going on, written without AI

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { lastQuota, canonicalModel } from './usage.mjs';
import { msg } from './i18n.mjs'; // the sentence is markers, decoded by the language of the request
import { stopKind } from './autonomy.mjs';
import { isRetired } from './retire.mjs';
import { HUMAN_KINDS } from './pilot.mjs';
import { nextStep } from './nextstep.mjs';
import { kindOf } from './learning.mjs';
import { historyOf, etaOf } from './eta.mjs';
import { leftFixesOf } from './leftfixes.mjs'; // the fixes left to apply by hand (Dev, 2026-11-03 19:45)
import { alertOf as linearAlertOf } from './linearsync.mjs'; // the Linear sync's alert of the day (docs/connectors.md)

const parse = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
// A marker ⟦key|{…}⟧ (lib/i18n.mjs) is never cut: cut, it cannot be decoded and the screen showed it raw (2026-11-02, Dev,
// the 390 list of the Flot: « ⟦srv.s.launchedWt|{"cwd":… »); the page clamps the decoded text itself
export const oneLine = (t, n = 140) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); if (s.includes('⟦')) return s; return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
// What waits for the developer himself (Dev, 2026-11-02): a reply, a permission, a review, and a finished session whose
// branch waits for his merge
export const MINE = new Set(['dev', 'permission', 'review', 'merge']);
// The verb of the « À toi » badge (Dev, 2026-11-02: « voir dans le flow les endroits où j'aurais besoin d'intervenir »):
// judge a human stop (a taste stop, a capture), reply, allow, review, merge
export const verbOf = (waitingFor, human = false) => (waitingFor === 'dev' ? (human ? 'judge' : 'reply') : waitingFor === 'permission' ? 'allow' : waitingFor === 'review' ? 'review' : waitingFor === 'merge' ? 'merge' : null);
// What a plan's end node says (docs/flot.md « L'issue d'une phase »): the plan's `next` field, else the project's next
// plan by date, else nothing
export const NEXT_KINDS = ['judge', 'qa', 'none'];

// A branch already in its base branch is merged, whatever the row says (2026-11-02: 23 done sessions of Orchard said
// « attend ta relecture » when other merges had carried their work). `git merge-base --is-ancestor`, local, no network;
// cached: a true answer is final, a false one is asked again after ANCESTOR_TTL_MS. `isAncestor` is replaceable (tests).
export const ANCESTOR_TTL_MS = 60e3;
const ancestors = new Map(); // "root|branch|base" → { at, yes }
export const gitIsAncestor = (root, branch, base) => { try { execFileSync('git', ['merge-base', '--is-ancestor', branch, base], { cwd: root, stdio: 'ignore', timeout: 4000 }); return true; } catch { return false; } };
// The commit a branch points at, read in the repository's files without starting git (docs/perf.md: one synchronous git
// per finished session froze the whole server ~1 s at every opening of the flow, then every minute); null when unsure.
const gitDirOf = (root) => {
  const dot = path.join(root, '.git');
  try { if (statSync(dot).isDirectory()) return dot; const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8')); if (!m) return null; const wtDir = path.resolve(root, m[1].trim()); const common = path.join(wtDir, 'commondir'); return existsSync(common) ? path.resolve(wtDir, readFileSync(common, 'utf8').trim()) : wtDir; } catch { return null; }
};
export const tipOf = (root, branch) => {
  const dir = gitDirOf(root); if (!dir || !branch) return null;
  try { const s = readFileSync(path.join(dir, 'refs', 'heads', branch), 'utf8').trim(); if (/^[0-9a-f]{40,64}$/.test(s)) return s; } catch { /* packed */ }
  try { for (const line of readFileSync(path.join(dir, 'packed-refs'), 'utf8').split('\n')) { const [sha, ref] = line.split(' '); if (ref === 'refs/heads/' + branch && /^[0-9a-f]{40,64}$/.test(sha)) return sha; } } catch {}
  return null;
};
// Every branch already in a base, in one git call per repository and base (not one per session), asked again only when
// the base's tip moved (read in .git), or after ANCESTOR_TTL_MS when the tip cannot be read
const mergedSets = new Map(); // "root|base" → { at, baseTip, merged: Map(branch → tip) }
const mergedInto = (root, base) => {
  const out = execFileSync('git', ['for-each-ref', `--merged=${base}`, '--format=%(objectname) %(refname:short)', 'refs/heads/'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  return new Map(out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return [l.slice(i + 1), l.slice(0, i)]; }));
};
export const inBase = (wt, { isAncestor = gitIsAncestor, now = Date.now() } = {}) => {
  if (!wt || !wt.root || !wt.branch || !wt.base) return false;
  if (isAncestor !== gitIsAncestor) { // a replaced check (tests): one answer per branch, a false one asked again after the TTL
    const key = `${wt.root}|${wt.branch}|${wt.base}`; const c = ancestors.get(key);
    if (c && (c.yes || now - c.at < ANCESTOR_TTL_MS)) return c.yes;
    const yes = !!isAncestor(wt.root, wt.branch, wt.base); ancestors.set(key, { at: now, yes }); return yes;
  }
  const key = `${wt.root}|${wt.base}`; let c = mergedSets.get(key); const baseTip = tipOf(wt.root, wt.base);
  const stale = !c || (baseTip ? c.baseTip !== baseTip : now - c.at >= ANCESTOR_TTL_MS)
    || (c.merged.has(wt.branch) && tipOf(wt.root, wt.branch) && c.merged.get(wt.branch) !== tipOf(wt.root, wt.branch)); // merged, then moved on
  if (stale) { let merged; try { merged = mergedInto(wt.root, wt.base); } catch { merged = new Map(); } c = { at: now, baseTip, merged }; mergedSets.set(key, c); }
  return c.merged.has(wt.branch);
};
export const forgetAncestors = () => { ancestors.clear(); mergedSets.clear(); };

// The status a node shows: merged beats done, an error beats waiting; a session running again shows running (its last
// error is history once a new turn started, 2026-11-02: « en erreur » beside a session that was working)
const statusOf = (row, opts) => {
  if (!row) return 'todo';
  if (row.status === 'done') return !row.worktree || row.worktree.merged || inBase(row.worktree, opts) ? 'merged' : 'done';
  if (row.health === 'error' && row.status !== 'running') return 'error';
  return row.status || 'todo';
};
// A merged session waits for nothing (2026-11-02: the head line said « PX attend ta réponse » for a merged PX, because a
// reply left pending on a merged session still counted). A finished session waits for a review (`reviewed` true) only
// when the project reviews strictly; it waits for the developer's merge (`reviewed` 'merge', Dev 2026-11-02 08:35: « je
// ne vois pas où je fusionne ») when the plan merges by hand and is not a kit (sessions delivered without a merge) and
// is not closed; a plan that merges by itself asks nothing (`reviewed` false). With a pilot present (built-in or
// external), what a pilot can handle waits for the pilot, not the developer (public/todo.js): a reply to an ordinary
// stop, a permission, an ordinary review; a taste, data, security or release stop stays the developer's (`human`), and
// so does a merge: nothing is merged without his click.
// The old waitingFor words, read from nextStep (lib/nextstep.mjs): the developer's gesture names what he does, a pilot's
// line is 'pilot', a session at work or nobody is null
const DEV_WAIT = { allow: 'permission', merge: 'merge', review: 'review', reply: 'dev', judge: 'dev', retry: 'dev' };
export const waitingFromNext = (next) => (!next ? null : next.who === 'pilot' ? 'pilot' : next.who === 'dev' ? DEV_WAIT[next.gesture] || 'dev' : null);
export const waitingForOf = (row, status, reviewed, { pilot = false, human = false } = {}) => {
  if (status === 'merged') return null;
  const pending = row?.pending || [];
  if (pending.some((p) => p.kind === 'permission')) return pilot ? 'pilot' : 'permission';
  if (pending.some((p) => p.kind === 'reply')) return pilot && !human ? 'pilot' : 'dev';
  if (status === 'done') return reviewed === 'merge' ? 'merge' : reviewed ? (pilot ? 'pilot' : 'review') : null;
  // a turn ended with no pending entry still waits for a person: the pilot when one is present, else the developer (6 Nov.:
  // with the pilot off, nine waiting sessions were counted « pour le pilote » and nobody saw them)
  if (row?.status === 'waiting') return pilot ? 'pilot' : 'dev';
  return null;
};
// What a session waiting for the pilot waits on, so « À toi » can show it folded: 'permission', 'review' or 'reply'
export const keptKindOf = (row, status) => ((row?.pending || []).some((p) => p.kind === 'permission') ? 'permission' : status === 'done' ? 'review' : 'reply');
// The pending reply of a row asks the developer himself when its stop is of a human kind (lib/pilot.mjs HUMAN_KINDS)
export const humanOf = (row, stops = []) => { const r = (row?.pending || []).find((p) => p.kind === 'reply'); return !!(r && Number.isInteger(r.stop) && HUMAN_KINDS.includes(stopKind(stops[r.stop]))); };

const reviewLevelOf = (db, project) => { try { const j = parse(db.prepare('select json from project_settings where project = ?').get(project)?.json, {}); return j.review || j.reviewLevel || null; } catch { return null; } };
const ACTIVITY = { running: 3, waiting: 3, error: 3, todo: 1 };

// The status of a plan from its nodes
const planStatusOf = (mine) => (mine.every((n) => n.status === 'merged') ? 'merged' : mine.every((n) => ['merged', 'done'].includes(n.status)) ? 'done' : mine.some((n) => ['running', 'waiting', 'error', 'done', 'merged'].includes(n.status)) ? 'running' : 'todo');
// The end node of a plan (docs/flot.md « L'issue d'une phase »): what happens after it. `next` is the plan's field
// (a plan id, 'judge', 'qa' or 'none'); without it, the project's next plan by date; without one, nothing. With a plan
// to chain, the node waits for the developer's click (« À toi · Lancer ») once everything is merged and the next plan
// has not left; the pilot never launches a plan (nothing starts without his click).
const endOf = (pr, plan, mine, status, after, titleOf) => {
  const id = `${pr.id}/main`; const ready = status === 'merged';
  const open = mine.filter((n) => MINE.has(n.waitingFor)).length;
  const next = typeof plan.next === 'string' && plan.next.trim() ? plan.next.trim() : null;
  const kind = next && NEXT_KINDS.includes(next) ? next : next || after ? 'next' : 'none';
  const base = { id, plan: pr.id, kind, ready, merged: mine.filter((n) => n.status === 'merged').length, total: mine.length, open, waitingFor: null, verb: null, next: null };
  if (kind !== 'next') return base;
  const target = next ? titleOf(next) : after;
  if (!target) return { ...base, kind: 'none' };
  const launchable = ready && target.status === 'todo';
  return { ...base, next: target, waitingFor: launchable ? 'dev' : null, verb: launchable ? 'launch' : null };
};

export const flowOf = (db, project, { all = false, defaultBudget = 5, calibration = null, quota = lastQuota(db), reviewLevel = reviewLevelOf(db, project), pilot = false, mode = 'guide', isAncestor = gitIsAncestor, now = Date.now() } = {}) => {
  const planRows = db.prepare('select id, title, created, json, project from plans where project = ? order by created desc').all(project);
  const plans = []; const nodes = []; const edges = []; const folded = []; const ends = []; const live = []; const retired = [];
  // every plan's status, for the end nodes (a next plan may be folded or not shown)
  const statuses = new Map(); const titles = new Map();
  for (const pr of planRows) { const plan = parse(pr.json, null); if (!plan || !Array.isArray(plan.sessions)) continue; titles.set(pr.id, plan.title || pr.title || pr.id);
    const rows = db.prepare('select id, status, worktree from sessions where plan = ?').all(pr.id).map((r) => ({ ...r, worktree: parse(r.worktree) }));
    const st = plan.sessions.map((s) => statusOf(rows.find((r) => r.id === s.id), { isAncestor }));
    statuses.set(pr.id, st.length ? planStatusOf(st.map((status) => ({ status }))) : 'todo'); }
  const titleOf = (id) => (titles.has(id) ? { id, title: titles.get(id), status: statuses.get(id) } : null);
  for (const [i, pr] of planRows.entries()) {
    const plan = parse(pr.json, null); if (!plan || !Array.isArray(plan.sessions)) continue;
    const after = i > 0 ? titleOf(planRows[i - 1].id) : null; // the plans come newest first: the next by date is the one before
    const rows = Object.fromEntries(db.prepare('select * from sessions where plan = ?').all(pr.id).map((r) => [r.id, { ...r, stops: parse(r.stops, []), worktree: parse(r.worktree), usage: parse(r.usage), pending: parse(r.pending, []), review: parse(r.review) }]));
    const started = Object.fromEntries(db.prepare("select session, min(at) as at from log where plan = ? and status = 'running' group by session").all(pr.id).map((r) => [r.session, r.at]));
    const acts = Object.fromEntries(db.prepare("select session, text, at from session_messages where seq in (select max(seq) from session_messages where plan = ? and role = 'activity' group by session)").all(pr.id).map((r) => [r.session, r]));
    const maxWave = Math.max(1, ...plan.sessions.map((s) => s.wave || 1));
    const planned = plan.sessions.map((s) => ({ ...s, wave: s.wave || 1 }));
    const extra = Object.values(rows).filter((r) => r.id !== 'pilot' && !planned.some((s) => s.id === r.id)).map((r) => ({ id: r.id, name: r.name || r.id, wave: maxWave + 1, stops: [] }));
    const sessions = [...planned, ...extra];
    const closed = isRetired(plan);
    const kit = plan.kit || plan.delivery === 'kit';
    // true: a strict review; 'merge': the developer's merge; false: nothing (a kit, a closed plan, a plan that merges alone)
    const reviewed = reviewLevel === 'strict' ? true : !plan.autoMerge && !kit && !closed ? 'merge' : false;
    const mine = sessions.map((s) => {
      const row = rows[s.id]; const status = statusOf(row, { isAncestor }); const usage = row?.usage || null; const act = acts[s.id]; const human = humanOf(row, s.stops || []);
      // What it does now: while it runs, its last activity when newer than its last state block; else the state block's line
      const now = status === 'running' && act && (!row?.at || act.at > row.at) ? act.text : row?.claude || act?.text || '';
      const stopsTotal = (s.stops || []).length;
      // ATOI (Dev, 7 Nov. 02:00, « 6 t'attend » where almost nothing was his): who waits is nextStep's word alone; every
      // designation of the developer (« t'attend », « Attend ta réponse », « À toi », tab, push) reads waitingFor from it
      const next = nextStep({ ...(row || {}), id: s.id, plan: pr.id, merged: status === 'merged', stops: s.stops || [], delivery: kit ? 'kit' : plan.delivery, autoMerge: plan.autoMerge, closed }, { id: project, pilotOn: pilot, pilotPresent: pilot, mode });
      // a strict project's finished session waits for a review nextStep does not know (the review level): kept as before
      const waitingFor = row && !(reviewed === true && status === 'done') ? waitingFromNext(next) : waitingForOf(row, status, reviewed, { pilot, human });
      if (row?.worktree?.path && status !== 'merged' && !row.worktree.merged) live.push({ plan: pr.id, session: s.id, path: row.worktree.path });
      return {
        id: `${pr.id}/${s.id}`, plan: pr.id, session: s.id, name: s.name || row?.name || s.id, model: s.model || plan.model || null, kind: kindOf(s),
        status, wave: s.wave, cost: round(usage?.cost || 0), budget: Number.isFinite(s.budget) && s.budget > 0 ? s.budget : defaultBudget,
        contextPct: Number.isFinite(usage?.context) ? usage.context : null, startedAt: started[s.id] || null,
        now: oneLine(now), waitingFor, verb: verbOf(waitingFor, human), human, kept: waitingFor === 'pilot' ? keptKindOf(row, status) : null,
        stopsDone: new Set((row?.stops || []).filter((i) => Number.isInteger(i) && i >= 0 && (!stopsTotal || i < stopsTotal))).size, stopsTotal,
        stops: s.stops || [], summary: row?.summary || null, health: row?.health || 'ok', after: [], eta: null,
        // FIAB 8: who acts, said once by lib/nextstep.mjs; « À toi » and the Review read it, never compute it again
        next,
      };
    });
    // A finished plan (every session done or merged) folds into one line, out of the canvas, the totals and the sentence;
    // not while its end node waits for the developer's click on the next plan: the Flot must say where he is awaited
    // A retired plan (lib/retire.mjs, closed by hand too) leaves the canvas, the totals and the sentence for « Retirés »
    if (closed) { retired.push({ id: pr.id, title: plan.title || pr.title || pr.id, sessions: mine.length, cost: round(mine.reduce((a, n) => a + n.cost, 0), 2), closedAt: plan.closedAt || null, closedWhy: plan.closedWhy || '' }); continue; }
    const pstatus = planStatusOf(mine);
    const end = endOf(pr, plan, mine, pstatus, after, titleOf);
    if (!all && !end.waitingFor && mine.every((n) => n.status === 'done' || n.status === 'merged')) { folded.push({ id: pr.id, title: plan.title || pr.title || pr.id, sessions: mine.length, cost: round(mine.reduce((a, n) => a + n.cost, 0), 2), merged: mine.filter((n) => n.status === 'merged').length }); continue; }
    ends.push(end);
    // The edges: after, else the whole previous wave; then each session without a successor to the plan's merge into main
    const byS = Object.fromEntries(mine.map((n) => [n.session, n]));
    const waves = [...new Set(sessions.map((s) => s.wave))].sort((a, b) => a - b);
    const mineEdges = [];
    for (const s of sessions) {
      const to = byS[s.id];
      if (s.after && s.after.length) for (const a of s.after) { if (byS[a]) { mineEdges.push({ from: byS[a].id, to: to.id, kind: 'after' }); to.after.push(a); } }
      else { const prev = waves[waves.indexOf(s.wave) - 1]; if (prev !== undefined && s.wave <= maxWave) for (const p of sessions.filter((x) => x.wave === prev)) { mineEdges.push({ from: byS[p.id].id, to: to.id, kind: 'wave' }); to.after.push(p.id); } }
    }
    const sources = new Set(mineEdges.map((e) => e.from));
    for (const n of mine) if (!sources.has(n.id)) mineEdges.push({ from: n.id, to: `${pr.id}/main`, kind: 'merge' });
    const merged = (id) => nodes.concat(mine).find((n) => n.id === id)?.status === 'merged';
    for (const e of mineEdges) edges.push({ ...e, met: merged(e.from) });
    const sum = (k) => round(mine.reduce((a, n) => a + n[k], 0));
    plans.push({ activity: mine.reduce((a, n) => a + (ACTIVITY[n.status] || 0) + (MINE.has(n.waitingFor) ? 2 : 0), 0) + (end.waitingFor ? 2 : 0), id: pr.id, retired: closed, title: plan.title || pr.title || pr.id, status: pstatus, cost: sum('cost'), budget: sum('budget'), main: { merged: mine.filter((n) => n.status === 'merged').length, total: mine.length }, eta: null, end: end.id });
    nodes.push(...mine);
  }
  // The ETAs (lib/eta.mjs): from the project's history, the end of each card and of each plan; null without history
  let history = []; try { history = historyOf(db, project, { now }); } catch {}
  const eta = etaOf({ nodes, edges, history, now });
  for (const n of nodes) n.eta = eta.nodes[n.id] || null;
  for (const p of plans) p.eta = eta.plans[p.id] || null;
  for (const e of ends) e.eta = eta.plans[e.plan] || null;
  const weeklyNow = quota && typeof quota.weekly === 'number' ? quota.weekly : calibration?.weeklyNow ?? null;
  const left = nodes.filter((n) => !['done', 'merged'].includes(n.status)).reduce((a, n) => a + Math.max(0, n.budget - n.cost), 0);
  const perPct = calibration?.calibrated && calibration.dollarsPerPct ? calibration.dollarsPerPct : null;
  // A fix left to apply by hand (docs/correctif-*.md, .escadrille/*.patch) waits for the developer or the pilot (lib/leftfixes.mjs)
  let fixes = []; try { fixes = leftFixesOf({ root: project, worktrees: live }); } catch {}
  const totals = {
    fixes: fixes.length,
    running: nodes.filter((n) => n.status === 'running').length,
    waiting: nodes.filter((n) => n.status === 'waiting' || n.waitingFor === 'review' || n.waitingFor === 'merge').length,
    mine: nodes.filter((n) => MINE.has(n.waitingFor)).length + ends.filter((e) => e.waitingFor).length + fixes.length,
    cost: round(nodes.reduce((a, n) => a + n.cost, 0), 2), budget: round(nodes.reduce((a, n) => a + n.budget, 0), 2),
    weeklyNow, weeklyAfter: weeklyNow != null && perPct ? round(weeklyNow + left / perPct / 100, 4) : null,
  };
  // The most active plan first (running, waiting and what waits for the developer weigh most), then the most recent
  plans.sort((a, b) => b.activity - a.activity);
  const parts = storyParts({ plans, nodes, edges, ends, fixes });
  // The Linear sync's alert of the day (lib/linearsync.mjs), for « À toi »; null without one
  return { project, plans, nodes, edges, ends, totals, story: sentence(parts.slice(0, 2), plans, ' · '), storyFull: sentence(parts, plans), fixes, folded, retired, finished: folded.length, linear: linearAlertOf(db, project, new Date(now)) };
};

// ---------------------------------------------------------------- the sentence (docs/projectflow.md, « La ligne de récit »)
const andList = (a) => (a.length < 2 ? a.join('') : msg('srv.f.and', { a: a.slice(0, -1).join(', '), b: a[a.length - 1] }));
const shortTitle = (t) => { const s = String(t || '').split(/\s*[:—–,(·]\s*/)[0].trim(); const w = s.split(/\s+/); return w.length > 3 ? w.slice(0, 2).join(' ') : s; };
// A group: "A code", "A et C codent", "12 sessions codent"
// A group of sessions [{ s, plan }]: "A code", "A et C codent", "12 sessions codent"; with several plans on the canvas
// the letters are grouped by plan, each run followed by the plan's short title: "C (R02) et E (Finition UI) attendent"
const group = (items, one, many, titles, qualify) => {
  if (items.length > 4) return msg('srv.f.many', { n: items.length, verb: msg(many) });
  const verb = msg(items.length > 1 ? many : one);
  if (!qualify) return msg('srv.f.group', { who: andList(items.map((x) => x.s)), verb });
  const runs = []; for (const x of items) { const r = runs.find((y) => y.plan === x.plan); if (r) r.s.push(x.s); else runs.push({ plan: x.plan, s: [x.s] }); }
  return msg('srv.f.group', { who: runs.length > 1 ? andList(runs.map((r) => `${r.s.join(', ')} (${titles[r.plan]})`)) : `${andList(runs[0].s)} (${titles[runs[0].plan]})`, verb });
};

// The groups of the sentence, most urgent first
export const storyParts = ({ plans, nodes, edges, ends = [], fixes = [] }) => {
  const titles = Object.fromEntries(plans.map((p) => [p.id, shortTitle(p.title)]));
  const live = nodes.filter((n) => n.status !== 'merged');
  // letters carry their plan only when the sessions the sentence can name (not those still to launch) span several plans
  const qualify = new Set(live.filter((n) => n.status !== 'todo' && n.status !== 'later').map((n) => n.plan)).size > 1;
  const label = (n) => (qualify ? `${n.session} (${titles[n.plan]})` : n.session);
  const said = new Set(); // each session is told once, in the first group that holds it
  const pick = (f) => nodes.filter((n) => !said.has(n.id) && f(n)).map((n) => { said.add(n.id); return { s: n.session, plan: n.plan }; });
  const parts = [];
  const add = (labels, one, many) => { if (labels.length) parts.push(group(labels, one, many, titles, qualify)); };
  add(pick((n) => n.waitingFor === 'dev'), 'srv.f.dev1', 'srv.f.devN');
  add(pick((n) => n.waitingFor === 'permission'), 'srv.f.perm1', 'srv.f.permN');
  add(pick((n) => n.status === 'error'), 'srv.f.err1', 'srv.f.errN');
  add(pick((n) => n.waitingFor === 'review'), 'srv.f.rev1', 'srv.f.revN');
  add(pick((n) => n.waitingFor === 'merge'), 'srv.f.merge1', 'srv.f.mergeN');
  // a fix left to apply by hand: what it fixes does not work until it is applied (lib/leftfixes.mjs)
  if (fixes.length) parts.push(msg(fixes.length === 1 ? 'srv.f.fix1' : 'srv.f.fixN', { n: fixes.length }));
  // a plan merged whole whose next plan waits for the developer's click (the end node says it too)
  for (const e of ends) if (e.waitingFor && e.next) parts.push(msg('srv.f.click', { title: shortTitle(e.next.title) }));
  add(pick((n) => n.status === 'running'), 'srv.f.run1', 'srv.f.runN');
  add(pick((n) => n.waitingFor === 'pilot' && n.status !== 'error'), 'srv.f.pilot1', 'srv.f.pilotN');
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const later = nodes.filter((n) => n.status === 'later' && !said.has(n.id)).map((n) => ({ n, unmet: edges.filter((e) => e.to === n.id && e.kind !== 'merge' && byId[e.from]?.status !== 'merged').map((e) => byId[e.from].session) }))
    .filter((x) => x.unmet.length).sort((a, b) => a.n.wave - b.n.wave);
  if (later.length) {
    const { n, unmet } = later[0];
    const after = msg('srv.f.after', { who: label(n), list: andList(unmet) });
    parts.push(later.length > 1 ? msg('srv.f.then', { s: after, n: later.length - 1 }) : after);
  }
  const todo = nodes.filter((n) => n.status === 'todo').length;
  if (todo) parts.push(msg('srv.f.todo', { n: todo }));
  return parts;
};
// every group starts with a session letter or a count: nothing to capitalise
const sentence = (parts, plans, sep = ', ') => (!parts.length ? msg(plans.length ? 'srv.f.allMerged' : 'srv.f.nothing') : msg('srv.f.sentence', { s: parts.join(sep) }));
// The whole sentence; the head of the screen shows its first two groups (story), the rest on a click (storyFull)
export const storyOf = (flow, { max = Infinity, sep = ', ' } = {}) => sentence(storyParts(flow).slice(0, max), flow.plans, sep);
