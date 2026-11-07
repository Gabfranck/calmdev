// What Escadrille learns from its own use, project by project (docs/learning.md). Nothing is stored twice:
// the registry is computed from the base (plans, sessions, reviews, planning questions, the developer's
// messages) and from the project's docs/backlog.md; the only file it writes is the distilled
// <project>/.escadrille/preferences.md, with its small state beside it (.escadrille/learning.json).
//
//   kindOf(session)                    'front' | 'back' | 'migration' | 'design' | 'docs' | 'tests' | 'qa' | 'other'
//   registryOf({ db, project, transcripts?, now? })   the registry of a project (docs/learning.md « Le registre »)
//   gapsOf(registry)                   the learned estimate gaps: [{ kind, model, ratio, sessions }], sessions >= GAP_MIN_SESSIONS
//   adjusterOf(registry)               (session) => { kind, model, ratio, sessions } | null, for estimatePlan's `adjust`
//   parseAnswer(text, count)           Map n -> { accepted, text } read from the developer's answer to a questions block
//   readPreferences(project)           { file, exists, lines: [{ text, source: 'dev' | 'distilled' }], at }
//   distillDue({ registry, state, now }) { due, reason, newResults, nextAt }
//   distillPrompt(registry, prefs, state) the turn sent to the distilling session
//   acceptLines(lines, { dev, max })   the distilled lines kept: one proof each, no duplicate of a developer line
//   writePreferences(project, { dev, lines, now }) writes the file and the state (hashes of the lines written)
//   distill({ db, project, start, registry?, now?, timeoutMs? })  one distilling session; resolves { ok, lines, cost, error? }
//   learningSection(project, registry?) the section appended to the planner's prompt ('' when nothing is learned)
//   learningReport({ db, project, transcripts? })  GET /api/learning
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { estimateSession, median, quantile, canonicalModel, scanTranscripts } from './usage.mjs';
import { contextReport } from './context.mjs';
import { BACKLOG } from './burst.mjs';
import { projectRel } from './names.mjs';

