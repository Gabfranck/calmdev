// Who has to act (Dev, 2026-11-02 04:45, the product's rule): the developer never sees a notice by mistake. A
// notification, a badge, a count « Ce qui m'attend » or a line « attend ta réponse » is born only for a gesture he alone
// can make: validate an image or a taste stop, give his key for a guard, answer a planner's question,
// launch a proposed plan. Everything a pilot can handle (the built-in one, docs/pilot.md, or an external one that
// declared itself with POST /api/pilot { external: true }) goes to the pilot, in silence. One function, used by the
// home's « À toi » list (mainchat.js), the plan page's notifications and tab title (plan.html), the Flot's line and count
// (lib/projectflow.mjs through the server) and the phone's push (server.mjs pushNotice).
//   needsDev({ kind, pilot, human, guard, design })  true when the developer himself has to see it
//   items({ nodes, ends, perms, escs, reviews, proposals, pilot })  the « À toi » lines, written by Escadrille
// Loaded by the pages after i18n.js; required by lib/todo.mjs for the server and the tests.
(function (root) {
  // what a pilot handles: a reply to an ordinary stop, a permission, an ordinary review, a wait (tests, a turn ended)
  const PILOT_KINDS = ['reply', 'permission', 'review', 'waiting', 'tests'];
  const needsDev = ({ kind, pilot = false, human = false, guard = false, design = false } = {}) => {
    if (human || guard || design) return true;
    if (!PILOT_KINDS.includes(String(kind || ''))) return true;
    return !pilot;
  };

  // The lines of « À toi »: each is { kind, s, plan, title, why (an i18n key and its vars), act }, never a session's own
  // words (a session's text reaches the developer only in its thread, on a click). The page writes them with T().
  //   nodes: lib/projectflow.mjs nodes (waitingFor, human, plan, session); perms: 'plan/session' → the permission asked
  //   escs: the plannings (status, stale, title, id); reviews: /api/reviews rows (id, guard, additions, deletions)
  //   proposals: the cards still proposed in the thread [{ seq, title }]
  //   team: the collisions of GET /api/team (docs/team.md), only the developer can talk to a colleague: one line each
  //   linear: the day's alert of the Linear sync ({ at, text }, lib/linearsync.mjs through the Flot): the key or a ticket to fix
  //   fixes: the fixes left to apply by hand (lib/leftfixes.mjs through the Flot): one line each, the developer's or the pilot's
  //   to apply or hand over, never hidden by a pilot (Dev, 2026-11-03 19:45: a button that does not work is never shown)
  //   withKept: also the lines a present pilot keeps, marked `kept: true` (the home folds them in one line « n gardés pour
  //   le pilote », Dev 6 Nov.: what waits must stay visible); without it they are left out, as before
  const items = ({ nodes = [], ends = [], perms = {}, escs = [], reviews = [], proposals = [], pilot = false, team = [], linear = null, fixes = [], qa = null, withKept = false } = {}) => {
    const all = [];
    const out = { push: (it) => all.push(it) };
    const keep = (it) => all.push({ ...it, kept: true });
    // FIAB 7: the QA grouped by project, when nextStep (lib/nextstep.mjs, server side) gives it to the developer
    if (qa && qa.next && qa.next.who === 'dev' && qa.next.gesture === 'startQa') out.push({ kind: 'qa', plans: (qa.plans || []).length, act: 'startQa' });
    // FIAB 8: who acts on a session is nextStep's word (n.next, computed by the server): « à toi » when it says dev,
    // « pour le pilote » when it says pilot, nothing else; the old waitingFor reading stays for a node without it
    const byNext = new Map(nodes.filter((n) => n && n.next).map((n) => [n.plan + '/' + n.session, n.next]));
    const GESTURE_KIND = { allow: 'permission', reply: 'reply', judge: 'design', retry: 'reply', merge: 'merge' };
    const guarded = new Set(reviews.filter((r) => r && r.guard && (Array.isArray(r.guard) ? r.guard.length : r.guard)).map((r) => (r.plan || '') + '/' + (r.session || '')));
    nodes = nodes.filter((n) => {
      const nx = n && n.next; if (!nx) return true;
      if (nx.who !== 'dev' && nx.who !== 'pilot') return false;
      // ATOI: a review behind the developer's key opens the Review; its guard line from `reviews` says it once
      if (nx.gesture === 'review') { if (!guarded.has(n.plan + '/' + n.session)) out.push({ kind: 'guard', s: n.session, plan: n.plan, link: nx.link || null, act: 'review' }); return false; }
      const kind = GESTURE_KIND[nx.gesture]; if (!kind) return false;
      const p = kind === 'permission' ? perms[n.plan + '/' + n.session] || null : null;
      const it = { kind, s: n.session, plan: n.plan, act: kind === 'permission' ? (p && nx.who === 'dev' ? 'allow' : 'open') : kind === 'merge' ? 'merge' : kind === 'design' || kind === 'reply' ? 'reply' : 'open', ...(kind === 'permission' ? { perm: p && nx.who === 'dev' ? { id: p.id, tool: p.tool || null, network: p.network ? (Array.isArray(p.network) ? p.network.join(', ') : String(p.network)) : null } : null } : {}), ...(nx.ask ? { ask: nx.ask } : {}) };
      (nx.who === 'dev' ? out.push : keep)(it); return false;
    });
    for (const f of fixes) if (f && f.file) out.push({ kind: 'fix', s: f.session || null, plan: f.plan || null, file: String(f.file), title: String(f.title || ''), act: 'open' });
    if (linear && linear.at) out.push({ kind: 'linear', at: linear.at, text: String(linear.text || ''), act: 'open' });
    for (const c of team) if (c && c.member && c.ours) out.push({ kind: 'team', s: c.ours.id, plan: c.ours.plan, member: c.member, file: c.file, title: (c.theirs && c.theirs.title) || '', files: c.files || [], act: 'open' });
    for (const n of nodes) {
      if (n.waitingFor === 'dev' && n.human) out.push({ kind: 'design', s: n.session, plan: n.plan, act: 'reply' });
      else if (n.waitingFor === 'dev') (needsDev({ kind: 'reply', pilot }) ? out.push : keep)({ kind: 'reply', s: n.session, plan: n.plan, act: 'reply' });
      else if (n.waitingFor === 'permission') { const p = perms[n.plan + '/' + n.session] || null; (needsDev({ kind: 'permission', pilot }) ? out.push : keep)({ kind: 'permission', s: n.session, plan: n.plan, act: p ? 'allow' : 'open', perm: p ? { id: p.id, tool: p.tool || null, network: p.network ? (Array.isArray(p.network) ? p.network.join(', ') : String(p.network)) : null } : null }); }
      // what the server already gave to the pilot (lib/projectflow.mjs `kept`); a kept review comes from `reviews` below
      else if (n.waitingFor === 'pilot' && n.status !== 'error' && n.kept !== 'review') keep({ kind: n.kept === 'permission' ? 'permission' : 'reply', s: n.session, plan: n.plan, act: 'open', perm: null });
      // a finished branch waits for the developer's merge: his alone, a pilot never merges for him (Dev, 2026-11-02)
      else if (n.waitingFor === 'merge') out.push({ kind: 'merge', s: n.session, plan: n.plan, act: 'merge' });
    }
    // a plan merged whole whose next plan waits for the click (lib/projectflow.mjs ends): nothing starts without it
    for (const e of ends) if (e.waitingFor && e.next) out.push({ kind: 'launch', plan: e.plan, next: e.next, act: 'launch' });
    for (const r of reviews) {
      const guard = !!(r.guard && (Array.isArray(r.guard) ? r.guard.length : r.guard));
      const nx = r.next || byNext.get((r.plan || '') + '/' + (r.session || ''));
      if (guard) out.push({ kind: 'guard', s: r.session || null, plan: r.plan || null, id: r.id, act: 'review' });
      else ((nx ? nx.who === 'dev' : needsDev({ kind: 'review', pilot })) ? out.push : keep)({ kind: 'review', s: r.session || null, plan: r.plan || null, id: r.id, act: 'review', minutes: Math.round(((r.additions || 0) + (r.deletions || 0)) / 400 * 60) });
    }
    for (const e of escs) if (e.status === 'waiting' && !e.stale) out.push({ kind: 'planning', id: e.id, title: e.title || e.id, act: 'open' });
    for (const p of proposals) out.push({ kind: 'proposal', seq: p.seq, title: p.title || '', act: 'goto' });
    if (!withKept) return all.filter((it) => !it.kept);
    // a session kept by the pilot counts once (its node and its review never both)
    const seen = new Set();
    return all.filter((it) => { if (!it.kept || !it.s) return true; const k = it.plan + '/' + it.s; if (seen.has(k)) return false; seen.add(k); return true; });
  };

  const api = { needsDev, items, PILOT_KINDS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.escadrilleTodo = api;
})(typeof window !== 'undefined' ? window : globalThis);
