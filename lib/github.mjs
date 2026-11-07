// The GitHub connector (docs/connectors.md): the gh already signed in on this Mac, the program given by
// ESCADRILLE_GH (default 'gh'), and git; both through execFile with fixed arguments, never a shell.
// Nothing here runs on its own: the server calls it on the developer's click only.
//
//   pushBranch({ cwd, branch })                  git push -u origin <branch>: the only push of the server
//   createPr({ cwd, base, head, title, body })   → { url, number, existing }   (an open PR already there: its URL)
//   prState({ cwd, number })                     → { state, merged, url, reviewDecision }
//   issueList({ cwd, q, limit })                 → [{ number, title, state, url }]   open issues, gh's search for q, 50 at most
//   issueView({ cwd, number })                   → { number, title, body, state, url, comments: [{ author, body, at }] }
//   ghPresent(env)                               gh on the PATH, found by existsSync, never launched
// Phase 16 GH: prList, prView, prChecks, failedLog, prReviewComments, mergeBlock, prMerge (the developer's click
// only), conflicts (git merge-tree, local); see docs/connectors.md « Phase 16 GH ».
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envVar } from './names.mjs';

const ghOf = (env = process.env) => envVar('GH', env) || 'gh';

const run = (cmd, args, cwd) => new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout: 60000, maxBuffer: 4e6, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, out, errOut) => {
  if (!err) return resolve(String(out).trim());
  const text = String(errOut || '').trim() || err.message;
  const e = new Error(text); e.code = err.code; reject(e);
}));

// A gh failure, said plainly
const readable = (e) => {
  if (e.code === 'ENOENT') return new Error('gh introuvable : installe GitHub CLI (https://cli.github.com) puis lance gh auth login');
  if (/not logged in|gh auth login|authentication required|HTTP 401/i.test(e.message)) return new Error('gh n’est pas connecté : lance gh auth login');
  if (/no git remotes|none of the git remotes|not a git repository/i.test(e.message)) return new Error('le dépôt n’a pas de remote GitHub (origin)');
  return new Error('gh : ' + e.message.split('\n')[0]);
};
const gh = async (args, cwd) => { try { return await run(ghOf(), args, cwd); } catch (e) { throw readable(e); } };

export const ghPresent = (env = process.env) => {
  const g = ghOf(env);
  if (g.includes('/')) return existsSync(g);
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((d) => existsSync(path.join(d, g)));
};

const BRANCH = /^[\w./-]+$/;
const checkBranch = (b, what) => { if (!BRANCH.test(String(b || '')) || String(b).startsWith('-')) throw new Error(`${what} : nom de branche invalide`); return String(b); };

export const pushBranch = async ({ cwd, branch }) => {
  checkBranch(branch, 'branche');
  try { await run('git', ['push', '-u', 'origin', branch], cwd); } catch (e) {
    if (e.code === 'ENOENT') throw new Error('git introuvable');
    if (/'origin' does not appear|no such remote|does not appear to be a git repository/i.test(e.message)) throw new Error('le dépôt n’a pas de remote origin');
    throw new Error('git push : ' + e.message.split('\n').filter(Boolean).slice(-1)[0]);
  }
  return { ok: true };
};

const numberOf = (url) => Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null;

export const createPr = async ({ cwd, base, head, title, body }) => {
  checkBranch(base, 'base'); checkBranch(head, 'head');
  try {
    const out = await run(ghOf(), ['pr', 'create', '--base', base, '--head', head, '--title', String(title || head), '--body', String(body || '')], cwd);
    const url = out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop();
    if (!url) throw new Error('gh pr create n’a pas rendu d’URL');
    return { url, number: numberOf(url), existing: false };
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw readable(e);
    const list = JSON.parse((await gh(['pr', 'list', '--head', head, '--state', 'open', '--json', 'url,number'], cwd)) || '[]');
    if (!list.length) throw new Error('gh dit qu’une PR existe déjà pour ' + head + ', mais gh pr list ne la trouve pas');
    return { url: list[0].url, number: list[0].number, existing: true };
  }
};

// The issues a plan may start from (phase 16 TIX, read only): the open ones, or those gh's search finds for q
export const issueList = async ({ cwd, q = '', limit = 50 }) => {
  const args = ['issue', 'list', '--state', 'open', '--limit', String(Math.min(50, Math.max(1, Number(limit) || 50))), '--json', 'number,title,state,url'];
  const term = String(q || '').trim(); if (term) args.push('--search', term);
  return JSON.parse((await gh(args, cwd)) || '[]').map((i) => ({ number: i.number, title: i.title, state: i.state ?? null, url: i.url ?? null }));
};