// ---------------------------------------------------------------- the thresholds, said in the code
export const DISTILL_MODEL = 'claude-sonnet-5-5';
export const DISTILL_BUDGET_USD = 1;
export const DISTILL_EVERY_MS = 7 * 24 * 3600e3; // at most once a week per project
export const DISTILL_MIN_RESULTS = 5;            // new results (finished sessions, verdicts, answered questions) since the last one
export const MAX_LINES = 15;
export const GAP_MIN_SESSIONS = 3;               // an estimate gap is learned from three sessions with both figures
export const GAP_MIN = 0.25, GAP_MAX = 4;        // and applied within these bounds
export const REPEAT_MIN = 2;                     // a question asked twice is a repeated one
export const PREFS_FILE = projectRel('preferences.md');
export const STATE_FILE = projectRel('learning.json');
// A distilled line ends with its proof, which holds a figure: « - Le front sur Opus suffit (preuve : 9 sessions, 8 approuvées du premier coup) »
export const PROOF = /\(preuve\s*:\s*[^)]*\d[^)]*\)\s*$/i;

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const parse = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const hash = (s) => createHash('sha1').update(String(s).trim()).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- the kind of a task
export const KINDS = ['front', 'back', 'migration', 'design', 'docs', 'tests', 'qa', 'other'];
// The name of the session says its role and decides when it names one (three points a word); otherwise its brief
// does, by its words and the paths it names. The docs every brief tells to read (docs/flot.md, CLAUDE.md…) are not
// a docs task: in a brief only README, CHANGELOG and the like count for docs.
const WORDS = {
  migration: /\b(migrations?|schema de (la )?base|knex|prisma|alter table|sql)\b/g,
  design: /\b(design|maquettes?|planches?|logos?|visuels?|avatars?|dessins?|charte|typo\w*|palette|esthetique|direction artistique|passe|polish|sombre|wahou)\b/g,
  qa: /\b(verif\w*|fusions?|merge|qa|recette|revues? d.expert|relecture|integration|essai|audit)\b/g,
  tests: /\b(tests?|e2e|couverture|verificateur|fixtures?)\b/g,
  docs: /\b(docs?|documentation|guides?|readme|changelog|contributing|redige\w*|comm|recits?|bilan|roadmap|kit|post|video)\b/g,
  front: /\b(ecrans?|pages?|front\w*|ui|ux|interface|composants?|react|expo|telephone|phone|clavier|css|accueil|barre|selecteur|flot|vues?|onglets?|dictee|fenetre|landing|formules a l.ecran|cote page|app)\b/g,
  back: /\b(serveur|server|api|routes?|back\w*|registre|endpoints?|base de donnees|sqlite|estimation|planificateur|pilote|garde\w*|rafale|limites|pause|robustesse|budget|reprise|connecteurs|memoire|projets|gabarits|modeles|release|autonomie|regle|captures?|journal|usage|apprendre|backlog|defauts|playbooks|cote serveur|plan en cours)\b/g,
};
const BRIEF_WORDS = { ...WORDS, docs: /\b(readme|changelog|contributing|documentation)\b/g };
const PATHS = {
  migration: /(^|[\s`(])[\w./-]*(migrations?\/|\.sql\b)/g,
  design: /(^|[\s`(])[\w./-]*(design-system\/|\.svg\b|\.css\b)/g,
  tests: /(^|[\s`(])[\w./-]*(test\/|\.test\.\w+|\.spec\.\w+)/g,
  docs: /(^|[\s`(])[\w./-]*(README\.md|CHANGELOG\.md|CONTRIBUTING\.md)/g,
  front: /(^|[\s`(])[\w./-]*(public\/|components?\/|phone\/|\.html\b|\.tsx\b|\.jsx\b|\.vue\b|\.svelte\b)/g,
  back: /(^|[\s`(])[\w./-]*(server\.mjs|lib\/|api\/|routes\/|\.sql\b)/g,
};
const TIE = ['migration', 'design', 'qa', 'tests', 'docs', 'front', 'back'];
const count = (re, s) => (re ? (String(s).match(re) || []).length : 0);
const pick = (score) => { let best = 'other', top = 0; for (const k of TIE) { const v = score(k); if (v > top) { best = k; top = v; } } return best; };
export const kindOf = (session = {}) => {
  const name = fold(session.name || session.title || session.id);
  const brief = String(session.prompt || '').slice(0, 4000);
  const words = fold(brief);
  const fromBrief = (k) => Math.min(4, count(BRIEF_WORDS[k], words)) + Math.min(4, count(PATHS[k], brief));
  const inName = (k) => 3 * count(WORDS[k], name);
  return TIE.some((k) => inName(k) > 0) ? pick((k) => inName(k) + fromBrief(k) / 10) : pick(fromBrief);
};

// ---------------------------------------------------------------- the developer's answers to the planner's questions
// « ok pour tout », « ok pour tout sauf : 6. … », « Réponses : 1. Oui … 2. … » → n -> { accepted, text }
export const parseAnswer = (text, total = 0) => {
  const out = new Map(); const t = String(text ?? '');
  const all = /\b(ok|oui|d'accord|d’accord|go|valide)\b[^.\n]{0,20}\bpour tout\b|\btelles quelles\b|\btel quel\b/i.test(t);
  const parts = [...t.matchAll(/(?:^|[\n;:]|[.!)]\s)\s*(\d{1,2})\s*[.)]\s+/g)].filter((m) => !total || (+m[1] >= 1 && +m[1] <= total));
  const segs = parts.map((m, i) => ({ n: +m[1], text: t.slice(m.index + m[0].length, i + 1 < parts.length ? parts[i + 1].index : undefined).trim() }));
  if (all) for (let n = 1; n <= total; n++) out.set(n, { accepted: true, text: '' });
  const sauf = /\bsauf\b/i.test(t);
  for (const s of segs) {
    const yes = /^(oui|ok|d'accord|d’accord|valide|tel quel|telle quelle|tels quels|telles quelles)\b/i.test(s.text);
    const accepted = yes || (all && !sauf);
    out.set(s.n, { accepted, text: accepted ? '' : s.text.replace(/\s+/g, ' ').slice(0, 300) });
  }
  return out;
};
const STOP = new Set('le la les l un une des de du d et ou a au aux en dans sur pour par avec sans ce ces cette qui que quoi quel quelle quels quelles est sont tu ton ta tes on se il elle the of to and'.split(' '));
const tokens = (s) => new Set(fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const sameQuestion = (a, b) => { const t = jaccard(a.titleTokens, b.titleTokens); return (t >= 0.6 && a.titleTokens.size > 0) || jaccard(a.questionTokens, b.questionTokens) >= 0.45; };

// ---------------------------------------------------------------- the defects reported in the backlog
const DEFECT = /^\s*- \[( |x|X)\] Défaut(?: \(([^)]*)\))? : (.+)$/;
export const defectsOf = (project) => {
  let text = ''; try { text = readFileSync(path.join(project, BACKLOG), 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.match(DEFECT)).filter(Boolean).map((m) => ({ done: m[1] !== ' ', screen: m[2] || null, text: m[3].trim() }));
};

// ---------------------------------------------------------------- the registry
const stats = (xs) => { xs = xs.filter((x) => Number.isFinite(x)); return xs.length ? { median: round(median(xs), 2), p25: round(quantile(xs, 0.25), 2), p75: round(quantile(xs, 0.75), 2), spread: round(quantile(xs, 0.75) - quantile(xs, 0.25), 2) } : { median: null, p25: null, p75: null, spread: null }; };
// The transcripts the estimate reads; when the folder cannot be read (a copy of the base, a sandbox), the cache in the base
export const transcriptsOf = (db) => {
  let list = []; try { list = scanTranscripts({ db }); } catch {}
  if (list.length || !db) return list;
  try { return db.prepare('select json from transcripts').all().map((r) => parse(r.json)).filter((s) => s && s.tokens > 0); } catch { return []; }
};
const inProject = (project) => (p) => p === project || (p && project && p.startsWith(project.replace(/\/$/, '') + '/.claude/worktrees/'));

export const registryOf = ({ db, project, transcripts, now = Date.now() } = {}) => {
  const plans = db.prepare('select id, created, project, json from plans').all().map((r) => ({ ...r, plan: parse(r.json, {}) }))
    .filter((r) => inProject(project)(r.project || r.plan.project));
  const ids = new Set(plans.map((p) => p.id));
  const all = (q, ...a) => { try { return db.prepare(q).all(...a); } catch { return []; } };
  const rows = all('select plan, id, status, usage, at from sessions').filter((r) => ids.has(r.plan));
  const reviews = all("select id, plan, session, verdict, body, retries, escalated, kind, verdict_at, at from reviews where kind = 'code' or kind is null").filter((r) => ids.has(r.plan));
  const comments = all('select review, body from review_comments');
  const devs = all("select plan, session, text, at from session_messages where role = 'dev'").filter((r) => ids.has(r.plan));
  const pool = transcripts || (db ? transcriptsOf(db) : []);

  // One line per launched session of the project
  const sessions = [];
  for (const p of plans) for (const s of p.plan.sessions || []) {
    const row = rows.find((r) => r.plan === p.id && r.id === s.id); if (!row) continue;
    const usage = parse(row.usage, {}) || {};
    const model = canonicalModel(s.model || p.plan.model || null);
    const mine = reviews.filter((r) => r.session === s.id && r.plan === p.id);
    const judged = mine.filter((r) => r.verdict && r.verdict !== 'comment');
    const first = judged.sort((a, b) => String(a.verdict_at || a.at).localeCompare(String(b.verdict_at || b.at)))[0];
    // What the estimate said when the plan was written: the same computation on the transcripts that existed then
    const before = p.created ? pool.filter((t) => String(t.lastAt) < p.created) : [];
    const estimate = before.length ? estimateSession(s, p.plan, { sessions: before }).cost : null;
    sessions.push({
      plan: p.id, id: s.id, name: s.name || s.id, kind: kindOf(s), model, status: row.status, at: row.at || p.created,
      budget: Number.isFinite(s.budget) ? s.budget : null, cost: Number.isFinite(usage.cost) && usage.cost > 0 ? round(usage.cost, 4) : null, estimate: round(estimate, 4),
      reviewed: !!first, firstTry: first ? first.verdict === 'approve' && !(first.retries > 0) : null,
      retries: mine.reduce((n, r) => n + (r.retries || 0), 0), escalated: mine.some((r) => r.escalated), corrections: devs.filter((d) => d.session === s.id && d.plan === p.id).length,
    });
  }
  const finished = sessions.filter((s) => s.status === 'done');

  // By kind and model
  const groups = new Map();
  for (const s of finished) { const k = `${s.kind}|${s.model}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const byKind = [...groups].map(([k, xs]) => {
    const [kind, model] = k.split('|');
    const both = xs.filter((s) => s.cost != null && s.estimate > 0);
    const reviewed = xs.filter((s) => s.reviewed);
    return {
      kind, model: model === 'null' ? null : model, sessions: xs.length,
      cost: stats(xs.map((s) => s.cost)), estimate: stats(xs.map((s) => s.estimate)), budget: stats(xs.map((s) => s.budget)),
      ratio: { median: both.length ? round(median(both.map((s) => s.cost / s.estimate)), 3) : null, sessions: both.length },
      budgetUse: round(median(xs.filter((s) => s.cost != null && s.budget > 0).map((s) => s.cost / s.budget)), 3),
      reviewed: reviewed.length, firstTry: reviewed.filter((s) => s.firstTry).length, firstTryRate: reviewed.length ? round(reviewed.filter((s) => s.firstTry).length / reviewed.length, 3) : null,
      retries: xs.reduce((n, s) => n + s.retries, 0), escalated: xs.filter((s) => s.escalated).length, corrections: stats(xs.map((s) => s.corrections)).median,
    };
  }).sort((a, b) => b.sessions - a.sessions);

  // The planner's questions and the developer's answers, grouped when the same question comes back
  const escs = all('select id, created from escadrilles where project = ?', project);
  const asked = [];
  for (const e of escs) {
    const msgs = all('select seq, role, text, data, at from messages where escadrille = ? order by seq', e.id);
    msgs.forEach((m, i) => {
      if (m.role !== 'questions') return;
      const items = parse(m.data, {})?.items || [];
      const reply = msgs.slice(i + 1).find((x) => x.role === 'user');
      const answers = reply ? parseAnswer(reply.text, items.length) : new Map();
      for (const q of items) {
        const a = answers.get(q.n);
        asked.push({ escadrille: e.id, at: m.at, title: q.title || '', question: q.question || '', recommendation: q.recommendation || '', answered: !!a, accepted: a ? a.accepted : null, answer: a ? (a.accepted ? q.recommendation || '' : a.text) : null, titleTokens: tokens(q.title), questionTokens: tokens(q.question) });
      }
    });
  }
  const clusters = [];
  for (const q of asked) { const c = clusters.find((c) => sameQuestion(c[0], q)); if (c) c.push(q); else clusters.push([q]); }
  const questions = clusters.filter((c) => c.length >= REPEAT_MIN).map((c) => {
    const ans = c.filter((q) => q.answered);
    const last = ans[ans.length - 1] || null;
    return { title: c[0].title, question: c[c.length - 1].question, asked: c.length, answered: ans.length, accepted: ans.filter((q) => q.accepted).length, overridden: ans.filter((q) => !q.accepted).length, last: last ? { at: last.at, accepted: last.accepted, answer: String(last.answer || '').slice(0, 300) } : null, settled: ans.length >= REPEAT_MIN && ans.every((q) => q.accepted === ans[0].accepted) };
  }).sort((a, b) => b.asked - a.asked);

  // What the review refused, and why
  const refused = reviews.filter((r) => ['reject', 'changes', 'retry'].includes(r.verdict) || r.escalated).map((r) => {
    const s = sessions.find((x) => x.plan === r.plan && x.id === r.session);
    return { plan: r.plan, session: r.session, kind: s?.kind || null, model: s?.model || null, verdict: r.verdict, escalated: !!r.escalated, retries: r.retries || 0, at: r.verdict_at || r.at, body: String(r.body || '').slice(0, 300), comments: comments.filter((c) => c.review === r.id).map((c) => String(c.body || '').slice(0, 200)).slice(0, 5) };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const verdicts = {}; for (const r of reviews) if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;

  const defects = defectsOf(project);
  const byScreen = {}; for (const d of defects) { const k = d.screen || '—'; byScreen[k] = (byScreen[k] || 0) + 1; }
  const corrections = devs.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20).map((d) => ({ plan: d.plan, session: d.session, kind: sessions.find((s) => s.plan === d.plan && s.id === d.session)?.kind || null, at: d.at, text: String(d.text || '').replace(/\s+/g, ' ').slice(0, 200) }));
  // A result: a finished session, a verdict, an answered question; the distillation counts them
  const results = finished.length + Object.values(verdicts).reduce((a, b) => a + b, 0) + asked.filter((q) => q.answered).length;
  return {
    project, at: new Date(now).toISOString(), results,
    totals: { plans: plans.length, sessions: sessions.length, finished: finished.length, withCost: finished.filter((s) => s.cost != null).length, cost: round(finished.reduce((a, s) => a + (s.cost || 0), 0), 2), questions: asked.length, answered: asked.filter((q) => q.answered).length, reviews: reviews.length, defects: defects.length, corrections: devs.length },
    byKind, questions, refusals: { verdicts, items: refused.slice(0, 20) },
    defects: { total: defects.length, open: defects.filter((d) => !d.done).length, byScreen, recent: defects.slice(-10).reverse() },
    corrections, sessions,
  };
};

// ---------------------------------------------------------------- the learned estimate gap
export const gapsOf = (registry) => (registry?.byKind || []).filter((g) => g.ratio.sessions >= GAP_MIN_SESSIONS && g.ratio.median > 0)
  .map((g) => ({ kind: g.kind, model: g.model, ratio: round(Math.min(GAP_MAX, Math.max(GAP_MIN, g.ratio.median)), 3), sessions: g.ratio.sessions }));
export const adjusterOf = (registry) => {
  const gaps = gapsOf(registry); if (!gaps.length) return null;
  return (session, plan = {}) => { const kind = kindOf(session); const model = canonicalModel(session.model || plan.model || null); return gaps.find((g) => g.kind === kind && g.model === model) || null; };
};

// ---------------------------------------------------------------- the preferences file
const HEAD = (name, date) => `# Préférences apprises : ${name}\n\nDistillées par calmdev depuis l'usage du projet le ${date} (docs/learning.md). Une ligne par préférence, chacune avec sa preuve.\nTu peux éditer ce fichier : tes lignes priment, elles ne sont jamais réécrites ; une ligne que tu retires n'est plus proposée.\n\n`;
// A file that exists but cannot be read (a sandbox that denies the project's folder) is told, never thrown:
// the registry still answers, the page says the file is unreadable
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? null : { error: e.code || e.message }; } };
const readState = (project) => { const t = readText(path.join(project, STATE_FILE)); return (typeof t === 'string' ? parse(t, {}) : null) || {}; };
export const stateOf = readState;
export const readPreferences = (project) => {
  const file = path.join(project, PREFS_FILE); const state = readState(project); const written = new Set(state.written || []);
  const text = readText(file);
  if (text == null) return { file, exists: false, lines: [], at: null };
  if (typeof text !== 'string') return { file, exists: true, unreadable: text.error, lines: [], at: null };
  const lines = text.split('\n').filter((l) => /^\s*[-*] /.test(l)).map((l) => l.replace(/^\s*[-*] /, '').trim()).filter(Boolean)
    .map((text) => ({ text, source: written.has(hash(text)) ? 'distilled' : 'dev' }));
  return { file, exists: true, lines, at: statSync(file).mtime.toISOString() };
};
export const acceptLines = (lines, { dev = [], removed = [], max = MAX_LINES } = {}) => {
  // the same preference whatever its proof: a developer's line, or a removed one, keeps its place
  const key = (t) => fold(String(t).replace(PROOF, '')).replace(/\W+/g, ' ').trim();
  const seen = new Set([...dev, ...removed].map(key));
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const text = String(raw ?? '').replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300 || !PROOF.test(text)) continue; // never a line without its proof
    const k = key(text); if (seen.has(k)) continue; seen.add(k);
    out.push(text); if (out.length + dev.length >= max) break;
  }
  return out;
};
// The file as the developer rewrote it on the Apprentissage screen (phase 11 PX): one line per preference, in his
// order, at most MAX_LINES; the state is not touched, so a distilled line he kept stays marked as Escadrille's and
// a line he dropped is seen as removed by the next distillation. Returns readPreferences().
export const savePreferences = (project, input, { now = Date.now() } = {}) => {
  const raw = Array.isArray(input) ? input : String(input ?? '').split('\n');
  const lines = raw.map((l) => String(l ?? '').replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, MAX_LINES);
  const file = path.join(project, PREFS_FILE); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, HEAD(path.basename(project), new Date(now).toISOString().slice(0, 10)) + lines.map((l) => `- ${l}`).join('\n') + (lines.length ? '\n' : ''));
  return readPreferences(project);
};
export const writePreferences = (project, { dev = [], lines = [], removed = [], results = 0, now = Date.now() } = {}) => {
  const file = path.join(project, PREFS_FILE); mkdirSync(path.dirname(file), { recursive: true });
  const date = new Date(now).toISOString().slice(0, 10);
  writeFileSync(file, HEAD(path.basename(project), date) + [...dev, ...lines].slice(0, MAX_LINES).map((l) => `- ${l}`).join('\n') + '\n');
  const state = { distilledAt: new Date(now).toISOString(), results, written: lines.map(hash), lines, removed: removed.slice(-50) };
  writeFileSync(path.join(project, STATE_FILE), JSON.stringify(state, null, 1) + '\n');
  return { file, state };
};

// ---------------------------------------------------------------- the distillation
export const distillDue = ({ registry, state = {}, now = Date.now() } = {}) => {
  const last = state.distilledAt ? Date.parse(state.distilledAt) : 0;
  const newResults = Math.max(0, (registry?.results || 0) - (state.results || 0));
  const nextAt = last ? new Date(last + DISTILL_EVERY_MS).toISOString() : null;
  if (last && now - last < DISTILL_EVERY_MS) return { due: false, reason: 'week', newResults, nextAt };
  if (newResults < DISTILL_MIN_RESULTS) return { due: false, reason: 'results', newResults, nextAt };
  return { due: true, reason: '', newResults, nextAt };
};
// The registry said compactly for the distilling session: figures, no prompts
const compact = (r) => ({
  byKind: r.byKind.map((g) => ({ kind: g.kind, model: g.model, sessions: g.sessions, costMedian: g.cost.median, costP25: g.cost.p25, costP75: g.cost.p75, estimateMedian: g.estimate.median, realOverEstimate: g.ratio.median, withBoth: g.ratio.sessions, budgetMedian: g.budget.median, budgetUse: g.budgetUse, reviewed: g.reviewed, firstTry: g.firstTry, retries: g.retries, escalated: g.escalated })),
  questions: r.questions.map((q) => ({ title: q.title, asked: q.asked, answered: q.answered, accepted: q.accepted, overridden: q.overridden, settled: q.settled, lastAnswer: q.last?.answer || null })),
  refusals: r.refusals, defects: { total: r.defects.total, open: r.defects.open, byScreen: r.defects.byScreen, recent: r.defects.recent.map((d) => d.text) },
  corrections: r.corrections.slice(0, 10).map((c) => `${c.kind || '?'} : ${c.text}`),
});
export const DISTILL_SYSTEM = `Tu distilles ce que calmdev a appris de l'usage d'un projet en préférences pour son planificateur. Tu ne lis rien, tu n'écris rien : tout est dans le message.

Règles :
- Au plus ${MAX_LINES} lignes en tout, lignes du développeur comprises ; chacune concrète, en français, et utile à un choix du planificateur : le modèle d'un type de tâche, le plafond en dollars, une question qu'il n'a plus à poser (et sa réponse), ce que la revue refuse, un défaut qui revient.
- Chaque ligne finit par sa preuve entre parenthèses, avec les chiffres du registre : « Le front sur Opus suffit (preuve : 9 sessions, 8 approuvées du premier coup, médiane 6,10 $) ». Pas de chiffre, pas de ligne. N'invente aucun chiffre.
- Les lignes du développeur priment : ne les répète pas, ne les contredis pas. Ne repropose aucune ligne qu'il a retirée.
- Réponds par un seul bloc, une ligne de JSON :
\`\`\`escadrille:preferences
{"lines":["…"]}
\`\`\``;
export const distillPrompt = (registry, prefs = { lines: [] }, state = {}) => {
  const dev = prefs.lines.filter((l) => l.source === 'dev').map((l) => l.text);
  return `Projet : ${registry.project}\n\nLignes du développeur (elles restent telles quelles) :\n${dev.length ? dev.map((l) => '- ' + l).join('\n') : '(aucune)'}\n\nLignes qu'il a retirées (ne pas reproposer) :\n${(state.removed || []).length ? state.removed.map((l) => '- ' + l).join('\n') : '(aucune)'}\n\nLe registre :\n${JSON.stringify(compact(registry))}`;
};
// The ```escadrille:preferences block of a text, its lines; null when absent or unreadable (lib/blocks.mjs keeps the
// planner's own kinds, this one is read here)
export const preferencesBlock = (text) => {
  const m = String(text ?? '').match(/```escadrille:preferences[ \t]*\n([\s\S]*?)\n?```/); if (!m) return null;
  const v = parse(m[1].trim()); return v && Array.isArray(v.lines) ? v.lines : null;
};
// One distilling session: `start` is lib/planner.mjs's startPlanner (read-only, never asks), Sonnet, capped at one dollar
export const distill = ({ db, project, start, registry, now = Date.now(), timeoutMs = 5 * 60e3, claude } = {}) => new Promise((resolve) => {
  const reg = registry || registryOf({ db, project, now });
  const prefs = readPreferences(project); const state = readState(project);
  // A line Escadrille wrote that is gone from the file: the developer removed it
  const present = new Set(prefs.lines.map((l) => hash(l.text)));
  const goneHashes = (state.written || []).filter((h) => !present.has(h));
  const removed = [...(state.removed || []), ...(state.lines || []).filter((t) => goneHashes.includes(hash(t)))];
  const dev = prefs.lines.filter((l) => l.source === 'dev').map((l) => l.text);
  let done = false, cost = 0, lines = null, proc = null;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { proc?.stop(); } catch {} resolve(r); };
  const timer = setTimeout(() => finish({ ok: false, error: 'délai dépassé', lines: [], cost }), timeoutMs); timer.unref?.();
  try {
    proc = start({ cwd: project, model: DISTILL_MODEL, budget: DISTILL_BUDGET_USD, systemPrompt: DISTILL_SYSTEM, ...(claude ? { claude } : {}), onEvent: (e) => {
      if (e.type === 'text') { const found = preferencesBlock(e.text); if (found) lines = found; }
      else if (e.type === 'turn') {
        cost = e.cost || 0;
        if (!lines) return finish({ ok: false, error: 'pas de bloc escadrille:preferences', lines: [], cost });
        const kept = acceptLines(lines, { dev, removed });
        writePreferences(project, { dev, lines: kept, removed, results: reg.results, now });
        finish({ ok: true, lines: kept, dropped: lines.length - kept.length, cost });
      } else if (e.type === 'exit') finish({ ok: false, error: `la session s'est arrêtée (${e.code})`, lines: [], cost });
    } });
    proc.send(distillPrompt(reg, prefs, { ...state, removed }));
  } catch (err) { finish({ ok: false, error: err.message, lines: [], cost }); }
});

