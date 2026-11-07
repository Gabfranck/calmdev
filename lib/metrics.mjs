// The measure (docs/mesure.md): three figures read from Escadrille's own database, nothing estimated.
//
//   planMetrics({ db, planId, now })      one plan: cost per merged PR, attention against session hours, unattended
//   overallMetrics({ db, project, now })  { overall, plans }: the same over every plan of a project (all plans without one)
//
// The tables are the server's: sessions (usage, worktree, handoffs, health), log (one line per change of
// state), session_messages (dev, ask, system… with their time), plans (json, project).
// A wait ('reply') is not kept in the database once answered: it is read as the log line where the session
// turns 'waiting', and ends at the first 'dev' message after it. A message with data.auto (sent by the
// server itself, session L) is neither attention nor an intervention.

const parse = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const ms = (iso) => Date.parse(iso);
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const CAP = /^Plafond de .* atteint/;

const columns = (db, table) => new Set(db.prepare(`pragma table_info(${table})`).all().map((c) => c.name));

// The figures of one session from its journal lines (ascending) and its messages (ascending)
const sessionFigures = (log, messages, nowMs) => {
  let running = 0, since = null, status = null, prevStops = 0;
  let firstRunning = null, lastDone = null, errored = false;
  const waits = [];
  for (const l of log) {
    const t = ms(l.at); const stops = parse(l.stops, []).length;
    if (l.health === 'error') errored = true;
    if (l.status === status) continue;
    if (status === 'running' && since !== null) running += t - since;
    status = l.status; since = l.status === 'running' ? t : null;
    if (l.status === 'running' && firstRunning === null) firstRunning = t;
    if (l.status === 'done') lastDone = t;
    if (l.status === 'waiting') { waits.push({ at: t, named: stops > prevStops, answered: false }); prevStops = stops; }
  }
  if (status === 'running' && since !== null) running += Math.max(0, nowMs - since);
  let attention = 0, interventions = 0, caps = 0;
  const asks = new Map();
  for (const m of messages) {
    const t = ms(m.at); const data = parse(m.data, {}) || {};
    if (m.role === 'ask' && data.id) { asks.set(data.id, t); continue; }
    if (m.role === 'system' && data.answer) { const a = asks.get(data.answer); if (a !== undefined) { if (!data.auto) attention += t - a; asks.delete(data.answer); } continue; }
    if (m.role === 'system' && CAP.test(m.text || '')) { caps++; continue; }
    if (m.role === 'dev') {
      // The wait this message answers: the last one before it, not answered yet
      let w = null; for (const x of waits) if (x.at <= t && !x.answered) w = x;
      if (w) { w.answered = true; for (const x of waits) if (x.at <= w.at) x.answered = true; }
      if (data.auto) continue;
      if (w) attention += t - w.at;
      if (!w || !w.named) interventions++;
    }
  }
  return { running, attention, interventions, caps, firstRunning, lastDone, errored };
};

// What a plan is made of, read once: its rows, its journal and its messages
const readPlan = (db, planId) => {
  const cols = columns(db, 'sessions');
  const pick = ['id', 'status', 'stops', 'health', ...['worktree', 'usage', 'handoffs'].filter((c) => cols.has(c))].join(', ');
  const rows = db.prepare(`select ${pick} from sessions where plan = ? order by id`).all(planId).map((r) => ({ ...r, stops: parse(r.stops, []), worktree: parse(r.worktree), usage: parse(r.usage), handoffs: parse(r.handoffs, []) }));
  const log = db.prepare('select session, at, status, stops, health from log where plan = ? order by seq').all(planId);
  const messages = db.prepare('select session, role, text, data, at from session_messages where plan = ? order by seq').all(planId);
  const p = db.prepare('select json from plans where id = ?').get(planId);
  return { rows, log, messages, plan: p ? parse(p.json, {}) : null };
};

export const planMetrics = ({ db, planId, now = Date.now() }) => {
  const { rows, log, messages, plan } = readPlan(db, planId);
  const nowMs = typeof now === 'number' ? now : ms(now);
  let running = 0, attention = 0, interventions = 0, caps = 0, errors = 0, first = null, last = null;
  for (const r of rows) {
    const f = sessionFigures(log.filter((l) => l.session === r.id), messages.filter((m) => m.session === r.id), nowMs);
    running += f.running; attention += f.attention; interventions += f.interventions; caps += f.caps;
    if (f.errored || r.health === 'error') errors++;
    if (f.firstRunning !== null && (first === null || f.firstRunning < first)) first = f.firstRunning;
    if (f.lastDone !== null && (last === null || f.lastDone > last)) last = f.lastDone;
  }
  const cost = rows.reduce((s, r) => s + (Number(r.usage?.cost) || 0), 0);
  const merged = rows.filter((r) => r.worktree?.merged).length;
  const launched = rows.some((r) => !['todo', 'later'].includes(r.status)) || log.length > 0;
  const finished = rows.length > 0 && rows.every((r) => r.status === 'done');
  return {
    id: planId, title: plan?.title ?? planId,
    costPerMergedPr: merged ? round(cost / merged, 2) : null,
    attentionMinutes: launched ? round(attention / 60e3, 1) : null,
    sessionHours: launched ? round(running / 3.6e6, 2) : null,
    unattended: finished ? interventions === 0 && caps === 0 : null,
    cost: round(cost, 2), merged, sessions: rows.length, finished,
    interventions, caps, errors, handoffs: rows.reduce((s, r) => s + (r.handoffs?.length || 0), 0),
    stops: rows.reduce((s, r) => s + r.stops.length, 0),
    startedAt: first !== null ? new Date(first).toISOString() : null,
    endedAt: finished && last !== null ? new Date(last).toISOString() : null,
  };
};

export const overallMetrics = ({ db, project = null, now = Date.now() } = {}) => {
  const hasProject = columns(db, 'plans').has('project');
  const ids = db.prepare(hasProject && project ? 'select id from plans where project = ? order by created desc' : 'select id from plans order by created desc').all(...(hasProject && project ? [project] : [])).map((r) => r.id);
  const all = ids.map((planId) => planMetrics({ db, planId, now })).filter((m) => m.sessionHours !== null);
  const sum = (k) => all.reduce((s, m) => s + (m[k] || 0), 0);
  const cost = sum('cost'), merged = sum('merged');
  const finished = all.filter((m) => m.finished).length, unattended = all.filter((m) => m.unattended === true).length;
  return {
    overall: {
      costPerMergedPr: merged ? round(cost / merged, 2) : null,
      attentionMinutes: all.length ? round(sum('attentionMinutes'), 1) : null,
      sessionHours: all.length ? round(sum('sessionHours'), 2) : null,
      unattendedRate: finished ? round(unattended / finished, 3) : null,
      cost: round(cost, 2), merged, finished, unattended, plans: all.length,
    },
    plans: all.map(({ id, title, costPerMergedPr, attentionMinutes, sessionHours, unattended }) => ({ id, title, costPerMergedPr, attentionMinutes, sessionHours, unattended })),
  };
};
