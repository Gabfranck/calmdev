// PIL (Dev, 3 November 17:35): the pilot's watchdog. FIX (Harbor) waited 16 minutes for a read-only permission while the
// pilot was on and idle; earlier the pilot stayed mute 20 minutes after its daily cap. A request is never left mute:
//   every TICK_MS the server lists, per project, what waits for an answer (a permission, a stop for the pilot, a message of
//   Dev) — in every plan of the project, not the 12 latest — and tick() decides:
//   - the pilot on, idle, able to wake, a request older than STALE_MS that no wake carried: one wake with the missed keys
//     (force: the cursor's seen no longer hides them), at most one wake per GAP_MS per project;
//   - a request already carried by a forced wake and still unanswered BUSY_MS later, the pilot busy BUSY_MS without a word,
//     or the pilot unable to wake (daily cap, error): « À toi » and the phone, with the reason in one line, once per request;
//   - the daily cap: one warning per day; once lifted, the requests that came meanwhile are carried by the next tick.
// No model, no timer of its own in tests: start() takes setInterval, tick() takes the clock.
import { isRetired } from './retire.mjs';

export const TICK_MS = 30000, STALE_MS = 60000, BUSY_MS = 300000, GAP_MS = 60000, AGE_SHOWN_MS = 120000, RETRY_MS = 180000;

// (4, the night of 3 November) the policy on, a permission the local rule marks allow is answered by the server at once, on
// every tick too (a permission from before a restart, or before the policy was switched on): no wake, no model turn. A refusal
// stays with the pilot. decide: lib/pilotpolicy.mjs decidePolicy. → the requests to allow, with the decision
export const policyAllows = ({ on = false, requests = [], decide }) => (on ? requests.filter((r) => r.kind === 'permission' && r.suggest?.allow === true).map((r) => ({ r, d: decide({ on, suggest: r.suggest, ask: r }) })).filter((x) => x.d.answer === 'allow') : []);

export const reasonOf = (why) => {
  if (why === 'relancé') return 'le pilote ne répondait plus : relancé';
  if (why === 'plafond du jour') return 'le pilote a atteint son plafond';
  if (why === 'muet') return 'le pilote ne répond plus';
  if (why === 'sans réponse') return "le pilote n'a pas répondu";
  return `le pilote ne peut pas se réveiller (${why || 'erreur'})`;
};

const ageOf = (r, t) => t - (Date.parse(r.at) || t);
// The age of the oldest request without an answer, and the line the Flot shows past AGE_SHOWN_MS (else null)
export const oldestAge = (requests = [], t = Date.now()) => requests.reduce((m, r) => Math.max(m, ageOf(r, t)), 0);
export const ageLine = (ms) => (ms > AGE_SHOWN_MS ? `Plus vieille demande sans réponse : ${Math.floor(ms / 60000)} min` : null);

// What waits for the pilot in a project, over ALL its plans (pilotCollect read the 12 latest only: on Harbor, a plan launched
// before twelve others had its permissions never carried). plans: [{ id, sessions: [{ id, stops }] }]; rowsOf(id) → [{ id,
// pending: [{ id, kind, stop, text, at }] }]; stopKindOf(stop) → kind. → [{ key, plan, session, pendingId, kind, stopKind, at, text }]
// A retired plan waits for nobody (7 November: the QA of a plan closed the day before showed « Plus vieille demande sans
// réponse : 1494 min »), as « À toi » already reads it (lib/retire.mjs).
export const requestsOf = ({ plans = [], rowsOf, stopKindOf = () => 'info' }) => {
  const out = [];
  for (const plan of plans) if (!isRetired(plan)) for (const r of rowsOf(plan.id) || []) for (const e of r.pending || []) {
    if (!['reply', 'permission', 'review'].includes(e.kind)) continue;
    const s = plan.sessions?.find((x) => x.id === r.id);
    out.push({ key: `pend:${plan.id}/${r.id}/${e.id}`, plan: plan.id, session: r.id, pendingId: e.id, kind: e.kind, stopKind: Number.isInteger(e.stop) ? stopKindOf(s?.stops?.[e.stop]) : 'info', at: e.at, text: e.text, ...(e.kind === 'permission' ? { id: e.id, tool: e.tool, input: e.input, network: e.network, suggest: e.suggest } : {}) });
  }
  return out;
};

