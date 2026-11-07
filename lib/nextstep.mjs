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
export const GESTURES = ['allow', 'reply', 'judge', 'merge', 'retry', 'startQa'];
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
    if (!piloted || humanKinds(cran).includes(kind)) return step('dev', gesture, kind === 'info' || kind === 'review' ? 'reply' : kind, link);
    return toPilot(gesture, kind === 'taste' ? 'taste' : 'reply', link);
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
  merge: (s) => ({ ...s, status: 'done', merged: true, worktree: s.worktree ? { ...s.worktree, merged: true } : s.worktree }),
};