// ---------------------------------------------------------------- what the planner gets
const money = (x) => (x == null ? '?' : x.toFixed(2).replace('.', ',') + ' $');
export const learningSection = (project, registry = null) => {
  if (!project || !existsSync(project)) return '';
  const prefs = readPreferences(project);
  const gaps = registry ? gapsOf(registry) : [];
  if (!prefs.lines.length && !gaps.length) return '';
  const out = ['', '', '## Ce que calmdev a appris de ce projet', '',
    `Fichier : ${prefs.file} (les lignes du développeur priment). Tiens-en compte dans tes choix de modèles, de plafonds et de découpage. Une question dont la réponse est apprise ici ne se repose pas : rappelle la réponse dans ton plan (« Appris : … »). Quand une préférence change un choix que tu aurais fait autrement, dis-le en une ligne.`];
  if (prefs.lines.length) out.push('', ...prefs.lines.map((l) => `- ${l.text}${l.source === 'dev' ? ' [développeur]' : ''}`));
  if (gaps.length) out.push('', "L'écart appris entre l'estimation et le réel (déjà appliqué à l'estimation des plans) :", ...gaps.map((g) => `- ${g.kind} sur ${g.model} : réel = ${String(g.ratio).replace('.', ',')} × l'estimé (${g.sessions} sessions)`));
  return out.join('\n');
};

