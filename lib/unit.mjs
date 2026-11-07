// The single unit of usage (docs/usage-unit.md): every share of the subscription, every extra credit, in dollars.
// The included quota becomes « included dollars » through the value of a weekly point, measured per model.
//   rateSamples(runs, { others })   one sample per session that ran alone: its cost over the weekly points it moved
//                                   runs: [{ id, model, from, to, w0, w1, c0, c1 }] (first and last quota reading)
//                                   others: [{ id, from, to }] activity seen elsewhere (transcripts, planners)
//   modelRates(samples)             { <model>: { usdPerPct, low, high, n } } the median and a range that narrows with n
// A sample is never taken from a saturated gauge (w1 = 1: the cost rises, the gauge does not), across a weekly reset
// (w1 < w0), from a move under MIN_POINTS (the gauge's rounding weighs too much) or from a window shared with another
// session (whose model would mix in). No model is ever priced at another model's rate.
import { isSaturated, median } from './usage.mjs';

export const MIN_POINTS = 2;
const t = (s) => Date.parse(s);
const overlaps = (a, b) => t(a.from) < t(b.to) && t(b.from) < t(a.to);

export const rateSamples = (runs = [], { others = [] } = {}) => {
  const out = [];
  for (const r of runs) {
    if (!r || !r.model || !Number.isFinite(t(r.from)) || !Number.isFinite(t(r.to))) continue;
    if (typeof r.w0 !== 'number' || typeof r.w1 !== 'number' || isSaturated(r.w1) || r.w1 <= r.w0) continue;
    const points = Math.round((r.w1 - r.w0) * 1000) / 10;
    if (points < MIN_POINTS) continue;
    const cost = (r.c1 ?? 0) - (r.c0 ?? 0); if (!(cost > 0)) continue;
    if (runs.some((o) => o !== r && o.id !== r.id && overlaps(r, o))) continue;
    if (others.some((o) => o.id !== r.id && overlaps(r, o))) continue;
    out.push({ id: r.id, model: r.model, usdPerPct: Math.round((cost / points) * 100) / 100, points });
  }
  return out;
};

// ---------------------------------------------------------------- the gauge, in money really paid (Dev, 7 November)
// The unit is the money of the developer's bill (EUR for Dev), never the API list price:
//   - the included quota is worth what the subscription costs: planEurMonth (a Mac setting, never guessed) × 12 / 52 a
//     week, so a weekly point is worth weekEur / 100;
//   - usage credits (extra usage) are worth their billed price: creditEurPerUsd € per dollar of API-equivalent (a setting:
//     the price is not published in the pages read, docs/usage-unit.md), so a point bought is usdPerPct × creditEurPerUsd;
//   - the API-equivalent stays visible second (« would cost X $ at the API »).
// The jump (credits € per point / included € per point) is the decision: overflow now, or wait for the reset.
//   validateUnit(b)                 { value, errors } of { planEurMonth, creditEurPerUsd } (null removes one)
//   unitGauge({ unit, usdPerPct, rates, claude, credits, overage })
export const UNIT_KEYS = { planEurMonth: [1, 10000], creditEurPerUsd: [0.01, 10] };
export const validateUnit = (b = {}) => {
  const value = {}; const errors = [];
  for (const [k, [lo, hi]] of Object.entries(UNIT_KEYS)) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === '') { value[k] = null; continue; }
    const n = Number(b[k]);
    if (typeof b[k] === 'boolean' || !Number.isFinite(n) || n < lo || n > hi) errors.push(`${k} : un nombre entre ${lo} et ${hi}`); else value[k] = n;
  }
  return errors.length ? { value: null, errors } : { value, errors: null };
};
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const num = (x) => typeof x === 'number' && Number.isFinite(x);
export const WEEKS_PER_MONTH = 52 / 12;
export const unitGauge = ({ unit = {}, usdPerPct = null, rates = {}, claude = null, credits = null, overage = null } = {}) => {
  const plan = num(unit.planEurMonth) && unit.planEurMonth > 0 ? unit.planEurMonth : null;
  const rate = num(unit.creditEurPerUsd) && unit.creditEurPerUsd > 0 ? unit.creditEurPerUsd : null;
  const api = num(usdPerPct) && usdPerPct > 0 ? usdPerPct : null;
  const weekEur = plan != null ? r2(plan / WEEKS_PER_MONTH) : null;
  const inclPerPct = weekEur != null ? weekEur / 100 : null;
  const w = claude && claude.weekly; const pct = w && num(w.pct) ? w.pct : null;
  const week = {
    pct, resetsAt: (w && w.resetsAt) || null, saturated: pct != null && pct >= 100,
    eurPerPct: inclPerPct != null ? r3(inclPerPct) : null, includedEur: weekEur,
    usedEur: inclPerPct != null && pct != null ? r2(Math.min(pct, 100) * inclPerPct) : null,
    leftEur: inclPerPct != null && pct != null ? r2(Math.max(0, 100 - pct) * inclPerPct) : null,
    apiUsdPerPct: api != null ? r2(api) : null, apiWeekUsd: api != null ? Math.round(api * 100) : null,
  };
  const creditPerPct = rate != null && api != null ? r2(rate * api) : null;
  const c = credits || null; const minor = (x) => (num(x) ? r2(x / 100) : null);
  const spent = c ? minor(c.usedMinor) : null; const limit = c ? minor(c.limitMinor) : null;
  const creditsOut = {
    eurPerPct: creditPerPct, eurPerApiUsd: rate, enabled: c ? c.enabled ?? null : null, currency: (c && c.currency) || null,
    spent, limit, left: spent != null && limit != null ? r2(Math.max(0, limit - spent)) : null, unlimited: !!(c && c.unlimited),
    status: (overage && overage.status) || null, using: overage ? overage.using ?? null : null, disabledReason: (overage && overage.disabledReason) || null,
  };
  const models = {};
  for (const [m, v] of Object.entries(rates || {})) models[m] = { ...v, eurPerApiUsd: inclPerPct != null && v.usdPerPct > 0 ? r3(inclPerPct / v.usdPerPct) : null };
  const fh = claude && claude.fiveHour; const five = fh && num(fh.pct) ? { pct: fh.pct, resetsAt: fh.resetsAt || null } : null;
  return { unit: 'EUR', week, credits: creditsOut, jump: creditPerPct != null && inclPerPct ? Math.round(creditPerPct / inclPerPct * 10) / 10 : null, models, fiveHour: five, setting: { planEurMonth: plan, creditEurPerUsd: rate } };
};

// The range: median × e^(±h), h = 2 σ / √n on the logs (σ at least 0.15: two equal samples are not a certainty),
// ln 2 for a single sample (a factor of two each way, said as such).
const SIGMA_MIN = 0.15;
export const modelRates = (samples = []) => {
  const by = {};
  for (const s of samples) if (s && s.model && s.usdPerPct > 0) (by[s.model] ||= []).push(s.usdPerPct);
  const out = {};
  for (const [model, xs] of Object.entries(by)) {
    const n = xs.length; const mid = median(xs);
    let h = Math.LN2;
    if (n > 1) {
      const logs = xs.map(Math.log); const m = logs.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(logs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
      h = Math.min(Math.LN2, (2 * Math.max(sd, SIGMA_MIN)) / Math.sqrt(n));
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    out[model] = { usdPerPct: r2(mid), low: r2(mid * Math.exp(-h)), high: r2(mid * Math.exp(h)), n };
  }
  return out;
};
