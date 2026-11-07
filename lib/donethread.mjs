// Phase 16 PAIR: the end report of a session (« Ce qui a été fait ») and the review thread that relaunches it.
// The contract is docs/review.md « Le résumé de fin et le fil »; the routes live in server.mjs, the rules here.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectDir, projectRel, PROJECT_DIR, LEGACY_PROJECT_DIR } from './names.mjs';

export const SOURCES = ['dev', 'qa', 'github'];

export const schema = (db) => db.exec(`
  create table if not exists review_done (plan text, session text, json text, at text, primary key (plan, session));
  create table if not exists review_thread (id integer primary key autoincrement, plan text, session text, source text, author text,
    body text, path text, line integer, url text, at text, sent integer default 0, held integer default 0);
  create index if not exists review_thread_key on review_thread (plan, session, id);
`);

// The validated report of the last state block that carried one; a later one replaces it
export const saveDone = (db, plan, session, report, at = new Date().toISOString()) => {
  if (!report) return null;
  db.prepare('insert into review_done (plan, session, json, at) values (?, ?, ?, ?) on conflict (plan, session) do update set json = excluded.json, at = excluded.at').run(plan, session, JSON.stringify(report), at);
  return { ...report, at };
};
export const doneOf = (db, plan, session) => {
  const r = db.prepare('select json, at from review_done where plan = ? and session = ?').get(plan, session);
  if (!r) return null; try { return { ...JSON.parse(r.json), at: r.at }; } catch { return null; }
};

const entryOf = (r) => ({ id: r.id, source: r.source, author: r.author, body: r.body, path: r.path ?? null, line: r.line ?? null, url: r.url ?? null, at: r.at, sent: !!r.sent, held: !!r.held });
export const threadOf = (db, plan, session) => db.prepare('select * from review_thread where plan = ? and session = ? order by at, id').all(plan, session).map(entryOf);

// An entry is written before anything is sent: a message held during a turn, or refused later, is never lost
export const addEntry = (db, plan, session, e) => {
  const source = SOURCES.includes(e.source) ? e.source : null; if (!source) throw new Error('source : dev, qa ou github');
  const body = String(e.body ?? '').trim().slice(0, 8000); if (!body) throw new Error('message vide');
  const line = Number.isInteger(Number(e.line)) && Number(e.line) > 0 ? Number(e.line) : null;
  const at = e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
  const author = String(e.author || (source === 'dev' ? 'Dev' : source)).trim().slice(0, 80);
  const r = db.prepare('insert into review_thread (plan, session, source, author, body, path, line, url, at, sent, held) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
    .run(plan, session, source, author, body, e.path ? String(e.path).slice(0, 400) : null, line, e.url ? String(e.url).slice(0, 400) : null, at);
  return entryOf(db.prepare('select * from review_thread where id = ?').get(Number(r.lastInsertRowid)));
};
export const markSent = (db, id, { held = false } = {}) => { db.prepare('update review_thread set sent = 1, held = ? where id = ?').run(held ? 1 : 0, id); return entryOf(db.prepare('select * from review_thread where id = ?').get(id)); };

// The message the session gets: the text first, then where it comes from
export const relayText = (entry) => `${entry.body}\n\n— fil de la Revue (${entry.source === 'dev' ? 'Dev' : entry.source === 'qa' ? 'QA' : 'GitHub'})`;

// A review-comment message of the GitHub connector (docs/connectors.md) as a thread entry; null when it is not one
export const githubEntry = (m) => {
  if (!m || m.type !== 'review-comment' || !String(m.body ?? '').trim()) return null;
  return { source: 'github', author: String(m.author || m.user?.login || 'github'), body: String(m.body), path: m.path || null, line: m.line ?? m.original_line ?? null, url: m.url || m.html_url || null, at: m.at || m.created_at || null };
};

// The folders of a worktree a capture may be read from; a path outside them (links followed) is refused
const ALLOWED = [PROJECT_DIR, LEGACY_PROJECT_DIR].flatMap((d) => [`${d}/captures`, `${d}/qa`]);
export const resolveCapture = (root, rel) => {
  if (!root || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const file = path.resolve(root, rel);
  let real; try { real = realpathSync(file); } catch { return null; }
  let base; try { base = realpathSync(root); } catch { return null; }
  const ok = ALLOWED.some((d) => real.startsWith(path.join(base, d) + path.sep)) && /\.(png|html)$/i.test(real);
  return ok ? real : null;
};

// The most recent QA board of the worktree (.escadrille/qa/<run>/planche.html), relative to it, or null
export const latestBoard = (root) => {
  const dir = root && projectDir(root, 'qa'); if (!dir || !existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name, 'planche.html');
    try { const t = statSync(f).mtimeMs; if (!best || t > best.t) best = { t, rel: projectRel('qa', name, 'planche.html') }; } catch {}
  }
  return best ? best.rel : null;
};

export const fileUrl = (plan, session, rel) => `/api/review/done/file?plan=${encodeURIComponent(plan)}&session=${encodeURIComponent(session)}&path=${encodeURIComponent(rel)}`;
