// Who has to act on a session, and with which button (docs/nextstep.md). The one source (Dev, 6 November 22:35): « À toi »,
// the Review, the Flot, the pilot's wake and the push read nextStep and never compute it again. Pure, no server, no git.
//   nextStep(session, project, { now }) → { who, gesture, button, link, why }
//   cranOf({ pilotOn, mode, cran }) → 'moi' | 'pilote' | 'autonome'   (the old stored settings, converted)
//   storedOf(cran) → { pilotOn, mode }                                  (what writing a cran writes)
//   humanKinds(cran) → the stop kinds that stay the developer's
//   stalled(session, now) → bool                                        (the dead-end detector, C1)
//   EFFECT[gesture](session) → the session after the gesture            (the test checks that each button unblocks)

export const CRANS = ['moi', 'pilote', 'autonome'];
export const WHO = ['dev', 'pilot', 'session', 'none'];
export const GESTURES = ['allow', 'reply', 'judge', 'merge', 'retry', 'startQa', 'review'];
const STOP_KINDS = ['taste', 'review', 'data', 'security', 'release', 'info'];

// The old pair (pilot switch + autonomy mode) read as one cran; an explicit cran wins
export const cranOf = ({ cran, pilotOn = false, mode = 'surveille' } = {}) => {
  if (CRANS.includes(cran)) return cran;
  if (!pilotOn) return 'moi';
  return mode === 'autonome' ? 'autonome' : 'pilote';
};
export const storedOf = (cran) => ({ moi: { pilotOn: false, mode: 'surveille' }, pilote: { pilotOn: true, mode: 'guide' }, autonome: { pilotOn: true, mode: 'autonome' } })[CRANS.includes(cran) ? cran : 'moi'];

// The stops that wait for the developer whatever the pilot: under Pilote autonome, the pilot judges taste
export const humanKinds = (cran) => (cran === 'autonome' ? ['data', 'security', 'release'] : ['taste', 'data', 'security', 'release']);

export const STALL_MS = 3600e3; export const STALL_REPEATS = 2;
export const stalled = (s = {}, now = Date.now()) => {
  const since = Date.parse(s.waitingSince); if (!Number.isFinite(since)) return false;
  return now - since > STALL_MS && (Number(s.pilotRepeats) || 0) >= STALL_REPEATS;
};

const enc = encodeURIComponent;
const linkOf = (s, project, to) => {
  if (!s.plan) return null;
  const base = `/plan/${enc(s.plan)}${project?.id ? `?project=${enc(project.id)}` : ''}`;
  if (to === 'pending' && s.pendingId) return `${base}#pending-${enc(s.pendingId)}`;
  if (to === 'review') return `${base}#review-${enc(s.id)}`;
  return `${base}#s-${enc(s.id)}`;
};
const stopKindOf = (stop) => (stop && typeof stop === 'object' && STOP_KINDS.includes(stop.kind) ? stop.kind : 'info');

const step = (who, gesture, why, link = null) => ({ who, gesture, button: gesture ? `next.btn.${gesture}` : null, link: gesture ? link : null, why: `next.why.${why}` });

