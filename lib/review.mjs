// The review (docs/review.md): one branch against its base in a repository, read like a GitHub pull request.
// A session of a plan (its escadrille/<plan>/<session> branch against the branch its worktree started from), or any
// base...head pair of a known project. The diff comes from `git diff -M base...head`, parsed here without a
// dependency; comments, "viewed" boxes and the verdict live in SQLite. The project setting `review` (strict, guided,
// auto) says when a session may be merged: mergeAllowed() is asked before every merge.
//
//   parseDiff(text)                 → [{ path, oldPath, status, additions, deletions, binary, blob, hunks }]
//   isGenerated(path)               lockfiles, snapshots, build output, *.min.*, *.map
//   reviewId(repo, base, head)      the stable id
//   init(ctx)                       { db, settingsOf, planOf, rowOf, plansOf, sessionMessage, mergeSession, onChange }
//   openReview(q)                   GET /api/review (q: { project, base, head } or { plan, session })
//   reviewById(id), fileOf(id, path), addComment, resolveComment, setViewed, submit, reviewQueue(project)
//   mergeAllowed(project, plan, session) → { allowed, level, why, review }
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { targetOf } from './mergedin.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const LEVELS = ['strict', 'guided', 'auto'];
export const DEFAULT_LEVEL = 'guided';
export const LARGE_LINES = 1500;
// What a review is about (Dev, 09:20, « Le flot du produit »): code (the default, the diff), image (the PNG added or
// modified), doc (the .md), plan (a plans/*.json), stop (the last reply a session stopped on)
export const KINDS = ['code', 'image', 'doc', 'plan', 'stop'];
export const VERDICTS = ['comment', 'approve', 'changes', 'reject', 'retry'];
export const DEFAULT_RETRY_MAX = 2;
const CHANGED = new Set(['added', 'modified', 'renamed']);
const KIND_FILTER = { image: (f) => /\.png$/i.test(f.path), doc: (f) => /\.md$/i.test(f.path), plan: (f) => /(^|\/)plans\/[^/]+\.json$/.test(f.path) };

const runBuf = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60000, maxBuffer: 256e6, encoding: 'buffer' }, (err, out) => (err ? reject(err) : resolve(out))));
const run = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60000, maxBuffer: 256e6 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out)))));
const tryRun = async (cwd, args) => { try { return (await run(cwd, args)).trim(); } catch { return ''; } };
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------------------------------------------

// git quotes a path with unusual characters C-style ("a/caf\303\251.md"): back to UTF-8
export const unquote = (s) => {
  if (!s.startsWith('"')) return s;
  const bytes = []; let i = 1;
  const esc = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\') {
      const c = s[i + 1];
      if (/[0-7]/.test(c)) { bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 4; continue; }
      bytes.push(esc[c] ?? c.charCodeAt(0)); i += 2; continue;
    }
    bytes.push(...Buffer.from(s[i])); i++;
  }
  return Buffer.from(bytes).toString('utf8');
};
const strip = (p, prefix) => (p && p.startsWith(prefix) ? p.slice(prefix.length) : p);
// '--- a/x' or '+++ b/x' (git adds a tab after a name with a space), '/dev/null' for the missing side
const sidePath = (rest, prefix) => { rest = rest.replace(/\t$/, ''); return rest === '/dev/null' ? null : strip(unquote(rest), prefix); };
// 'diff --git a/x b/y': the names, used when no ---/+++ lines follow (binary, pure rename, mode change)
const gitLinePaths = (rest) => {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1); const a = rest.slice(0, end + 1); const b = rest.slice(end + 2);
    return [strip(unquote(a), 'a/'), strip(unquote(b), 'b/')];
  }
  if (rest.endsWith('"')) { const i = rest.indexOf(' "'); return [strip(rest.slice(0, i), 'a/'), strip(unquote(rest.slice(i + 1)), 'b/')]; }
  if ((rest.length - 1) % 2 === 0) { const n = (rest.length - 1) / 2; const a = rest.slice(0, n); const b = rest.slice(n + 1); if (a.slice(2) === b.slice(2)) return [a.slice(2), b.slice(2)]; }
  const i = rest.indexOf(' b/'); return i < 0 ? [rest, rest] : [strip(rest.slice(0, i), 'a/'), rest.slice(i + 3)];
};

