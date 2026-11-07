// The burst « Jusqu'à la limite » (docs/burst.md): the project's backlog, the table, and the pure rules of the
// machine. server.mjs wires them to the planner and session events; nothing here answers a stop or merges.
//   parseBacklog(text) / readBacklog(project)       [{ n, text, done }]
//   createBacklog(project, { from, text, memoryFile }) writes docs/backlog.md, never over an existing one
//   appendDefect(project, { text, screen }) adds `- [ ] Défaut (<screen>) : <text>` (or `- [ ] Défaut : <text>` without
//     screen) at the end of docs/backlog.md, and creates the file, with createBacklog's header, when it is missing.
//     text: newlines become spaces, whitespace collapses, cut at 300 characters; screen: same, cut at 40.
//     An empty text (or only blanks) throws a plain Error (the route answers 400). Returns readBacklog(project).
//   ensureTable(db), burstOf(db, id), saveBurst(db, b), burstsOf(db, project), activeBursts(db)
//   untilOf, drainAtOf, shapePlan, answerFor, reviewMinutes, estimateMin, shouldDrain, pastUntil, validateAutoBurst
//   ACTIVE: the statuses of a burst that still works; every other status is final (done, stopped, limit, ended)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const BACKLOG = path.join('docs', 'backlog.md');
const BACKLOG_HEAD = "# Backlog\n\nUne tâche par ligne, dans l'ordre ; « - [x] » quand elle est faite.\n\n";
export const DRAIN_MIN = 45; // drainAt = until - 45 min
export const TASK_MIN = 45; // the estimate of a task when none of the burst's is done yet
export const HUMAN_WAIT_MS = 10 * 60e3; // a plan whose sessions all wait for a human this long lets the burst move on
export const REVIEW_MAX_MIN = 120; // above two hours of review queue, no new plan
export const FINISH_TEXT = 'Finis et livre ce qui est fait.';
export const AUTO_DEFAULT = { on: false, minMarginPct: 30, maxHoursLeft: 8 };

// ---------------------------------------------------------------- the backlog
const clean = (s) => String(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
export const parseBacklog = (text) => {
  const tasks = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line); if (!m) continue;
    let t = m[1]; let done = false;
    const box = /^\[([ xX])\]\s*(.*)$/.exec(t); if (box) { done = box[1] !== ' '; t = box[2]; }
    if (/^~~.*~~\s*$/.test(t)) { done = true; t = t.replace(/^~~|~~\s*$/g, ''); }
    t = clean(t); if (t) tasks.push({ n: tasks.length + 1, text: t, done });
  }
  return tasks;
};
export const readBacklog = (project) => {
  const f = path.join(project, BACKLOG);
  return existsSync(f) ? { exists: true, file: f, tasks: parseBacklog(readFileSync(f, 'utf8')) } : { exists: false, file: f, tasks: [] };
};

// The bullets of the newest « Reporté » (a heading, or a bullet with nested ones), else of the last phase not done
export const fromRoadmap = (text) => {
  const lines = String(text || '').split('\n');
  const bulletsAfter = (i, indent) => {
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]; if (/^#/.test(l)) break;
      const m = /^(\s*)[-*]\s+(.*)$/.exec(l);
      if (m) { if (indent !== null && m[1].length <= indent) break; out.push(m[2]); continue; }
      if (l.trim() && out.length && /^\s/.test(l)) out[out.length - 1] += ' ' + l.trim(); // a wrapped line
      else if (l.trim() && indent !== null) break;
    }
    return out.map(clean).filter(Boolean);
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/Report[ée]/.test(lines[i])) continue;
    const h = /^#/.test(lines[i]); const b = /^(\s*)[-*]\s/.exec(lines[i]);
    if (!h && !b) continue;
    const got = bulletsAfter(i, h ? null : b[1].length); if (got.length) return got;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^#{2,3}\s/.test(lines[i]) && /phase/i.test(lines[i]) && !/fait/i.test(lines[i])) { const got = bulletsAfter(i, null); if (got.length) return got; }
  }
  return [];
};
// Of the memory's last 20 lines, those that start with an infinitive or « Reste à »
export const fromMemory = (text) => String(text || '').split('\n').slice(-20)
  .map((l) => clean(l.replace(/^\s*[-*]\s+/, '').replace(/^\d{4}-\d\d-\d\d\s*[:·-]?\s*/, '')))
  .filter((l) => /^(Reste à\s|[A-ZÀÂÉÈÊÎÔÛ][a-zàâçéèêëîïôûùüÿœ]+(er|ir|re)\b)/.test(l));

