// The horizon of the weekly quota (docs/burst.md, « L'horizon »): how much is left until the next reset, in
// points and in dollars. The quota is the account's: the newest reading wins, whatever the project.
//   weeklyNow(db)                          { weekly, resetsAt, at } the newest rate_limit_event read, planners and sessions
//   horizonOf({ db, project, calibration, now })
//                                          { usedPct, resetsAt, remainingPct, remainingUsd, hoursLeft, source }

// A reading taken before the last reset says last week's share (Dev, 2026-11-02: the Flot said 74 % while the account
// was at 26 %): the weekly window restarts every seven days at the reset hour, so the last reset is the newest reset
// date read, moved back by whole weeks to the latest one already past; a reading older than it is dropped.
const WEEK_MS = 7 * 24 * 3600 * 1000;
export const lastResetBefore = (resetsAt, now = Date.now()) => {
  const t = Date.parse(resetsAt); if (!Number.isFinite(t)) return null;
  return t <= now ? t + Math.floor((now - t) / WEEK_MS) * WEEK_MS : t - Math.ceil((t - now) / WEEK_MS) * WEEK_MS;
};
export const weeklyNow = (db, now = Date.now()) => {
  let best = null; let reset = null;
  try {
    const r = db.prepare('select reset_at from escadrilles where reset_at is not null order by at desc limit 1').get();
    if (r) reset = lastResetBefore(r.reset_at, now);
  } catch {}
  const fresh = (at) => reset == null || !at || Date.parse(at) >= reset;
  try {
    const r = db.prepare('select weekly, reset_at, at from escadrilles where weekly is not null order by at desc limit 1').get();
    if (r && fresh(r.at)) best = { weekly: r.weekly, resetsAt: r.reset_at || null, at: r.at };
  } catch {}
  // A session's quota event carries the share only: it refreshes the share, the reset stays the planner's
  try {
    const rows = db.prepare("select usage, at from sessions where usage like '%\"weekly\":%' order by at desc limit 20").all();
    for (const row of rows) {
      const w = JSON.parse(row.usage)?.weekly;
      if (typeof w === 'number' && (!best || row.at > best.at)) { if (fresh(row.at)) best = { weekly: w, resetsAt: best?.resetsAt ?? null, at: row.at }; break; }
    }
  } catch {}
  // a session carries the share only: the reset is the next one after the last known (a week later)
  if (best && !best.resetsAt && reset != null) best.resetsAt = new Date(reset + WEEK_MS).toISOString();
  return best;
};

export const horizonOf = ({ db, project = null, calibration = null, now = Date.now() } = {}) => {
  const q = weeklyNow(db, now);
  if (!q) return { project, usedPct: null, resetsAt: null, remainingPct: null, remainingUsd: null, hoursLeft: null, source: 'none' };
  const usedPct = Math.round(q.weekly * 1000) / 10;
  const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);
  // the window restarts every seven days: a reset already past moves forward by whole weeks (the screen never says « in 1 min » days away)
  const read = q.resetsAt ? Date.parse(q.resetsAt) : NaN; const reset = Number.isFinite(read) && read <= now ? read + Math.ceil((now - read + 1) / WEEK_MS) * WEEK_MS : read;
  const hoursLeft = Number.isFinite(reset) ? Math.max(0, Math.round((reset - now) / 36e5 * 10) / 10) : null;
  const perPct = calibration?.dollarsPerPct;
  const ok = typeof perPct === 'number' && perPct > 0;
  return { project, usedPct, resetsAt: Number.isFinite(reset) && reset !== read ? new Date(reset).toISOString() : q.resetsAt, remainingPct, remainingUsd: ok ? Math.round(remainingPct * perPct * 100) / 100 : null, hoursLeft, source: ok ? 'calibration' : 'none' };
};
