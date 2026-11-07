// The logo of a project, found in its folder by the server without any network (Dev, 2026-11-02 04:30): the picker of
// the sidebar shows it, the current dot stays when nothing is found. Looked up in this order, the first file that
// exists wins: public/favicon.*, app/icon.*, assets/icon.*, the icons of a web manifest (public/manifest.json or
// .webmanifest), the icon of an Expo app.json, logo.svg at the root. Only a file under the project's folder is ever
// served, and only an image.
//   findLogo(dir)              → { path, type } or null
//   contentType(file)          → the MIME type of an image file, or null when it is not one
//   logoAnswer({ project, known, find })  → the route's answer: 200 with the logo, else 204 (never a 404)
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXTS = ['.svg', '.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif'];
export const contentType = (file) => TYPES[path.extname(String(file || '')).toLowerCase()] || null;
// The answer of GET /api/projects/logo (server.mjs): 200 and the logo for a known project that has one; 204 otherwise,
// an unknown project too (a worktree the page names, the click robot on 2026-11-04: 36 lines of 404 in the console),
// so the page keeps its initial and its console stays clean. Nothing is ever read outside a known project.
//   logoAnswer({ project, known, find })  → { status: 200, logo } | { status: 204 }
export const logoAnswer = ({ project, known = [], find = (d) => findLogo(d) }) => {
  if (!project || !known.includes(project)) return { status: 204 };
  const logo = find(project);
  return logo ? { status: 200, logo } : { status: 204 };
};
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const inside = (dir, p) => { const rel = path.relative(dir, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const json = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// A path a manifest names, resolved under dir; refused when it leaves dir or is not an image on disk
const resolveIn = (dir, base, src) => {
  if (typeof src !== 'string' || !src.trim() || /^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return null;
  const clean = src.replace(/[?#].*$/, '');
  const p = path.resolve(clean.startsWith('/') ? path.join(dir, 'public') : base, clean.startsWith('/') ? '.' + clean : clean);
  return inside(dir, p) && isFile(p) && contentType(p) ? p : null;
};

export const findLogo = (dir) => {
  if (!dir || !existsSync(dir)) return null;
  const found = (p) => (p ? { path: p, type: contentType(p) } : null);
  for (const stem of ['public/favicon', 'app/icon', 'assets/icon']) for (const ext of EXTS) { const p = path.join(dir, stem + ext); if (isFile(p)) return found(p); }
  for (const m of ['public/manifest.json', 'public/manifest.webmanifest', 'manifest.json', 'manifest.webmanifest']) {
    const mp = path.join(dir, m); if (!isFile(mp)) continue; const j = json(mp); const icons = j && Array.isArray(j.icons) ? j.icons : [];
    for (const i of icons) { const p = resolveIn(dir, path.dirname(mp), i && i.src); if (p) return found(p); }
  }
  const app = path.join(dir, 'app.json'); if (isFile(app)) { const j = json(app); const e = j && (j.expo || j); const p = e && resolveIn(dir, dir, e.icon); if (p) return found(p); }
  const svg = path.join(dir, 'logo.svg'); if (isFile(svg)) return found(svg);
  return null;
};