// ---------------------------------------------------------------- GET /api/learning
// `context`: the fixed context of the project's sessions (lib/context.mjs, docs/frugal.md « Le contexte fixe »), read
// from the same transcripts as the registry; a broken folder gives nulls, never breaks the page.
export const learningReport = ({ db, project, transcripts, now = Date.now(), running = false, home = undefined } = {}) => {
  const pool = transcripts || (db ? transcriptsOf(db) : []);
  const registry = registryOf({ db, project, transcripts: pool, now });
  const state = existsSync(project) ? readState(project) : {};
  const { sessions, ...rest } = registry;
  let context = null; try { context = contextReport({ sessions: pool, project, now, home }); } catch (e) { context = { tokens: null, sessions: 0, growth: null, alert: false, error: e.message }; }
  return {
    project, registry: rest, preferences: existsSync(project) ? readPreferences(project) : { file: path.join(project, PREFS_FILE), exists: false, lines: [], at: null },
    estimation: { gaps: gapsOf(registry), minSessions: GAP_MIN_SESSIONS, bounds: [GAP_MIN, GAP_MAX] },
    distill: { lastAt: state.distilledAt || null, ...distillDue({ registry, state, now }), threshold: DISTILL_MIN_RESULTS, everyDays: DISTILL_EVERY_MS / 864e5, model: DISTILL_MODEL, budget: DISTILL_BUDGET_USD, running },
    context,
  };
};
