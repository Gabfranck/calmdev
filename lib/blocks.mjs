// The planning session talks in prose and, when it is ready, in fenced blocks the server understands:
//   ```escadrille:plan      the plan, JSON in the format of plans/ (id, title, goal, waves, sessions)
//   ```escadrille:install   the plugins, skills and rules it proposes, a JSON list of { kind, name, why, how }
//   ```escadrille:questions the questions, a JSON list of { n, title, question, recommendation, why }
//   ```escadrille:state     what a launched session reports at the end of a turn: { stops, health, why, claude, done, summary? }
//   ```escadrille:pilot     the pilot's actions (docs/pilot.md); read only in the pilot's own stream
// This file finds those blocks in a message, validates them, and strips them from the prose. Each kind is also read
// under its new name, ```calmdev:plan, ```calmdev:state… (lib/names.mjs); the escadrille: forms stay accepted.

const OPEN = /```(?:calmdev|escadrille):(plan|install|questions|state|pilot)[ \t]*\n/g;

// Every block of the text: { kind, raw, value | error, start, end }. A prompt inside the plan may itself
// hold a fenced code block, so the closing fence is the first one after which the JSON parses.
const scan = (text) => {
  const out = []; text = String(text ?? '');
  for (const m of text.matchAll(OPEN)) {
    const kind = m[1]; const from = m.index + m[0].length; let at = from; let found = null; let first = null;
    while ((at = text.indexOf('```', at)) !== -1) {
      const raw = text.slice(from, at).trim(); if (first === null) first = { raw, end: at + 3 };
      try { found = { raw, value: JSON.parse(raw), end: at + 3 }; break; } catch (e) { if (!first.error) first.error = 'JSON invalide : ' + e.message; at += 3; }
    }
    if (found) out.push({ kind, raw: found.raw, value: found.value, start: m.index, end: found.end });
    else if (first) out.push({ kind, raw: first.raw, error: first.error, start: m.index, end: first.end });
    else out.push({ kind, raw: text.slice(from).trim(), error: 'bloc sans fin', start: m.index, end: text.length });
  }
  return out;
};
export const findBlocks = (text) => scan(text).map(({ start, end, ...b }) => b);

// The prose without the blocks (the page shows the plan and the list as their own cards)
export const stripBlocks = (text) => { text = String(text ?? ''); const blocks = scan(text); let out = ''; let at = 0; for (const b of blocks) { out += text.slice(at, b.start); at = b.end; } out += text.slice(at); return out.replace(/\n{3,}/g, '\n\n').trim(); };

import { isModel } from './models.mjs';
import { TIERS, tierOf } from './formulas.mjs';
import { applyReserve } from './fablereserve.mjs';
import { KINDS as STOP_KINDS, validateAutonomy } from './autonomy.mjs';
import { PROJECT_DIR, LEGACY_PROJECT_DIR } from './names.mjs';
export { stopTitle, stopKind, stopFallback } from './autonomy.mjs';

const NEXT_KINDS = ['judge', 'qa', 'none']; // the same list as lib/projectflow.mjs NEXT_KINDS (kept here: no import of the flow)
const slug = (s) => { const full = String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return full.length <= 48 ? full : full.slice(0, 48).replace(/-[^-]*$/, ''); };

// The tickets of a session (phase 7, docs/connectors.md): Linear identifiers such as ORC-88
export const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const BRANCH = /^[\w./-]+$/;

// The stops of a session, validated here and only here, at least one: a non-empty string (kind info, no fallback),
// or { title, kind, fallback } (docs/autonomy.md) with kind among taste, review, data, security, release, info
const validateStop = (t, sid, errors) => {
  if (!t || typeof t !== 'object') return String(t ?? '').trim();
  const title = String(t.title ?? '').trim(); if (!title) { errors.push(`${sid} : un arrêt sans title`); return ''; }
  const kind = t.kind === undefined ? 'info' : t.kind; if (!STOP_KINDS.includes(kind)) errors.push(`${sid} : arrêt « ${title} » de genre inconnu ${kind} (${STOP_KINDS.join(', ')})`);
  const out = { title, kind }; if (typeof t.fallback === 'string' && t.fallback.trim()) out.fallback = t.fallback.trim();
  return out;
};
const validateStops = (stops, sid, errors) => {
  const out = Array.isArray(stops) ? stops.map((t) => validateStop(t, sid, errors)).filter(Boolean) : [];
  if (!out.length) errors.push(`${sid} : au moins un arrêt`);
  return out;
};

