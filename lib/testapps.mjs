// The test apps of a session stop alone (Dev, 6 November: 72 apps listed, 53 of them left by finished sessions).
// A test app is a server listening on the Mac whose folder is inside a session's worktree (a capture instance, an
// `npm run dev` a session started), or the session's own dev server (lib/running.mjs). It stops, with no setting and no
// button: when its session is merged, when its plan is abandoned (retired) or its worktree removed, one hour after its
// session is done, and at the server's start when no session owns it any more. Nothing outside a project's
// `.claude/worktrees/` is ever touched: the project's own server (the Environnement) and the Mac's other apps stay.
//
//   isTestCwd(cwd, roots)            → the worktree folder (<root>/.claude/worktrees/<name>) the cwd is in, else null
//   ownerOf(cwd, rows)               → the session row whose worktree holds cwd, else null
//   verdict({ app, rows, roots, now }) → null (keep) | 'merged' | 'abandoned' | 'done' | 'orphan'
//   toStop({ apps, rows, roots, now }) → [{ ...app, why }]
//   split(apps)                      → { env: [...], tests: [...] }: the list of the page, the Environnement first
//   rows: [{ plan, id, status, at, retired, worktree: { path, merged } }]; apps: [{ pid, cwd, port?, url?, role? }]
import path from 'node:path';

export const HOUR_MS = 3600000;
export const SWEEP_MS = 300000; // the one-hour rule is checked every 5 minutes

const clean = (p) => String(p || '').replace(/\/+$/, '');
const inside = (cwd, dir) => { const c = clean(cwd); const d = clean(dir); return !!c && !!d && (c === d || c.startsWith(d + '/')); };

export const isTestCwd = (cwd, roots = []) => {
  for (const r of roots) {
    const base = path.join(clean(r), '.claude', 'worktrees'); if (!inside(cwd, base)) continue;
    const name = clean(cwd).slice(base.length + 1).split('/')[0]; if (name) return path.join(base, name);
  }
  return null;
};
export const ownerOf = (cwd, rows = []) => rows.find((r) => r && r.worktree && r.worktree.path && inside(cwd, r.worktree.path)) || null;

export const verdict = ({ app, rows = [], roots = [], now = Date.now(), hourMs = HOUR_MS }) => {
  if (!app) return null;
  const owner = app.plan && app.session ? rows.find((r) => r.plan === app.plan && r.id === app.session) || null : ownerOf(app.cwd, rows);
  if (!owner) return app.plan && app.session ? 'orphan' : isTestCwd(app.cwd, roots) ? 'orphan' : null; // outside a worktree: never ours to stop
  if (owner.worktree && owner.worktree.merged) return 'merged';
  if (owner.retired) return 'abandoned';
  if (owner.status === 'done') { const t = Date.parse(owner.at || ''); return Number.isFinite(t) && now - t >= hourMs ? 'done' : null; }
  return null;
};
export const toStop = ({ apps = [], rows = [], roots = [], now = Date.now(), hourMs = HOUR_MS }) =>
  apps.map((app) => ({ app, why: verdict({ app, rows, roots, now, hourMs }) })).filter((x) => x.why).map(({ app, why }) => ({ ...app, why }));

// The page's list: the Environnement (role 'env': the project's own server, the one `ENV: up` started) shown, every other
// app folded under one line. Both groups come from the same array, so a count never reads an older list.
export const split = (apps = []) => ({ env: apps.filter((a) => a && a.role === 'env'), tests: apps.filter((a) => a && a.role !== 'env') });
