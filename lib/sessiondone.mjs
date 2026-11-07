// The end date of a session, fixed once. sessions.at moves on every write of the row (usage, alerts), so an age measured
// from it never comes: a server left by a finished session lived 10 h (BKL, 7 November). Here the date is written when
// the status becomes done and erased when the session reopens.
//
//   ensure(db)                         creates the table session_done (plan, session, at)
//   mark(db, plan, session, at?)       keeps the first date (insert or ignore)
//   clear(db, plan, session)           the session is not done any more
//   doneAt(db, plan, session, fallback) the fixed date, else the fallback (sessions.at)
//   sync(db, rows)                     rows [{ plan, id, status, at }]: a done row without a date gets its `at`, a row not done loses its date
//   all(db)                            Map "plan/session" -> at
export const ensure = (db) => db.exec('create table if not exists session_done (plan text, session text, at text, primary key (plan, session))');
export const mark = (db, plan, session, at = new Date().toISOString()) => db.prepare('insert or ignore into session_done (plan, session, at) values (?, ?, ?)').run(plan, session, at);
export const clear = (db, plan, session) => db.prepare('delete from session_done where plan = ? and session = ?').run(plan, session);
export const all = (db) => { try { return new Map(db.prepare('select plan, session, at from session_done').all().map((r) => [`${r.plan}/${r.session}`, r.at])); } catch { return new Map(); } };
export const doneAt = (db, plan, session, fallback = null) => { try { return db.prepare('select at from session_done where plan = ? and session = ?').get(plan, session)?.at || fallback; } catch { return fallback; } };
export const sync = (db, rows = []) => {
  const known = all(db);
  for (const r of rows) {
    const k = `${r.plan}/${r.id}`;
    if (r.status === 'done') { if (!known.has(k) && r.at) mark(db, r.plan, r.id, r.at); }
    else if (known.has(k)) clear(db, r.plan, r.id);
  }
};
