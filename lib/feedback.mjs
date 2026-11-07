// « Retour » (docs/backlog.md, Dev, 7 November): the report a first tester reads whole before anything leaves the Mac.
//   facts({ plans, sessions })          the steps crossed (installation → first plan → first session → first merge),
//                                       the cost and the number of stops, from the rows of the base (counts only)
//   logErrors(text, max)                the last error lines of server.log, each one cleaned
//   clean(line, ctx)                    maskSecrets, then every path and quoted text cut, then lib/privacy.mjs redact
//   report({ version, node, facts, errors })   the report's body, Markdown, French (the issue is read by the team)
//   GET /api/feedback (server.mjs) answers { report }; public/feedback.js adds the sentence and builds the issue URL.
// Nothing here sends anything: the browser opens github.com only on the developer's click. In doubt, a fact is left out.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { maskSecrets } from './mainchat.mjs';
import { context, redact } from './privacy.mjs';

const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export const facts = ({ plans = 0, sessions = [] } = {}) => {
  const rows = sessions.map((r) => ({ usage: parse(r.usage) || {}, worktree: parse(r.worktree) || {}, stops: parse(r.stops, []) || [], started: !!(r.session_id || parse(r.usage)) }));
  const cost = rows.reduce((t, r) => t + (Number(r.usage.cost) || 0), 0);
  return {
    steps: { install: true, plan: plans > 0, session: rows.some((r) => r.started), merge: rows.some((r) => r.worktree.merged) },
    sessions: rows.length,
    cost: Math.round(cost * 100) / 100,
    stops: rows.reduce((t, r) => t + (Array.isArray(r.stops) ? r.stops.length : 0), 0),
  };
};

// the projects' names (folder and parent) become <autre-projet>, the home folder ~ (then cut as a path below)
export const contextOf = (projects = [], home) => context({ projects, ...(home ? { home } : {}) });

// a path of any kind (absolute, ~, ./, a Windows drive) and any quoted text (a prompt, a file's content) go; the
// server's own routes stay, they say where it broke
const PATH = /(?:~|\.{1,2})?\/(?!api\/)[^\s'"`()<>,;]*\/[^\s'"`()<>,;]*|[A-Za-z]:\\[^\s'"`]+/g;
const QUOTED = /«[^»]{0,400}»|"[^"\n]{12,}"|'[^'\n]{12,}'|`[^`\n]{12,}`/g;
export const clean = (line, ctx = context()) => {
  let t = maskSecrets(String(line ?? '')).text;
  t = t.replace(QUOTED, '«…»').replace(PATH, '<chemin>');
  t = redact(t, ctx); // what is left outside a path: a project's name, an e-mail, a LAN address
  return t.replace(/\s+/g, ' ').trim().slice(0, 200);
};

const ERROR = /\b(error|erreur|err!?|fail(?:ed|ure)?|échec|échoué|exception|uncaught|unhandled|refus[ée]?|denied|E[A-Z]{3,}|exit code [1-9])\b/i;
export const logErrors = (text, ctx = context(), max = 8) => {
  const lines = String(text || '').split('\n').filter((l) => ERROR.test(l));
  return lines.slice(-max).map((l) => clean(l, ctx)).filter(Boolean);
};

// the tail of the log only (the last 256 KB): a log of months never slows the report
export const readTail = (file, bytes = 256 * 1024) => {
  try {
    const size = statSync(file).size; if (size <= bytes) return readFileSync(file, 'utf8');
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(bytes);
    try { readSync(fd, buf, 0, bytes, size - bytes); } finally { closeSync(fd); }
    return buf.toString('utf8').split('\n').slice(1).join('\n');
  } catch { return ''; }
};

const yes = (b) => (b ? 'oui' : 'pas encore');
export const report = ({ version = '—', node = process.version, facts: f = facts(), errors = [] } = {}) => [
  '## Rapport',
  '',
  `- Version : ${version} · Node ${node}`,
  `- Étapes : installation ${yes(f.steps.install)} → premier plan ${yes(f.steps.plan)} → première session ${yes(f.steps.session)} → première fusion ${yes(f.steps.merge)}`,
  `- Sessions : ${f.sessions} · arrêts franchis : ${f.stops} · coût : ${f.cost.toFixed(2)} $`,
  '',
  '## Dernières erreurs du serveur',
  '',
  ...(errors.length ? errors.map((e) => `- ${e}`) : ['- aucune']),
].join('\n');