// A plan the server will keep: the fields the seed's page relies on, with the gaps filled.
// `defaults` gives what the planner may leave out: the project folder, the model, the id prefix.
export const validatePlan = (plan, defaults = {}) => {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { errors: ['le plan doit être un objet JSON'] };
  const p = { ...plan };
  p.title = String(p.title || '').trim(); if (!p.title) errors.push('title manquant');
  p.goal = String(p.goal || '').trim();
  if (!p.id) p.id = [defaults.idPrefix, slug(p.title)].filter(Boolean).join('-');
  p.id = slug(p.id); if (!p.id) errors.push('id manquant');
  p.created = p.created || new Date().toISOString();
  // The hosts the sessions may reach from the sandbox (phase 4, lib/planner.mjs); kept as given, empty by default
  // The project of the plan (phase 6, docs/multiproject.md): the escadrille's when it comes from one, else the one given, else null
  p.project = defaults.project || (typeof p.project === 'string' && p.project.trim() ? p.project.trim() : null);
  // The base branch of the sessions' PRs (phase 7); missing: the branch each worktree started from, else main
  if (p.base !== undefined && p.base !== null) { p.base = String(p.base).trim(); if (!BRANCH.test(p.base) || p.base.startsWith('-')) errors.push(`base : nom de branche invalide`); } else delete p.base;
  // The autonomy of the plan (docs/autonomy.md): a contract written at creation from the project's setting
  if (p.autonomy !== undefined && p.autonomy !== null) { const a = validateAutonomy(p.autonomy); if (a.errors) errors.push(...a.errors); else p.autonomy = a.value; } else delete p.autonomy;
  // delivery 'kit': the sessions deliver a branch, never merged; a done session counts as delivered for the next waves
  if (p.delivery !== undefined && p.delivery !== null) { if (p.delivery !== 'kit' && p.delivery !== 'merge') errors.push("delivery : 'kit' ou 'merge'"); } else delete p.delivery;
  // network: an announcement (« ce plan utilisera crates.io »), it opens nothing; only the project's list does (lib/domains.mjs)
  p.network = Array.isArray(p.network) ? p.network.map((d) => String(d && typeof d === 'object' ? d.host : d).trim().toLowerCase()).filter(Boolean) : [];
  // What follows the plan (phase 13 FL, docs/flot.md « L'issue d'une phase »): the id of the plan to chain, or 'judge'
  // (the developer judges the captures), 'qa' (a QA of the phase) or 'none'; missing, the project's next plan by date
  if (p.next !== undefined && p.next !== null && String(p.next).trim() !== '') { p.next = String(p.next).trim(); if (!NEXT_KINDS.includes(p.next) && !/^[\w.-]+$/.test(p.next)) errors.push(`next : un id de plan, ou ${NEXT_KINDS.join(', ')}`); } else delete p.next;
  // The formulas (Dev, 2026-11-01, lib/formulas.mjs): économe, recommandée, sans limite, each its own sessions;
  // the plan's sessions are the chosen one's (the recommended by default). A plan without formulas stays valid.
  let formulas = null;
  if (p.formulas !== undefined && p.formulas !== null) {
    if (!Array.isArray(p.formulas) || !p.formulas.length) errors.push('formulas : une liste de formules { tier, gain, sessions }');
    else {
      formulas = []; const seen = new Set();
      for (const [i, f] of p.formulas.entries()) {
        const tier = tierOf(f?.tier); if (!tier) { errors.push(`formule ${i + 1} : tier inconnu ${f?.tier ?? '(vide)'} (${TIERS.join(', ')})`); continue; }
        if (seen.has(tier)) { errors.push(`formule ${tier} : en double`); continue; } seen.add(tier);
        formulas.push({ tier, gain: String(f.gain ?? '').trim(), sessions: f.sessions, waves: Array.isArray(f.waves) ? f.waves : undefined });
      }
      formulas.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
    }
  }
  if (formulas && formulas.length) {
    const asked = p.formula === undefined || p.formula === null ? null : tierOf(p.formula);
    if (p.formula !== undefined && p.formula !== null && !asked) errors.push(`formula : inconnue ${p.formula} (${TIERS.join(', ')})`);
    const pick = formulas.find((f) => f.tier === asked) || formulas.find((f) => f.tier === 'recommended') || formulas[0];
    p.formula = pick.tier;
    // The plan's sessions win for the chosen formula when both are given; else the formula gives them to the plan
    if (Array.isArray(p.sessions) && p.sessions.length) pick.sessions = p.sessions; else p.sessions = pick.sessions;
    if (!Array.isArray(p.waves) && pick.waves) p.waves = pick.waves;
  } else delete p.formula;
  delete p.formulas;
  if (!Array.isArray(p.sessions) || !p.sessions.length) errors.push('sessions : au moins une session');
  p.sessions = validateSessions(p.sessions, defaults, errors, '');
  if (formulas && formulas.length) p.formulas = formulas.map((f) => {
    const sessions = f.tier === p.formula ? p.sessions : validateSessions(f.sessions, defaults, errors, `formule ${f.tier}, `);
    if (f.tier !== p.formula && (!Array.isArray(f.sessions) || !f.sessions.length)) errors.push(`formule ${f.tier} : au moins une session`);
    const out = { tier: f.tier, gain: f.gain, sessions }; if (f.waves) out.waves = f.waves; return out;
  });
  // Fable in reserve (docs/fable-reserve.md): a Fable session without its one-sentence `fableWhy` goes to Opus, in every formula
  if (p.fableReserve === true) { const r = applyReserve(p); p.sessions = r.plan.sessions; if (r.plan.formulas) p.formulas = r.plan.formulas; } else { delete p.fableReserve; for (const s of [...p.sessions, ...(p.formulas || []).flatMap((f) => f.sessions)]) if (s && typeof s.fableWhy === 'string') s.fableWhy = s.fableWhy.trim().slice(0, 240); }
  const waveNs = [...new Set(p.sessions.map((s) => s.wave))].sort((a, b) => a - b);
  const given = Array.isArray(p.waves) ? p.waves : [];
  p.waves = waveNs.map((n) => { const w = given.find((g) => g.n === n) || {}; return { n, title: String(w.title || (n === 1 ? 'Maintenant, en parallèle' : `Vague ${n}`)).trim(), text: String(w.text || '').trim() }; });
  return errors.length ? { errors } : { plan: p };
};