// list(project) → [{ key, at, kind, plan, session, text }]; state(project) → { on, busy, busySince, lastWord, canWake: { ok, why },
// seen: [] }; wake(project, keys); escalate(project, requests, reason); warn(project, reason) once per cap and day
export const createWatchdog = ({ projects, list, state, wake, escalate, restart = () => {}, warn = () => {}, now = Date.now, day = () => new Date(now()).toISOString().slice(0, 10), staleMs = STALE_MS, busyMs = BUSY_MS, gapMs = GAP_MS, retryMs = RETRY_MS }) => {
  const mem = new Map(); // project → { lastWake, forced: Map(key → at), told: Set(key), warned: day, fruitless }
  const of = (p) => { if (!mem.has(p)) mem.set(p, { lastWake: -Infinity, forced: new Map(), told: new Set(), warned: null, fruitless: 0 }); return mem.get(p); };
  const tell = (project, m, reqs, why) => { const fresh = reqs.filter((r) => !m.told.has(r.key)); if (!fresh.length) return 0; for (const r of fresh) m.told.add(r.key); escalate(project, fresh, reasonOf(why)); return fresh.length; };
  const tickOne = (project) => {
    const st = state(project) || {}; const m = of(project); const t = now();
    if (!st.on) return { project, did: 'éteint' };
    const reqs = list(project) || []; const keys = new Set(reqs.map((r) => r.key));
    for (const k of m.told) if (!keys.has(k)) m.told.delete(k); // answered: a new request with that key may be told again
    for (const k of m.forced.keys()) if (!keys.has(k)) { m.forced.delete(k); m.fruitless = 0; } // an answer: the wakes had an effect
    const old = reqs.filter((r) => ageOf(r, t) > staleMs);
    if (!st.busy) m.restartedMute = false;
    if (!st.canWake?.ok) {
      const why = st.canWake?.why || 'erreur';
      if (why === 'plafond du jour' && m.warned !== day()) { m.warned = day(); warn(project, reasonOf(why)); }
      return { project, did: 'à toi', told: tell(project, m, old, why) };
    }
    if (st.busy) {
      const quiet = t - (Date.parse(st.lastWord || st.busySince || '') || t);
      if (quiet <= busyMs) return { project, did: 'occupé' };
      if (!m.restartedMute) { m.restartedMute = true; restart(project); } // a hung turn: one restart, then Dev
      return { project, did: 'à toi', told: tell(project, m, old, 'muet') };
    }
    // (5, the night of 3 November) a request no wake saw, past staleMs, or any request past retryMs: a wake; the same key is
    // carried again only retryMs later; two wakes without effect (nothing answered since): the pilot is restarted, and the
    // requests go to « À toi » with the reason
    const seen = new Set(st.seen || []);
    const due = old.filter((r) => !m.told.has(r.key) && (m.forced.has(r.key) ? t - m.forced.get(r.key) > retryMs : !seen.has(r.key) || ageOf(r, t) > retryMs));
    if (!due.length) return { project, did: 'rien' };
    if (t - m.lastWake < gapMs) return { project, did: 'attend' };
    m.lastWake = t;
    if (m.fruitless >= 2) { m.fruitless = 0; m.forced.clear(); restart(project); return { project, did: 'relance', told: tell(project, m, due, 'relancé') }; }
    m.fruitless++; for (const r of due) m.forced.set(r.key, t);
    wake(project, due.map((r) => r.key));
    return { project, did: 'réveil', keys: due.map((r) => r.key) };
  };
  return {
    tick: () => (projects() || []).map(tickOne),
    start: (every = setInterval, ms = TICK_MS) => { const h = every(() => { try { (projects() || []).forEach(tickOne); } catch (e) { console.error('pilotwatch', e); } }, ms); h?.unref?.(); return h; },
    forget: (project) => mem.delete(project),
  };
};
