// The Communication screen (public/comm.html): the project's comm/ folder read at every opening, nothing copied.
//   GET /comm                               the page
//   GET /api/comm?project=                  { exists, head, channels, visuals, sources, pdfs, recap }
//   GET /api/comm/file?project=&path=       one file of comm/, refused (403) for any path outside comm/
// The recap (« En deux jours ») is computed, never written: the first commit and the commits of main (git), the phases
// marked done in ROADMAP.md or merged on main, the plans and sessions launched and merged (sessions.sqlite), the
// public-price cost of the project's transcripts since the first commit (lib/usage.mjs, docs/estimation.md), and the
// state of a sale plan, if any (a plan whose id or title speaks of selling): planned, running or merged, never more.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { render, firstTitle } from './markdown.mjs';
import { scanTranscripts, costBetween, repoRoot } from './usage.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mjs': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4' };
const HEAD = ['PUBLIER.md', 'chiffres.md', 'README.md'];
// The channels, in the order they are published (comm/PUBLIER.md); an unknown .md of comm/ comes after them
const CHANNELS = ['article', 'linkedin', 'x', 'hackernews', 'reddit', 'producthunt'];
const NETWORKS = ['linkedin', 'x', 'og'];
const SALE = /vendre|vente|commerciali|\bsell|pricing/i;

// A path of comm/, or null when it leaves comm/ (.., absolute, a symlink pointing out)
export const resolveIn = (dir, rel) => {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  let root; try { root = realpathSync(dir); } catch { return null; }
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) return null;
  let real; try { real = realpathSync(p); } catch { return null; }
  if (!real.startsWith(root + path.sep) || !statSync(real).isFile()) return null;
  return real;
};