export const createBacklog = (project, { from, text, memoryFile } = {}) => {
  const f = path.join(project, BACKLOG);
  if (existsSync(f)) { const e = new Error('docs/backlog.md existe déjà'); e.code = 409; throw e; }
  let items;
  if (from === 'roadmap') { const r = path.join(project, 'ROADMAP.md'); if (!existsSync(r)) throw new Error('pas de ROADMAP.md'); items = fromRoadmap(readFileSync(r, 'utf8')); }
  else if (from === 'memory') { if (!memoryFile || !existsSync(memoryFile)) throw new Error('pas de mémoire'); items = fromMemory(readFileSync(memoryFile, 'utf8')); }
  else if (from === 'text') items = String(text || '').split('\n').map((l) => clean(l.replace(/^\s*[-*]\s+(\[[ xX]\]\s*)?/, ''))).filter(Boolean);
  else throw new Error("from : 'roadmap', 'memory' ou 'text'");
  if (!items.length) throw new Error('aucune tâche trouvée');
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${BACKLOG_HEAD}${items.map((t) => `- [ ] ${t}`).join('\n')}\n`);
  return readBacklog(project);
};

// One defect line at the end of docs/backlog.md; the file is created, with the same header, when missing
export const appendDefect = (project, { text, screen } = {}) => {
  const t = clean(text ?? '').slice(0, 300).trim();
  if (!t) throw new Error('texte vide');
  const s = clean(screen ?? '').slice(0, 40).trim();
  const line = `- [ ] ${s ? `Défaut (${s})` : 'Défaut'} : ${t}\n`;
  const f = path.join(project, BACKLOG);
  if (existsSync(f)) {
    const cur = readFileSync(f, 'utf8');
    writeFileSync(f, (cur === '' || cur.endsWith('\n') ? cur : cur + '\n') + line);
  } else {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, `${BACKLOG_HEAD}${line}`);
  }
  return readBacklog(project);
};

// ---------------------------------------------------------------- the table
export const ensureTable = (db) => {
  db.exec("create table if not exists bursts (id text primary key, project text, created text, status text, cap_usd real, spent_usd real default 0, until text, drain_at text, model text, tasks text, log text)");
};
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const rowToBurst = (r) => r && { id: r.id, project: r.project, created: r.created, status: r.status, capUsd: r.cap_usd, spentUsd: r.spent_usd || 0, until: r.until, drainAt: r.drain_at, model: r.model, tasks: parse(r.tasks, []), log: parse(r.log, []) };
export const burstOf = (db, id) => rowToBurst(db.prepare('select * from bursts where id = ?').get(id));
export const burstsOf = (db, project) => db.prepare('select * from bursts where (? is null or project = ?) order by created desc').all(project, project).map(rowToBurst);
export const ACTIVE = ['running', 'draining'];
export const activeBursts = (db) => db.prepare("select * from bursts where status in ('running', 'draining') order by created").all().map(rowToBurst);
// The plans of the bursts that are over (any final status): the server never resumes their sessions on its own
export const finishedPlans = (db) => new Set(db.prepare("select * from bursts where status not in ('running', 'draining')").all().map(rowToBurst).flatMap((b) => b.tasks.map((t) => t.plan).filter(Boolean)));
export const insertBurst = (db, b) => db.prepare('insert into bursts (id, project, created, status, cap_usd, spent_usd, until, drain_at, model, tasks, log) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(b.id, b.project, b.created, b.status, b.capUsd, b.spentUsd || 0, b.until, b.drainAt, b.model || null, JSON.stringify(b.tasks), JSON.stringify(b.log));
export const saveBurst = (db, b) => db.prepare('update bursts set status = ?, spent_usd = ?, tasks = ?, log = ? where id = ?').run(b.status, b.spentUsd, JSON.stringify(b.tasks), JSON.stringify(b.log), b.id);
export const logLine = (b, text, at = new Date().toISOString()) => { b.log.push({ at, text }); return b; };

// ---------------------------------------------------------------- the rules
// until: the limit, or the cutoff when it is earlier; without a known limit, the cutoff, else now + 4 h
export const untilOf = ({ resetsAt, cutoff, now = Date.now() }) => {
  const c = [resetsAt, cutoff].map((x) => (x ? Date.parse(x) : NaN)).filter((t) => Number.isFinite(t) && t > now);
  return new Date(c.length ? Math.min(...c) : now + 4 * 36e5).toISOString();
};
export const drainAtOf = (until, drainMin = DRAIN_MIN) => new Date(Date.parse(until) - drainMin * 60e3).toISOString();
// The mean duration of the burst's finished tasks, else TASK_MIN
export const estimateMin = (b) => {
  const d = b.tasks.filter((t) => t.status === 'done' && t.started && t.ended).map((t) => (Date.parse(t.ended) - Date.parse(t.started)) / 60e3);
  return d.length ? d.reduce((a, x) => a + x, 0) / d.length : TASK_MIN;
};
// Drain: past drainAt, or not enough time left for one more task
export const shouldDrain = (b, now = Date.now()) => now >= Date.parse(b.drainAt) || Date.parse(b.until) - now < estimateMin(b) * 60e3;
// The end, without exception: once until is past, the burst ends ('ended') whatever it is doing, drain or not
export const pastUntil = (b, now = Date.now()) => { const u = Date.parse(b?.until); return Number.isFinite(u) && now >= u; };
// The review queue in minutes, as « À relire » counts it: an hour per 400 changed lines
export const reviewMinutes = (queue) => Math.round((queue || []).reduce((a, r) => a + (r.additions || 0) + (r.deletions || 0), 0) / 400 * 60);

const STRICTNESS = ['strict', 'surveille', 'guide', 'guidé', 'guided', 'autonome'];
const rank = (m) => { const i = STRICTNESS.indexOf(String(m || '')); return i < 0 ? STRICTNESS.length : i; };
// The plan of a burst: no network, mode autonome (the project's when stricter), the session caps within the rest
export const shapePlan = (plan, { rest, projectAutonomy = null, defaultBudget = 5 }) => {
  const p = { ...plan, network: [], closedNetwork: true }; // closedNetwork: the project's domains stay shut to a burst
  p.autonomy = projectAutonomy?.mode && rank(projectAutonomy.mode) < rank('autonome') ? { ...projectAutonomy } : { ...(plan.autonomy || {}), mode: 'autonome' };
  const caps = p.sessions.map((s) => (Number(s.budget) > 0 ? Number(s.budget) : defaultBudget));
  const sum = caps.reduce((a, x) => a + x, 0); const room = Math.max(0.01, rest);
  const k = sum > room ? room / sum : 1;
  p.sessions = p.sessions.map((s, i) => ({ ...s, budget: Math.max(0.01, Math.floor(caps[i] * k * 100) / 100) }));
  return p;
};
// What « Tout accepter » sends (public/index.html, composeAnswer), every recommendation kept
export const answerFor = (escadrille) => {
  const lines = ['ok pour tout'];
  const inst = escadrille?.install || [];
  if (inst.length) { const kept = inst.filter((x) => x.checked).map((x) => x.name); const dropped = inst.filter((x) => !x.checked).map((x) => x.name); lines.push(`À installer : je garde ${kept.length ? kept.join(', ') : 'rien'}${dropped.length ? ` ; j'écarte ${dropped.join(', ')}` : ''}.`); }
  lines.push('Écris le plan.');
  return lines.join('\n\n');
};
// The section appended to the planner's system prompt
export const plannerSection = (rest) => `\n\n## La rafale\n\nCette planification vient d'une rafale sans développeur : chaque arrêt porte un kind et un fallback, les sessions ont des budgets qui tiennent dans ${rest.toFixed(2)} $, réseau vide, aucune question dont la recommandation ne suffit pas.`;

export const validateAutoBurst = (v) => {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('autoBurst : { on, minMarginPct, maxHoursLeft }');
  const o = { ...AUTO_DEFAULT, ...v };
  if (typeof o.on !== 'boolean') throw new Error('autoBurst.on : vrai ou faux');
  if (!(Number(o.minMarginPct) >= 0 && Number(o.minMarginPct) <= 100)) throw new Error('autoBurst.minMarginPct : de 0 à 100');
  if (!(Number(o.maxHoursLeft) > 0 && Number(o.maxHoursLeft) <= 168)) throw new Error('autoBurst.maxHoursLeft : de 0 à 168');
  return { on: o.on, minMarginPct: Number(o.minMarginPct), maxHoursLeft: Number(o.maxHoursLeft) };
};
// Should the auto mode start a burst now
export const autoWants = (auto, horizon) => !!(auto?.on && horizon && horizon.remainingPct != null && horizon.hoursLeft != null && horizon.remainingPct > auto.minMarginPct && horizon.hoursLeft < auto.maxHoursLeft);
// The default cap: 60 % of the margin in dollars, rounded; 10 $ when unknown
export const defaultCap = (horizon) => (horizon?.remainingUsd > 0 ? Math.max(1, Math.round(horizon.remainingUsd * 0.6)) : 10);

// For L's engine: is this plan in a draining burst (its next stop gets FINISH_TEXT, not the fallback)
let drainingPlans = new Set();
export const setDraining = (plans) => { drainingPlans = new Set(plans); };
export const burstDraining = (planId) => drainingPlans.has(planId);
