// Phase 8 D, the pilot's log (docs/pilotlog.md): what the pilot did, one row per action, so the backstage reads fast.
// The first line of text is the action (ten words at most, cut beyond); the lines after it are the why, shown on a click.
export const KINDS = ['answer', 'propose', 'launch', 'message', 'memory', 'capture', 'refuse', 'merge', 'note'];
export const MAX_TEXT = 4000;
export const MAX_WORDS = 10;

export const schema = (db) => db.exec(`
  create table if not exists pilot_actions (seq integer primary key autoincrement, project text not null, plan_id text, session_id text, kind text not null, text text not null, at text not null);
  create index if not exists pilot_actions_at on pilot_actions (project, at, seq);
`);

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const opt = (v) => { const s = String(v ?? '').trim(); return s || null; };

// The line and the why of a stored text: the first line cut to ten words, the rest (and what was cut) as detail
export const split = (text) => {
  const [first, ...rest] = String(text).split('\n');
  const words = first.trim().split(/\s+/).filter(Boolean);
  const line = words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(' ') + '…' : words.join(' ');
  const detail = [words.length > MAX_WORDS ? '…' + words.slice(MAX_WORDS).join(' ') : '', rest.join('\n').trim()].filter(Boolean).join('\n');
  return { line, detail };
};

// The server builds the link, never the text: the session's node in the Flot, else the plan, else nothing
export const hrefOf = ({ project, plan_id, session_id }) => {
  if (!plan_id) return null;
  const base = '/plan/' + encodeURIComponent(plan_id) + '?project=' + encodeURIComponent(project);
  return session_id ? base + '#s-' + encodeURIComponent(session_id) : base;
};

const row = (r) => { const { line, detail } = split(r.text); return { seq: r.seq, kind: r.kind, text: line, detail, planId: r.plan_id, sessionId: r.session_id, at: r.at, href: hrefOf(r) }; };

export const record = (db, { project, planId, sessionId, kind, text, at } = {}) => {
  if (!opt(project)) throw bad('project manquant');
  if (!KINDS.includes(kind)) throw bad('kind : ' + KINDS.join(', '));
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) throw bad('text vide');
  if (t.length > MAX_TEXT) throw bad(`text : ${MAX_TEXT} caractères au plus`);
  const when = at ? new Date(at).toISOString() : new Date().toISOString();
  const r = db.prepare('insert into pilot_actions (project, plan_id, session_id, kind, text, at) values (?, ?, ?, ?, ?, ?) returning *').get(project, opt(planId), opt(sessionId), kind, t, when);
  return row(r);
};

// Newest first; before is the seq of the oldest row already shown
export const list = (db, { project, before = null, limit = 50 } = {}) => {
  limit = Math.max(1, Math.min(200, Number(limit) || 50));
  let where = 'project = ?'; let args = [project];
  if (before != null && before !== '') { const b = db.prepare('select at, seq from pilot_actions where seq = ? and project = ?').get(Number(before), project); if (b) { where += ' and (at < ? or (at = ? and seq < ?))'; args = [...args, b.at, b.at, b.seq]; } }
  const rows = db.prepare(`select * from pilot_actions where ${where} order by at desc, seq desc limit ?`).all(...args, limit + 1);
  const total = db.prepare('select count(*) as n from pilot_actions where project = ?').get(project).n;
  return { actions: rows.slice(0, limit).map(row), more: rows.length > limit, total };
};
