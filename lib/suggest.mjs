// The guessed reply (plan « le fil et les mots », session DEV): the grey text behind the cursor of an empty composer.
// Local only: the stop's own fallback first, then Dev's most frequent reply to the same kind of stop, weighted by recency,
// else nothing. Never an invented text. Every send is recorded (accepted, corrected, ignored); a guess corrected three
// times in a row for a kind yields to the correction.
//
//   schema(db)                        the table suggest_replies, created if missing
//   rank({ current, history, now })   → { text, source: 'fallback' | 'history' | 'learned', kind } or null (pure)
//   suggestFor(db, { project, plan, session, planOf, now }) → { text, source, kind, stop, plan, session } or { text: null }
//   record(db, { project, plan, session, kind, suggestion, sent, tabbed, at }) → { outcome }
//   route(req, res, url, { db, json, readBody, projectArg, planOf }) → true when it answered /api/suggest
//
//   GET  /api/suggest?project=&plan=&session=  one request per opening of a composer; no plan/session: the main thread
//   POST /api/suggest { project, plan, session, kind, suggestion, sent, tabbed } → { ok, outcome }

import { stopKind, stopFallback } from './autonomy.mjs';

export const HALF_LIFE_DAYS = 7; // a reply a week old weighs half of today's
export const MAX_REPLY = 160; // longer replies are specific to their stop: never guessed again
export const YIELD_AFTER = 3; // corrected this many times in a row → the correction wins
const HISTORY_ROWS = 400;

export const schema = (db) => db.exec(`
  create table if not exists suggest_replies (seq integer primary key autoincrement, project text, plan text, session text, kind text not null, suggestion text, sent text not null, outcome text not null, at text not null);
  create index if not exists suggest_replies_kind on suggest_replies (kind, seq);
`);

const norm = (t) => String(t ?? '').trim().replace(/\s+/g, ' ');
const key = (t) => norm(t).toLowerCase().replace(/[.!\s]+$/, '');

// The outcome of a send: the guess sent as is, the guess taken by Tab then edited, or another text typed over it
export const outcomeOf = ({ suggestion, sent, tabbed }) => {
  if (!norm(suggestion)) return 'none';
  if (key(sent) === key(suggestion)) return 'accepted';
  return tabbed ? 'corrected' : 'ignored';
};

// history: rows { kind, suggestion, sent, outcome, at }, any order
export const rank = ({ current, history = [], now = Date.now() }) => {
  const kind = current?.kind || null;
  if (!kind) return null;
  const rows = history.filter((r) => r.kind === kind).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.seq ?? 0) - (b.seq ?? 0));
  let pick = null;
  const fallback = norm(current.fallback);
  if (fallback) pick = { text: fallback, source: 'fallback', kind };
  else {
    const scores = new Map();
    for (const r of rows) {
      const t = norm(r.sent);
      if (!t || t.length > MAX_REPLY) continue;
      const age = Math.max(0, (now - Date.parse(r.at)) / 864e5);
      const w = Math.pow(0.5, age / HALF_LIFE_DAYS);
      const k = key(t); const s = scores.get(k) || { text: t, score: 0, last: 0 };
      s.score += w; s.text = t; s.last = Math.max(s.last, Date.parse(r.at)); scores.set(k, s);
    }
    const best = [...scores.values()].sort((a, b) => b.score - a.score || b.last - a.last)[0];
    if (best) pick = { text: best.text, source: 'history', kind };
  }
  if (!pick) return null;
  // The last YIELD_AFTER sends of this kind all corrected (or typed over) this very guess: the correction takes its place
  const last = rows.slice(-YIELD_AFTER);
  if (last.length === YIELD_AFTER && last.every((r) => key(r.suggestion) === key(pick.text) && (r.outcome === 'corrected' || r.outcome === 'ignored'))) {
    const fixes = last.map((r) => norm(r.sent)).filter((t) => t && t.length <= MAX_REPLY);
    if (!fixes.length) return null;
    const count = (t) => fixes.filter((f) => key(f) === key(t)).length;
    const text = fixes.slice().reverse().sort((a, b) => count(b) - count(a))[0];
    return { text, source: 'learned', kind };
  }
  return pick;
};

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// The stops waiting for an answer: a pending 'reply' whose stop index is known in the plan
export const waitingStops = (db, { project, plan = null, session = null, planOf }) => {
  const rows = plan
    ? db.prepare('select plan, id, pending from sessions where plan = ? and id = ?').all(plan, session)
    : db.prepare("select s.plan, s.id, s.pending from sessions s join plans p on p.id = s.plan where p.project = ? and s.status = 'waiting'").all(project);
  const out = [];
  for (const r of rows) {
    const reply = parse(r.pending, []).find((p) => p.kind === 'reply');
    if (!reply) continue;
    const p = planOf(r.plan); const s = p?.sessions?.find((x) => x.id === r.id);
    const stop = Number.isInteger(reply.stop) ? s?.stops?.[reply.stop] : undefined;
    out.push({ plan: r.plan, session: r.id, stop: Number.isInteger(reply.stop) ? reply.stop : null, kind: stop === undefined ? null : stopKind(stop), fallback: stop === undefined ? null : stopFallback(stop), at: reply.at });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
};

export const historyOf = (db) => db.prepare('select seq, kind, suggestion, sent, outcome, at from suggest_replies order by seq desc limit ?').all(HISTORY_ROWS);

export const suggestFor = (db, { project, plan = null, session = null, planOf, now = Date.now() }) => {
  const waiting = waitingStops(db, { project, plan, session, planOf }).filter((w) => w.kind);
  const current = waiting[0]; // the session's own stop, or the oldest one waiting for the main thread
  const r = current ? rank({ current, history: historyOf(db), now }) : null;
  if (!current) return { text: null };
  // no guess, but a stop waits: its kind comes back so that the send teaches the history of that kind
  return { ...(r || { text: null, source: null, kind: current.kind }), stop: current.stop, plan: current.plan, session: current.session };
};

export const record = (db, { project = null, plan = null, session = null, kind, suggestion = null, sent, tabbed = false, at = new Date().toISOString() }) => {
  const outcome = outcomeOf({ suggestion, sent, tabbed });
  if (!kind || !norm(sent)) return { outcome: 'skipped' };
  db.prepare('insert into suggest_replies (project, plan, session, kind, suggestion, sent, outcome, at) values (?, ?, ?, ?, ?, ?, ?, ?)').run(project, plan, session, String(kind), norm(suggestion) || null, norm(sent).slice(0, 2000), outcome, at);
  return { outcome };
};

export const route = async (req, res, url, { db, json, readBody, projectArg, planOf }) => {
  if (url.pathname !== '/api/suggest') return false;
  if (req.method === 'POST') {
    const b = await readBody(req, 2e4);
    const project = projectArg(b.project);
    const r = record(db, { project, plan: b.plan || null, session: b.session || null, kind: b.kind, suggestion: b.suggestion, sent: b.sent, tabbed: !!b.tabbed });
    json(res, 200, { ok: true, ...r });
    return true;
  }
  if (req.method !== 'GET') { json(res, 405, { error: 'GET ou POST' }); return true; }
  const plan = url.searchParams.get('plan') || null; const session = url.searchParams.get('session') || null;
  if (plan && !session) { json(res, 400, { error: 'session manquante' }); return true; }
  const project = projectArg(url.searchParams.get('project'));
  json(res, 200, suggestFor(db, { project, plan, session, planOf }));
  return true;
};