// The sessions of a plan or of one of its formulas, the gaps filled; `pre` names the formula in the errors
const validateSessions = (list, defaults, errors, pre) => {
  const sessions = Array.isArray(list) ? list : [];
  const ids = new Set();
  const out = sessions.map((s, i) => {
    const x = { ...s };
    x.id = String(x.id || String.fromCharCode(65 + i)).trim();
    if (ids.has(x.id)) errors.push(`${pre}session ${x.id} : id en double`); ids.add(x.id);
    x.name = String(x.name || '').trim(); if (!x.name) errors.push(`${pre}session ${x.id} : name manquant`);
    x.wave = Number.isInteger(x.wave) && x.wave > 0 ? x.wave : 1;
    x.path = x.path || defaults.path || ''; if (!x.path) errors.push(`${pre}session ${x.id} : path manquant`);
    x.model = x.model || defaults.model || ''; if (x.model && !isModel(x.model)) errors.push(`${pre}session ${x.id} : modèle inconnu ${x.model}`);
    x.stops = validateStops(x.stops, pre + 'session ' + x.id, errors);
    x.prompt = String(x.prompt || '').trim(); if (!x.prompt) errors.push(`${pre}session ${x.id} : prompt manquant`);
    x.where = String(x.where || '').trim(); x.when = String(x.when || '').trim();
    if (Array.isArray(x.after)) x.after = x.after.map(String); else delete x.after;
    // The branch this session is merged into (a PR branch, Harbor on 3 November), over the plan's base (lib/mergedin.mjs targetOf)
    if (x.base !== undefined && x.base !== null && String(x.base).trim() !== '') { x.base = String(x.base).trim(); if (!BRANCH.test(x.base) || x.base.startsWith('-')) errors.push(`${pre}session ${x.id} : base, nom de branche invalide`); } else delete x.base;
    // The cap in US dollars of this session (phase 4); the server applies its default when it is missing
    if (x.budget !== undefined && Number.isFinite(Number(x.budget)) && Number(x.budget) > 0) x.budget = Number(x.budget); else delete x.budget;
    // The Linear tickets of this session (phase 7): moved to « À revoir » when its PR opens
    if (x.tickets !== undefined) {
      if (!Array.isArray(x.tickets)) errors.push(`${pre}session ${x.id} : tickets doit être une liste d'identifiants comme ORC-88`);
      else { x.tickets = [...new Set(x.tickets.map((t) => String(t ?? '').trim()))]; for (const t of x.tickets) if (!TICKET.test(t)) errors.push(`${pre}session ${x.id} : ticket ${t || '(vide)'} mal formé (un identifiant comme ORC-88)`); }
    }
    return x;
  });
  // A session that waits for another sits in a later wave than it
  for (const s of out) for (const a of s.after || []) {
    const dep = out.find((y) => y.id === a);
    if (!dep) errors.push(`${pre}session ${s.id} : dépend de ${a}, inconnue`);
    else if (dep.wave >= s.wave) errors.push(`${pre}session ${s.id} : dépend de ${a} qui n'est pas dans une vague antérieure`);
  }
  return out;
};