export const parseDiff = (text) => {
  const files = []; let f = null; let h = null; let oldNo = 0; let newNo = 0; let remOld = 0; let remNew = 0;
  const lines = String(text || '').split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  const lastLine = () => h?.lines[h.lines.length - 1];
  for (const line of lines) {
    if (h && (remOld > 0 || remNew > 0)) {
      const c = line[0];
      if (c === '+') { h.lines.push({ kind: 'add', old: null, new: newNo++, text: line.slice(1) }); remNew--; f.additions++; continue; }
      if (c === '-') { h.lines.push({ kind: 'del', old: oldNo++, new: null, text: line.slice(1) }); remOld--; f.deletions++; continue; }
      if (c === ' ' || line === '') { h.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) }); remOld--; remNew--; continue; }
      if (c === '\\') { if (lastLine()) lastLine().noEol = true; continue; }
    }
    if (line.startsWith('\\')) { if (lastLine()) lastLine().noEol = true; continue; }
    if (line.startsWith('diff --git ')) {
      const [a, b] = gitLinePaths(line.slice(11));
      f = { path: b, oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: false, blob: null, hunks: [], _a: a, _b: b };
      files.push(f); h = null; continue;
    }
    if (!f) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      oldNo = Number(m[1]); newNo = Number(m[3]); remOld = m[2] === undefined ? 1 : Number(m[2]); remNew = m[4] === undefined ? 1 : Number(m[4]);
      h = { header: line, oldStart: oldNo, oldLines: remOld, newStart: newNo, newLines: remNew, lines: [] }; f.hunks.push(h); continue;
    }
    if (h) continue; // nothing else belongs to a file once its hunks have started
    if (line.startsWith('new file mode')) f.status = 'added';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) { f.status = 'renamed'; f._a = unquote(line.slice(12)); }
    else if (line.startsWith('rename to ')) { f.status = 'renamed'; f._b = unquote(line.slice(10)); }
    else if (line.startsWith('copy to ')) { f.status = 'added'; f._b = unquote(line.slice(8)); }
    else if (line.startsWith('index ')) { const ix = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line); if (ix) f.blob = ix[2]; }
    else if (line.startsWith('Binary files ')) f.binary = true;
    else if (line.startsWith('--- ')) { const p = sidePath(line.slice(4), 'a/'); if (p) f._a = p; }
    else if (line.startsWith('+++ ')) { const p = sidePath(line.slice(4), 'b/'); if (p) f._b = p; }
  }
  return files.map(({ _a, _b, ...x }) => {
    x.path = x.status === 'deleted' ? _a : _b;
    x.oldPath = x.status === 'renamed' ? _a : null;
    if (x.status === 'deleted') x.blob = 'deleted';
    else if (!x.blob || /^0+$/.test(x.blob)) x.blob = `same:${_a}`; // a pure rename keeps its content
    return x;
  });
};

const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|Podfile\.lock|go\.sum|uv\.lock)$/,
  /\.snap$/, /(^|\/)__snapshots__\//, /\.min\.(js|css|mjs)$/, /\.map$/,
  /(^|\/)(dist|build|\.next|coverage|out)\//,
];
export const isGenerated = (p) => GENERATED.some((r) => r.test(p));

// code keeps the id of the first contract; another kind on the same pair is another review
export const reviewId = (repo, base, head, kind = 'code') => createHash('sha1').update(`${repo}\n${base}\n${head}` + (kind === 'code' ? '' : `\n${kind}`)).digest('hex').slice(0, 16);

