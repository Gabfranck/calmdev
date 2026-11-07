// Costing a task before launching it (phase 11, PX; docs/learning.md « Chiffrer avant de lancer »). No planning
// session, no token spent: the developer describes the task, the three formulas of the plan skill
// (économe, recommandée, sans limite; lib/formulas.mjs) are composed here from the kind of the task, and each
// session is priced by the estimate (lib/usage.mjs) corrected by the learned gap of its kind and model
// (lib/learning.mjs). « Lancer » turns the chosen formula into a real plan, launched at once.
//
//   composition(kind)                  { frugal, recommended, unlimited }: [{ role, model }] per tier
//   buildPlan({ project, text, lang, id?, budget? })   a plan skeleton with its three formulas (lib/blocks.mjs validates it)
//   costing(plan, estimate, { registry })  one line per formula: cost, weekly share, sessions, the learned corrections
import { kindOf } from './learning.mjs';
import { TIERS } from './formulas.mjs';
import { canonicalModel } from './usage.mjs';

export const SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5', FABLE = 'claude-fable-5-1';
export const MAX_TEXT = 4000;
const round2 = (n) => Math.round(n * 100) / 100;

// The hands of a task: Sonnet where the work is mechanical (docs, tests), Opus elsewhere; the skill's three tiers:
// économe = fewer sessions and no separate verifier; recommandée = Opus hands and a fresh verifier; sans limite =
// Fable wherever there is judgment, a check and a final pass (.claude/skills/plan/SKILL.md « Trois formules »)
export const composition = (kind) => {
  const light = kind === 'docs' || kind === 'tests';
  return {
    frugal: [{ role: 'hands', model: light ? SONNET : OPUS }],
    recommended: [{ role: 'hands', model: light ? SONNET : OPUS }, { role: 'verifier', model: light ? SONNET : OPUS }],
    unlimited: [{ role: 'hands', model: light ? OPUS : FABLE }, { role: 'verifier', model: OPUS }, { role: 'final', model: FABLE }],
  };
};

// The words of the sessions' briefs, in the developer's language (the task's text is his)
const WORDS = {
  fr: {
    hands: (t) => `${t}\n\nTravaille dans ton worktree, commite en anglais sans co-auteur, et dis dans ton arrêt final ce que le développeur doit regarder.`,
    verifier: (t, h) => `Vérifie le travail de la session ${h} sur cette tâche :\n\n${t}\n\nRelis son diff et ses tests, lance la suite, essaie le résultat ; corrige ce qui est faux, et dis en une ligne ce qui tient et ce qui manque.`,
    final: (t) => `Passe finale sur cette tâche, après ses sessions :\n\n${t}\n\nJuge le résultat d'ensemble comme un relecteur exigeant : cohérence, cas limites, lisibilité ; corrige ce qui reste, puis dis ce qui est fini.`,
    name: { hands: 'La tâche', verifier: 'La vérification', final: 'La passe finale' },
    stop: { hands: ['Le résultat, à juger', 'Si personne ne répond, garde le résultat tel quel et finis.'], verifier: ['Ce qui tient et ce qui manque', 'Si personne ne répond, garde tes corrections et finis.'], final: ['Le jugement final', 'Si personne ne répond, garde tes corrections et finis.'] },
    wave: { 1: 'La tâche', 2: 'La vérification', 3: 'La passe finale' },
  },
  en: {
    hands: (t) => `${t}\n\nWork in your worktree, commit in English without a co-author line, and say in your final stop what the developer must look at.`,
    verifier: (t, h) => `Check the work of session ${h} on this task:\n\n${t}\n\nRead its diff and its tests, run the suite, try the result; fix what is wrong, and say in one line what holds and what is missing.`,
    final: (t) => `Final pass on this task, after its sessions:\n\n${t}\n\nJudge the whole result as a demanding reviewer: consistency, edge cases, readability; fix what remains, then say what is done.`,
    name: { hands: 'The task', verifier: 'The check', final: 'The final pass' },
    stop: { hands: ['The result, to judge', 'If nobody answers, keep the result as it is and finish.'], verifier: ['What holds and what is missing', 'If nobody answers, keep your fixes and finish.'], final: ['The final judgment', 'If nobody answers, keep your fixes and finish.'] },
    wave: { 1: 'The task', 2: 'The check', 3: 'The final pass' },
  },
};
const ROLE_WAVE = { hands: 1, verifier: 2, final: 3 };
const ROLE_ID = { hands: 'A', verifier: 'V', final: 'F' };

