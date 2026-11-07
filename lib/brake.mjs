// The review pace brake (Dev, 7 Nov., docs/decisions.md « Vision, but et méthode »: produce at the pace of the review,
// not of the quota). Per project, the finished deliveries nobody has reviewed yet: a session `done`, its worktree not
// merged, no approval on its review, its plan neither a kit nor closed. Above the project's threshold (`reviewBrake`,
// set in Accès, default 8), neither the pilot nor « Avancer le backlog » launches; the developer's own launches stay open.
// The refusal is the server's; its sentence gives the path that works (review, or raise the threshold).
import { isRetired } from './retire.mjs';
import { doneAt } from './sessiondone.mjs'; // the fixed end date (session_done), else sessions.at

export const DEFAULT_BRAKE = 8;
const parse = (s, d) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

// The threshold stored in the project's settings, else the default; a bad value falls back to the default
export const brakeOf = (settings) => { const n = Number(settings?.reviewBrake); return Number.isInteger(n) && n > 0 ? n : DEFAULT_BRAKE; };

// POST /api/limits { project, brake }: an integer from 1 to 999, or null for the default
export const validateBrake = (v) => {
  if (v === null) return { value: null };
  const n = Number(v);
  if (typeof v === 'boolean' || v === '' || !Number.isInteger(n) || n < 1 || n > 999) return { errors: ['brake : un nombre entier de livraisons, de 1 à 999'] };
  return { value: n };
};

// A finished delivery whose last activity (sessions.at) is older than this stops weighing on the brake; it stays
// visible elsewhere, nothing is deleted or merged
export const STALE_DAYS = 3;

// The finished deliveries of a project not yet reviewed, as [{ plan, session }]; `now` is injectable for tests
export const unreviewedOf = (db, project, now = Date.now()) => {
  const approved = new Set();
  try { for (const r of db.prepare("select plan, session from reviews where project = ? and verdict = 'approve' and plan is not null").all(project)) approved.add(`${r.plan}/${r.session}`); } catch {}
  const out = [];
  for (const pr of db.prepare('select id, json from plans where project = ?').all(project)) {
    const plan = parse(pr.json, null); if (!plan || isRetired(plan) || plan.kit || plan.delivery === 'kit') continue;
    for (const s of db.prepare("select id, worktree, at from sessions where plan = ? and status = 'done'").all(pr.id)) {
      if (s.id === 'pilot') continue;
      const t = Date.parse(doneAt(db, pr.id, s.id, s.at)); if (Number.isFinite(t) && now - t > STALE_DAYS * 864e5) continue;
      const w = parse(s.worktree, null); if (!w || w.merged) continue;
      if (approved.has(`${pr.id}/${s.id}`)) continue;
      out.push({ plan: pr.id, session: s.id });
    }
  }
  return out;
};
export const unreviewedCount = (db, project) => unreviewedOf(db, project).length;

// The verdict for a launch the developer did not click: ok under the threshold, else the sentence for the Flot
export const brakeCheck = ({ count, threshold = DEFAULT_BRAKE }) => {
  const k = Number.isInteger(threshold) && threshold > 0 ? threshold : DEFAULT_BRAKE;
  if (count <= k) return { ok: true, count, threshold: k };
  return { ok: false, count, threshold: k, why: brakeLine(count, k) };
};
export const brakeLine = (count, threshold) =>
  `Rien de neuf ne part seul : ${count} livraison${count > 1 ? 's' : ''} finie${count > 1 ? 's' : ''} à relire (seuil ${threshold}). Relis-en dans « À toi », ou monte le seuil dans Accès › Rythme de relecture ; un lancement à la main reste possible.`;
