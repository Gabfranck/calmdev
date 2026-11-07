// The git gestures of a session (lesson of 3 November, session GIT; docs/gitops.md): a « GIT: » line alone on its line asks
// the server for a commit, a branch, a switch or a merge in the session's own worktree or one of its submodules, run
// outside the sandbox, logged, and handed back at the head of the next message. On the model of lib/docker.mjs.
// Never push, fetch, pull, remote, reset, clean, rebase, worktree; never a path out of the worktree (realpath); never
// main or master; never a hook, a filter or a driver of the repository's own config (the session can write .git/).
//
//   tokenize(s)                          → { words } | { error }: words, "double quotes", \" and \\ inside them
//   parseLines(prefix, text, state, max) → the « PREFIX: rest » lines of a turn, unique, in order (reused by TEST:)
//   plan(words)                          → { rel, verb, steps: [argv…], show } | { error }: the only argv ever built
//   repoOf(worktree, rel)                → { dir } | { error }: realpath inside the worktree, root of a git repo
//   gitRun({ line, worktree, … })        → { ok, code, lines, command, repo, error? }
//   gitNote(r)                           → the lines handed to the session
//   createGitOps({ … })                  → { ofTurn(planId, sid, text, state, worktree), busy, queue } for the server
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { safeEnv } from './planner.mjs';
import { createQueue } from './docker.mjs';

export const VERBS = Object.freeze(['commit', 'branch', 'switch', 'merge']);
export const MAX_PER_TURN = 4;
export const MAX_LINES = 60;
export const TIMEOUT_MS = 30000;
const FORBIDDEN = new Set(['push', 'fetch', 'pull', 'remote', 'reset', 'clean', 'rebase', 'worktree', 'checkout', 'restore', 'config', 'tag', 'stash', 'gc', 'prune', 'submodule', 'filter-branch', 'update-ref', 'clone', 'init', 'am', 'apply', 'cherry-pick', 'revert', 'rm', 'mv']);
const PROTECTED = new Set(['main', 'master']);
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)(?!.*\.$)[A-Za-z0-9._\/-]{1,200}$/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// keys of the repository's own config (local or worktree scope) that make git run a program: refused before any gesture
const RISKY = /^(filter\.|core\.(hookspath|fsmonitor|editor|pager|sshcommand|gitproxy|askpass|alternaterefsCommand)|sequence\.editor|gpg\.|diff\.[^.]+\.(textconv|command)|merge\.[^.]+\.driver|include\.|includeif\.|alias\.|credential\.|uploadpack\.|receive\.)/i;

export const INSTRUCTION = 'Un geste git dans ton worktree ou un de ses sous-modules se demande par une ligne seule `GIT: [-C <sous-module>] commit -m "<message>" [-a | <chemins>]`, `GIT: branch <nom> [depuis]`, `GIT: switch <branche>`, `GIT: merge --no-ff <branche>` ou `GIT: merge --ff-only <branche>` : le serveur l’exécute hors du bac (jamais push, jamais main ni master) et rend le résultat en tête de ton message suivant (docs/gitops.md).';

// ---------------------------------------------------------------- words
export const tokenize = (s) => {
  const words = []; let cur = null; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) { cur += s[++i]; continue; } if (c === '"') { q = false; continue; } cur += c; continue; }
    if (c === '"') { q = true; cur ??= ''; continue; }
    if (c === ' ' || c === '\t') { if (cur !== null) { words.push(cur); cur = null; } continue; }
    cur = (cur ?? '') + c;
  }
  if (q) return { error: 'guillemet non fermé' };
  if (cur !== null) words.push(cur);
  return { words };
};

export const parseLines = (prefix, text, state, max = MAX_PER_TURN) => {
  const out = []; const seen = new Set(); const re = new RegExp(`^[ \\t>*-]*${prefix}:[ \\t]*(\\S.*?)[ \\t]*$`, 'gm');
  const scan = (s) => { for (const m of String(s ?? '').matchAll(re)) { if (seen.has(m[1])) continue; seen.add(m[1]); out.push(m[1]); } };
  scan(text);
  if (state && typeof state === 'object') for (const v of Object.values(state)) if (typeof v === 'string') scan(v);
  return out.slice(0, max);
};
export const parseGit = (text, state) => parseLines('GIT', text, state);

