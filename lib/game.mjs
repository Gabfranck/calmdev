// The progression (docs/game.md): XP, ranks, achievements and the week, all computed from what the
// database already holds (plans, sessions, log, escadrilles, and R's reviews when its tables exist).
// Nothing is tracked for it; everything is retroactive. Lines of code earn nothing.
//
//   levelOf(db, { project, now, rulesFile, defaultBudget }) → { xp, level, rank, next, badges, week, events }
//   planXp(db, planId, { defaultBudget }) → { earned, potential }
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { planMetrics } from './metrics.mjs';

const parse = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const ms = (iso) => Date.parse(iso);

export const XP = { merge: 10, review: 15, reviewStrict: 25, viewed: 1, viewedCap: 20, resolved: 3, underBudget: 20, savedPer10c: 1, savedCap: 30, unattended: 10, handoff: 5, rule: 5 };

export const RANKS = [
  ['Élève pilote', 0], ['Pilote', 100], ['Pilote confirmé', 250], ['Chef de patrouille', 500],
  ['Chef d\'escadrille', 900], ['Commandant', 1500], ['Chef d\'escadre', 2400], ['Commandant de l\'air', 3600],
];

// id, title, why (one short line), icon (public/game.js draws it), test over the events → the time it was won, or null
const nth = (list, n) => (list.length >= n ? list[n - 1].at : null);
export const BADGES = [
  ['first-escadrille', 'Première planification', 'Une planification créée', 'plane', (e) => nth(e.escadrille, 1)],
  ['first-merge', 'Première fusion', 'Une session fusionnée', 'merge', (e) => nth(e.merge, 1)],
  ['night', 'Nuit blanche pour Claude, pas pour toi', 'Une session finie entre 0 h et 6 h', 'moon', (e) => nth(e.night, 1)],
  ['first-review', 'Premier regard', 'Une revue terminée', 'eye', (e) => nth(e.review, 1)],
  ['reviewer', 'Relecteur', '10 revues terminées', 'eye', (e) => nth(e.review, 10)],
  ['strict', 'Exigeant', 'Une revue stricte terminée', 'shield', (e) => nth(e.review.filter((r) => r.strict), 1)],
  ['architect', 'Gardien de l\'architecture', 'Une revue avant la fusion', 'map', (e) => nth(e.reviewBeforeMerge, 1)],
  ['resolved', 'Rien en suspens', '10 commentaires résolus', 'check', (e) => nth(e.resolved, 10)],
  ['frugal', 'Frugal', 'Un plan sous 80 % du budget', 'leaf', (e) => nth(e.plan.filter((p) => p.ratio <= 0.8), 1)],
  ['autopilot', 'Pilote automatique', 'Un plan fini sans intervention', 'compass', (e) => nth(e.unattended, 1)],
  ['zero-red', 'Zéro rouge', '10 fusions sans erreur', 'target', (e) => nth(e.merge.filter((m) => !m.errored), 10)],
  ['relay', 'Relais', 'Une passation menée au bout', 'relay', (e) => nth(e.handoff, 1)],
  ['rule', 'Règle d\'or', 'Une règle dans docs/regles.md', 'book', (e) => nth(e.rule, 1)],
  ['squadron', 'Escadre', 'Un plan de 10 sessions fini', 'grid', (e) => nth(e.plan.filter((p) => p.sessions >= 10), 1)],
  ['steady', 'Régulier', 'Une série de 7 jours', 'flame', (e) => e.streakAt7],
];

const tableExists = (db, t) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
const columns = (db, t) => new Set(db.prepare(`pragma table_info(${t})`).all().map((c) => c.name));
const byAt = (a, b) => ms(a.at) - ms(b.at);

// The rules of the developer: one bullet of <project>/docs/regles.md each, dated by the file
const rulesOf = (file) => {
  if (!file || !existsSync(file)) return [];
  let at, text; try { at = statSync(file).mtime.toISOString(); text = readFileSync(file, 'utf8'); } catch { return []; } // unreadable: no rule counted
  return text.split('\n').filter((l) => /^\s*[-*] \S/.test(l)).map(() => ({ at }));
};

const budgetOf = (plan, s, dflt) => (Number.isFinite(s?.budget) && s.budget > 0 ? s.budget : Number.isFinite(plan?.budget) && plan.budget > 0 ? plan.budget : dflt);