const listDir = (d) => { try { return readdirSync(d).filter((f) => !f.startsWith('.')).sort(); } catch { return []; } };
// The first lines of a text: no heading, no table, no blank; the opening paragraph of the post
const excerptOf = (md) => {
  // paragraphs until about 120 characters: a post that opens on its name (« ## Name / Escadrille ») reads on
  const out = []; let len = 0;
  for (const l of String(md).split('\n')) {
    const t = l.trim();
    if (!t || /^(#|\||[-*_]{3,}|```|<)/.test(t)) { if (len >= 120) break; continue; }
    out.push(t.replace(/^[-*+]\s+|^>\s*/, '').replace(/\*\*|`/g, '')); len += t.length;
  }
  return out.reduce((acc, x) => (acc ? acc + (/[.!?:,;]$/.test(acc) ? ' ' : ' · ') : '') + x, '').slice(0, 280);
};
const mdEntry = (dir, f) => { const md = readFileSync(path.join(dir, f), 'utf8'); const box = (x) => (md.match(new RegExp('(^\\s*[-*+]\\s+|\\|\\s*)\\[' + x + '\\]', 'gim')) || []).length; return { file: f, title: firstTitle(md), excerpt: excerptOf(md), html: render(md, { linkMd: 'md' }), chars: md.length, boxes: { left: box(' '), done: box('x') } }; };

export const indexOf = (dir) => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { exists: false, head: [], channels: [], visuals: [], sources: [], pdfs: [], files: 0 };
  const top = listDir(dir).filter((f) => f.endsWith('.md'));
  const head = HEAD.filter((f) => top.includes(f)).map((f) => mdEntry(dir, f));
  const byId = new Map();
  for (const f of top.filter((f) => !HEAD.includes(f))) {
    const m = /^(.+?)(?:\.(fr|en))?\.md$/.exec(f); const id = m[1]; const lang = m[2] || null;
    if (!byId.has(id)) byId.set(id, { id, langs: {} });
    byId.get(id).langs[lang || 'any'] = mdEntry(dir, f);
  }
  const rank = (id) => { const i = CHANNELS.indexOf(id); return i < 0 ? CHANNELS.length : i; };
  const channels = [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  // Visuals: <network>-<lang>[-dark].png, light and dark side by side, grouped by network
  const vdir = path.join(dir, 'visuals'); const groups = new Map();
  for (const f of listDir(vdir).filter((f) => /\.(png|jpe?g)$/i.test(f))) {
    const m = /^([a-z0-9]+)(?:-([a-z]{2}))?(-dark)?\.\w+$/i.exec(f); const net = m ? m[1] : f.replace(/\.\w+$/, ''); const lang = m?.[2] || null;
    if (!groups.has(net)) groups.set(net, { id: net, pairs: [] });
    const g = groups.get(net); let pair = g.pairs.find((p) => p.lang === lang); if (!pair) g.pairs.push(pair = { lang, light: null, dark: null });
    pair[m?.[3] ? 'dark' : 'light'] = 'visuals/' + f;
  }
  const nrank = (id) => { const i = NETWORKS.indexOf(id); return i < 0 ? NETWORKS.length : i; };
  const visuals = [...groups.values()].sort((a, b) => nrank(a.id) - nrank(b.id) || a.id.localeCompare(b.id));
  for (const g of visuals) g.pairs.sort((a, b) => String(b.lang).localeCompare(String(a.lang))); // fr before en
  const sources = [...listDir(path.join(vdir, 'src')).map((f) => 'visuals/src/' + f), ...listDir(vdir).filter((f) => /\.m?js$/.test(f)).map((f) => 'visuals/' + f)];
  const pdfs = listDir(path.join(dir, 'pdf')).filter((f) => f.endsWith('.pdf')).map((f) => ({ file: 'pdf/' + f, lang: /\.(fr|en)\.pdf$/.exec(f)?.[1] || null, bytes: statSync(path.join(dir, 'pdf', f)).size }));
  let files = 0; const walk = (d) => { for (const f of listDir(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files++; } }; walk(dir);
  return { exists: true, head, channels, visuals, sources, pdfs, files };
};

const git = (cwd, args) => new Promise((ok) => execFile('git', args, { cwd, maxBuffer: 16 << 20 }, (e, out) => ok(e ? null : String(out))));
const branchOf = async (repo) => ((await git(repo, ['rev-parse', '--verify', '-q', 'main'])) ? 'main' : (await git(repo, ['rev-parse', '--verify', '-q', 'master'])) ? 'master' : 'HEAD');

// The phase numbers delivered: a « ## Phase N … fait(e) » heading of ROADMAP.md, a « Phase N: » commit or a merged
// branch « …phase-N-… » on the main branch
export const phasesOf = (roadmap, subjects) => {
  const set = new Set();
  for (const m of String(roadmap || '').matchAll(/^#{2,3}\s+Phase\s+(\d+)\b[^\n]*\bfaite?\b/gim)) set.add(+m[1]);
  for (const s of subjects) { const a = /^Phase (\d+)\s*:/i.exec(s); if (a) set.add(+a[1]); const b = /^Merge\b.*\bphase-(\d+)-/i.exec(s); if (b) set.add(+b[1]); }
  return [...set].sort((a, b) => a - b);
};

const LAUNCHED = "(s.session_id is not null or s.worktree is not null or s.status in ('running','waiting','done','paused','stopped','error'))";
export const plansOf = (db, project) => {
  const unknown = { launched: null, merged: null, sessions: null, sessionsMerged: null }; // no base or no plan: unknown, never 0
  if (!db) return unknown;
  if (!db.prepare('select count(*) as n from plans where project in (?, ?)').get(project, repoRoot(project) || project).n) return unknown;
  const rows = db.prepare(`select s.plan, s.worktree, ${LAUNCHED} as launched from sessions s join plans p on p.id = s.plan where p.project in (?, ?)`).all(project, repoRoot(project) || project);
  const merged = (r) => { try { return !!JSON.parse(r.worktree || 'null')?.merged; } catch { return false; } };
  const L = rows.filter((r) => r.launched), M = rows.filter(merged);
  return { launched: new Set(L.map((r) => r.plan)).size, merged: new Set(M.map((r) => r.plan)).size, sessions: L.length, sessionsMerged: M.length };
};

// A plan about selling: its state, never more than what the base says
export const saleOf = (db, project, plansDir) => {
  const cands = [];
  const repo = repoRoot(project) || project; // a worktree is its repository's project
  if (db) for (const p of db.prepare('select id, title, json from plans where project in (?, ?)').all(project, repo)) if (SALE.test(p.id) || SALE.test(p.title || '')) cands.push({ id: p.id, title: p.title });
  if (plansDir) for (const f of listDir(plansDir).filter((f) => f.endsWith('.json') && SALE.test(f))) {
    const id = f.slice(0, -5); if (cands.some((c) => c.id === id)) continue;
    try { const j = JSON.parse(readFileSync(path.join(plansDir, f), 'utf8')); if (!j.project || [project, repo].includes(path.resolve(j.project))) cands.push({ id, title: j.title || id }); } catch {}
  }
  // no plan of this project in the base (a copy without it, a sandbox): the state of the sale is unknown, not « none »
  if (!cands.length) return { state: db && db.prepare('select count(*) as n from plans where project in (?, ?)').get(project, repo).n ? 'none' : 'unknown', onSale: false };
  const c = cands.sort((a, b) => b.id.localeCompare(a.id))[0];
  const rows = db ? db.prepare(`select s.worktree, ${LAUNCHED} as launched from sessions s where s.plan = ?`).all(c.id) : [];
  const launched = rows.filter((r) => r.launched).length; const merged = rows.filter((r) => { try { return !!JSON.parse(r.worktree || 'null')?.merged; } catch { return false; } }).length;
  const state = !launched ? 'planned' : merged && merged === rows.length ? 'merged' : 'running';
  return { state, plan: c.id, title: c.title, onSale: false };
};

export const recapOf = async ({ project, db = null, plansDir = null, sessions = null, now = Date.now() }) => {
  const repo = repoRoot(project) || project; const branch = await branchOf(project); // git runs in the project (a worktree answers for its repository)
  const first = ((await git(project, ['log', '--reverse', '--format=%aI%x09%h%x09%s', branch])) || '').split('\n')[0];
  const [firstAt, firstHash, firstSubject] = first ? first.split('\t') : [null, null, null];
  const count = await git(project, ['rev-list', '--count', branch]);
  const subjects = ((await git(project, ['log', '--format=%s', branch])) || '').split('\n').filter(Boolean);
  let roadmap = null; try { roadmap = readFileSync(path.join(project, 'ROADMAP.md'), 'utf8'); } catch {}
  const phases = phasesOf(roadmap, subjects);
  let cost = null, costSessions = null;
  if (firstAt) {
    try {
      const all = (sessions || scanTranscripts({ db })).filter((s) => s.project && (s.project === project || repoRoot(s.project) === repo));
      // no transcript readable (a sandbox, another machine): the cost is unknown, never 0
      if (all.length) { const c = costBetween(all, Date.parse(firstAt), now); if (c.sessions) { cost = Math.round(c.cost * 100) / 100; costSessions = c.sessions; } }
    } catch {}
  }
  return {
    branch, firstCommit: firstAt ? { at: firstAt, hash: firstHash, subject: firstSubject } : null,
    days: firstAt ? Math.max(1, Math.ceil((now - Date.parse(firstAt)) / 864e5)) : null,
    commits: count == null ? null : +count.trim(), phases, plans: plansOf(db, project), cost, costSessions, sale: saleOf(db, project, plansDir), at: new Date(now).toISOString(),
  };
};

const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

// The route. known(project) says whether the project is one of the developer's (the registry): nothing else is read.
export const route = async (req, res, url, { db, publicDir, plansDir, known = () => true, sessions = null }) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET seulement' });
  if (url.pathname === '/comm') return send(res, 200, readFileSync(path.join(publicDir, 'comm.html')), 'text/html; charset=utf-8');
  const raw = String(url.searchParams.get('project') || '').trim();
  if (!raw || !path.isAbsolute(raw)) return send(res, 400, { error: 'project : un chemin absolu' });
  const project = path.resolve(raw);
  if (!known(project)) return send(res, 404, { error: 'projet inconnu' });
  const dir = path.join(project, 'comm');
  if (url.pathname === '/api/comm') return send(res, 200, { project, ...indexOf(dir), recap: await recapOf({ project, db, plansDir, sessions }) });
  if (url.pathname === '/api/comm/file') {
    const fp = resolveIn(dir, url.searchParams.get('path'));
    if (!fp) return send(res, 403, { error: 'hors de comm/' });
    const ext = path.extname(fp).toLowerCase();
    // A page or a drawing of the project is shown in a sandbox of its own: no script of comm/ runs as the app
    const sandbox = ext === '.html' || ext === '.svg' ? { 'content-security-policy': 'sandbox' } : {};
    return send(res, 200, readFileSync(fp), MIME[ext] || 'application/octet-stream', { ...sandbox, 'x-content-type-options': 'nosniff' });
  }
  return send(res, 404, { error: 'not found' });
};