// ---------------------------------------------------------------- the only argv ever built
const refused = (why) => ({ error: why });
const badRef = (n, what) => (!n ? `${what} manque` : !REF.test(n) ? `« ${clip(n, 60)} » n’est pas un nom de ${what} valide` : null);
export const stripCoAuthor = (m) => m.replace(/\s*co-authored-by:.*$/is, '').trim();

export const plan = (words) => {
  let w = [...words]; let rel = '.';
  if (w[0] === '-C') { if (!w[1]) return refused('-C sans chemin'); rel = w[1]; w = w.slice(2); }
  const verb = (w[0] || '').toLowerCase(); const args = w.slice(1);
  if (!verb) return refused('aucun verbe');
  if (FORBIDDEN.has(verb)) return refused(`${verb} refusé : seuls commit, branch, switch et merge passent, jamais rien qui pousse, efface ou touche aux worktrees`);
  if (!VERBS.includes(verb)) return refused(`verbe inconnu (${clip(verb, 40)}) : commit, branch, switch ou merge`);
  const base = { rel, verb };
  if (verb === 'commit') {
    let msg = null; let all = false; const paths = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m' && msg === null) { if (args[i + 1] === undefined) return refused('commit : -m sans message'); msg = args[++i]; }
      else if (a === '-a' && !all) all = true;
      else if (a === '--') { paths.push(...args.slice(i + 1)); break; }
      else if (a.startsWith('-')) return refused(`commit : option ${clip(a, 30)} refusée (seuls -m et -a)`);
      else paths.push(a);
    }
    const message = stripCoAuthor(msg ?? '');
    if (!message) return refused('commit : le message manque (-m "<message>")');
    if (all && paths.length) return refused('commit : -a ou des chemins, pas les deux');
    if (paths.length > 100) return refused('commit : 100 chemins au plus');
    for (const p of paths) if (!p || p.startsWith('-') || path.isAbsolute(p) || /[\0\r\n]/.test(p) || path.normalize(p).split(path.sep)[0] === '..' || p.startsWith(':')) return refused(`commit : chemin ${clip(p, 60)} refusé (relatif, dans le dépôt)`);
    const steps = [];
    if (paths.length) steps.push(['add', '--', ...paths]);
    steps.push(['commit', '-m', message, ...(all ? ['-a'] : []), ...(paths.length ? ['--', ...paths] : [])]);
    return { ...base, steps, show: `commit${all ? ' -a' : ''} -m "${clip(message, 80)}"${paths.length ? ' ' + paths.join(' ') : ''}`, head: true };
  }
  if (verb === 'branch') {
    if (args.length < 1 || args.length > 2) return refused('branch <nom> [depuis]');
    const bad = badRef(args[0], 'branche') || (args[1] !== undefined && badRef(args[1], 'point de départ')); if (bad) return refused('branch : ' + bad);
    if (PROTECTED.has(args[0])) return refused(`branch : ${args[0]} est protégée (main et master restent au pilote)`);
    return { ...base, steps: [['branch', ...args]], show: 'branch ' + args.join(' ') };
  }
  if (verb === 'switch') {
    if (args.length !== 1) return refused('switch <branche>');
    const bad = badRef(args[0], 'branche'); if (bad) return refused('switch : ' + bad);
    if (PROTECTED.has(args[0])) return refused(`switch sur ${args[0]} refusé : main et master restent au pilote`);
    return { ...base, steps: [['switch', args[0]]], show: 'switch ' + args[0] };
  }
  // merge
  if (args.length !== 2 || !['--no-ff', '--ff-only'].includes(args[0])) return refused('merge --no-ff <branche> ou merge --ff-only <branche>');
  const bad = badRef(args[1], 'branche'); if (bad) return refused('merge : ' + bad);
  return { ...base, steps: [args[0] === '--no-ff' ? ['merge', '--no-ff', '--no-edit', args[1]] : ['merge', '--ff-only', args[1]]], show: `merge ${args[0]} ${args[1]}`, head: true };
};

