// Phase 16 GH, the routes (docs/connectors.md « Les routes »): GET /api/github/prs, GET /api/github/pr/:n,
// POST /api/github/pr/:n/merge. The merge needs the page cookie (ctx.guardOk): a session on 127.0.0.1 gets 403.
// handle() answers and returns true when the path is one of them, false otherwise.
//
// ctx: { json(res, code, body), readBody(req), projectArg(v), guardOk(req), sessionsOf(project) → [{ planId, sessionId,
//        branch, pr }], secretsOf(project) → [values to hide], record({ project, planId, sessionId, kind, text }),
//        say(planId, sessionId, text), gh: lib/github.mjs (or a stand-in) }
import * as github from './github.mjs';

const fail = (res, ctx, e) => ctx.json(res, e.status || 400, { error: e.message });

export const handle = async (req, res, url, ctx) => {
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'api' || seg[1] !== 'github') return false;
  const gh = ctx.gh || github;
  try {
    if (seg[2] === 'prs' && !seg[3] && req.method === 'GET') {
      const project = ctx.projectArg(url.searchParams.get('project'));
      return ctx.json(res, 200, { ok: true, prs: await gh.prList({ cwd: project, sessions: ctx.sessionsOf(project) }) }), true;
    }
    if (seg[2] !== 'pr' || !seg[3]) return ctx.json(res, 404, { error: 'not found' }), true;
    const n = Number(seg[3]); if (!Number.isInteger(n) || n <= 0 || String(n) !== seg[3]) return ctx.json(res, 400, { error: 'numéro de PR invalide' }), true;
    if (!seg[4] && req.method === 'GET') {
      const project = ctx.projectArg(url.searchParams.get('project'));
      const open = await gh.prList({ cwd: project, sessions: ctx.sessionsOf(project) });
      const pr = open.find((p) => p.number === n); if (!pr) return ctx.json(res, 404, { error: `PR #${n} absente des PR ouvertes` }), true;
      const { checks } = await gh.prChecks({ cwd: project, number: n });
      const failedLog = pr.ci === 'red' ? await gh.failedLog({ cwd: project, number: n, secrets: ctx.secretsOf(project), checks }).catch((e) => ({ error: e.message })) : null;
      const comments = await gh.prReviewComments({ cwd: project, number: n });
      const conflict = pr.base && pr.branch ? await gh.conflicts({ cwd: project, base: pr.base, head: pr.branch }).catch(() => (pr.mergeable === 'CONFLICTING' ? { conflict: true, files: [] } : { conflict: false, files: [] })) : { conflict: pr.mergeable === 'CONFLICTING', files: [] };
      return ctx.json(res, 200, { ok: true, pr, checks, failedLog, comments, conflict, mergeBlock: github.mergeBlock(pr) }), true;
    }
    if (seg[4] === 'merge' && !seg[5] && req.method === 'POST') {
      if (!ctx.guardOk(req)) return ctx.json(res, 403, { error: 'fusion sur le clic du développeur seulement (cookie de page)' }), true;
      const b = await ctx.readBody(req);
      const project = ctx.projectArg(b.project);
      const method = b.method == null ? 'squash' : String(b.method);
      const link = ctx.sessionsOf(project).find((s) => Number(s.pr?.number) === n) || null;
      try {
        const r = await gh.prMerge({ cwd: project, number: n, method, deleteBranch: b.deleteBranch === true });
        ctx.record({ project, planId: link?.planId, sessionId: link?.sessionId, kind: 'merge', text: `PR #${n} fusionnée (${method})\nSur le clic du développeur, tête ${String(r.head || '').slice(0, 7)}${r.deleted ? ', branche supprimée' : ''}.` });
        if (link) ctx.say(link.planId, link.sessionId, `PR #${n} fusionnée sur GitHub (${method}).`);
        return ctx.json(res, 200, { ok: true, number: r.number, method: r.method, deleted: r.deleted }), true;
      } catch (e) {
        if (e.status === 409) ctx.record({ project, planId: link?.planId, sessionId: link?.sessionId, kind: 'refuse', text: `Fusion de la PR #${n} refusée\n${e.message}` });
        throw e;
      }
    }
    return ctx.json(res, 404, { error: 'not found' }), true;
  } catch (e) { return fail(res, ctx, e), true; }
};
