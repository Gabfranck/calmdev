// Fable in reserve (Dev, 2026-11-02: « tu es presque à la fin de Fable, pense à le garder pour les tâches qui en auront
// le plus besoin »; docs/fable-reserve.md). When the week's Fable quota runs low, the planner keeps Fable for the sessions
// that justify it in one sentence (`fableWhy`) and puts Opus everywhere else, in every formula. Pure functions: the
// server reads the setting and the limits, these say whether the reserve is on and what the planner reads.
//
//   MODES, DEFAULT_SHARE                       'auto' | 'on' | 'off'; auto turns on at 70 % of the week's Fable quota
//   validateSetting(v)                         { value, errors }: 'auto' | 'on' | 'off' | { mode, share } | null (cleared)
//   resolveSetting(mac, project)               { mode, share } the project's when it sets one, else the Mac's, else auto
//   reserveOf({ setting, rows })               { active, why: 'on' | 'share' | 'threshold' | null, pct, share }
//                                              rows: lib/limits.mjs rowsOf (the row model:fable)
//   reserveSection(reserve)                    the lines the planner reads (appended to its system prompt), '' when off
//   isFable(model)                             true for a Fable model id
//   applyReserve(plan, { fallback })           the plan with every Fable session without `fableWhy` moved to Opus, in its
//                                              sessions and in each formula; { plan, moved: [ids] }. Only when
//                                              plan.fableReserve is true.
//   reserveSummary(plan)                       { active, onOpus, kept: [{ id, name, why }] } for the plan screen

export const MODES = ['auto', 'on', 'off'];
export const DEFAULT_SHARE = 70;
export const FALLBACK = 'claude-opus-5-5';
export const MAX_WHY = 240;

export const isFable = (model) => /(^|-)fable(-|$)/i.test(String(model || ''));

// ---------------------------------------------------------------- the setting
export const validateSetting = (v) => {
  if (v === null || v === undefined || v === '') return { value: null, errors: null };
  const o = typeof v === 'string' ? { mode: v } : v;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { value: null, errors: ["fableReserve : 'auto', 'on', 'off' ou { mode, share }"] };
  const mode = String(o.mode ?? 'auto').trim().toLowerCase();
  const errors = [];
  if (!MODES.includes(mode)) errors.push(`fableReserve.mode : inconnu ${o.mode} (${MODES.join(', ')})`);
  let share = DEFAULT_SHARE;
  if (o.share !== undefined && o.share !== null && o.share !== '') { share = Number(o.share); if (!(Number.isFinite(share) && share >= 1 && share <= 100)) errors.push('fableReserve.share : de 1 à 100 (% du quota Fable de la semaine)'); }
  return errors.length ? { value: null, errors } : { value: { mode, share: Math.round(share * 10) / 10 }, errors: null };
};

// The project decides when it says something (a project may want Fable kept, or spent); else the Mac; else auto at 70 %
export const resolveSetting = (mac, project) => {
  for (const x of [project, mac]) { const { value } = validateSetting(x); if (value) return value; }
  return { mode: 'auto', share: DEFAULT_SHARE };
};

// ---------------------------------------------------------------- the reserve now
export const reserveOf = ({ setting = null, rows = [] } = {}) => {
  const s = setting && MODES.includes(setting.mode) ? { share: DEFAULT_SHARE, ...setting } : resolveSetting(null, setting);
  const row = (rows || []).find((r) => r && (r.id === 'model:fable' || (r.kind === 'model' && /fable/i.test(r.label || ''))));
  const pct = row && typeof row.pct === 'number' ? row.pct : null;
  const base = { pct, share: s.share, mode: s.mode };
  if (s.mode === 'off') return { ...base, active: false, why: null };
  if (s.mode === 'on') return { ...base, active: true, why: 'on' };
  // auto: the soft or hard threshold of the Fable quota crossed (lib/limits.mjs), or the week's share past `share`
  if (row && (row.level === 'soft' || row.level === 'hard')) return { ...base, active: true, why: 'threshold' };
  if (pct !== null && pct >= s.share) return { ...base, active: true, why: 'share' };
  return { ...base, active: false, why: null };
};

const WHY_FR = { on: 'réglée à « on » pour ce projet ou ce Mac', share: null, threshold: 'le seuil du quota hebdo Fable est franchi' };
export const reserveSection = (r) => {
  if (!r || !r.active) return '';
  const cause = r.why === 'share' ? `${r.pct} % du quota Fable de la semaine est utilisé (réserve à ${r.share} %)` : WHY_FR[r.why] || 'réglée pour ce projet';
  return `\n\n## Fable en réserve\n\nFable en réserve : ${cause}. Applique la règle « Fable en réserve » de ce skill dans les trois formules : Fable seulement pour une session que tu justifies en une phrase dans \`fableWhy\` (architecture neuve, débogage difficile, sécurité, design exigeant d'un écran principal), Opus pour le reste, Sonnet pour le mécanique ; le bloc porte \`"fableReserve": true\`.`;
};

// ---------------------------------------------------------------- the plan
const whyOf = (s) => (typeof s.fableWhy === 'string' ? s.fableWhy.trim().slice(0, MAX_WHY) : '');
const moveList = (list, fallback, moved) => (Array.isArray(list) ? list.map((s) => {
  if (!s || typeof s !== 'object') return s;
  const x = { ...s }; const why = whyOf(x);
  if (why) x.fableWhy = why; else delete x.fableWhy;
  if (isFable(x.model) && !why) { x.model = fallback; x.reservedFrom = s.model; if (!moved.includes(x.id)) moved.push(x.id); }
  if (!isFable(x.model)) delete x.fableWhy; // a reason only means something on Fable
  return x;
}) : list);

export const applyReserve = (plan, { fallback = FALLBACK } = {}) => {
  if (!plan || typeof plan !== 'object' || plan.fableReserve !== true) return { plan, moved: [] };
  const moved = [];
  const out = { ...plan, sessions: moveList(plan.sessions, fallback, moved) };
  if (Array.isArray(plan.formulas)) out.formulas = plan.formulas.map((f) => (f && typeof f === 'object' ? { ...f, sessions: moveList(f.sessions, fallback, moved) } : f));
  return { plan: out, moved };
};

export const reserveSummary = (plan) => {
  const sessions = Array.isArray(plan?.sessions) ? plan.sessions : [];
  if (plan?.fableReserve !== true) return { active: false, onOpus: 0, kept: [] };
  return { active: true, onOpus: sessions.filter((s) => /opus/i.test(s.model || '')).length, kept: sessions.filter((s) => isFable(s.model)).map((s) => ({ id: s.id, name: s.name || '', why: whyOf(s) })) };
};