// ---------------------------------------------------------------- the repository: inside the worktree, by realpath
export const repoOf = (worktree, rel) => {
  if (!worktree || !existsSync(worktree)) return refused('aucun worktree pour cette session : rien ne s’exécute hors d’un worktree');
  if (path.isAbsolute(rel)) return refused(`-C ${clip(rel, 60)} : un chemin relatif au worktree est attendu`);
  let root; let dir;
  try { root = realpathSync(worktree); } catch { return refused('worktree illisible'); }
  try { dir = realpathSync(path.resolve(root, rel)); } catch { return refused(`-C ${clip(rel, 60)} : dossier introuvable`); }
  if (dir !== root && !dir.startsWith(root + path.sep)) return refused(`-C ${clip(rel, 60)} sort du worktree (realpath ${dir})`);
  try { if (!statSync(dir).isDirectory()) return refused(`-C ${clip(rel, 60)} n’est pas un dossier`); } catch { return refused(`-C ${clip(rel, 60)} : dossier introuvable`); }
  if (!existsSync(path.join(dir, '.git'))) return refused(`${rel === '.' ? 'le worktree' : clip(rel, 60)} n’est pas la racine d’un dépôt git (sous-module attendu)`);
  return { dir, repo: path.relative(root, dir) || '.' };
};

// ---------------------------------------------------------------- one git command
const envOf = (env) => {
  const out = safeEnv(env);
  for (const k of Object.keys(out)) if (/^GIT_/.test(k)) delete out[k];
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
};
const SAFE_C = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'credential.helper='];
export const git = ({ dir, args, env = process.env, spawn = nodeSpawn, timeoutMs = TIMEOUT_MS, maxLines = MAX_LINES }) => new Promise((resolve) => {
  let child;
  try { child = spawn('git', ['-C', dir, ...SAFE_C, ...args], { cwd: dir, env: envOf(env), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true }); }
  catch (e) { resolve({ code: null, stdout: '', lines: [], error: e.message }); return; }
  let stdout = ''; const lines = []; const rest = { out: '', err: '' };
  const push = (p) => { if (p.trim()) lines.push(clip(p, 300)); if (lines.length > maxLines) lines.shift(); };
  const take = (k, chunk) => { const s = String(chunk); if (k === 'out' && stdout.length < 1e5) stdout += s; rest[k] += s.replace(ANSI, ''); const parts = rest[k].split(/\r?\n/); rest[k] = parts.pop(); parts.forEach(push); };
  child.stdout?.on('data', (c) => take('out', c)); child.stderr?.on('data', (c) => take('err', c));
  let done = false; let killed = false;
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  const timer = setTimeout(() => { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref(); }, timeoutMs);
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); for (const k of ['out', 'err']) if (rest[k].trim()) push(rest[k]); resolve(r); };
  child.on('error', (e) => finish({ code: null, stdout, lines, error: e.code === 'ENOENT' ? 'git introuvable sur ce Mac' : e.message }));
  child.on('exit', (code, signal) => finish({ code: code ?? (signal ? 128 : 1), stdout, lines, ...(killed ? { error: `délai de ${Math.round(timeoutMs / 1000)} s dépassé` } : {}) }));
});