export const issueView = async ({ cwd, number }) => {
  if (!Number.isInteger(Number(number)) || Number(number) <= 0) throw new Error('numéro d’issue invalide');
  const v = JSON.parse(await gh(['issue', 'view', String(Number(number)), '--json', 'number,title,body,state,url,comments'], cwd));
  return { number: v.number, title: v.title, body: v.body || '', state: v.state ?? null, url: v.url ?? null, comments: (v.comments || []).map((c) => ({ author: c.author?.login || '?', body: c.body || '', at: c.createdAt || '' })) };
};

export const prState = async ({ cwd, number }) => {
  const n = checkNumber(number);
  const v = JSON.parse(await gh(['pr', 'view', n, '--json', 'state,mergedAt,url,reviewDecision'], cwd));
  return { state: v.state ?? null, merged: v.state === 'MERGED' || !!v.mergedAt, url: v.url ?? null, reviewDecision: v.reviewDecision || null };
};

// ---------------------------------------------------------------- Phase 16 GH (docs/connectors.md): read the PRs, merge on a click
const checkNumber = (number) => { const n = Number(number); if (!Number.isInteger(n) || n <= 0 || String(number).trim() !== String(n)) throw new Error('numéro de PR invalide'); return String(n); };
const parse = (s, fallback) => { try { return JSON.parse(s || ''); } catch { return fallback; } };

// gh pr checks exits 1 when a check failed and 8 when some are pending: the JSON on stdout is still the answer
const ghKeep = (args, cwd, codes) => new Promise((resolve, reject) => execFile(ghOf(), args, { cwd, timeout: 60000, maxBuffer: 4e6, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, out, errOut) => {
  if (!err || (codes.includes(err.code) && String(out).trim())) return resolve(String(out).trim());
  const e = new Error(String(errOut || '').trim() || err.message); e.code = err.code; reject(readable(e));
}));

// A check of statusCheckRollup (CheckRun or StatusContext) or of gh pr checks, reduced to a bucket
const bucketOf = (c) => {
  if (c.bucket) return c.bucket;
  const s = String(c.conclusion || c.state || '').toUpperCase(); const st = String(c.status || '').toUpperCase();
  if (st && st !== 'COMPLETED') return 'pending';
  if (['SUCCESS', 'NEUTRAL'].includes(s)) return 'pass';
  if (s === 'SKIPPED') return 'skipping';
  if (['CANCELLED', 'CANCELED'].includes(s)) return 'cancel';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) return 'fail';
  return 'pending';
};
export const ciOf = (checks = []) => {
  const b = (checks || []).map(bucketOf);
  if (!b.length) return 'none';
  if (b.some((x) => x === 'fail' || x === 'cancel')) return 'red';
  if (b.some((x) => x === 'pending')) return 'pending';
  return 'green';
};

const linkOf = (sessions = [], number, branch) => {
  const s = sessions.find((x) => Number(x.pr?.number) === Number(number)) || sessions.find((x) => x.branch && x.branch === branch);
  return s ? { planId: s.planId, sessionId: s.sessionId } : null;
};
const rowOfPr = (v, sessions) => ({
  number: v.number, title: v.title ?? '', branch: v.headRefName ?? null, base: v.baseRefName ?? null, head: v.headRefOid ?? null,
  author: v.author?.login ?? null, reviewDecision: v.reviewDecision || null, ci: ciOf(v.statusCheckRollup), mergeable: v.mergeable || 'UNKNOWN',
  url: v.url ?? null, state: v.state || 'OPEN', session: linkOf(sessions, v.number, v.headRefName),
});
const PR_FIELDS = 'number,title,headRefName,headRefOid,baseRefName,author,reviewDecision,statusCheckRollup,mergeable,url';