const title = (text) => { const first = String(text).split(/\n/)[0].replace(/\s+/g, ' ').trim(); return first.length <= 64 ? first : first.slice(0, 64).replace(/\s+\S*$/, '').replace(/[\s:;,.(«-]+$/, '') + '…'; };
const slug = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The plan skeleton: the three formulas, each with its complete sessions (one wave per role, in order), the
// recommended one chosen. `kind` is read from the text as the registry would (lib/learning.mjs kindOf).
export const buildPlan = ({ project, text, lang = 'fr', id, now = new Date(), budget = null } = {}) => {
  const t = String(text || '').trim().slice(0, MAX_TEXT); if (!t) throw new Error('empty task');
  const W = WORDS[lang === 'en' ? 'en' : 'fr'];
  const kind = kindOf({ prompt: t });
  const comp = composition(kind);
  const session = ({ role, model }) => ({
    id: ROLE_ID[role], name: W.name[role], wave: ROLE_WAVE[role], path: project, model,
    stops: [{ title: W.stop[role][0], kind: role === 'hands' ? 'review' : 'info', fallback: W.stop[role][1] }],
    prompt: W[role](t, ROLE_ID.hands), ...(budget ? { budget } : {}),
  });
  const formulas = TIERS.map((tier) => ({ tier, gain: '', sessions: comp[tier].map(session), waves: comp[tier].map((s) => ({ n: ROLE_WAVE[s.role], title: W.wave[ROLE_WAVE[s.role]] })) }));
  const ttl = title(t);
  const date = now.toISOString().slice(0, 10);
  return { id: id || `${date}-${slug(ttl).split('-').slice(0, 5).join('-') || 'tache'}`, title: ttl, goal: t, project, path: project, kind, formula: 'recommended', formulas, sessions: formulas[1].sessions, waves: formulas[1].waves, network: [] };
};

// What the registry knows of this kind on this model: the real median of its finished sessions, how many
const realOf = (registry, kind, model) => { const g = (registry?.byKind || []).find((x) => x.kind === kind && canonicalModel(x.model) === canonicalModel(model)); return g && g.cost.median != null ? { median: g.cost.median, sessions: g.sessions, firstTryRate: g.firstTryRate } : null; };

// One line per formula. `estimate` is estimatePlan's answer for a plan holding every formula's sessions under
// unique ids (allSessionsPlan): cost and weekly share summed, the learned gaps listed once, the real median beside.
// A session the estimate cannot price (no transcript to read) is priced by that real median when the registry has
// one (basis.scope 'registry', fromReal: true); the weekly share then needs the calibration's dollarsPerPct.
// delta: the cost against the recommended formula, -0.4 = 40 % cheaper; null when a cost is unknown.
export const allSessionsPlan = (plan) => ({ ...plan, sessions: plan.formulas.flatMap((f) => f.sessions.map((s) => ({ ...s, id: `${f.tier}:${s.id}` }))) });
export const costing = (plan, estimate, { registry = null } = {}) => {
  const by = estimate?.sessions || {};
  const perPct = estimate?.calibration?.calibrated ? estimate.calibration.dollarsPerPct : null;
  const rows = plan.formulas.map((f) => {
    const sessions = f.sessions.map((s) => {
      const e = by[`${f.tier}:${s.id}`] || null;
      const real = realOf(registry, plan.kind, s.model);
      const row = { id: s.id, name: s.name, role: s.id === 'A' ? 'hands' : s.id === 'V' ? 'verifier' : 'final', model: s.model, wave: s.wave, cost: e?.cost ?? null, rawCost: e?.basis?.rawCost ?? e?.cost ?? null, weeklyPct: e?.weeklyPct ?? null, learned: e?.basis?.learned || null, real, fromReal: false, basis: e ? { sessions: e.basis.sessions, scope: e.basis.scope } : null };
      if (row.cost == null && real) Object.assign(row, { cost: real.median, rawCost: real.median, weeklyPct: perPct ? Math.round((real.median / perPct / 100) * 1e6) / 1e6 : null, fromReal: true, basis: { sessions: real.sessions, scope: 'registry' } });
      return row;
    });
    const known = sessions.every((s) => s.cost != null);
    const cost = known ? round2(sessions.reduce((n, s) => n + s.cost, 0)) : null;
    const pctKnown = sessions.every((s) => s.weeklyPct != null);
    return { tier: f.tier, chosen: f.tier === plan.formula, sessions, cost, weeklyPct: pctKnown ? Math.round(sessions.reduce((n, s) => n + s.weeklyPct, 0) * 1e6) / 1e6 : null, learned: sessions.filter((s) => s.learned).map((s) => ({ model: s.model, ...s.learned })) };
  });
  const ref = rows.find((r) => r.tier === 'recommended');
  for (const r of rows) r.delta = ref && ref.cost > 0 && r.cost != null ? Math.round(((r.cost - ref.cost) / ref.cost) * 1000) / 1000 : null;
  return { kind: plan.kind, title: plan.title, formulas: rows, calibrated: !!estimate?.calibration?.calibrated, weeklyNow: estimate?.total?.weeklyNow ?? null };
};

// The plan to launch: the chosen formula's sessions, the cap of each at 1,5 × its estimate (never under 1 $),
// rounded up to the half-dollar, so the plan says its budget as every plan does; the default when nothing is known
export const launchable = (plan, tier, costed, { defaultBudget = 5 } = {}) => {
  const f = plan.formulas.find((x) => x.tier === tier); if (!f) throw new Error(`unknown formula ${tier}`);
  const cap = (t, s) => { const c = costed.formulas.find((x) => x.tier === t)?.sessions.find((x) => x.id === s.id)?.cost; return c == null ? defaultBudget : Math.max(1, Math.ceil(c * 1.5 * 2) / 2); };
  const formulas = plan.formulas.map((x) => ({ ...x, sessions: x.sessions.map((s) => ({ ...s, budget: cap(x.tier, s) })) }));
  const chosen = formulas.find((x) => x.tier === tier);
  return { ...plan, formula: tier, formulas, sessions: chosen.sessions, waves: chosen.waves };
};