// ATOI (Dev, 7 November 01:45: « des À toi qui ne sont pas des actions que je dois faire »)
// A reply that asks to reread code: a review verb and something that is code (a diff, a branch, a source file)
const REVIEW_VERB = /\b(relire|relis|relisez|relecture|revoir|revois|review|reviewer)\b/i;
const CODE_WORD = /\b(diff|code|branche|branch|commit)\b|\.(m?js|cjs|ts|tsx|jsx|py|go|rs|rb|php|css|html|sql|swift|kt)\b/i;
export const asksCodeReview = (text = '') => REVIEW_VERB.test(String(text)) && CODE_WORD.test(String(text));
// The branch touches a guardrail behind the developer's key or a private trace (server.mjs checkGuarded fills review.guard
// with lib/guardrails.mjs protectedTouched, review.privacy with the private traces): only then is the review his
export const keyedReview = (s = {}) => !!s.review && !s.review.seen && !!((Array.isArray(s.review?.guard) && s.review.guard.length) || s.review?.privacy);
// The session says itself that work is left: « Reste : » with something to do (not the developer's review or merge),
// « pas fait », « pas fini », or stops of its plan still ahead of the one it stopped at
const NOTHING_LEFT = /^(\s*[-—–.]?\s*$|rien|néant|aucun|nothing|none|n\/a)|^\W*(ta |ton |la |une )?(revue|relecture|fusion|merge|validation|avis|réponse|feu vert|accord|décision|choix|qa)\b/i;
export const workLeft = (s = {}, reply = {}) => {
  const said = `${reply.summary || ''}\n${s.summary || ''}`;
  const m = /\breste\s*:\s*([^\n]*)/i.exec(said);
  if (m && !NOTHING_LEFT.test(m[1].trim())) return true;
  if (/\b(n['’]est |ne sont |pas encore )?pas (encore )?(fait|faits|faite|fini|finie|terminé|terminée)\b/i.test(`${reply.text || ''}\n${said}`)) return true;
  const total = Array.isArray(s.stops) ? s.stops.length : 0;
  return Number.isInteger(reply.stop) && total > reply.stop + 1;
};
// What is left for the developer, said as one question with its recommended answer, never « read file X »: the first
// sentence of the session that is a question (its text, then its summary), the recommendation it gave; else the key of
// a question written by Escadrille for the stop's kind (next.ask.<kind>), never the session's instruction
const READ_ORDER = /^\s*(re)?(lis|lire|regarde|ouvre|voir|vois|consulte|read|open|look)\b/i;
const sentences = (t) => String(t || '').replace(/\s+/g, ' ').match(/[^.?!]+[?!.]?/g) || [];
export const askOf = (reply = {}, kind = 'info') => {
  const all = [...sentences(reply.text), ...sentences(reply.summary)].map((x) => x.trim()).filter(Boolean);
  const q = all.find((x) => x.endsWith('?') && !READ_ORDER.test(x) && x.length <= 200) || null;
  const r = /\b(?:recommand[ée]e?s?|recommandation|reco|je recommande|recommended)\s*[:：]?\s*([^.\n?]{2,120})/i.exec(`${reply.text || ''}\n${reply.summary || ''}`);
  const rec = r ? r[1].trim().replace(/^(de |d['’]|:)\s*/i, '') : null;
  return q ? { q, rec, key: null } : { q: null, rec, key: `next.ask.${kind}` };
};

export const nextStep = (session = {}, project = {}, { now = Date.now() } = {}) => {
  const s = session || {};
  const stored = cranOf(project || {});
  // a pilot present (built-in or external) makes Moi read as Pilote: someone can answer
  const cran = stored === 'moi' && project?.pilotPresent ? 'pilote' : stored;
  const piloted = cran !== 'moi';
  const pending = Array.isArray(s.pending) ? s.pending : [];
  const perm = pending.find((p) => p && p.kind === 'permission');
  const reply = pending.find((p) => p && p.kind === 'reply');
  const unmerged = !!s.worktree && !s.worktree.merged && !s.merged;
  const toPilot = (gesture, why, link) => {
    if (!piloted) return step('dev', gesture, why, link);
    if (stalled(s, now)) return step('dev', gesture, 'stalled', link);
    return step('pilot', gesture, why, link);
  };

  // FIAB 7: the QA grouped by project (lib/qa.mjs) is the developer's to start, never the pilot's nor automatic
  if (s.kind === 'projectQa') {
    if (s.status === 'ready') return step('dev', 'startQa', 'qaReady', project?.id ? `/?project=${enc(project.id)}#qa` : '/#qa');
    return s.status === 'running' ? step('session', null, 'running') : step('none', null, 'queued');
  }
  if (s.merged || s.worktree?.merged || s.status === 'merged') return step('none', null, 'merged');
  // ATOI (Dev, 7 Nov. 02:00): a retired plan never waits for anybody, whatever its sessions were doing
  if (s.closed) return step('none', null, 'retired');
  if (!s.status || s.status === 'later' || s.status === 'todo') return step('none', null, 'queued');
  if (s.status === 'paused') return step('none', null, 'paused');
  if (s.status === 'running') return step('session', null, 'running');
  if (perm) {
    const link = linkOf({ ...s, pendingId: perm.id }, project, 'pending');
    if (perm.network || perm.guard || perm.refused) return step('dev', 'allow', perm.network ? 'network' : 'guard', link);
    return toPilot('allow', 'permission', link);
  }
  if (reply) {
    const link = linkOf({ ...s, pendingId: reply.id }, project, 'pending');
    const kind = Number.isInteger(reply.stop) ? stopKindOf((s.stops || [])[reply.stop]) : 'info';
    const gesture = kind === 'taste' ? 'judge' : 'reply';
    const dev = (g, why, l = link) => ({ ...step('dev', g, why, l), ask: askOf(reply, kind) });
    const codeReview = kind === 'review' || asksCodeReview(reply.text);
    // ATOI 2: a session that says work is left does not rise for a review or a taste: taste and review are judged once
    // everything is done (Dev, 7 Nov.); the pilot tells it to go on
    const asked = (o) => (o.who === 'dev' ? { ...o, ask: askOf(reply, kind) } : o);
    if (piloted && (kind === 'taste' || codeReview) && !['data', 'security', 'release'].includes(kind) && workLeft(s, reply)) return asked(toPilot('reply', 'workLeft', link));
    // ATOI 1: rereading code is the pilot's work, unless the branch touches a key-gated guardrail or a private trace:
    // then the developer, with the button that opens the Review
    if (codeReview && !['data', 'security', 'release'].includes(kind)) {
      if (keyedReview(s)) return dev('review', 'keyedReview', linkOf(s, project, 'review'));
      if (piloted) return asked(toPilot('reply', 'codeReview', link));
    }
    if (!piloted || humanKinds(cran).includes(kind)) return dev(gesture, kind === 'info' || kind === 'review' ? 'reply' : kind);
    return asked(toPilot(gesture, kind === 'taste' ? 'taste' : 'reply', link));
  }
  if (s.health === 'error' && s.status !== 'done') return toPilot('retry', 'error', linkOf(s, project, 'thread'));
  const finished = s.status === 'done' || (s.status === 'waiting' && unmerged);
  if (finished) {
    if (s.delivery === 'kit' || s.closed || !s.worktree) return step('none', null, 'nothingToMerge');
    if (s.autoMerge) return step('none', null, 'autoMerge');
    // a merge is never the pilot's, at any cran: nothing is merged without the developer's click (A3)
    return step('dev', 'merge', 'merge', linkOf(s, project, 'review'));
  }
  if (s.status === 'waiting') return toPilot('reply', 'turnEnded', linkOf(s, project, 'thread'));
  return step('none', null, 'unknown');
};

// What a gesture does to the session: the contract each button must keep (test/nextstep.test.mjs)
const resume = (s) => ({ ...s, status: 'running', health: 'ok', pending: [] });
export const EFFECT = {
  allow: resume, reply: resume, judge: resume, retry: resume, startQa: resume,
  // the Review read with the developer's key: the review is seen, the session goes on (server.mjs reviewSeen)
  review: (s) => ({ ...resume(s), review: s.review ? { ...s.review, seen: true } : s.review }),
  merge: (s) => ({ ...s, status: 'done', merged: true, worktree: s.worktree ? { ...s.worktree, merged: true } : s.worktree }),
};