// sessions: [{ planId, sessionId, branch, pr }] to link each PR to its session
export const prList = async ({ cwd, sessions = [] }) => parse(await gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', PR_FIELDS], cwd), []).map((v) => rowOfPr(v, sessions));

export const prView = async ({ cwd, number, sessions = [] }) => rowOfPr(parse(await gh(['pr', 'view', checkNumber(number), '--json', PR_FIELDS + ',state'], cwd), {}), sessions);

export const prChecks = async ({ cwd, number }) => {
  const list = parse(await ghKeep(['pr', 'checks', checkNumber(number), '--json', 'name,state,bucket,link,workflow'], cwd, [1, 8]), []);
  const checks = list.map((c) => ({ name: c.name ?? '', workflow: c.workflow ?? '', bucket: bucketOf(c), link: c.link ?? '' }));
  return { ci: ciOf(checks), checks };
};

// The log of a failed job, its last lines, the secrets hidden (as hide() of lib/qarun.mjs, plus token patterns)
const TOKENS = [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /\blin_api_[A-Za-z0-9]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abp]-[A-Za-z0-9-]{10,}/g];
export const maskLog = (text, secrets = []) => {
  let t = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 3) t = t.split(String(s)).join('•••');
  for (const re of TOKENS) t = t.replace(re, '•••');
  return t.replace(/(Bearer\s+)[^\s'"]+/gi, '$1•••').replace(/\b(password|passwd|token|secret|api[_-]?key)(\s*[=:]\s*)[^\s'"&]+/gi, '$1$2•••');
};
export const LOG_LINES = 200;
export const failedLog = async ({ cwd, number, secrets = [], checks = null }) => {
  const list = checks || (await prChecks({ cwd, number })).checks;
  const failed = list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const c = failed.find((x) => /\/actions\/runs\/\d+\/job\/\d+/.test(x.link)) || failed.find((x) => /\/actions\/runs\/\d+/.test(x.link));
  if (!c) return failed.length ? { check: failed[0].name, run: null, job: null, log: '' } : null;
  const [, run, job] = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(c.link);
  const out = await gh(['run', 'view', run, ...(job ? ['--job', job] : []), '--log-failed'], cwd);
  return { check: c.name, run, job: job || null, log: maskLog(out.split('\n').slice(-LOG_LINES).join('\n'), secrets) };
};

// The unresolved review threads: a fixed GraphQL query; gh fills {owner} and {repo} from the remote, the number is checked
const THREADS = `query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) {
  reviewThreads(first: 100) { nodes { id isResolved isOutdated path line comments(first: 50) { nodes { author { login } body url createdAt } } } }
  reviews(last: 20, states: CHANGES_REQUESTED) { nodes { id author { login } body url submittedAt } } } } }`;
export const prReviewComments = async ({ cwd, number }) => {
  const v = parse(await gh(['api', 'graphql', '-f', 'query=' + THREADS, '-F', 'owner={owner}', '-F', 'repo={repo}', '-F', 'n=' + checkNumber(number)], cwd), {});
  const pr = v?.data?.repository?.pullRequest || {};
  const threads = (pr.reviewThreads?.nodes || []).filter((t) => !t.isResolved && !t.isOutdated && t.comments?.nodes?.length).map((t) => {
    const [first, ...replies] = t.comments.nodes;
    return { id: t.id, path: t.path ?? null, line: t.line ?? null, author: first.author?.login ?? null, body: [first.body, ...replies.map((r) => `${r.author?.login ?? '?'} : ${r.body}`)].join('\n'), url: first.url ?? null, at: first.createdAt ?? null };
  });
  const reviews = (pr.reviews?.nodes || []).filter((r) => String(r.body || '').trim()).map((r) => ({ id: r.id, path: null, line: null, author: r.author?.login ?? null, body: r.body, url: r.url ?? null, at: r.submittedAt ?? null }));
  return [...threads, ...reviews];
};

// The refusal of a merge, in one sentence, or null
export const mergeBlock = (pr) => {
  if (!pr || (pr.state && pr.state !== 'OPEN')) return 'La PR n’est plus ouverte.';
  if (pr.ci === 'red') return 'La CI est rouge : corrige-la avant de fusionner.';
  if (pr.ci === 'pending') return 'La CI tourne encore : attends qu’elle finisse.';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Des changements sont demandés en revue.';
  if (pr.mergeable === 'CONFLICTING') return 'La PR est en conflit avec sa base.';
  if (pr.mergeable !== 'MERGEABLE') return 'GitHub ne sait pas encore si la PR est fusionnable : réessaie dans un instant.';
  return null;
};
export const METHODS = ['merge', 'squash', 'rebase'];
// Only on the developer's click (the server checks the page cookie before calling it)
export const prMerge = async ({ cwd, number, method = 'squash', deleteBranch = false }) => {
  if (!METHODS.includes(method)) throw Object.assign(new Error('méthode : merge, squash ou rebase'), { status: 400 });
  const n = checkNumber(number);
  const pr = await prView({ cwd, number: n });
  const block = mergeBlock(pr); if (block) throw Object.assign(new Error(block), { status: 409 });
  await gh(['pr', 'merge', n, '--' + method, ...(deleteBranch ? ['--delete-branch'] : []), '--match-head-commit', pr.head], cwd);
  return { ok: true, number: Number(n), method, deleted: !!deleteBranch, head: pr.head };
};

// The conflicts with the base, locally: git merge-tree (git 2.38+), no fetch, nothing written to the branches
export const conflicts = async ({ cwd, base, head }) => {
  checkBranch(base, 'base'); checkBranch(head, 'head');
  const has = async (ref) => { try { await run('git', ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], cwd); return true; } catch { return false; } };
  const b = (await has('refs/remotes/origin/' + base)) ? 'origin/' + base : base;
  return new Promise((resolve, reject) => execFile('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', b, head], { cwd, timeout: 60000, maxBuffer: 4e6 }, (err, out, errOut) => {
    if (!err) return resolve({ conflict: false, files: [] });
    if (err.code === 1) return resolve({ conflict: true, files: String(out).trim().split('\n').slice(1).filter(Boolean) });
    reject(new Error('git merge-tree : ' + (String(errOut || '').trim().split('\n')[0] || err.message)));
  }));
};