// ---------------------------------------------------------------- a GIT: line, from words to verdict
export const gitRun = async ({ line, worktree, hide = (s) => s, env = process.env, spawn = nodeSpawn, timeoutMs = TIMEOUT_MS }) => {
  const base = { line, command: 'git ' + line, repo: null, code: null, lines: [] };
  const no = (error, extra = {}) => ({ ...base, ...extra, ok: false, refused: true, error });
  const t = tokenize(line); if (t.error) return no(t.error);
  const p = plan(t.words); if (p.error) return no(p.error);
  const r = repoOf(worktree, p.rel); if (r.error) return no(r.error);
  const where = { repo: r.repo, command: `git${p.rel === '.' ? '' : ' -C ' + p.rel} ${p.show}` };
  const ask = (args) => git({ dir: r.dir, args, env, spawn, timeoutMs, maxLines: 500 });
  const cfg = await ask(['config', '--list', '--show-scope']);
  if (cfg.code !== 0) return no(`config du dépôt illisible (code ${cfg.code})`, where);
  const risky = cfg.stdout.split('\n').map((l) => l.split('\t')).filter(([scope, kv]) => kv && ['local', 'worktree'].includes(scope) && RISKY.test(kv.split('=')[0])).map(([, kv]) => kv.split('=')[0]);
  if (risky.length) return no(`la config du dépôt fait lancer un programme à git (${[...new Set(risky)].slice(0, 4).join(', ')}) : geste refusé, au pilote de regarder`, where);
  if (p.head) {
    const h = await ask(['symbolic-ref', '--quiet', '--short', 'HEAD']); const head = h.stdout.trim();
    if (h.code !== 0 || !head) return no(`${p.verb} refusé : HEAD détachée, passe d’abord sur une branche (GIT: switch)`, where);
    if (PROTECTED.has(head)) return no(`${p.verb} sur ${head} refusé : main et master restent au pilote`, where);
  }
  const out = []; let last = { code: 0 };
  for (const args of p.steps) {
    last = await git({ dir: r.dir, args, env, spawn, timeoutMs });
    out.push(...last.lines);
    if (last.error || last.code !== 0) break;
  }
  return { ...base, ...where, ok: !last.error && last.code === 0, code: last.code, lines: out.slice(-MAX_LINES).map(hide), ...(last.error ? { error: hide(last.error) } : {}) };
};

export const gitNote = (r) => {
  const head = `GIT ${clip(String(r.command || "git ?").replace(/^git /, ''), 160)}${r.repo ? ` (${r.repo})` : ''} : `;
  const verdict = r.refused ? 'refusé : ' + r.error : r.ok ? `ok (code ${r.code})` : `échec (code ${r.code}${r.error ? ', ' + r.error : ''})`;
  return head + verdict + ((r.lines || []).length ? '\n' + r.lines.map((l) => '  │ ' + l).join('\n') : '');
};

// ---------------------------------------------------------------- the server's side
// record({ project, planId, sessionId, kind, text }) (the pilot's log), onNote(planId, sid, line, r), onIdle(planId, sid),
// projectOfPlan(planId), hideOf(project) → a masker (lib/docker.mjs masker)
export const createGitOps = ({ record = () => {}, onNote = () => {}, onIdle = () => {}, projectOfPlan = () => null, hideOf = () => (s) => s, env = process.env, spawn = nodeSpawn, timeoutMs = TIMEOUT_MS } = {}) => {
  const queue = createQueue();
  const ofTurn = (planId, sid, text, state, worktree) => {
    const lines = parseGit(text, state); if (!lines.length) return 0;
    const project = projectOfPlan(planId); const hide = hideOf(project);
    for (const line of lines) {
      queue.push(worktree || '(aucun worktree)', () => gitRun({ line, worktree, hide, env, spawn, timeoutMs }), { planId, sid }).then((r) => {
        if (project) try { record({ kind: 'note', project, planId, sessionId: sid, text: `Git (session ${sid}, dépôt ${r.repo || '?'}) : ${clip(hide(r.command || "git " + line), 400)} → ${r.refused ? 'refusé : ' + clip(r.error, 200) : `code ${r.code}`}` }); } catch {}
        try { onNote(planId, sid, gitNote(r), r); } catch {}
        if (!queue.busy(planId, sid)) { try { onIdle(planId, sid); } catch {} }
      });
    }
    return lines.length;
  };
  return { ofTurn, busy: queue.busy, queue };
};
