// What still waits for the developer on the home (« Ce qui t'attend », public/mainchat.js). A planning waiting for an
// answer for more than 12 h is not waiting any more: GET /api/escadrilles marks it stale, the home folds it into one
// line « n anciennes » that shows it on a click. Nothing is deleted; an answer brings it back (its `at` moves).
export const STALE_PLANNING_MS = 12 * 36e5;
export const isStalePlanning = (e, now = Date.now()) => {
  if (!e || e.status !== 'waiting') return false;
  const at = Date.parse(e.at || e.created); return Number.isFinite(at) && now - at > STALE_PLANNING_MS;
};
