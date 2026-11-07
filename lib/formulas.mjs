// The three formulas of a plan (Dev, 2026-11-01; .claude/skills/plan/SKILL.md « Trois formules, un choix éclairé »):
//   frugal       économe : Sonnet and Opus, fewer sessions, no separate verifier
//   recommended  recommandée : a Fable head for taste and architecture, Opus hands, a fresh verifier
//   unlimited    sans limite : Fable wherever there is judgment, a check per step, a final pass
// The escadrille:plan block may carry `formulas: [{ tier, gain, sessions, waves? }]` and `formula` (the chosen tier,
// the recommended by default); lib/blocks.mjs validates them, the plan's sessions are the chosen formula's.
//   tierOf(x)                         the tier id of an id or a French name (« économe », « sans limite »), else null
//   summarize(plan, { defaultBudget, dollarsPerPct })   one line per formula: sessions, models, cap, weekly share, gain
//   switchTo(plan, tier)              { plan } the raw plan with that formula's sessions, or { error }

export const TIERS = ['frugal', 'recommended', 'unlimited'];
const ALIASES = { frugal: 'frugal', econome: 'frugal', economique: 'frugal', recommended: 'recommended', recommandee: 'recommended', unlimited: 'unlimited', 'sans-limite': 'unlimited', 'sans-limites': 'unlimited' };
export const tierOf = (x) => { const k = String(x ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, '-'); return ALIASES[k] || null; };

const round2 = (n) => Math.round(n * 100) / 100;
const budgetOf = (s, d) => (Number.isFinite(Number(s.budget)) && Number(s.budget) > 0 ? Number(s.budget) : d);

// The sessions of a formula grouped by model, in the order of the sessions: [{ model, n, ids }]
const modelsOf = (sessions) => { const out = []; for (const s of sessions) { const m = s.model || ''; let g = out.find((x) => x.model === m); if (!g) out.push((g = { model: m, n: 0, ids: [] })); g.n++; g.ids.push(s.id); } return out; };

// One line per formula, frugal → unlimited. A plan without formulas gives one line, its own sessions, chosen.
// weeklyPct is a fraction of the weekly quota (0.12 = 12 %), null without a calibration (/api/usage).
export const summarize = (plan, { defaultBudget = 5, dollarsPerPct = null } = {}) => {
  const list = Array.isArray(plan?.formulas) && plan.formulas.length ? plan.formulas : [{ tier: plan?.formula || 'recommended', gain: '', sessions: plan?.sessions || [] }];
  const chosen = plan?.formula || (list.some((f) => f.tier === 'recommended') ? 'recommended' : list[0].tier);
  return list.map((f) => {
    const sessions = f.tier === chosen ? plan.sessions || f.sessions || [] : f.sessions || [];
    const cap = round2(sessions.reduce((n, s) => n + budgetOf(s, defaultBudget), 0));
    return { tier: f.tier, chosen: f.tier === chosen, sessions: sessions.length, models: modelsOf(sessions), cap, weeklyPct: Number.isFinite(dollarsPerPct) && dollarsPerPct > 0 ? Math.round((cap / dollarsPerPct / 100) * 1e4) / 1e4 : null, gain: f.gain || '' };
  });
};

// The plan with another formula's sessions; the caller validates it and refuses it once a session has left (lib/queue.mjs)
export const switchTo = (plan, tier) => {
  const t = tierOf(tier); if (!t) return { error: `formule inconnue ${tier ?? '(vide)'} (${TIERS.join(', ')})` };
  const f = (plan?.formulas || []).find((x) => x.tier === t); if (!f) return { error: `le plan n'a pas de formule ${t}` };
  if (plan.formula === t) return { plan, same: true };
  return { plan: { ...plan, formula: t, sessions: f.sessions, waves: f.waves || plan.waves } };
};
