// The fixes a session left to apply by hand (Dev, 2026-11-03 19:45: « ne jamais montrer un bouton qui ne marche pas »;
// renaming a project failed because docs/correctif-server-nom-projet.md, left by the session NOM, was never applied).
// A left fix is a file docs/correctif-*.md, or a .patch in .escadrille/ (or one folder below it). It is open until a
// line of its own says it is handled:
//   Statut : appliqué (8eb9924)          Status: applied
//   Statut : confié au pilote            Status: handed to the pilot
// A .patch holds that line in its preamble (before the first `diff`; git apply ignores it). An open fix is a line of
// « À toi » and of the Flot (lib/projectflow.mjs, public/todo.js), and a session that leaves one cannot say itself
// done (server.mjs) until it is applied or handed to the pilot.
//   fixesIn(dir)                      [{ file, title, status }]  every left fix of a folder, status 'open' | 'applied' | 'pilot'
//   openFixesIn(dir)                  the open ones only
//   statusOf(text)                    'open' | 'applied' | 'pilot'
//   leftFixesOf({ root, worktrees })  [{ file, title, plan, session }] the open ones of a project and of its live worktrees
//   fixesRefusal(left)                the text a session that said itself done receives (server.mjs)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR, LEGACY_PROJECT_DIR } from './names.mjs';

const STATUS = /^[\s>*_-]*(?:statut|status)[\s*_]*:[\s*_]*(appliqu[ée]e?|applied|confi[ée]e? au pilote|handed to the pilot)/im;
export const statusOf = (text) => {
  const head = String(text || '').split(/^diff --git /m)[0];
  const m = head.match(STATUS);
  if (!m) return 'open';
  return /pilot/i.test(m[1]) ? 'pilot' : 'applied';
};

const MAX_BYTES = 512 * 1024;
const read = (f) => { try { const st = statSync(f); if (!st.isFile() || st.size > MAX_BYTES) return null; return readFileSync(f, 'utf8'); } catch { return null; } };
const list = (d) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const titleOf = (file, text) => {
  const h = text.match(/^#\s+(.+)$/m) || text.match(/^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.+)$/m);
  return (h ? h[1] : path.basename(file)).trim().slice(0, 120);
};

// The candidate files of a folder, relative to it: docs/correctif-*.md, .escadrille/*.patch, .escadrille/*/*.patch
export const candidatesIn = (dir) => {
  const out = [];
  for (const e of list(path.join(dir, 'docs'))) if (e.isFile() && /^correctif-.+\.md$/i.test(e.name)) out.push(`docs/${e.name}`);
  // .calmdev/, else .escadrille/ in a folder not migrated yet (once migrated, the old name is a link to the same files)
  const name = existsSync(path.join(dir, PROJECT_DIR)) ? PROJECT_DIR : LEGACY_PROJECT_DIR;
  const esc = path.join(dir, name);
  for (const e of list(esc)) {
    if (e.isFile() && e.name.endsWith('.patch')) out.push(`${name}/${e.name}`);
    else if (e.isDirectory()) for (const f of list(path.join(esc, e.name))) if (f.isFile() && f.name.endsWith('.patch')) out.push(`${name}/${e.name}/${f.name}`);
  }
  return out.sort();
};

export const fixesIn = (dir) => {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const file of candidatesIn(dir)) {
    const text = read(path.join(dir, file)); if (text === null) continue;
    out.push({ file, title: titleOf(file, text), status: statusOf(text) });
  }
  return out;
};
export const openFixesIn = (dir) => fixesIn(dir).filter((f) => f.status === 'open');

// What a session that said itself done is told when it left open fixes (server.mjs tellFixes): it stays unfinished
export const fixesRefusal = (left) => `Tu t’es dite finie, mais tu laisses ${left.length === 1 ? 'un correctif' : `${left.length} correctifs`} à appliquer à la main : ${left.map((f) => f.file).join(', ')}. `
  + 'Un bouton qui en dépend ne marche pas tant qu’il n’est pas appliqué. Applique-le, ou, si tu ne peux pas (fichier protégé), '
  + 'écris en tête la ligne « Statut : confié au pilote » et dis-le dans ton arrêt ; une fois appliqué, la ligne devient « Statut : appliqué (<commit>) ». Puis redis-toi finie.';

// root: the project's checkout (what main holds); worktrees: [{ plan, session, path }] of the sessions not merged.
// A file a worktree shares with the root is the root's (the worktree started from main): told once, without a session,
// unless the worktree changed it and it is open there and handled at the root (never: handled wins).
export const leftFixesOf = ({ root = null, worktrees = [] } = {}) => {
  const out = []; const seen = new Set();
  const atRoot = root ? fixesIn(root) : [];
  for (const f of atRoot) { seen.add(f.file); if (f.status === 'open') out.push({ file: f.file, title: f.title, plan: null, session: null }); }
  for (const w of worktrees) {
    if (!w || !w.path) continue;
    for (const f of openFixesIn(w.path)) {
      if (seen.has(f.file)) continue;
      seen.add(f.file);
      out.push({ file: f.file, title: f.title, plan: w.plan || null, session: w.session || null });
    }
  }
  return out;
};
