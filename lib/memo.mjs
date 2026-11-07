// One answer per state (docs/perf.md, 2026-11-02): the pages of every tab reload the same routes on the same change; the
// first request computes, the others read. An entry is fresh while its signature has not changed and it is younger than
// maxAgeMs; a promise is shared while it runs, so two tabs asking at once start one computation.
import { tipOf } from './projectflow.mjs';

const entries = new Map(); // key -> { sig, at, value }

export const memo = (key, sig, maxAgeMs, compute, now = Date.now()) => {
  const e = entries.get(key);
  if (e && e.sig === sig && now - e.at < maxAgeMs) return e.value;
  const value = compute();
  entries.set(key, { sig, at: now, value });
  // a failed computation is not kept
  if (value && typeof value.then === 'function') value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
  return value;
};
export const forget = (prefix = '') => { for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k); };

// What the review queue of a project depends on, without starting git: the sessions' status and worktree, the tips of
// their branches and bases (read in .git), the reviews, their comments and their files seen. Same stamp, same queue.
export const reviewStamp = (db, project) => {
  const tips = (root, ...refs) => refs.map((r) => tipOf(root, r) || '?').join(',');
  const rows = db.prepare('select s.plan, s.id, s.status, s.worktree from sessions s join plans p on p.id = s.plan where s.worktree is not null and (? is null or p.project = ?) order by s.plan, s.id').all(project, project)
    .map((r) => { let w = null; try { w = JSON.parse(r.worktree); } catch {} return [r.plan, r.id, r.status, r.worktree, w && w.root && !w.merged ? tips(w.root, w.branch, w.base || 'HEAD') : ''].join('|'); });
  let reviews = []; let more = [];
  try {
    reviews = db.prepare('select * from reviews where (? is null or project = ? or project is null) order by id').all(project, project).map((r) => JSON.stringify(r) + (r.repo ? tips(r.repo, r.head, r.base) : ''));
    more = [db.prepare('select count(*) as n, max(id) as m, sum(resolved) as r from review_comments').get(), db.prepare('select count(*) as n, max(at) as m from review_viewed').get()].map((x) => JSON.stringify(x));
  } catch { /* the review tables come with lib/review.mjs */ }
  return [...rows, ...reviews, ...more].join('\n');
};
