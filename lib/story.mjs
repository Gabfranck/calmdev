// The story of a plan (docs/mesure.md, "Le récit"): a French Markdown template, first person, in the
// developer's voice, filled with the real figures. No model call, no adjective: a sentence whose figure
// is missing is not written.
//
//   storyOf({ plan, state, log, metrics, messages, timeZone })  → string
//   projectOfStory(plan, gitRootOf)                              → the folder where docs/recits/<id>.md goes
import path from 'node:path';

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const usd = (x) => `${x.toFixed(2).replace('.', ',')} $`;
const dec = (x, n = 1) => String(Math.round(x * 10 ** n) / 10 ** n).replace('.', ',');
const plural = (n, one, many = one + 's') => `${n} ${n > 1 ? many : one}`;
const partsOf = (iso, timeZone) => {
  const f = new Intl.DateTimeFormat('fr-FR', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: Number(p.month), year: Number(p.year), time: `${p.hour}:${p.minute}` };
};
const dayOf = (p) => `${p.day === 1 ? '1er' : p.day} ${MONTHS[p.month - 1]} ${p.year}`;
const lengthOf = (ms) => { const m = Math.round(ms / 60e3); const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

// PIL (3 November, Harbor: the pilot 51,6 $, the code 24,2 $): the pilot's share of a plan. costs: the pilot's wakes
// [{ cost, at }] (the project's pilot.costs); the plan's window from..to (to null: still running). → the dollars of the wakes
// inside the window
export const pilotCostIn = (costs = [], from, to = null) => {
  const a = Date.parse(from); if (!Number.isFinite(a)) return null;
  const b = to ? Date.parse(to) : Infinity;
  return Math.round(costs.reduce((s, c) => { const t = Date.parse(c?.at); return t >= a && t <= b ? s + (Number(c.cost) || 0) : s; }, 0) * 100) / 100;
};
// metrics.pilotCost and metrics.cost (the sessions) → the line of the story, and a warning past 1
export const pilotLines = ({ pilotCost, cost } = {}) => {
  if (!Number.isFinite(pilotCost) || !Number.isFinite(cost)) return [];
  const ratio = cost > 0 ? pilotCost / cost : null;
  const out = [`Pilote : ${usd(pilotCost)} ; sessions : ${usd(cost)} ; rapport ${ratio === null ? '—' : dec(ratio, 2)}.`];
  if ((ratio !== null && ratio > 1) || (cost === 0 && pilotCost > 0)) out.push('Le pilote a coûté plus que le code qu’il pilote.');
  return out;
};
export const storyOf = ({ plan, state = [], log = [], metrics = {}, messages = [], timeZone } = {}) => {
  const out = [];
  const title = plan?.title || plan?.id || 'Un plan';
  const sessions = Array.isArray(plan?.sessions) ? plan.sessions : [];
  const waves = Array.isArray(plan?.waves) && plan.waves.length ? plan.waves.length : new Set(sessions.map((s) => s.wave || 1)).size;
  const project = plan?.project ? path.basename(plan.project) : null;
  const sorted = [...log].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const startedAt = metrics.startedAt || sorted.find((l) => l.status === 'running')?.at || null;
  const finished = state.length > 0 && state.every((r) => r.status === 'done');
  const endedAt = finished ? metrics.endedAt || [...sorted].reverse().find((l) => l.status === 'done')?.at || null : null;

  out.push(`# ${title}`, '');
  const start = startedAt ? partsOf(startedAt, timeZone) : null;
  out.push(`${start ? `Le ${dayOf(start)} à ${start.time}, j'ai lancé` : "J'ai écrit"} « ${title} »${project ? ` sur ${project}` : ''}.${plan?.goal ? ` Le but : ${plan.goal.trim().replace(/\.?$/, '.')}` : ''}`, '');

  const lines = [];
  let shape = `${plural(sessions.length || state.length, 'session')} en ${plural(waves, 'vague')}`;
  if (start && endedAt) { const end = partsOf(endedAt, timeZone); shape += `, de ${start.time} à ${end.time}${dayOf(end) !== dayOf(start) ? ` le ${dayOf(end)}` : ''}, soit ${lengthOf(Date.parse(endedAt) - Date.parse(startedAt))}`; }
  else if (!finished) { const left = state.filter((r) => r.status !== 'done').length; shape += `, pas encore fini (${plural(left, 'session')} sur ${state.length} en cours ou à venir)`; }
  lines.push(shape + '.');
  if (Number.isFinite(metrics.cost)) {
    const merged = metrics.merged ?? state.filter((r) => r.worktree?.merged).length;
    lines.push(`Coût au tarif public : ${usd(metrics.cost)} ; ${merged ? `${plural(merged, 'PR fusionnée', 'PR fusionnées')}${metrics.costPerMergedPr != null ? `, soit ${usd(metrics.costPerMergedPr)} par PR` : ''}` : 'aucune PR fusionnée'}.`);
  }
  lines.push(...pilotLines(metrics));
  if (metrics.sessionHours != null && metrics.attentionMinutes != null) lines.push(`Mon attention : ${Math.round(metrics.attentionMinutes)} min pour ${dec(metrics.sessionHours)} h de sessions.`);
  const planned = sessions.reduce((n, s) => n + (Array.isArray(s.stops) ? s.stops.length : 0), 0);
  const crossed = state.reduce((n, r) => n + (Array.isArray(r.stops) ? r.stops.length : 0), 0);
  if (planned) lines.push(`Arrêts franchis : ${crossed} sur ${planned}.`);
  if (metrics.unattended === true) lines.push('Fini sans intervention : je n’ai répondu qu’aux arrêts prévus.');
  else if (metrics.unattended === false && metrics.interventions) lines.push(`J'ai dû intervenir ${metrics.interventions === 1 ? 'une fois' : `${metrics.interventions} fois`} hors des arrêts prévus.`);
  out.push(lines.map((l) => `- ${l}`).join('\n'), '');

  // What broke: health 'error', handoffs, caps reached
  const errored = new Set([...state.filter((r) => r.health === 'error').map((r) => r.id), ...log.filter((l) => l.health === 'error').map((l) => l.session)]).size;
  const handoffs = state.reduce((n, r) => n + (Array.isArray(r.handoffs) ? r.handoffs.length : 0), 0);
  const flat = Array.isArray(messages) ? messages : Object.values(messages || {}).flat();
  const caps = flat.filter((m) => m.role === 'system' && /^(Plafond de .* atteint|⟦srv\.s\.capped)/.test(m.text || '')).length;
  const broke = [errored && `${plural(errored, 'session')} en erreur`, handoffs && `${plural(handoffs, 'passation')} (une session fraîche a repris le travail)`, caps && `${caps === 1 ? 'un plafond atteint' : `${caps} plafonds atteints`}`].filter(Boolean);
  out.push(broke.length ? `Ce qui a cassé : ${broke.join(', ')}.` : 'Rien n’a cassé.', '');

  out.push('Fait avec calmdev, local, source available.', '');
  return out.join('\n');
};

// Where the story goes: the plan's project, else the git root of its first session's folder
export const projectOfStory = (plan, gitRootOf) => {
  if (plan?.project) return plan.project;
  const first = Array.isArray(plan?.sessions) ? plan.sessions.find((s) => s && s.path)?.path : null;
  return first ? gitRootOf(first) : null;
};