// Every event that earns XP or counts for an achievement, ascending in time
export const eventsOf = (db, { project = null, rulesFile = null, defaultBudget = 5, reviewLevel = null } = {}) => {
  const hasProject = columns(db, 'plans').has('project');
  const plans = db.prepare('select id, title, json' + (hasProject ? ', project' : '') + ' from plans').all()
    .map((p) => ({ ...p, json: parse(p.json, {}) }))
    .filter((p) => !project || (p.project || p.json.project) === project);
  const ids = new Set(plans.map((p) => p.id));
  const sessions = db.prepare('select * from sessions').all().filter((s) => ids.has(s.plan));
  const logs = tableExists(db, 'log') ? db.prepare('select plan, session, at, status, health, claude from log order by seq').all().filter((l) => ids.has(l.plan)) : [];
  const logOf = (plan, sid) => logs.filter((l) => l.plan === plan && l.session === sid);
  const e = { escadrille: [], merge: [], night: [], review: [], reviewBeforeMerge: [], resolved: [], viewed: [], plan: [], unattended: [], handoff: [], rule: [] };

  if (tableExists(db, 'escadrilles')) for (const x of db.prepare('select id, title, project, created, at from escadrilles').all())
    if (!project || x.project === project) e.escadrille.push({ at: x.created || x.at, ref: x.title || x.id });

  const mergedAt = new Map();
  for (const s of sessions) {
    const L = logOf(s.plan, s.id); const wt = parse(s.worktree); const handoffs = parse(s.handoffs, []);
    const errored = s.health === 'error' || L.some((l) => l.health === 'error');
    const doneAt = L.find((l) => l.status === 'done')?.at || (s.status === 'done' ? s.at : null);
    if (wt?.merged) {
      const at = L.find((l) => /^(Fusionnée|⟦srv\.s\.mergedState)/.test(l.claude || ''))?.at || doneAt || s.at;
      mergedAt.set(`${s.plan}/${s.id}`, at);
      e.merge.push({ at, ref: `${s.plan}/${s.id}`, name: s.name || s.id, errored, xp: XP.merge });
    }
    if (doneAt && s.status === 'done') {
      const h = new Date(doneAt).getHours(); if (h < 6) e.night.push({ at: doneAt, ref: `${s.plan}/${s.id}` });
      if (handoffs.length) e.handoff.push(...handoffs.map((x) => ({ at: x.at || doneAt, ref: `${s.plan}/${s.id}`, xp: XP.handoff })));
    }
  }

  for (const p of plans) {
    const mine = sessions.filter((s) => s.plan === p.id); const list = p.json.sessions || [];
    if (!mine.length || !mine.every((s) => s.status === 'done')) continue;
    const budget = list.reduce((a, s) => a + budgetOf(p.json, s, defaultBudget), 0) || mine.length * defaultBudget;
    const cost = mine.reduce((a, s) => a + (Number(parse(s.usage)?.cost) || 0), 0);
    const at = mine.map((s) => logOf(p.id, s.id).find((l) => l.status === 'done')?.at || s.at).sort().pop();
    const saved = Math.max(0, budget - cost);
    const under = cost <= budget;
    e.plan.push({ at, ref: p.id, name: p.title || p.id, sessions: mine.length, ratio: budget ? cost / budget : 1, cost, budget,
      xp: under ? XP.underBudget + Math.min(XP.savedCap, Math.floor(saved * 10 + 1e-9) * XP.savedPer10c) : 0 });
    let unattended = null; try { unattended = planMetrics({ db, planId: p.id }).unattended; } catch {}
    if (unattended) e.unattended.push({ at, ref: p.id, xp: XP.unattended });
  }

  if (tableExists(db, 'reviews')) {
    const rs = db.prepare('select * from reviews where verdict_at is not null').all().filter((r) => !project || !r.project || r.project === project);
    for (const r of rs) {
      const strict = r.level === 'strict' || (!r.level && reviewLevel === 'strict');
      e.review.push({ at: r.verdict_at, ref: r.id, strict, xp: strict ? XP.reviewStrict : XP.review });
      const m = r.plan && r.session ? mergedAt.get(`${r.plan}/${r.session}`) : null;
      if (m && ms(r.verdict_at) <= ms(m)) e.reviewBeforeMerge.push({ at: r.verdict_at, ref: r.id });
    }
    const keep = new Set(db.prepare('select id, project from reviews').all().filter((r) => !project || !r.project || r.project === project).map((r) => r.id));
    if (tableExists(db, 'review_viewed')) {
      const per = new Map();
      for (const v of db.prepare('select review, path, at from review_viewed order by at').all()) {
        if (!keep.has(v.review)) continue; const n = (per.get(v.review) || 0) + 1; per.set(v.review, n);
        if (n <= XP.viewedCap) e.viewed.push({ at: v.at, ref: `${v.review}:${v.path}`, xp: XP.viewed });
      }
    }
    if (tableExists(db, 'review_comments')) for (const c of db.prepare('select id, review, at from review_comments where resolved = 1').all())
      if (keep.has(c.review)) e.resolved.push({ at: c.at, ref: `${c.review}#${c.id}`, xp: XP.resolved });
  }

  e.rule = rulesOf(rulesFile).map((r, i) => ({ ...r, ref: `rule-${i + 1}`, xp: XP.rule }));
  for (const k of Object.keys(e)) e[k].sort(byAt);
  return e;
};