// A glob of guarded paths ('auth/**', 'db/*.sql') as a regular expression
export const globRe = (g) => new RegExp('^' + String(g).split(/(\*\*\/?|\*|\?)/).map((t) => (t === '**' || t === '**/' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');

// ---------------------------------------------------------------------------------------------------------------
// The store and the routes' work
// ---------------------------------------------------------------------------------------------------------------

let ctx = null;
const cache = new Map(); // id -> { headSha, baseSha, files } (the full parse, hunks included)

export const init = (c) => {
  ctx = c;
  ctx.db.exec(`
    create table if not exists reviews (id text primary key, repo text, project text, base text, head text, plan text, session text,
      head_sha text, verdict text, body text, verdict_sha text, verdict_at text, created text, at text);
    create table if not exists review_comments (id integer primary key autoincrement, review text, path text, side text, line integer,
      body text, author text, at text, resolved integer default 0, head_sha text, snippet text);
    create index if not exists review_comments_review on review_comments (review, id);
    create table if not exists review_viewed (review text, path text, blob text, at text, primary key (review, path));
  `);
  for (const [col, type] of [['kind', "text default 'code'"], ['retries', 'integer default 0'], ['escalated', 'integer default 0'], ['stop', 'text']]) if (!ctx.db.prepare('pragma table_info(reviews)').all().some((c) => c.name === col)) ctx.db.exec(`alter table reviews add column ${col} ${type}`);
};

// The optional hooks of Q (pre-review), Y (architecture delta) and L (guarded domains): absent until they merge
const hooks = {};
const hook = async (file, name) => {
  if (!(file in hooks)) hooks[file] = existsSync(path.join(HERE, file)) ? import('./' + file).catch(() => null) : Promise.resolve(null);
  const m = await hooks[file]; return typeof m?.[name] === 'function' ? m[name] : null;
};
const guardedOf = async (project) => { const f = await hook('autonomy.mjs', 'guardedPaths'); if (!f || !project) return []; try { return (await f(project)) || []; } catch { return []; } };

const refOk = (r) => typeof r === 'string' && r.trim() && !r.startsWith('-') && !/[\s~^:?*[\\]|\.\./.test(r);
const shaOf = async (repo, ref) => { const s = await tryRun(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']); if (!s) throw fail(`branche inconnue : ${ref}`); return s; };
const currentBranch = (repo) => tryRun(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
const levelOf = (project) => { const l = project ? ctx.settingsOf(project)?.review : null; return LEVELS.includes(l) ? l : DEFAULT_LEVEL; };

// Where a session's review lives: repo = its worktree root, head = its branch, base = the branch it will be merged into
// (lib/mergedin.mjs targetOf: the session's base, the plan's, else the one it started from); once merged, what that branch
// was just before the merge (worktree.mergedBase), so the read-only review still shows what the merge brought
const sessionTarget = async (planId, sid) => {
  const plan = ctx.planOf(planId); const row = plan && ctx.rowOf(planId, sid); const s = plan?.sessions.find((x) => x.id === sid);
  if (!s || !row) throw fail('session inconnue', 404);
  if (!row.worktree) throw fail('la session n’a pas de worktree');
  const wt = row.worktree; const repo = wt.root;
  const base = (wt.merged && /^[0-9a-f]{7,64}$/.test(String(wt.mergedBase || '')) && wt.mergedBase) || targetOf(plan, sid, wt) || await currentBranch(repo);
  return { repo, base, head: row.worktree.branch, plan: planId, session: sid, project: plan.project || repo, title: `${sid} · ${s.name || sid}`, row, planObj: plan };
};

const diffArgs = (base, head) => ['-c', 'core.quotepath=true', 'diff', '--no-color', '--no-ext-diff', '--full-index', '-M', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${head}`];
const load = async (r) => {
  const headSha = await shaOf(r.repo, r.head); const baseSha = await shaOf(r.repo, r.base);
  const c = cache.get(r.id);
  if (c && c.headSha === headSha && c.baseSha === baseSha) return c;
  const files = parseDiff(await run(r.repo, diffArgs(r.base, r.head)));
  const fresh = { headSha, baseSha, files }; cache.set(r.id, fresh);
  ctx.db.prepare('update reviews set head_sha = ?, at = ? where id = ?').run(headSha, now(), r.id);
  return fresh;
};

const rowById = (id) => ctx.db.prepare('select * from reviews where id = ?').get(id);
// A session already merged (by the server, or outside it: lib/mergedin.mjs) is read only: the page shows « Fusionnée (commit) »
// without a button that acts, and the server refuses here a verdict, a decision or a comment (409), whatever the page sends
const mergedOf = (row) => { const wt = row?.plan ? ctx.rowOf(row.plan, row.session)?.worktree : null; return wt?.merged ? { commit: wt.mergedCommit || null, into: wt.mergedInto || null, by: wt.mergedBy || null, at: wt.mergedAt || null, outside: !!wt.outside } : null; };
// (a stop review answers the live session's last reply, not its merged code: a session merged mid-way may still be answered)
const refuseMerged = (row) => { if (row.kind === 'stop') return; const m = mergedOf(row); if (m) throw fail(`Session déjà fusionnée${m.commit ? ` (${m.commit.slice(0, 7)})` : ''}${m.into ? ` dans ${m.into}` : ''} : la revue est en lecture seule, rien n’est envoyé.`, 409); };
const ensureRow = (t) => {
  const kind = t.kind || 'code'; const id = reviewId(t.repo, t.base, t.head, kind);
  ctx.db.prepare(`insert into reviews (id, repo, project, base, head, plan, session, kind, stop, created, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set plan = coalesce(excluded.plan, plan), session = coalesce(excluded.session, session), project = excluded.project`)
    .run(id, t.repo, t.project ?? null, t.base, t.head, t.plan ?? null, t.session ?? null, kind, t.stop ? JSON.stringify(t.stop) : null, now(), now());
  return id;
};

const commentsOf = (id) => ctx.db.prepare('select * from review_comments where review = ? order by id').all(id).map((c) => ({ ...c, resolved: !!c.resolved }));
const verdictOf = (row, headSha) => (row?.verdict ? { verdict: row.verdict, body: row.body || '', at: row.verdict_at, headSha: row.verdict_sha, stale: row.verdict_sha !== headSha } : null);
const viewedMap = (id) => Object.fromEntries(ctx.db.prepare('select path, blob from review_viewed where review = ?').all(id).map((v) => [v.path, v.blob]));
const lineCount = (f) => f.hunks.reduce((n, h) => n + h.lines.length, 0);
const collapsedOf = (f) => (f.binary ? null : isGenerated(f.path) ? 'generated' : lineCount(f) > LARGE_LINES ? 'large' : null);
const guardHit = (p, globs) => globs.find((g) => globRe(g).test(p)) || null;

// The full review of a stored row
const retryMaxOf = (project) => { const n = project ? ctx.settingsOf(project)?.retryMax : undefined; return Number.isInteger(n) && n >= 0 ? n : DEFAULT_RETRY_MAX; };
const titleOf = (row) => (row.plan ? `${row.session} · ${ctx.planOf(row.plan)?.sessions.find((s) => s.id === row.session)?.name || row.session}` : row.head);
// What every kind adds to the first contract: kind, retries, retryMax, escalated (S reads the rest unchanged)
const extras = (row) => ({ kind: row.kind || 'code', retries: row.retries || 0, retryMax: retryMaxOf(row.project), escalated: !!row.escalated });
const blobUrl = (id, p, side) => `/api/review/${id}/blob?path=${encodeURIComponent(p)}&side=${side}`;
const buildStop = (row) => {
  const fresh = rowById(row.id);
  return { id: row.id, repo: row.repo, project: row.project, plan: row.plan, session: row.session, title: titleOf(row), base: null, head: null, headSha: null, baseSha: null,
    level: levelOf(row.project), ...extras(fresh), stop: JSON.parse(row.stop || 'null'), files: [], comments: [], verdict: verdictOf(fresh, row.head), prereview: null, architecture: null, mergeAllowed: null, merged: mergedOf(row) };
};
const build = async (row) => {
  if (row.kind === 'stop') return buildStop(row);
  const kind = row.kind || 'code';
  const { headSha, baseSha, files: all } = await load(row);
  const files = kind === 'code' ? all : all.filter((f) => CHANGED.has(f.status) && KIND_FILTER[kind](f));
  const viewed = viewedMap(row.id); const globs = await guardedOf(row.project);
  const out = files.map((f) => {
    const collapsed = collapsedOf(f); const g = guardHit(f.path, globs);
    const x = { path: f.path, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary, generated: isGenerated(f.path), collapsed, viewed: viewed[f.path] === f.blob, flagged: g ? `domaine sous garde : ${g}` : null, hunks: collapsed ? null : f.hunks };
    if (kind !== 'code') { x.before = f.status === 'added' ? null : blobUrl(row.id, f.path, 'old'); x.after = blobUrl(row.id, f.path, 'new'); }
    return x;
  });
  let prereview = null; let architecture = null;
  const pre = kind === 'code' ? await hook('prereview.mjs', 'prereview') : null;
  if (pre) { try { prereview = await pre({ repo: row.repo, base: row.base, head: row.head, project: row.project, files }); for (const x of prereview?.files || []) { const f = out.find((y) => y.path === x.path); if (f && x.flag && !f.flagged) f.flagged = x.why || 'à lire'; } } catch (e) { prereview = { error: e.message }; } }
  const arch = kind === 'code' ? await hook('architecture.mjs', 'architectureDelta') : null;
  if (arch) { try { architecture = await arch({ repo: row.repo, base: row.base, head: row.head, files }); } catch (e) { architecture = { error: e.message }; } }
  const level = levelOf(row.project);
  const fresh = rowById(row.id);
  return {
    id: row.id, repo: row.repo, project: row.project, plan: row.plan, session: row.session, title: titleOf(row), base: row.base, head: row.head, headSha, baseSha, level, ...extras(fresh),
    files: out, comments: commentsOf(row.id), verdict: verdictOf(fresh, headSha), prereview, architecture, merged: mergedOf(row), mergeOnApprove: mergeOnApprove(row), mergeBlocked: blockedNow(row, headSha),
    mergeAllowed: row.plan && kind === 'code' ? await mergeAllowed(row.project, row.plan, row.session) : null,
  };
};

export const openReview = async (q) => {
  const kind = q.kind || 'code'; if (!KINDS.includes(kind)) throw fail(`kind : ${KINDS.join(', ')}`);
  if (kind === 'stop') {
    // the last reply the session stopped on: one review per reply
    const plan = ctx.planOf(q.plan); const r = plan && ctx.rowOf(q.plan, q.session); if (!r) throw fail('session inconnue', 404);
    const reply = r.pending.filter((p) => p.kind === 'reply').at(-1); if (!reply) throw fail('Aucun arrêt en attente');
    const id = ensureRow({ kind, repo: `plan:${q.plan}/${q.session}`, base: 'stop', head: reply.id, plan: q.plan, session: q.session, project: plan.project || r.worktree?.root || null, stop: reply });
    return build(rowById(id));
  }
  let t;
  if (q.plan) t = await sessionTarget(q.plan, q.session);
  else {
    const project = String(q.project || '').trim();
    if (!project || !path.isAbsolute(project) || !existsSync(project) || !statSync(project).isDirectory()) throw fail('project : un dossier absolu existant');
    const repo = await tryRun(project, ['rev-parse', '--show-toplevel']); if (!repo) throw fail('le projet n’est pas un dépôt git');
    if (!refOk(q.base) || !refOk(q.head)) throw fail('base et head : deux noms de branche');
    t = { repo, base: q.base.trim(), head: q.head.trim(), project: path.resolve(project) };
  }
  await shaOf(t.repo, t.base); await shaOf(t.repo, t.head);
  const id = ensureRow({ ...t, kind });
  return build(rowById(id));
};
export const reviewById = async (id) => { const row = rowById(id); if (!row) throw fail('revue inconnue', 404); return build(row); };

const fileIn = async (id, p) => {
  const row = rowById(id); if (!row) throw fail('revue inconnue', 404);
  const { files, headSha } = await load(row); const f = files.find((x) => x.path === p); if (!f) throw fail(`fichier hors du diff : ${p}`);
  return { row, f, headSha };
};
export const fileOf = async (id, p) => { const { f } = await fileIn(id, p); return { path: f.path, hunks: f.hunks }; };
// The file itself on one side: old = at the merge base (what base...head compares to), new = at head
const TYPES = { png: 'image/png', md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8' };
export const blobOf = async (id, p, side) => {
  const { row, f, headSha } = await fileIn(id, p);
  if (side === 'old' && f.status === 'added') throw fail('Ajouté : pas d’avant');
  if (side === 'new' && f.status === 'deleted') throw fail('Supprimé : pas d’après');
  const ref = side === 'old' ? `${(await run(row.repo, ['merge-base', row.base, row.head])).trim()}:${f.oldPath || f.path}` : `${headSha}:${f.path}`;
  return { type: TYPES[path.extname(f.path).slice(1).toLowerCase()] || 'application/octet-stream', data: await runBuf(row.repo, ['show', ref]) };
};

export const addComment = async (id, b) => {
  const { row, f, headSha } = await fileIn(id, String(b.path || '')); refuseMerged(row);
  const side = b.side === 'old' ? 'old' : b.side === 'new' ? 'new' : null; if (!side) throw fail("side : 'old' ou 'new'");
  const line = Number(b.line); const body = String(b.body || '').trim(); if (!body) throw fail('commentaire vide');
  const at = f.hunks.flatMap((h) => h.lines).find((l) => l[side] === line && (side === 'new' ? l.kind !== 'del' : l.kind !== 'add'));
  if (!Number.isInteger(line) || !at) throw fail(`ligne ${b.line} hors du diff (${side})`);
  const author = ['dev', 'pilot', 'claude'].includes(b.author) ? b.author : 'dev';
  const r = ctx.db.prepare('insert into review_comments (review, path, side, line, body, author, at, resolved, head_sha, snippet) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)').run(id, f.path, side, line, body, author, now(), headSha, at.text);
  ctx.onChange?.(row);
  return { ok: true, comment: { ...ctx.db.prepare('select * from review_comments where id = ?').get(r.lastInsertRowid), resolved: false } };
};
export const resolveComment = (id, cid, b = {}) => {
  const row = rowById(id); if (!row) throw fail('revue inconnue', 404); refuseMerged(row);
  const r = ctx.db.prepare('update review_comments set resolved = ? where review = ? and id = ?').run(b.resolved === false ? 0 : 1, id, Number(cid));
  if (!r.changes) throw fail('commentaire inconnu', 404);
  ctx.onChange?.(row); return { ok: true };
};
export const setViewed = async (id, b) => {
  const { row, f } = await fileIn(id, String(b.path || ''));
  if (b.viewed === false) ctx.db.prepare('delete from review_viewed where review = ? and path = ?').run(id, f.path);
  else ctx.db.prepare('insert into review_viewed (review, path, blob, at) values (?, ?, ?, ?) on conflict(review, path) do update set blob = excluded.blob, at = excluded.at').run(id, f.path, f.blob, now());
  ctx.onChange?.(row); return { ok: true };
};

// The message a session receives: the body, then each unresolved comment (path:line, the snippet, the text)
export const reviewMessage = (verdict, body, comments, { n, max, kind } = {}) => {
  const head = verdict === 'retry' ? `Revue : à refaire (${n}/${max}).`
    : verdict === 'reject' ? 'Revue : refusée.'
    : verdict === 'changes' ? 'Revue : changements demandés.'
    : verdict === 'approve' ? (kind === 'stop' ? 'Arrêt validé : continue.' : 'Revue : approuvée.') : 'Revue : commentaires.';
  const items = comments.filter((c) => !c.resolved).map((c) => `- ${c.path}:${c.line} (${c.side === 'old' ? 'ancienne ligne, ' : ''}\`${String(c.snippet ?? '').trim().slice(0, 120)}\`) : ${c.body}`);
  return [head, body ? '\n' + body : '', items.length ? '\n' + items.join('\n') : ''].filter(Boolean).join('\n');
};

// Does an approve of this review merge at once? A code review of a plan's session whose turn is over (done, or waiting on
// the developer's word: the approve is that word), not merged, not a kit. A session in the middle of a turn keeps Approve
// alone. Before 6 novembre 22:10 a waiting session kept Approve alone: APPS, FONT, ARCH and APP were approved, never
// merged, and the page said « approuvée » as if it were done (docs/review.md « Approuver »).
const IDLE = new Set(['done', 'waiting']);
const mergeOnApprove = (row) => {
  if (!row?.plan || (row.kind || 'code') !== 'code') return false;
  const r = ctx.rowOf(row.plan, row.session); const plan = ctx.planOf(row.plan);
  return IDLE.has(r?.status) && !!r.worktree && !r.worktree.merged && plan?.delivery !== 'kit';
};
// The last reason an approve did not merge, per review, while its head has not moved: the page shows it again on reload
const lastBlocked = new Map();
const blockedNow = (row, headSha) => { const b = lastBlocked.get(row.id); return b && b.head === headSha && mergeOnApprove(row) ? { kind: b.kind, why: b.why } : null; };
// Why a merge did not go through, sorted for the page: conflict, guardrail, uncommitted files of the repo, the rest
const blockedOf = (m = {}) => {
  const why = String(m.error || 'fusion impossible');
  if (m.conflict) return { kind: 'conflict', why: 'conflit sur ' + (m.files || []).join(', ') };
  if (m.guard) return { kind: 'guard', why: 'garde-fou à accorder : ' + m.guard.join(', ') };
  if (/changements non commités/.test(why)) return { kind: 'dirty', why: why.replace(/ ; commite.*$/, '') };
  return { kind: m.privacy ? 'privacy' : 'other', why };
};

export const submit = async (id, b) => {
  const row = rowById(id); if (!row) throw fail('revue inconnue', 404); refuseMerged(row);
  const verdict = b.verdict; if (!VERDICTS.includes(verdict)) throw fail(`verdict : ${VERDICTS.join(', ')}`);
  const body = String(b.body || '').trim(); if (verdict !== 'approve' && !body) throw fail(verdict === 'reject' || verdict === 'retry' ? 'le motif est obligatoire' : 'le corps de la revue est vide');
  const kind = row.kind || 'code';
  const headSha = kind === 'stop' ? row.head : (await load(row)).headSha;
  // retry is capped by the project setting retryMax: beyond it, nothing is sent and the review goes to the developer, flagged
  const max = retryMaxOf(row.project); const retries = row.retries || 0;
  if (verdict === 'retry' && retries >= max) {
    ctx.db.prepare('update reviews set escalated = 1, at = ? where id = ?').run(now(), id); ctx.onChange?.(row);
    return { ok: true, sent: false, merged: false, escalated: true, retries, retryMax: max, mergeAllowed: null };
  }
  ctx.db.prepare('update reviews set verdict = ?, body = ?, verdict_sha = ?, verdict_at = ?, at = ?, retries = ?, escalated = ? where id = ?')
    .run(verdict, body, headSha, now(), now(), verdict === 'retry' ? retries + 1 : retries, verdict === 'retry' ? row.escalated || 0 : 0, id);
  let sent = false; let merged = false;
  if (row.plan && (verdict !== 'approve' || kind === 'stop')) {
    try { ctx.sessionMessage(row.plan, row.session, reviewMessage(verdict, body, kind === 'stop' ? [] : commentsOf(id), { n: retries + 1, max, kind })); sent = true; } catch { sent = false; }
  }
  // Approve and merge (Dev, 6 novembre): a finished session merges at once, through the very path of the Flot's button
  // (mergeSession: guardrails, privacy, level, a local merge only, nothing leaves the Mac); when it cannot, the approve is kept and the
  // reason comes back with its kind, for the page to say the gesture that unblocks
  let mergeBlocked = null;
  if (row.plan && verdict === 'approve' && kind === 'code' && mergeOnApprove(row)) {
    const t = ctx.rowOf(row.plan, row.session).worktree.tests;
    if (t && t.code !== 0 && t.head === headSha) mergeBlocked = { kind: 'tests', why: `tests rouges (code ${t.code})${t.failed?.length ? ' : ' + t.failed.slice(0, 3).join(', ') : ''}` };
    else {
      let m; try { m = await ctx.mergeSession(row.plan, row.session, { close: true }); } catch (e) { m = { error: e.message }; }
      merged = !!m?.ok; if (!merged) mergeBlocked = blockedOf(m);
    }
  }
  if (mergeBlocked) lastBlocked.set(id, { ...mergeBlocked, head: headSha }); else lastBlocked.delete(id);
  ctx.onChange?.(row);
  return { ok: true, sent, merged, ...(mergeBlocked ? { mergeBlocked } : {}), escalated: false, retries: verdict === 'retry' ? retries + 1 : retries, retryMax: max, mergeAllowed: row.plan && kind === 'code' ? await mergeAllowed(row.project, row.plan, row.session) : null };
};

// May this session be merged now? strict: only with an up-to-date approve; guided: yes, unless it touches a guarded
// domain (then strict); auto: yes. The red tests guard is the pilot's, not a setting.
export const mergeAllowed = async (project, planId, sid) => {
  let level = levelOf(project);
  let t; try { t = await sessionTarget(planId, sid); } catch (e) { return { allowed: level !== 'strict', level, why: e.message, review: null }; }
  const id = reviewId(t.repo, t.base, t.head);
  let guarded = null;
  if (level === 'guided') {
    const globs = await guardedOf(project);
    if (globs.length) {
      const names = (await tryRun(t.repo, ['diff', '--name-only', '-M', `${t.base}...${t.head}`])).split('\n').filter(Boolean);
      for (const n of names) { const g = guardHit(n, globs); if (g) { guarded = `${n} (${g})`; break; } }
      if (guarded) level = 'strict';
    }
  }
  if (level !== 'strict') return { allowed: true, level, why: '', review: id };
  const row = rowById(id); const headSha = await tryRun(t.repo, ['rev-parse', '--verify', '--quiet', t.head + '^{commit}']);
  if (row?.verdict === 'approve' && row.verdict_sha === headSha) return { allowed: true, level, why: '', review: id };
  const why = guarded ? `Domaine sous garde : ${guarded}` : row?.verdict === 'approve' ? 'Branche modifiée après l’approbation' : 'Approbation requise';
  return { allowed: false, level, why, review: id };
};

// The queue: what to look at first (strict, then guarded, then the smallest)
const summaryOf = async (t, id) => {
  const range = `${t.base}...${t.head}`;
  const ahead = Number(await tryRun(t.repo, ['rev-list', '--count', `${t.base}..${t.head}`])) || 0;
  if (!ahead) return null;
  const numstat = (await tryRun(t.repo, ['diff', '--numstat', '-M', '-z', range]));
  // -z: "add\tdel\tpath\0" or, for a rename, "add\tdel\t\0old\0new\0"
  const parts = numstat.split('\0'); const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]); if (!m) continue;
    let p = m[3]; if (p === '') { p = parts[i + 2]; i += 2; }
    files.push({ path: p, additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0 });
  }
  const globs = await guardedOf(t.project);
  const raw = (await tryRun(t.repo, ['diff', '--raw', '--no-abbrev', '-M', '-z', range])).split('\0');
  const blobs = {};
  for (let i = 0; i < raw.length; i++) {
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(raw[i]); if (!m) continue;
    if (m[3] === 'R' || m[3] === 'C') { const oldP = raw[i + 1]; const newP = raw[i + 2]; blobs[newP] = /^0+$/.test(m[2]) || m[1] === m[2] ? `same:${oldP}` : m[2]; i += 2; }
    else { const p = raw[i + 1]; blobs[p] = m[3] === 'D' ? 'deleted' : m[2]; i += 1; }
  }
  const viewed = viewedMap(id);
  const row = rowById(id); const headSha = await tryRun(t.repo, ['rev-parse', t.head]);
  return {
    id, title: t.title || t.head, plan: t.plan ?? null, session: t.session ?? null, base: t.base, head: t.head,
    level: levelOf(t.project), guarded: files.some((f) => guardHit(f.path, globs)),
    files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    viewed: files.filter((f) => viewed[f.path] && viewed[f.path] === blobs[f.path]).length,
    comments: row ? ctx.db.prepare('select count(*) as n from review_comments where review = ? and resolved = 0').get(id).n : 0,
    verdict: verdictOf(row, headSha), waitingSince: (await tryRun(t.repo, ['log', '-1', '--format=%cI', t.head])) || null,
    kind: 'code', escalated: !!row?.escalated, retries: row?.retries || 0,
  };
};
export const reviewQueue = async (project) => {
  const out = []; const seen = new Set();
  for (const p of ctx.plansOf(project)) {
    for (const s of ctx.planOf(p.id)?.sessions || []) {
      const r = ctx.rowOf(p.id, s.id); if (!r?.worktree || r.worktree.merged) continue;
      let t; try { t = await sessionTarget(p.id, s.id); } catch { continue; }
      // the row exists from the listing on: a link of the queue (/review/:id) opens it (2026-11-01: « Pas de revue » on every link)
      let id; try { id = ensureRow({ ...t, plan: p.id, session: s.id, project: t.project ?? project ?? null }); } catch { continue; } if (seen.has(id)) continue; seen.add(id);
      try { const x = await summaryOf(t, id); if (x) out.push(x); } catch {}
    }
  }
  const pairs = ctx.db.prepare("select * from reviews where plan is null and coalesce(kind, 'code') = 'code' and (? is null or project = ?)").all(project, project);
  for (const row of pairs) {
    if (seen.has(row.id)) continue;
    try {
      const x = await summaryOf({ ...row, title: row.head }, row.id);
      if (x && !(x.verdict?.verdict === 'approve' && !x.verdict.stale)) out.push(x);
    } catch {}
  }
  // the other kinds come up here once escalated (retry beyond retryMax): the developer decides
  for (const row of ctx.db.prepare("select * from reviews where escalated = 1 and coalesce(kind, 'code') != 'code' and (? is null or project = ?)").all(project, project)) {
    out.push({ id: row.id, title: titleOf(row), plan: row.plan, session: row.session, base: row.base, head: row.head, level: levelOf(row.project), guarded: false,
      files: 0, additions: 0, deletions: 0, viewed: 0, comments: 0, verdict: verdictOf(row, row.verdict_sha), waitingSince: row.at, kind: row.kind, escalated: true, retries: row.retries || 0 });
  }
  if (project) for (const x of out) x.level = levelOf(project);
  const rank = (x) => (x.escalated ? 0 : x.level === 'strict' ? 1 : x.guarded ? 2 : 3);
  return { reviews: out.sort((a, b) => rank(a) - rank(b) || (a.additions + a.deletions) - (b.additions + b.deletions)) };
};