const KINDS = new Set(['plugin', 'skill', 'rule', 'mcp', 'setting']);
export const validateInstall = (list) => {
  if (!Array.isArray(list)) return { errors: ['la liste doit être un tableau JSON'] };
  const items = list.map((it, i) => ({ kind: KINDS.has(it?.kind) ? it.kind : 'rule', name: String(it?.name || `proposition ${i + 1}`).trim(), why: String(it?.why || '').trim(), how: String(it?.how || '').trim(), scope: it?.scope === 'session' ? 'session' : 'project', checked: it?.checked !== false }));
  return { items };
};

// The state block of a launched session, one line of JSON at the end of each of its turns. `summary`
// (phase 4) is optional: two lines, what is done and what is left; null when the session leaves it out.
const HEALTH = new Set(['ok', 'drift', 'error']);
export const validateState = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { errors: ['le bloc state doit être un objet JSON'] };
  const stops = Array.isArray(v.stops) ? [...new Set(v.stops.map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b) : [];
  const summary = typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim().slice(0, 1000) : null;
  // Phase 16 PAIR: `done` as an object is done:true plus the end report (docs/sessions.md « Le résumé de fin »)
  const isReport = !!v.done && typeof v.done === 'object' && !Array.isArray(v.done);
  return { state: { stops, health: HEALTH.has(v.health) ? v.health : 'ok', why: String(v.why ?? '').trim(), claude: String(v.claude ?? '').trim(), done: v.done === true || isReport, summary, report: isReport ? validateDone(v.done) : null,
    // « Avant de signer » (docs/apprendre-en-signant.md): up to three things the session supposed without proof
    assume: Array.isArray(v.assume) ? v.assume.map((a) => String(a ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, 3) : [] } };
};

// The end report of a session, « Ce qui a été fait »: fixed or cut, never an error; null without a readable summary
const strings = (v, max, len) => (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '')).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
const CAPTURE_PATH = new RegExp(`^(${[PROJECT_DIR, LEGACY_PROJECT_DIR].map((d) => d.replace('.', '\\.')).join('|')})/(captures|qa)/[^\\0]+\\.png$`, 'i');
export const validateDone = (v) => {
  if (!v || typeof v !== 'object' || typeof v.summary !== 'string' || !v.summary.trim()) return null;
  const sentences = v.summary.replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+|$)/g) || [];
  const summary = sentences.slice(0, 3).join('').trim().slice(0, 600);
  const tests = strings(v.tests, 20, 200).map((t) => t.split(' ').slice(0, 10).join(' '));
  const captures = strings(v.captures, 50, 300).map((c) => c.replace(/^\.\//, '')).filter((c) => CAPTURE_PATH.test(c) && !c.split('/').includes('..')).slice(0, 12);
  return { summary, journeys: strings(v.journeys, 8, 80), tests, captures };
};

export const validateQuestions = (list) => {
  if (!Array.isArray(list) || !list.length) return { errors: ['les questions doivent être un tableau JSON non vide'] };
  const items = list.map((q, i) => ({ n: Number.isInteger(q?.n) ? q.n : i + 1, title: String(q?.title || `Question ${i + 1}`).trim(), question: String(q?.question || '').trim(), recommendation: String(q?.recommendation || '').trim(), why: String(q?.why || '').trim() }));
  return { items };
};