// Local day key, Monday-first weeks
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mondayOf = (d) => { const m = new Date(d); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };
const weekKey = (d) => dayKey(mondayOf(d));

// The streak, forgiving: one empty day per week is frozen on its own; today never breaks it (it is not over)
export const streakOf = (days, now = new Date()) => {
  const has = new Set(days); const d = new Date(now); d.setHours(12, 0, 0, 0);
  const frozenWeeks = new Set(); let n = 0, frozen = 0, kept = 0;
  if (!has.has(dayKey(d))) d.setDate(d.getDate() - 1); else { n++; d.setDate(d.getDate() - 1); }
  for (let i = 0; i < 400; i++) {
    if (has.has(dayKey(d))) { n++; kept = frozen; }
    else if (!frozenWeeks.has(weekKey(d)) && n > 0) { frozenWeeks.add(weekKey(d)); frozen++; }
    else break;
    d.setDate(d.getDate() - 1);
  }
  return { days: n, frozen: kept };
};
// The day a streak first reached 7, for the achievement (retroactive, same freeze rule)
const streak7At = (days) => {
  const sorted = [...new Set(days)].sort();
  for (const k of sorted) { const [y, m, dd] = k.split('-').map(Number); if (streakOf(sorted.filter((x) => x <= k), new Date(y, m - 1, dd, 23)).days >= 7) return new Date(y, m - 1, dd, 23).toISOString(); }
  return null;
};

export const rankOf = (xp) => {
  let i = 0; while (i + 1 < RANKS.length && xp >= RANKS[i + 1][1]) i++;
  const [title, from] = RANKS[i]; const nx = RANKS[i + 1] || null;
  return { level: i + 1, rank: title, from, next: nx ? { rank: nx[0], xp: nx[1] } : null };
};

export const levelOf = (db, opts = {}) => {
  const now = opts.now ? new Date(opts.now) : new Date();
  const e = eventsOf(db, opts);
  const earning = [...e.merge, ...e.review, ...e.viewed, ...e.resolved, ...e.plan.filter((p) => p.xp), ...e.unattended, ...e.handoff, ...e.rule].filter((x) => x.at).sort(byAt);
  const xp = earning.reduce((a, x) => a + x.xp, 0);
  const days = earning.map((x) => dayKey(new Date(x.at)));
  e.streakAt7 = streak7At(days);
  const badges = BADGES.map(([id, title, why, icon, test]) => ({ id, title, why, icon, at: test(e) || null }));
  const monday = mondayOf(now).getTime(); const thisWeek = (l) => l.filter((x) => ms(x.at) >= monday);
  const quests = [
    { id: 'reviews', title: 'Relis 3 revues', done: Math.min(3, thisWeek(e.review).length), of: 3 },
    { id: 'budget', title: 'Finis un plan sous budget', done: Math.min(1, thisWeek(e.plan.filter((p) => p.xp)).length), of: 1 },
    { id: 'rule', title: 'Ajoute une règle', done: Math.min(1, thisWeek(e.rule).length ? 1 : 0), of: 1 },
  ];
  const r = rankOf(xp);
  return {
    xp, level: r.level, rank: r.rank, from: r.from, next: r.next,
    badges,
    week: { xp: thisWeek(earning).reduce((a, x) => a + x.xp, 0), quests, streak: streakOf(days, now) },
    recent: earning.slice(-20).reverse().map((x) => ({ at: x.at, xp: x.xp, ref: x.ref, kind: Object.keys(e).find((k) => Array.isArray(e[k]) && e[k].includes(x)) })),
  };
};

// What one plan brings: earned so far, and what is left to win (merges, under budget, unattended)
export const planXp = (db, planId, { defaultBudget = 5 } = {}) => {
  const row = db.prepare('select json from plans where id = ?').get(planId); if (!row) return null;
  const plan = parse(row.json, {}); const sessions = db.prepare('select * from sessions where plan = ?').all(planId);
  const e = eventsOf(db, { defaultBudget }); const mine = (l) => l.filter((x) => x.ref === planId || String(x.ref).startsWith(planId + '/'));
  const earned = [...mine(e.merge), ...mine(e.plan), ...mine(e.unattended), ...mine(e.handoff)].reduce((a, x) => a + (x.xp || 0), 0);
  const left = sessions.filter((s) => !parse(s.worktree)?.merged).length * XP.merge;
  const finished = sessions.length && sessions.every((s) => s.status === 'done');
  const potential = earned + left + (finished ? 0 : XP.underBudget + XP.unattended);
  return { earned, potential, sessions: (plan.sessions || []).length };
};

export const gameOn = (settings) => settings?.game !== false;
export const rulesFileOf = (project) => (project ? path.join(project, 'docs', 'regles.md') : null);
