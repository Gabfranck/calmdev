// Phase 13 PIL, the pilot's handoff (docs/pilot.md, « La passation du pilote »). The pilot was resumed by --resume at
// every wake: its context grew without end and every call read it all again (one pilot conversation ate ≈ 19 % of the
// week, mostly cache reads). The sessions' handoff (docs/sessions.md) applies to it with a lower, settable threshold:
// 40 % of the window, or a wake above HANDOFF_USD. At the threshold the same process gets one more turn to write
// <project>/.escadrille/passation-pilote.md (under 80 lines); the next wake starts a fresh process with that text, the
// last 40 memory lines and the state of the plans (which the wake prompt already carries). The journal keeps a row.
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { projectRel } from './names.mjs';

export const HANDOFF_CONTEXT = 0.4; // share of the window
export const HANDOFF_USD = 1.5; // a wake above this (the cap of a wake is 2 $) means the context is the cost
export const MAX_LINES = 80;
export const FILE = projectRel('passation-pilote.md');
export const MAX_COSTS = 60; // wakes kept for the average

export const thresholdsOf = (settings = {}) => ({ context: num(settings.pilotHandoffContext, HANDOFF_CONTEXT), usd: num(settings.pilotHandoffUsd, HANDOFF_USD) });
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 && v !== null && v !== '' ? Number(v) : d);

export const needsHandoff = ({ context = null, cost = 0, thresholds = thresholdsOf() } = {}) => {
  if (typeof context === 'number' && context >= thresholds.context) return { yes: true, why: `contexte à ${Math.round(context * 100)} %` };
  if (Number(cost) >= thresholds.usd) return { yes: true, why: `réveil à ${Number(cost).toFixed(2).replace('.', ',')} $` };
  return { yes: false, why: '' };
};

export const handoffFile = (project) => path.join(project, FILE);
// The text sent to the pilot for its handoff turn
export const handoffRequest = ({ project, n, why }) => `Passation n°${n} (${why}) : ton contexte coûte plus qu'il n'aide. Dans ce tour, et rien d'autre, écris le fichier ${handoffFile(project)} en français, moins de ${MAX_LINES} lignes :
1. ce qui tourne (plans, sessions, où elles en sont) ;
2. ce qui attend le développeur ;
3. les décisions du jour qui ne sont pas encore dans la mémoire du projet ;
4. la prochaine action.
Tu n'as pas d'outil d'écriture : mets ce texte dans un bloc \`\`\`escadrille:passation … \`\`\`, le serveur l'écrit pour toi. Aucun autre bloc.`;

// The block of the handoff turn, cut to MAX_LINES
export const parseHandoff = (text) => {
  const m = /```(?:calmdev|escadrille):passation\s*\n([\s\S]*?)```/.exec(String(text || ''));
  const body = (m ? m[1] : String(text || '')).trim();
  if (!body) return null;
  return body.split('\n').slice(0, MAX_LINES).join('\n');
};

// A handoff above ~4 KB is refused: the present state and the next step only, the history goes to the archive.
export const MAX_BYTES = 4096;
export const TOO_LONG = 'Passation trop longue : garde l’état présent et la suite, l’historique part en archive';
export const archiveFile = (project, date = new Date()) => path.join(project, projectRel(`passation-pilote-archive-${new Date(date).toISOString().slice(0, 10)}.md`));

// Writes the handoff in the project's private folder. Refused (nothing touched) above MAX_BYTES; otherwise the previous
// handoff is first appended to the archive of the day (never overwritten), then replaced. { ok, reason?, archived? }
export const writeHandoff = (project, text, date = new Date()) => {
  const body = String(text ?? '');
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return { ok: false, reason: TOO_LONG };
  const file = handoffFile(project);
  let archived = null;
  if (existsSync(file)) {
    const old = readFileSync(file, 'utf8');
    if (old.trim()) { archived = archiveFile(project, date); appendFileSync(archived, (existsSync(archived) ? '\n\n---\n\n' : '') + old.replace(/\n*$/, '\n')); }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body.replace(/\n*$/, '\n'));
  return { ok: true, archived };
};

// The head of the first prompt of a fresh pilot
export const freshPrompt = ({ n, text }) => `# Passation n°${n}, laissée par le pilote précédent\n\n${text}\n\n# Le réveil\n\n`;

// The costs of the wakes, kept short: [{ cost, fresh }] where fresh says the wake started a fresh process (after a handoff)
export const pushCost = (list = [], entry) => { const out = [...(Array.isArray(list) ? list : []), { cost: Math.round((Number(entry.cost) || 0) * 10000) / 10000, fresh: !!entry.fresh, at: entry.at || new Date().toISOString() }]; while (out.length > MAX_COSTS) out.shift(); return out; };
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10000) / 10000 : null);
// The mean cost of a wake over the last `ms` (24 h by default): { wakes, avg } with avg null when no wake
export const recentAvg = (list = [], now = Date.now(), ms = 864e5) => {
  const xs = (Array.isArray(list) ? list : []).filter((c) => { const t = Date.parse(c.at); return Number.isFinite(t) && t <= now && now - t < ms; }).map((c) => Number(c.cost) || 0);
  return { wakes: xs.length, avg: avg(xs) };
};
// Before: the wakes of the resumed pilot before its first handoff; after: those since (fresh process, then its resumes)
export const costStats = (list = []) => {
  const i = list.findIndex((c) => c.fresh);
  const before = (i < 0 ? list : list.slice(0, i)).map((c) => c.cost); const after = (i < 0 ? [] : list.slice(i)).map((c) => c.cost);
  return { before: { wakes: before.length, avg: avg(before) }, after: { wakes: after.length, avg: avg(after) } };
};
