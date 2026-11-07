// POL (Dev, 7 November): the guardrail follows the target of a call, never the window that makes it. The main
// conversation (the pilot, or a Claude Code conversation opened by hand in a known project) may do what Claude Code
// may; each of its tool calls is judged here, by the same rule as the sessions (lib/policy.mjs suggest), according to
// what it touches. POST /api/policy/check answers with check(); scripts/policy-hook.mjs carries it to a PreToolUse hook.
//
//   check({ cwd, tool, input, project?, caller, projects, sessions, pushRules }, facts)
//     → { decision: 'allow' | 'deny' | 'ask', why, path, target: { kind, root, project, session? }, rule }
//   caller     'pilot' (the request bore the pilot's token) or 'conversation'
//   projects   [path] of the registry (docs/multiproject.md); sessions: [{ plan, session, path }] whose session runs
//   pushRules  the pilot's personal push exception (readPushRules): [{ repo, branches: [glob] }], empty by default
//   path       the way that works, always given when the decision is not allow (CLAUDE.md: a rule never blocks a developer)
//
// The target, in order: a file tool's path; a Bash call's folder (its cwd, or the folder of a leading `cd`), the
// command itself being opaque. Then:
//   a running session's worktree         → read only
//   the main checkout of a git project   → no write (the worktree command is the way), .escadrille/ excepted
//   a worktree of a known project        → the project's rule (suggest with the worktree as root)
//   a known project without git          → the project's rule
//   outside every project                → the Mac's rule: what suggest allows, the rest asks the developer
// The absolutes hold everywhere, before the target: no push (but the pilot's exception), nothing posted, nothing in
// production, no secret read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { suggest } from './policy.mjs';

// A link followed by readlink when realpath cannot stat its target (a sandbox that denies reading .env): notes.txt → .env
const followLinks = (p) => {
  let cur = p; let hops = 0;
  for (; hops < 8; hops++) {
    let st; try { st = fs.lstatSync(cur); } catch { return hops ? cur : null; }
    if (!st.isSymbolicLink()) break;
    try { cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur)); } catch { return null; }
  }
  return hops ? cur : null;
};
const realFacts = {
  exists: (p) => { try { fs.statSync(p); return true; } catch { return false; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return followLinks(p); } },
  branch: (dir) => { try { const b = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return b && b !== 'HEAD' ? b : null; } catch { return null; } },
  // FUITE3 D1/D3: a remote of the repository, read only: its fetch and push URLs as git resolves them (insteadOf,
  // pushInsteadOf, pushurl applied), or null when it is not a named remote. name null: the remote a bare push goes to.
  remote: (dir, name) => {
    const git = (...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
    const n = name || (git('rev-parse', '--abbrev-ref', '@{push}') || '').split('/')[0] || 'origin';
    if (!/^[\w][\w.-]*$/.test(n)) return null;
    const fetch = git('remote', 'get-url', n); const push = git('remote', 'get-url', '--push', n);
    return fetch && push ? { name: n, fetch, push } : null;
  },
  home: () => os.homedir(),
  list: (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { return null; } },
  tmpDirs: () => ['/tmp', '/private/tmp', os.tmpdir()],
  // macOS disks ignore case: two spellings of one folder are one place there, two elsewhere
  caseless: process.platform === 'darwin',
};

const canon = (p, facts) => { let head = p; const tail = []; while (head !== path.dirname(head)) { const r = facts.realpath(head); if (r) return path.join(r, ...tail.reverse()); tail.push(path.basename(head)); head = path.dirname(head); } return p; };
const fold = (s, facts) => (facts?.caseless ? String(s).toLowerCase() : String(s));
const under = (p, root, facts) => { if (!root || !p) return false; const a = fold(p, facts); const r = fold(root, facts); return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
const relTo = (root, p, facts) => (under(p, root, facts) ? p.slice(root.length).replace(/^\/+/, '') : path.relative(root, p));
const expandHome = (p, home) => (p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p);
const tmpsOf = (facts) => [...new Set(facts.tmpDirs().filter(Boolean).map((t) => canon(path.resolve(String(t)), facts)))];
const isTmp = (p, facts) => tmpsOf(facts).some((t) => under(p, t, facts));

// ---------------------------------------------------------------- reading a shell line
// Its own light reader (lib/policy.mjs keeps its own): words with quotes removed and glued (.e"n"v is .env), the
// unquoted globs and the $… marked, redirections, pipes; $(…), `…`, bash -c '…' and eval '…' read as commands of their own.
const dropHeredocs = (src) => {
  const out = []; const tags = [];
  for (const line of String(src).split('\n')) {
    if (tags.length) { if (line.trim() === tags[0]) tags.shift(); continue; }
    out.push(line);
    for (const m of line.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) tags.push(m[2]);
  }
  return out.join('\n');
};
const lexLine = (src) => {
  const segs = []; const subs = []; const n = src.length; let seg = { words: [], redirs: [], piped: false }; let cur = null; let redir = null; let i = 0;
  const word = () => (cur ??= { v: '', dyn: false, glob: false, quoted: false });
  const flush = () => { if (!cur) return; if (redir) { seg.redirs.push({ out: redir.out, w: cur }); redir = null; } else seg.words.push(cur); cur = null; };
  const end = (piped = false) => { flush(); if (redir) { seg.redirs.push({ out: redir.out, w: null }); redir = null; } if (seg.words.length || seg.redirs.length) segs.push(seg); seg = { words: [], redirs: [], piped }; };
  const sub = (j) => { let depth = 1; let q = null; let k = j;
    for (; k < n; k++) { const c = src[k]; if (q) { if (c === '\\' && q === '"') k++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"') q = c; else if (c === '(') depth++; else if (c === ')' && --depth === 0) break; }
    subs.push(src.slice(j, k)); return k + 1; };
  const tick = (j) => { const k = src.indexOf('`', j); const e = k < 0 ? n : k; subs.push(src.slice(j, e)); return e + 1; };
  while (i < n) {
    const c = src[i];
    if (c === '\\') { if (src[i + 1] !== '\n') word().v += src[i + 1] ?? ''; i += 2; continue; }
    if (c === "'") { const k = src.indexOf("'", i + 1); const e = k < 0 ? n : k; const w = word(); w.v += src.slice(i + 1, e); w.quoted = true; i = e + 1; continue; }
    if (c === '"') { const w = word(); w.quoted = true; let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { w.v += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { j = sub(j + 2); w.dyn = true; continue; }
        if (src[j] === '`') { j = tick(j + 1); w.dyn = true; continue; }
        if (src[j] === '$') w.dyn = true;
        w.v += src[j++];
      }
      i = j + 1; continue; }
    if (c === '$' && src[i + 1] === '(') { i = sub(i + 2); word().dyn = true; continue; }
    if (c === '`') { i = tick(i + 1); word().dyn = true; continue; }
    if (c === '$') { const w = word(); w.dyn = true; w.v += c; i++; continue; }
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { end(); i++; continue; }
    if (c === '&' && src[i + 1] === '>') { flush(); redir = { out: true }; i += src[i + 2] === '>' ? 3 : 2; continue; }
    if (c === '|' && src[i + 1] !== '|') { end(true); i += src[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '&' || c === '|') { end(); i += src[i + 1] === c ? 2 : 1; continue; }
    if (c === '>' || c === '<') {
      if (cur && !cur.quoted && /^\d+$/.test(cur.v)) cur = null; else flush();
      let j = i + 1; if (src[j] === c) j++; if (c === '<' && src[j] === '-') j++;
      if (src[j] === '&') { j++; while (/[\d-]/.test(src[j] ?? '')) j++; i = j; continue; } // 2>&1: no file
      redir = { out: c === '>' }; i = j; continue;
    }
    const w = word(); if ('*?['.includes(c)) w.glob = true; w.v += c; i++;
  }
  end();
  return { segs, subs };
};
const base = (w) => path.basename(String(w?.v ?? w ?? ''));
const ASSIGN = /^[A-Za-z_]\w*=/;
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'sudo', 'doas', 'xargs', 'env', 'timeout', 'caffeinate', 'stdbuf', 'unbuffer']);
const SHELLS = /^(?:ba|z|da|k|fi|tc|c)?sh$/;
// The command a segment runs, its wrappers peeled (VAR=1, command, env …, nohup, xargs, sudo…)
const unwrap = (words) => {
  let ws = words; let wrapped = false;
  for (let guard = 0; guard < 8; guard++) {
    let k = 0; while (k < ws.length && !ws[k].quoted && ASSIGN.test(ws[k].v)) k++;
    if (k) { ws = ws.slice(k); wrapped = true; }
    const h = base(ws[0]);
    if (!ws[0] || ws[0].dyn || !WRAPPERS.has(h)) break;
    wrapped = true; ws = ws.slice(1);
    while (ws.length && (ws[0].v.startsWith('-') || (h === 'env' && ASSIGN.test(ws[0].v)))) { const o = ws[0].v; ws = ws.slice(1); if (/^(-u|--unset|-C|--chdir|-n|-s|--signal|-k|--kill-after|-I|-L|-P)$/.test(o) && ws.length) ws = ws.slice(1); }
    if (h === 'timeout' && ws.length) ws = ws.slice(1);
  }
  return { words: ws, wrapped };
};
// The code a segment hands to a shell: bash -c '…', sh -lc "…", eval …
const innerOf = (run) => {
  const h = base(run[0]); const rest = run.slice(1);
  if (h === 'eval') return rest.map((w) => w.v).join(' ');
  if (SHELLS.test(h)) { const k = rest.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.v)); if (k >= 0) return rest.slice(k + 1).find((w) => !w.v.startsWith('-'))?.v ?? ''; }
  return null;
};
// → [{ words, redirs, piped, run, wrapped, inner }]: inner when the segment came from $(…), `…`, bash -c or eval
const parseLine = (src, depth = 0, inner = false) => {
  if (depth > 4) return [{ words: [{ v: 'eval', dyn: true }], redirs: [], run: [{ v: 'eval', dyn: true }], wrapped: true, inner: true }];
  const { segs, subs } = lexLine(dropHeredocs(src));
  const out = [];
  for (const s of segs) {
    const u = unwrap(s.words); s.run = u.words; s.wrapped = u.wrapped; s.inner = inner; out.push(s);
    const code = innerOf(s.run); if (code) out.push(...parseLine(code, depth + 1, true));
  }
  return [...out, ...subs.flatMap((x) => parseLine(x, depth + 1, true))];
};
// git and its target: -C, --git-dir, --work-tree are where it acts; -c alias.* is an alias
const gitOf = (run) => {
  if (!run[0] || run[0].dyn || base(run[0]) !== 'git') return null;
  let i = 1; const dirs = []; const cfg = [];
  while (i < run.length && run[i].v.startsWith('-')) {
    const w = run[i].v;
    if (w === '-C') { dirs.push(run[i + 1]?.v); i += 2; continue; }
    if (w === '-c') { cfg.push(run[i + 1]?.v || ''); i += 2; continue; }
    const m = /^--(git-dir|work-tree|namespace|exec-path|config-env)(=(.*))?$/.exec(w);
    if (m) { const v = m[2] ? m[3] : run[i + 1]?.v; if (m[1] === 'git-dir') dirs.push(String(v || '').replace(/\/\.git\/?$/, '')); if (m[1] === 'work-tree') dirs.push(v); if (m[1] === 'config-env') cfg.push(String(v || '')); i += m[2] ? 1 : 2; continue; }
    i++;
  }
  return { sub: run[i]?.v, subDyn: !!run[i]?.dyn, rest: run.slice(i + 1).map((w) => w.v), dirs: dirs.filter(Boolean), cfg };
};
// What a Bash line writes and where its git acts, its cd followed: { writes: [abs], gitDirs: [{ dir, sub }], unknown }
const WRITES = { touch: 'all', mkdir: 'all', rm: 'all', rmdir: 'all', tee: 'all', truncate: 'all', cp: 'last', mv: 'last', ln: 'last', install: 'last', rsync: 'last' };
const bashTargets = (parsed, cwd, home) => {
  let d = cwd; const writes = []; const gitDirs = []; let unknown = false;
  const at = (v) => path.resolve(d, expandHome(v, home));
  for (const s of parsed) {
    for (const r of s.redirs) if (r.out) { if (!r.w || r.w.dyn) unknown = true; else if (!/^\/dev\//.test(r.w.v)) writes.push(at(r.w.v)); }
    const run = s.run; if (!run.length || run[0].dyn) continue;
    const h = base(run[0]); const pos = run.slice(1).filter((w) => !w.v.startsWith('-'));
    if (h === 'cd') { if (pos[0]?.dyn) unknown = true; else d = at(pos[0]?.v || '~'); continue; }
    const g = gitOf(run); if (g) { for (const x of g.dirs) gitDirs.push({ dir: at(x), sub: g.sub }); continue; }
    const kind = WRITES[h] || (h === 'sed' && run.some((w) => /^-i/.test(w.v)) ? 'sed' : h === 'dd' ? 'dd' : null);
    if (!kind) continue;
    const targets = kind === 'all' ? pos : kind === 'last' ? pos.slice(-1) : kind === 'sed' ? pos.slice(1) : run.filter((w) => /^of=/.test(w.v)).map((w) => ({ ...w, v: w.v.slice(3) }));
    for (const w of targets) { if (w.dyn) unknown = true; else writes.push(at(w.v)); }
  }
  return { writes, gitDirs, unknown };
};
// A script given in the line itself, not a file: node -e, python -c, perl -e, bash -c, eval, an interpreter fed on stdin
const inlineOf = (s) => {
  const run = s.run; if (!run.length) return null;
  if (run[0].dyn) return 'une commande dynamique';
  const h = base(run[0]); const args = run.slice(1).map((w) => w.v); const pos = args.filter((a) => !a.startsWith('-'));
  const stdin = s.piped || s.redirs.some((r) => !r.out);
  const fed = (!pos.length || pos[0] === '-') && stdin;
  if (h === 'eval') return 'eval';
  if (h === 'deno' && args[0] === 'eval') return 'deno eval';
  if (SHELLS.test(h)) return args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) ? `${h} -c` : fed ? `${h} sur son entrée` : null;
  const flag = /^(node|deno|bun)$/.test(h) ? /^(-e|--eval|-p|--print)(=|$)/ : /^python[\d.]*$/.test(h) ? /^-[a-zA-Z]*c$/ : /^(perl|ruby|lua)$/.test(h) ? /^-[a-zA-Z]*[eE]$/ : h === 'php' ? /^-r$/ : null;
  if (!flag) return null;
  const f = args.find((a) => flag.test(a)); if (f) return `${h} ${f}`;
  return fed ? `${h} sur son entrée` : null;
};
// The code of an interpreter's inline script (node -e/-p, deno eval, bun -e, python -c, ruby -e, perl -e, php -r), or null
const inlineCode = (s) => {
  const run = s.run; if (!run.length || run[0].dyn) return null;
  const h = base(run[0]); const args = run.slice(1).map((w) => w.v);
  if (h === 'deno' && args[0] === 'eval') return args.slice(1).join(' ');
  const flag = /^(node|deno|bun)$/.test(h) ? /^(-e|--eval|-p|--print)(=|$)/ : /^python[\d.]*$/.test(h) ? /^-[a-zA-Z]*c$/ : /^(perl|ruby)$/.test(h) ? /^-[a-zA-Z]*[eE]$/ : h === 'php' ? /^-r$/ : null;
  if (!flag) return null;
  const k = args.findIndex((a) => flag.test(a)); if (k < 0) return null;
  return [args[k].includes('=') ? args[k].slice(args[k].indexOf('=') + 1) : '', ...args.slice(k + 1)].join(' ');
};
// The environment read by name, or a file opened by a name built at run time ('.e' + 'nv'): what the code reaches is unreadable
const INLINE_ENV = /process\.env|os\.environ|getenv|\bENV\b|Deno\.env|Bun\.env/;
const READ_CALL = /(?:readFileSync|readFile|createReadStream|readTextFile|open|Path|File\.read|IO\.read|Bun\.file|slurp|file_get_contents)\s*\(\s*/g;
const LITERAL_ARG = /^(?:\)|(['"`])(?:(?!\1)[^\\$+{])*\1\s*[,)])/;
const inlineSecret = (code) => INLINE_ENV.test(code) ? 'lit l’environnement' : [...code.matchAll(READ_CALL)].some((m) => !LITERAL_ARG.test(code.slice(m.index + m[0].length))) ? 'lit un fichier au nom construit' : null;

// ---------------------------------------------------------------- globs (a secret behind *, ?, […])
const globPart = (g, dot) => new RegExp('^' + (dot || g.startsWith('.') ? '' : '(?!\\.)') + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\[!/g, '[^').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
// A shell glob against the disk, as the shell would expand it (a leading * skips the dot files)
const expandGlob = (abs, facts) => {
  let cur = ['/'];
  for (const part of abs.split('/').filter(Boolean)) {
    if (!/[*?[]/.test(part)) { cur = cur.map((c) => path.join(c, part)); continue; }
    const re = globPart(part, false); const next = [];
    for (const c of cur) for (const e of facts.list(c) || []) if (re.test(e.name)) next.push(path.join(c, e.name));
    cur = next.slice(0, 500); if (!cur.length) break;
  }
  return cur;
};
// A Glob or Grep pattern (**, *, ?, {a,b}) against a relative path; without a slash, Grep's glob matches a name anywhere
const toolGlob = (g, rel, { anyName = false } = {}) => {
  const src = String(g).replace(/^\.\//, '');
  const re = new RegExp('^' + src.replace(/[.+^$()|\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, a) => `(${a.split(',').join('|')})`).replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?') + '$');
  return re.test(rel) || (anyName && !src.includes('/') && re.test(path.basename(rel)));
};
// The secrets a folder holds, three levels down at most (node_modules and .git skipped)
const secretsUnder = (root, facts) => {
  const found = []; const queue = [[root, '', 0]]; let seen = 0;
  while (queue.length && seen < 2000 && found.length < 5) {
    const [d, rel, depth] = queue.shift();
    for (const e of facts.list(d) || []) {
      seen++; const r = rel ? `${rel}/${e.name}` : e.name; const abs = path.join(d, e.name);
      if (secretPath(abs, facts)) { found.push({ abs, rel: r, dir: e.dir }); continue; }
      if (e.dir && depth < 2 && !['node_modules', '.git'].includes(e.name)) queue.push([abs, r, depth + 1]);
    }
  }
  return found;
};
// FUITE3 D7: the first variable of a text that names a secret, $X or ${X…}; ${X:+…} and ${#X} reveal nothing
const secretVar = (text) => {
  for (const m of String(text).matchAll(/\$(\{)?([A-Za-z_]\w*)(:?[-+=?]?)/g)) if (SECRET_VAR.test(m[2]) && !(m[1] && m[3].endsWith('+'))) return m[2];
  return null;
};
// The bodies of the heredocs whose tag is not quoted: the shell expands their $X
const heredocBodies = (src) => {
  const out = []; let open = []; let body = [];
  for (const line of String(src).split('\n')) {
    if (open.length) { if (line.trim() === open[0].tag) { if (!open[0].quoted) out.push(body.join('\n')); open.shift(); body = []; } else body.push(line); continue; }
    for (const m of line.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) open.push({ tag: m[2], quoted: !!m[1] });
  }
  if (open.length && !open[0].quoted) out.push(body.join('\n'));
  return out;
};
// FUITE3 D5: grep -r / rg / ag / ack over a folder holding a secret its filters do not exclude → the secret's path, or null
const GREP_VALUE_FLAGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '-g', '-t', '-T', '-M', '-j', '-E', '-r', '-G', '-p', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context', '--glob', '--iglob', '--type', '--type-not', '--max-depth', '--depth', '--threads', '--encoding', '--replace', '--sort', '--sortr', '--pre', '--pre-glob', '--type-add', '--ignore-file', '--ignore', '--ignore-dir', '--file-search-regex', '--path-to-ignore', '--max-filesize', '--label']);
const recursiveGrep = (head, args, cwd, home, facts) => {
  const grep = /^[ef]?grep$/.test(head);
  if (!grep && !/^(rg|ag|ack|ack-grep)$/.test(head)) return null;
  if (grep && !args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || /^--(recursive|dereference-recursive|directories=recurse)$/.test(a))) return null;
  const inc = []; const exc = []; let typed = false; let patternGiven = false; const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]; const eq = a.indexOf('='); const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const takes = GREP_VALUE_FLAGS.has(flag) && !(grep && flag === '-r');
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue; }
    const val = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : takes ? args[++i] ?? '' : null;
    if (val == null) { if (/^--(js|ts|python|ruby|go|rust|java|html|css|json|shell|markdown|yaml)$/.test(a)) typed = true; continue; }
    if (/^(-e|-f|--regexp|--file)$/.test(flag)) patternGiven = true;
    else if (flag === '--include') inc.push(val);
    else if (/^--(exclude|exclude-dir|ignore|ignore-dir)$/.test(flag)) exc.push(val);
    else if (/^(-g|--glob|--iglob)$/.test(flag)) (val.startsWith('!') ? exc : inc).push(val.replace(/^!/, ''));
    else if (/^(-t|--type|-G|--file-search-regex)$/.test(flag)) typed = true;
  }
  if (typed) return null;
  const dirs = (patternGiven ? pos : pos.slice(1)).filter((p) => p !== '-');
  const roots = dirs.length ? dirs.map((d) => path.resolve(cwd, expandHome(d, home))).filter((d) => facts.list(d)) : [cwd];
  const match = (g, rel) => toolGlob(g, rel, { anyName: true }) || toolGlob(g, path.basename(rel));
  for (const r of roots) {
    const hit = secretsUnder(r, facts).find((f) => !exc.some((g) => match(g, f.rel) || f.rel.split('/').some((seg) => toolGlob(g, seg))) && (!inc.length || f.dir || inc.some((g) => match(g, f.rel))));
    if (hit) return path.relative(cwd, hit.abs) || hit.rel;
  }
  return null;
};
// find selecting a secret: by -name/-iname/-path/-regex (against usual secret names and the secrets on disk), or
// without any name test over a folder that holds one; -not/! before a test excludes
// The words that exclude a secret (--exclude='*.pem', -g '!.env*', find -not -name '.env*'): a name that is kept away, not read
const exclusionWords = (parsed) => {
  const out = new Set();
  for (const s of parsed) {
    const ws = s.run;
    for (let i = 0; i < ws.length; i++) {
      const v = ws[i].v; const nx = ws[i + 1];
      if (/^--(exclude|exclude-dir|ignore|ignore-dir)=/.test(v) || /^--i?glob=!/.test(v)) out.add(ws[i]);
      else if (nx && (/^--(exclude|exclude-dir|ignore|ignore-dir)$/.test(v) || (/^(-g|--glob|--iglob)$/.test(v) && nx.v.startsWith('!')))) out.add(nx);
      else if (nx && /^(-not|!)$/.test(v) && /^-i?(name|path|wholename)$/.test(nx.v) && ws[i + 2]) out.add(ws[i + 2]);
    }
  }
  return out;
};
const SECRET_SAMPLES =['.env', '.env.local', '.envrc', 'id_rsa', 'id_ed25519', 'server.pem', 'server.key', 'credentials.json', 'secrets.json', '.npmrc', '.netrc', 'cert.p12', 'app.keystore'];
const findSecret = (args, cwd, home, facts) => {
  const starts = []; let i = 0; for (; i < args.length && !/^[-(!]/.test(args[i]); i++) starts.push(args[i]);
  const tests = [];
  for (; i < args.length; i++) {
    const m = /^-(i?name|i?path|i?wholename|i?regex)$/.exec(args[i]); if (!m) continue;
    const neg = /^(-not|!)$/.test(args[i - 1] || ''); const p = args[i + 1] ?? ''; i++;
    const ci = m[1].startsWith('i') || facts.caseless; const kind = m[1].replace(/^i/, '');
    let re; try { re = kind === 'name' ? new RegExp(globPart(p, true).source, ci ? 'i' : '') : kind === 'regex' ? new RegExp('^' + p + '$', ci ? 'i' : '') : new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', ci ? 'i' : ''); } catch { re = /$^/; }
    tests.push({ neg, test: (rel) => re.test(kind === 'name' ? path.basename(rel) : rel) });
  }
  const pos = tests.filter((t) => !t.neg); const negs = tests.filter((t) => t.neg);
  const picks = (rel) => pos.every((t) => t.test(rel)) && !negs.some((t) => t.test(rel));
  if (pos.length) { const n = SECRET_SAMPLES.find((x) => picks(`./${x}`)); if (n) return n; }
  for (const st of starts.length ? starts : ['.']) {
    const root = path.resolve(cwd, expandHome(st, home)); if (!facts.list(root)) continue;
    const hit = secretsUnder(root, facts).find((f) => picks(`${st.replace(/\/$/, '')}/${f.rel}`));
    if (hit) return path.relative(cwd, hit.abs) || hit.rel;
  }
  return null;
};
const slug = (s) => String(s || 'correctif').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'correctif';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The tools without a target on disk or the network: the conversation's own bookkeeping
const FREE_TOOLS = new Set(['TodoWrite', 'Task', 'Agent', 'ToolSearch', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'SendMessage', 'ListAgents', 'TaskStop', 'Monitor', 'ScheduleWakeup', 'ReportFindings']);

// ---------------------------------------------------------------- the absolutes
const SECRET = [/(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/, /(^|\/)\.(ssh|aws|kube|gnupg|docker)(\/|$)/, /(^|\/)\.config\/(gh|gcloud|stripe|scw|calmdev|escadrille)(\/|$)/, /(^|\/)\.(npmrc|netrc|pgpass)$/, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/, /\.(pem|p12|pfx|key|keystore|jks)$/, /^\/proc\/[^/]+\/environ$/,
  // FUITE3 D6: direnv's file, the credential files, secrets.* (secrets.json, secrets.yaml…; .example and the like stay readable)
  /(^|\/)\.envrc$/, /(^|\/)\.?credentials\.json$/, /\.credentials$/, /(^|\/)secrets\.(?!example$|sample$|template$|dist$)[^/]+$/];
// macOS disks ignore case (facts.caseless): .ENV is .env there
const secretPath = (p, facts) => { const s = facts?.caseless ? String(p).toLowerCase() : String(p); return SECRET.some((re) => re.test(s)); };
// git's <ref>:<path> (HEAD:.env, :.env, origin/main:config/.env) names a file of the tree; a URL (https://…) does not
const refPathOf = (v) => /^[^:\s]*:(?!\/\/)(.+)$/.exec(String(v))?.[1] || null;
// A word in clear that reaches a secret: by its name, as <ref>:<path>, or through a symbolic link (notes.txt → .env)
const secretReach = (v, cwd, facts) => {
  if (secretPath(v, facts)) return v;
  const ref = refPathOf(v); if (ref && secretPath(ref, facts)) return v;
  if (!v || v.startsWith('-')) return null;
  const abs = path.resolve(cwd, expandHome(v, facts.home())); const real = facts.realpath(abs);
  return real && real !== abs && secretPath(real, facts) ? `${v} → ${real}` : null;
};
const SECRET_WAY = 'un secret ne se lit jamais : le code lit sa variable d’environnement, la valeur se règle par le développeur (Accès, ou son propre terminal)';
const UNCLEAR_WAY = 'écris le chemin en clair (sans $…, $(…), glob ni guillemets collés) pour que la cible soit jugée ; un secret ne se lit jamais : le code lit sa variable d’environnement';
const GREP_WAY = (hit) => `ce dossier tient un secret (${hit}) : ajoute à Grep un filtre glob ou type qui l’exclut (glob "*.mjs", type "js"), ou un path plus étroit sans secret`;
const MCP_WAY = 'un connecteur n’est libre qu’en lecture (get, list, read, search, query, fetch…) : pour écrire, un brouillon local (.escadrille/) que le développeur valide, ou il accepte cet appel dans Claude Code';
const MCP_WRITE_WORDS = new Set(['delete', 'remove', 'send', 'replace', 'update', 'write', 'create', 'post', 'put', 'patch', 'set', 'push', 'merge', 'drop',
  // FUITE3 D10
  'upload', 'publish', 'deploy', 'trigger', 'run', 'execute', 'invoke', 'sync', 'archive', 'transfer', 'share', 'approve', 'close', 'comment', 'assign',
  // and what a file connector does to a file (edit_file, move_file…)
  'edit', 'modify', 'move', 'rename', 'copy', 'insert', 'append']);
// FUITE3 D9: a connector named after a secret (get_api_key, list_tokens) is never a free read
const MCP_SECRET_WORDS = /^(secrets?|credentials?|tokens?|passwords?|keys?)$/;
// FUITE3 D8: the arguments of a connector that name a file, judged as a Read (or a write when the connector writes)
const MCP_PATH_ARGS = new Set(['path', 'file', 'filename', 'filepath', 'paths', 'file_path', 'files']);
const mcpPaths = (input, depth = 0) => {
  const out = []; if (!input || typeof input !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(input)) {
    const key = k.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
    if (MCP_PATH_ARGS.has(key) || MCP_PATH_ARGS.has(key.replace(/_/g, ''))) for (const x of [v].flat()) { if (typeof x === 'string' && x) out.push(x); else if (x && typeof x === 'object') out.push(...mcpPaths(x, depth + 1)); }
    else if (v && typeof v === 'object') out.push(...mcpPaths(v, depth + 1));
  }
  return out;
};
// FUITE3 D4: the files git runs by itself; `update` only inside a hooks folder (a common name elsewhere)
const HOOK_NAMES = new Set(['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit']);
// a hook: a hook's name, anything under .git/hooks, .husky or .githooks, or a file without extension in a hooks folder
// (src/hooks/useAuth.ts stays a source file)
const hookPath = (p) => {
  const s = String(p).toLowerCase(); const name = path.basename(s); const parent = path.basename(path.dirname(s));
  return HOOK_NAMES.has(name) || /(^|\/)(\.git\/hooks|\.husky|\.githooks)(\/|$)/.test(s) || (parent === 'hooks' && !name.includes('.'));
};
const HOOK_WAY = 'un hook git ne s’écrit pas par Claude (git le lance seul à chaque commit ou push) : le script vit dans scripts/ et se lance à la main, ou le développeur installe le hook dans son terminal';
// FUITE3 D2-D3: the git config that changes where a push goes, who answers for it, or what git runs by itself
const GIT_CFG_GUARDED = (k) => { k = String(k).split('=')[0].toLowerCase();
  return /^(remote|url|credential|include|includeif)\./.test(k) || /^credential$/.test(k) || /(^|\.)(url|pushurl|insteadof|pushinsteadof)$/.test(k)
    || /^core\.(hookspath|sshcommand|gitproxy|fsmonitor|askpass)$/.test(k) || /^branch\..*\.(remote|pushremote|merge)$/.test(k) || /^(remote\.pushdefault|push\.default)$/.test(k) || /^http\.(.*\.)?(extraheader|proxy)$/.test(k); };
const GIT_ENV_GUARDED = /^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)|GIT_SSH(_COMMAND)?|GIT_ASKPASS|GIT_PROXY_COMMAND)=/;
const GIT_CFG_WAY = 'la config git (remote, url, insteadOf, pushurl, hooksPath, sshCommand, credential) se règle par le développeur dans son terminal ; une commande git s’écrit sans -c ni variable GIT_CONFIG_* qui la touche';
// FUITE3 D7: a variable whose name holds a secret, written on the line, is read into the transcript
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i;
const VAR_WAY = 'une variable secrète ne s’écrit pas sur la ligne : test -n "$NOM" && echo présente pour la vérifier, ou un script du worktree (ou .escadrille/pilote/gate.sh, docs/gate.md) qui la lit sans l’afficher';
const MCP_POST_WORDS = new Set(['send', 'post', 'merge']);
const READ_VERBS = new Set(['get', 'list', 'read', 'search', 'query', 'fetch', 'find', 'view', 'describe', 'show', 'whoami', 'lookup', 'count', 'retrieve', 'browse', 'inspect', 'extract']);
// Commands that read a file's content (a path not in clear there may be a secret), and those that only name files
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'source', '.', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'cp', 'scp', 'rsync', 'nl', 'tac', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'jq', 'yq', 'openssl', 'gpg', 'zip', 'tar', 'pbcopy']);
const LISTERS = new Set(['ls', 'du', 'stat', 'echo', 'printf', 'test', '[', 'wc', 'rm', 'find']);
// The environment dumped whole: env alone, printenv, set alone, export -p, declare -x
const dumpOf = (s) => {
  const h = base(s.run[0]); const a = s.run.slice(1).map((w) => w.v);
  if (!s.run.length && s.words.some((w) => base(w) === 'env')) return 'env';
  if (h === 'printenv') return 'printenv';
  if (h === 'set' && !a.length) return 'set';
  if (['export', 'declare', 'typeset'].includes(h) && a.every((x) => /^-[px]+$/.test(x))) return [h, ...a].join(' ');
  return null;
};
// Commands that run another command given as their arguments or their code
const DISGUISERS = /^(g?awk|mawk|nawk|perl|python[\d.]*|ruby|node|deno|bun|php|lua|find|fd|parallel|watch|script|expect|osascript)$/;
const PUSH_WAY ='le bouton « Pousser » de l’app sur le Mac (clic du développeur) ; le pilote ne pousse que les branches de sa liste personnelle';
const POST_WAY = 'un brouillon local (.escadrille/), Dev dit oui, puis il poste ; une PR en brouillon (--draft) seule est permise au pilote';
const PROD_WAY = 'rien en production ni sur un service externe : tout reste local tant que Dev ne l’a pas demandé lui-même';

const PROD = /(?:^|[;&|(`"']\s*|\s)(?:vercel|netlify\s+deploy|fly\s+deploy|flyctl\s+deploy|heroku|firebase\s+deploy|npm\s+publish|pnpm\s+publish|yarn\s+publish|docker\s+push|terraform\s+apply|kubectl\s+(?:apply|delete|rollout)|eas\s+(?:submit|update)|expo\s+publish|stripe|aws|gcloud|scw)(?![\w-])/;
// A request that sends: a method (-XPOST, -X POST, --request=POST, --method POST) or a body (curl -d, wget --post-data)
const SEND_METHOD = /(?:^|\s)(?:-X\s*=?|--request(?:=|\s+)|--method(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b/i;
const CURL_BODY = /(?:^|\s)(?:-[dFT]\S*|--data(?:-raw|-binary|-urlencode|-ascii)?|--form(?:-string)?|--json|--upload-file)(?:[\s=]|$)/;
const WGET_BODY = /(?:^|\s)--(?:post-data|post-file|body-data|body-file)(?:[\s=]|$)/;
const POST_FLAG = { curl: [SEND_METHOD, CURL_BODY], xh: [SEND_METHOD, CURL_BODY], http: [SEND_METHOD, CURL_BODY], https: [SEND_METHOD, CURL_BODY], wget: [SEND_METHOD, WGET_BODY] };
const GH_POST_FLAG = /(?:^|\s)(?:-X\s*=?|--method(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-[fF]|--(?:raw-)?field|--input)(?:[\s=]|$)/i;
const LOCAL_URL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/]|$)/i;

const globRe = (g) => new RegExp('^' + String(g).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
// The pilot's personal exception (CLAUDE.md, Dev 3 November): a file of his, never a setting of the product, empty by
// default. One line per repository: `<absolute path of the main checkout> <branch glob> [<branch glob>…]`, # comments.
export const readPushRules = (file, read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }) => String(read(file) || '').split('\n')
  .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => l.split(/\s+/)).filter((w) => w.length >= 2 && path.isAbsolute(w[0]))
  // url=<push URL> (optional, FUITE3 D3): the remote's URL pinned; without it the push URL must be the fetch URL
  .map(([repo, ...words]) => { const urls = words.filter((w) => w.startsWith('url=')).map((w) => w.slice(4)).filter(Boolean); const branches = words.filter((w) => !w.startsWith('url='));
    return { repo: path.resolve(repo), branches, ...(urls.length ? { urls } : {}) }; });

const deny = (why, way, rule) => ({ decision: 'deny', why, path: way, rule });
// FUITE3 D4: a hook written (Write, Edit, a redirection, a heredoc, cp…): refused; one that pushes is a push
const hookWrite = (files, text) => {
  const f = files.find((p) => p && hookPath(p)); if (!f) return null;
  if (/\bgit\b[\s\S]*\b(push|send-pack)\b/.test(String(text || ''))) return deny(`un push caché dans un hook git : ${f}`, `${PUSH_WAY} ; ${HOOK_WAY}`, 'git-push');
  return deny(`un hook git : ${f}`, HOOK_WAY, 'git-hook');
};
const absolutes = ({ tool, input, caller, cwd, where, pushRules, facts, parsed, writes = [], ctx = {} }) => {
  const home = facts.home();
  if (WRITE_TOOLS.has(tool)) { const p = input.file_path || input.notebook_path; const h = p && hookWrite([path.resolve(cwd, expandHome(String(p), home))], [input.content, input.new_string, input.new_source, ...(input.edits || []).map((e) => e?.new_string)].join('\n')); if (h) return h; }
  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const p = input.file_path || input.notebook_path || input.path; const hit = p && secretReach(String(p), cwd, facts); if (hit) return deny(`secret : ${hit}`, SECRET_WAY, 'secret');
    if (tool === 'Grep' && input.glob && /\.env\b/.test(String(input.glob)) && !/example|sample/.test(String(input.glob))) return deny(`secret : ${input.glob}`, SECRET_WAY, 'secret');
    // Grep without a filter, or a Glob, over a folder that holds a secret: the secret is reached without being named
    if (tool === 'Grep' || tool === 'Glob') {
      const found = secretsUnder(path.resolve(cwd, expandHome(String(input.path || '.'), home)), facts);
      if (tool === 'Grep' && !input.type) { const hit = input.glob ? found.find((f) => toolGlob(input.glob, f.rel, { anyName: true })) : found[0]; if (hit) return deny(`Grep sur un dossier qui tient un secret : ${hit.rel}`, GREP_WAY(hit.rel), 'secret'); }
      if (tool === 'Glob') { const hit = found.find((f) => toolGlob(input.pattern || '*', f.rel)); if (hit) return { decision: 'ask', why: `Glob qui atteint un secret : ${hit.rel}`, path: `un motif qui ne l’atteint pas (« **/*.mjs » plutôt que « **/* »), ou un path plus étroit ; ${SECRET_WAY}`, rule: 'secret' }; }
    }
    return null;
  }
  if (/^mcp__/.test(tool)) {
    const name = tool.split('__').pop(); const verb = (name.match(/^[a-z]+/) || [name.split(/[_-]/)[0]])[0].toLowerCase();
    if (/push/i.test(name)) return deny(`un push par un connecteur : ${tool}`, PUSH_WAY, 'git-push');
    if (/^(save|create|update|delete|send|post|publish|merge|share|submit|mark|resolve|retire|restore|unshare|prepare)/i.test(name) || (!READ_VERBS.has(verb) && /comment|message|reply/i.test(name))) return deny(`rien ne se poste : ${tool}`, POST_WAY, 'post');
    // a write word anywhere in the name (getAndDeleteItem, list_and_delete, fetchThenSend): never a read
    const words = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/).filter(Boolean);
    const wrote = words.find((w) => MCP_WRITE_WORDS.has(w));
    if (wrote && MCP_POST_WORDS.has(wrote)) return deny(`rien ne se poste : ${tool} (${wrote})`, POST_WAY, 'post');
    if (words.includes('deploy')) return deny(`un déploiement par un connecteur : ${tool}`, PROD_WAY, 'production');
    // FUITE3 D8: a file named in the arguments is judged as a Read (a secret), and as a write when the connector writes
    for (const p of mcpPaths(input)) {
      const hit = secretReach(p, cwd, facts); if (hit) return deny(`secret par un connecteur : ${hit}`, SECRET_WAY, 'secret');
      if (!wrote) continue;
      const abs = path.resolve(cwd, expandHome(p, home)); const w = placeOf(abs, ctx, facts);
      if (w.kind === 'session') return deny(`worktree d’une session en cours : ${w.session} (${tool} → ${abs})`, SESSION_WAY(w), 'session-worktree');
      if (w.kind === 'main' && !handoff(w, abs, facts)) return deny(`checkout principal de ${w.project} : ${tool} → ${abs}`, WORKTREE_WAY(w, canon(abs, facts)), 'main-checkout');
    }
    // FUITE3 D9: a connector named after a secret is asked, never a free read
    const secretWord = words.find((w) => MCP_SECRET_WORDS.test(w));
    if (secretWord) return { decision: 'ask', why: `connecteur : ${name} touche un secret (${secretWord})`, path: `${SECRET_WAY} ; le développeur accepte cet appel dans Claude Code s’il ne renvoie pas la valeur`, rule: 'secret' };
    if (wrote) return { decision: 'ask', why: `connecteur : ${name} écrit (${wrote})`, path: MCP_WAY, rule: 'mcp-write' };
    if (READ_VERBS.has(verb)) return null;
    return { decision: 'ask', why: `connecteur : ${name} n’est pas un verbe de lecture connu`, path: MCP_WAY, rule: 'mcp-write' };
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') return null;
  if (tool !== 'Bash') return null;
  const cmd = String(input.command || '');
  const excl = exclusionWords(parsed); const exclVals = new Set([...excl].flatMap((w) => [w.v, w.v.replace(/^--[\w-]+=/, '')]).map((v) => v.replace(/^!/, '')));
  for (const w of cmd.match(/[^\s'"<>|;&()=]+/g) || []) { if (exclVals.has(w.replace(/^!/, '')) || /^--(exclude|exclude-dir|ignore|ignore-dir)$/.test(w)) continue; const ref = refPathOf(w); if (secretPath(w, facts) || (ref && secretPath(ref, facts))) return deny(`secret : ${w}`, SECRET_WAY, 'secret'); }
  if (PROD.test(cmd)) return deny('production ou service externe', PROD_WAY, 'production');
  { const h = hookWrite(writes, cmd); if (h) return h; }
  { const v = heredocBodies(cmd).map(secretVar).find(Boolean); if (v) return deny(`secret : $${v} dans un heredoc`, VAR_WAY, 'secret'); }
  { const e = parsed.flatMap((s) => s.words).find((w) => GIT_ENV_GUARDED.test(w.v)); if (e) return deny(`la config git par l’environnement : ${e.v.split('=')[0]}`, GIT_CFG_WAY, 'git-config'); }
  let pushed = 0; let drafted = 0; let unclear = null;
  const ask = (why, way) => { unclear ??= { decision: 'ask', why, path: `${way} ; ${SECRET_WAY}`, rule: 'secret' }; };
  for (const s of parsed) {
    // secrets: a word in clear (quotes glued, any case on macOS, <ref>:<path>, a link), a glob the disk expands to one,
    // a path behind $…, the environment dumped
    const head = base(s.run[0]);
    for (const w of [...s.words, ...s.redirs.map((r) => r.w).filter(Boolean)]) {
      if (excl.has(w)) continue;
      const v = expandHome(w.v.replace(/^\$\{?HOME\}?(?=\/|$)/, home), home);
      if (secretPath(v, facts)) return deny(`secret : ${w.v}`, SECRET_WAY, 'secret');
      const reach = !w.dyn && !w.glob && !LISTERS.has(head) && secretReach(v, cwd, facts); if (reach) return deny(`secret : ${reach}`, SECRET_WAY, 'secret');
      if (w.glob && !LISTERS.has(head)) { const hit = expandGlob(path.resolve(cwd, v), facts).find((x) => secretPath(x, facts)); if (hit) return deny(`secret derrière un glob : ${w.v} → ${path.basename(hit)}`, SECRET_WAY, 'secret'); }
    }
    const dump = dumpOf(s); if (dump) return deny(`secret : ${dump} montre tout l’environnement`, `${SECRET_WAY} ; une variable se vérifie par son nom (test -n "$NOM" && echo présente)`, 'secret');
    // FUITE3 D7: $X, ${X} on the line, X naming a secret (test -n/-z, ${X:+…} and ${#X} say only whether it is there)
    if (!['test', '[', '[['].includes(head)) {
      const v = [...s.words, ...s.redirs.map((r) => r.w).filter(Boolean)].filter((w) => w.dyn).map((w) => secretVar(w.v)).find(Boolean);
      if (v) return deny(`secret : $${v} écrit sur la ligne`, VAR_WAY, 'secret');
    }
    const fa = s.run.slice(1).map((w) => w.v);
    // FUITE3 D5: grep -r, rg, ag, ack over a folder that holds a secret, without an exclusion: as the Grep tool
    const rec = recursiveGrep(head, fa, cwd, home, facts);
    if (rec) ask(`${head} récursif sur un dossier qui tient un secret : ${rec}`, `exclus le secret : grep -r --exclude='.env*', rg -g '!.env*', ag --ignore '.env*' (et chaque autre secret), un chemin plus étroit, ou l’outil Grep avec un glob`);
    // find that selects a secret by its name (-name '.e*') and hands it to a command (-exec, | xargs): a read
    if (head === 'find') {
      const next = parsed[parsed.indexOf(s) + 1];
      const hands = fa.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) || (next?.piped && next.words.some((w) => base(w) === 'xargs'));
      const hit = hands && findSecret(fa, cwd, home, facts);
      if (hit) return deny(`secret : find choisit ${hit} et le passe à une commande`, `${SECRET_WAY} ; find … -not -name '.env*' (et chaque autre secret), ou nomme les fichiers à lire`, 'secret');
    }
    if (READERS.has(head) && s.run.slice(1).some((w) => w.dyn && !w.v.startsWith('-'))) unclear ??= { decision: 'ask', why: `${head} lit un chemin qui n’est pas en clair`, path: UNCLEAR_WAY, rule: 'secret' };
    // an inline script that reads the environment or a file by a built name: what it reaches is unreadable
    const code = inlineCode(s); const touch = code && inlineSecret(code);
    if (touch) ask(`script en ligne (${head}) qui ${touch}`, 'écris le nom du fichier en clair (une chaîne littérale), ou mets le script dans un fichier du worktree qui lit la seule variable utile par son nom');
    const args = s.run.slice(1).map((w) => w.v);
    if (head === 'ps' && ((args[0] && !args[0].startsWith('-') && /e/.test(args[0])) || args.some((a) => /^-[a-zA-Z]*E/.test(a)))) ask('ps e montre l’environnement des processus', 'ps sans e ni -E (ps -o pid,command)');
    if (head === 'security' && /password|dump-keychain|^export$/.test(args[0] || '')) ask(`security ${args[0]} sort un secret du trousseau`, 'le secret reste dans le trousseau : le code le lit par sa variable d’environnement, réglée par le développeur');
    if (/^(tar|bsdtar|gtar|zip|7z|7za|pax|cpio)$/.test(head) && !args.some((a) => /^(--exclude|-x)/.test(a))) {
      const dir = s.run.slice(1).find((w) => !w.dyn && !w.v.startsWith('-') && facts.list(path.resolve(cwd, expandHome(w.v, home))) && secretsUnder(path.resolve(cwd, expandHome(w.v, home)), facts).length);
      if (dir) ask(`${head} archive ${dir.v}, qui tient un secret (${secretsUnder(path.resolve(cwd, expandHome(dir.v, home)), facts)[0].rel})`, `nomme les fichiers à archiver, ou ajoute --exclude='.env*' (et chaque autre secret)`);
    }
    // a push hidden from the reader: git $(…), $g push, find -exec git push, awk system("git push"), git subtree push
    const disguised = (why) => deny(`un push déguisé (${why})`, `${PUSH_WAY} ; une commande git s’écrit en entier, seule, sans variable ni commande qui la lance`, 'git-push');
    if (s.run[0]?.dyn && args.some((a) => /^(push|send-pack)$/.test(a))) return disguised('une commande en variable');
    if (DISGUISERS.test(head)) {
      const gi = args.findIndex((a) => base(a) === 'git');
      if ((gi >= 0 && args.slice(gi + 1).some((a) => /^(push|send-pack)$/.test(a))) || args.some((a) => /\bgit\b[\s\S]*\b(push|send-pack)\b/.test(a))) return disguised(`lancé par ${head}`);
    }
    const words = s.run.map((w) => w.v);
    const g = gitOf(s.run);
    if (g) {
      if (g.subDyn) return disguised('git avec une sous-commande dynamique');
      if (['subtree', 'lfs'].includes(g.sub) && g.rest.includes('push')) return disguised(`git ${g.sub} push`);
      if (g.cfg.some((c) => /^alias\./i.test(c)) || (g.sub === 'config' && g.rest.some((w) => /^alias\./i.test(w)) && !g.rest.some((w) => /^(--get|--get-all|--get-regexp|--list|-l|--unset|--unset-all)$/.test(w)))) return deny('un alias git : un push déguisé possible', `${PUSH_WAY} ; une commande git s’écrit en entier, sans alias`, 'git-push');
      if (g.sub === 'send-pack') return deny('un push : git send-pack', PUSH_WAY, 'git-push');
      // FUITE3: git fed its subcommand by xargs (printf push | xargs git, xargs -I{} git {} <<< push)
      if (s.words.some((w) => !w.quoted && base(w) === 'xargs') && !/^[a-z][a-z-]*$/.test(g.sub || '')) return disguised('git nourri par xargs');
      // FUITE3 D2/D4: -c (or --config-env) on the url, pushurl, insteadOf, hooksPath, sshCommand, credential of any git command
      const cfgHit = g.cfg.find(GIT_CFG_GUARDED);
      if (cfgHit) return deny(`git -c ${cfgHit.split('=')[0]} : la destination, l’identité ou les hooks de git changés sur la ligne`, GIT_CFG_WAY, 'git-config');
      // FUITE3 D3: the remote's URL or the guarded config rewritten (worktrees share the main checkout's config)
      if (g.sub === 'remote' && where.project && /^(add|set-url|rename)$/.test(g.rest.find((w) => !w.startsWith('-')) || '')) return deny(`git remote ${g.rest.find((w) => !w.startsWith('-'))} : l’URL des remotes de ${where.project}`, GIT_CFG_WAY, 'git-config');
      if (g.sub === 'config') {
        const reads = g.rest.some((w) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--unset|--unset-all)$/.test(w));
        const posc = []; for (let i = 0; i < g.rest.length; i++) { const w = g.rest[i]; if (/^(-f|--file|--blob|--type|--default|--comment|--value)$/.test(w)) { i++; continue; } if (!w.startsWith('-')) posc.push(w); }
        const sub = /^(get|list|unset|set|rename-section|remove-section|edit)$/.test(posc[0] || '') ? posc.shift() : null;
        if (!reads && !['get', 'list', 'unset'].includes(sub) && posc[0] && GIT_CFG_GUARDED(posc[0])) return deny(`git config ${posc[0]} : la destination, l’identité ou les hooks de git`, GIT_CFG_WAY, 'git-config');
      }
      if (g.sub === 'push') {
        if (s.inner || s.wrapped) return deny('un push déguisé (dans bash -c, eval, $(…), derrière env, command, une variable…)', `${PUSH_WAY} ; jamais un push enveloppé`, 'git-push');
        const why = pilotPush({ g, caller, cwd, where, pushRules, facts }); if (why === true) { pushed++; continue; }
        return deny(`un push : ${why}`, PUSH_WAY, 'git-push');
      }
    }
    if (head === 'gh') {
      const [a, b] = words.slice(1).filter((w) => !w.startsWith('-'));
      if (a === 'pr' && b === 'create' && words.some((w) => /^--draft(=true)?$/.test(w))) {
        // the one thing the pilot opens alone (4 November): a draft PR from a branch of its list
        const k = words.findIndex((w) => /^(--head|-H)$/.test(w)); const given = k >= 0 ? words[k + 1] : (words.find((w) => w.startsWith('--head=')) || '').slice(7);
        const why = caller !== 'pilot' ? 'une PR en brouillon : le pilote seul l’ouvre' : s.inner || s.wrapped ? 'enveloppée' : pilotBranch({ ref: given ? given.split(':').pop() : facts.branch(cwd), where, pushRules, facts });
        if (why === true) { drafted++; continue; }
        return deny(`rien ne se poste : gh pr create --draft, ${why}`, POST_WAY, 'post');
      }
      if ((a === 'pr' && /^(create|merge|comment|review|edit|close|reopen|ready)$/.test(b)) || (a === 'issue' && /^(create|comment|edit|close)$/.test(b)) || a === 'release' || (a === 'api' && GH_POST_FLAG.test(' ' + words.slice(1).join(' ')))) return deny(`rien ne se poste : gh ${a} ${b || ''}`.trim(), POST_WAY, 'post');
      // FUITE3: what changes GitHub without a PR: a fork synced, a workflow run, a repo, a secret, a label, a key
      if ((a === 'repo' && /^(sync|create|delete|edit|fork|rename|archive|unarchive|deploy-key)$/.test(b)) || (a === 'workflow' && /^(run|enable|disable)$/.test(b)) || (a === 'run' && /^(rerun|cancel|delete)$/.test(b))
        || (/^(secret|variable)$/.test(a) && /^(set|delete|remove)$/.test(b)) || (/^(label|gist)$/.test(a) && /^(create|edit|delete|clone)$/.test(b) && !(a === 'gist' && b === 'clone')) || (/^(ssh-key|gpg-key)$/.test(a) && /^(add|delete)$/.test(b)) || (a === 'cache' && b === 'delete')) return deny(`rien ne se poste : gh ${a} ${b}`, POST_WAY, 'post');
    }
    // FUITE3: a package script that pushes, written then run (npm pkg set scripts.x="git push" && npm run x)
    if (/^(npm|pnpm|yarn|bun)$/.test(head) && ((args[0] === 'pkg' && args[1] === 'set') || args[0] === 'set-script') && args.some((w) => /\bgit\b[\s\S]*\b(push|send-pack)\b/.test(w))) return disguised(`${head} ${args[0]} écrit un script qui pousse`);
    const sends = POST_FLAG[head];
    if (sends) {
      const line = ' ' + words.slice(1).join(' ');
      if (sends.some((re) => re.test(line)) || (head !== 'curl' && head !== 'wget' && words.slice(1).some((w) => /^(POST|PUT|PATCH|DELETE)$/.test(w)))) {
        const args = words.slice(1);
        const dest = args.find((w) => /^https?:\/\//i.test(w)) || args.find((w) => !w.startsWith('-') && !w.includes('=') && /^[\w-]+(\.[\w-]+)+(?::\d+)?(\/|$)/.test(w) && !/\.(json|txt|md|html?|xml|csv|ya?ml|out|log)$/i.test(w));
        if (dest && !LOCAL_URL.test(dest)) return deny(`rien ne se poste : ${head} vers ${dest}`, POST_WAY, 'post');
      }
    }
  }
  // the pilot's exception, alone on its line (a cd before it, a $(cat …) for the body at most): allowed here, suggest would refuse it
  if (pushed || drafted) {
    const others = parsed.filter((s) => base(s.run[0]) !== 'cd' && !(s.inner && ['cat', 'echo', 'printf', 'head', 'tail'].includes(base(s.run[0])))).length - pushed - drafted;
    if (others) return deny('un push ou une PR du pilote se lance seul sur sa ligne', `${pushed ? PUSH_WAY : POST_WAY} ; la commande seule, un cd devant au plus`, pushed ? 'git-push' : 'post');
    return { decision: 'allow', why: pushed ? 'push du pilote, dans sa liste personnelle' : 'PR en brouillon du pilote, d’une branche de sa liste', path: '', rule: pushed ? 'pilot-push' : 'pilot-draft' };
  }
  return unclear;
};
// true when the pilot's personal exception covers this push; otherwise the reason
const pilotPush = ({ g, caller, cwd, where, pushRules, facts }) => {
  if (caller !== 'pilot') return 'jamais depuis une conversation ni une session';
  if (g.rest.some((w) => /^(--force.*|--all|--branches|--mirror|--tags|--follow-tags|--delete|--prune)$/.test(w) || /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(w) || w.startsWith('+'))) return 'forcé, groupé ou destructif';
  // FUITE3 D1-D2: the destination is a named remote of the repository, never a URL, a path or a -c on the line
  if (g.cfg.length) return 'un -c sur la ligne du push';
  if (g.rest.some((w) => /^--(repo|receive-pack|exec)(=|$)/.test(w))) return 'une destination ou un programme donné sur la ligne (--repo, --receive-pack, --exec)';
  const pos = [];
  for (let i = 0; i < g.rest.length; i++) { const w = g.rest[i]; if (/^(-o|--push-option)$/.test(w)) { i++; continue; } if (!w.startsWith('-')) pos.push(w); }
  const dir = g.dirs[0] ? path.resolve(cwd, g.dirs[0]) : cwd;
  if (pos[0] && !/^[\w][\w.-]*$/.test(pos[0])) return `${pos[0]} : une URL ou un chemin, pas un remote nommé du dépôt`;
  const remote = facts.remote?.(dir, pos[0] || null);
  if (!remote) return `${pos[0] || 'le remote par défaut'} : pas un remote nommé du dépôt`;
  // FUITE3 D3: the remote's URL is the known one (pinned by url= in the list, else the push URL is the fetch URL)
  const rule = (pushRules || []).find((r) => where.project && fold(canon(r.repo, facts), facts) === fold(where.project, facts));
  if (rule?.urls?.length ? !rule.urls.includes(remote.push) : remote.push !== remote.fetch) return `${remote.name} pousse vers ${remote.push}, pas l’URL connue du dépôt`;
  const refs = pos.slice(1);
  if (!refs.length) return pilotBranch({ ref: facts.branch(dir), where, pushRules, facts });
  // every ref pushed is judged (dev main, a:b, HEAD:main): one ref outside the list refuses the whole push
  for (const r of refs) {
    const k = r.indexOf(':'); const dst = k >= 0 ? r.slice(k + 1) : r;
    if (k === 0 || !dst) return `${r} : une suppression ou une ref vide`;
    if (/[*?[]/.test(r)) return `${r} : groupé`;
    const ref = /^(HEAD|@)$/.test(dst) ? facts.branch(dir) : dst.replace(/^refs\/heads\//, '');
    if (ref && ref.startsWith('refs/')) return `${ref} : pas une branche`;
    const why = pilotBranch({ ref, where, pushRules, facts }); if (why !== true) return why;
  }
  return true;
};
const pilotBranch = ({ ref, where, pushRules, facts }) => {
  if (!ref) return 'branche introuvable';
  const repo = where.project; const rule = (pushRules || []).find((r) => repo && fold(canon(r.repo, facts), facts) === fold(repo, facts));
  if (!rule) return 'ce dépôt n’est pas dans la liste personnelle du pilote';
  if (/^(main|master|release.*)$/.test(ref) && !rule.branches.includes(ref)) return `${ref} : jamais`;
  return rule.branches.some((b) => globRe(b).test(ref)) || `${ref} hors de la liste du pilote pour ce dépôt`;
};

// ---------------------------------------------------------------- the target
// Where does an absolute path fall? → { kind: 'session' | 'main' | 'worktree' | 'project' | 'mac', root, project, session? }
export const placeOf = (abs, { projects = [], sessions = [] } = {}, facts = realFacts) => {
  facts = { ...realFacts, ...facts };
  const p = canon(abs, facts);
  const live = sessions.map((s) => ({ ...s, path: canon(path.resolve(String(s.path)), facts) })).filter((s) => s.path && under(p, s.path, facts)).sort((a, b) => b.path.length - a.path.length)[0];
  const roots = projects.map((x) => canon(path.resolve(String(x)), facts)).filter((r) => under(p, r, facts)).sort((a, b) => b.length - a.length);
  const project = roots[0] || null;
  if (live) return { kind: 'session', root: live.path, project: project || live.project || null, session: `${live.plan}/${live.session}` };
  if (!project) return { kind: 'mac', root: null, project: null };
  const m = (facts.caseless ? /^\.claude\/worktrees\/([^/]+)/i : /^\.claude\/worktrees\/([^/]+)/).exec(relTo(project, p, facts));
  if (m) return { kind: 'worktree', root: path.join(project, '.claude', 'worktrees', m[1]), project };
  if (!facts.exists(path.join(project, '.git'))) return { kind: 'project', root: project, project };
  return { kind: 'main', root: project, project };
};

const WORKTREE_WAY = (where, file) => {
  const name = slug(file ? path.basename(file).replace(/\.[^.]+$/, '') : 'correctif');
  return `cd ${where.project} && git worktree add .claude/worktrees/${name} -b escadrille/fix/${name}, puis écris dans ${path.join(where.project, '.claude/worktrees', name, file ? path.relative(where.project, file) : '')}, lance les tests, et fusionne en local (git merge --no-ff escadrille/fix/${name} depuis ${where.project})`.replace(/\/$/, '');
};
const SESSION_WAY = (where) => `ce worktree est celui de la session ${where.session}, qui travaille : lis-le, et passe-lui la demande (message dans son Flot) ou attends sa fin`;
// What changes the files of a main checkout without being the local merge (the way that works ends by one)
const TREE_EDIT = new Set(['add', 'commit', 'rm', 'mv', 'restore', 'reset', 'apply', 'am', 'cherry-pick', 'rebase', 'revert', 'stash', 'checkout', 'switch', 'clean', 'pull']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'shortlog', 'describe', 'cat-file', 'reflog', 'merge-base', 'ls-tree', 'for-each-ref', 'show-ref', 'help', 'version', undefined]);
const ESCADRILLE_GUARDED = ['lib/guardrails.mjs', 'lib/policy.mjs', 'docs/autonomy.md', 'test/guardrails.test.mjs', 'CLAUDE.md'];
// .escadrille/ is the handoff, never committed; in CalmDev it is a link to .calmdev/: both names are the one place
const HANDOFF = /^\.(escadrille|calmdev)(\/|$)/;
const handoff = (where, abs, facts) => (facts.caseless ? new RegExp(HANDOFF.source, 'i') : HANDOFF).test(relTo(where.project, canon(abs, facts), facts));
const RANK = { session: 4, main: 3, mac: 2, worktree: 1, project: 1 };
const MAC_WAY = (facts) => `écris sous ${tmpsOf(facts).join(' ou ')}, ou dans un worktree d’un projet connu (registre des projets, docs/multiproject.md) ; sinon le développeur accepte cette écriture hors projet dans Claude Code`;
const INLINE_WAY = (where, facts) => where.kind === 'main' ? `écris le script dans un fichier d’un worktree et lance-le là : ${WORKTREE_WAY(where, null)}` : `écris le script dans un fichier sous ${tmpsOf(facts)[0]} et lance-le (node <fichier>), ou depuis un worktree d’un projet connu ; sinon le développeur le lit et l’accepte dans Claude Code`;
const OPAQUE_WAY = 'découpe la commande : une commande lisible par appel, sans $(…), eval ni script en ligne, ou écris le script dans un fichier du worktree et lance-le ; sinon le développeur l’accepte dans Claude Code';

// suggest's answer → a decision for the main conversation, with its way out
const fromSuggest = (s, { where, mac }) => {
  if (s.allow === true) return { decision: 'allow', why: s.reason, path: '', rule: s.rule };
  if (s.allow === false) {
    if (s.rule === 'deny-settings') return { decision: 'deny', why: s.reason, path: 'interdit par .claude/settings.json du projet : le développeur seul change cette règle, ou fais sans', rule: s.rule };
    if (s.rule === 'open-window') return { decision: 'deny', why: s.reason, path: 'une ligne CAPTURE: <url locale ou .html> ; un navigateur sans tête, jamais une fenêtre', rule: s.rule };
    if (s.rule === 'git-push') return { decision: 'deny', why: s.reason, path: PUSH_WAY, rule: s.rule };
    if (s.rule === 'real-host') return { decision: 'ask', why: s.reason, path: 'le développeur accorde ce domaine, ou un plan le déclare dans network', rule: s.rule };
    if (s.rule === 'write-outside') return { decision: 'ask', why: s.reason, path: 'écris avec Edit ou Write (la cible y est jugée), ou lance la commande depuis le dossier cible', rule: s.rule };
    if (s.rule === 'sandbox-off') return { decision: 'ask', why: s.reason, path: 'relance la commande sans dangerouslyDisableSandbox (dans le bac à sable) ; si elle n’y passe pas, le développeur l’accepte dans Claude Code', rule: s.rule };
    return { decision: 'ask', why: s.reason, path: OPAQUE_WAY, rule: s.rule };
  }
  if (s.rule === 'write-guarded') return { decision: 'ask', why: s.reason, path: 'ce fichier (.git/, .claude/, .env) se change par sa commande (git config, réglages de Claude Code) ou par le développeur dans son terminal ; le code s’écrit avec Edit ou Write', rule: s.rule };
  return { decision: 'ask', why: s.reason || (mac ? 'hors de tout projet : la règle du Mac ne sait pas' : `la règle du projet ne sait pas (${where.kind})`), path: OPAQUE_WAY, rule: s.rule || 'unknown' };
};

export const check = ({ cwd, tool, input = {}, project, caller = 'conversation', projects = [], sessions = [], pushRules = [] } = {}, facts = {}) => {
  facts = { ...realFacts, ...facts };
  const home = facts.home(); tool = String(tool || ''); input = input && typeof input === 'object' ? input : {};
  if (!cwd || !path.isAbsolute(String(cwd))) return { decision: 'ask', why: 'cwd manquant ou relatif', path: 'le hook envoie le cwd absolu de la conversation', target: null, rule: 'bad-call' };
  const known = [...new Set([...projects, ...(project && projects.some((x) => fold(path.resolve(x), facts) === fold(path.resolve(project), facts)) ? [project] : [])])];
  const ctx = { projects: known, sessions };
  const start = path.resolve(String(cwd));
  // The folder a Bash call runs in: its cwd, or the folder of a leading `cd <dir> &&`
  let dir = start;
  const cmd = String(input.command || '');
  if (tool === 'Bash') { const m = /^\s*cd\s+(['"]?)([^\s'";&|]+)\1\s*(?:&&|;)/.exec(cmd); if (m && !m[2].includes('$')) dir = path.resolve(dir, expandHome(m[2], home)); }
  const filePath = input.file_path || input.notebook_path || (READ_TOOLS.has(tool) ? input.path : null);
  const targetAbs = filePath ? path.resolve(dir, expandHome(String(filePath), home)) : dir;
  let where = placeOf(targetAbs, ctx, facts);
  // Bash: git -C, --git-dir, --work-tree are targets too; the strictest place wins (a session, the main checkout, the Mac)
  const parsed = tool === 'Bash' ? parseLine(cmd) : [];
  const bt = tool === 'Bash' ? bashTargets(parsed, start, home) : null;
  for (const g of bt?.gitDirs || []) { const w = placeOf(g.dir, ctx, facts); if (RANK[w.kind] > RANK[where.kind]) { where = w; dir = g.dir; } }
  const target = { kind: where.kind, root: where.root, project: where.project, ...(where.session ? { session: where.session } : {}) };
  const out = (r) => ({ ...r, path: r.decision === 'allow' ? '' : r.path || OPAQUE_WAY, target });

  const abs = absolutes({ tool, input, caller, cwd: dir, where: { ...where, project: where.project || placeOf(dir, ctx, facts).project }, pushRules, facts, parsed, writes: bt?.writes || [], ctx });
  if (abs) return out(abs);
  if (FREE_TOOLS.has(tool) || READ_TOOLS.has(tool)) return out({ decision: 'allow', why: READ_TOOLS.has(tool) ? 'lecture' : 'sans cible', rule: 'read' });
  if (/^mcp__/.test(tool)) return out({ decision: 'allow', why: 'lecture d’un connecteur', rule: 'mcp-read' });
  if (tool === 'WebSearch') return out({ decision: 'allow', why: 'une recherche, rien ne part', rule: 'search' });

  if (WRITE_TOOLS.has(tool)) {
    if (!filePath) return out({ decision: 'ask', why: 'écriture sans chemin', path: 'donne file_path, un chemin absolu : la cible y est jugée', rule: 'bad-call' });
    if (where.kind === 'session') return out({ decision: 'deny', why: `worktree d’une session en cours : ${where.session}`, path: SESSION_WAY(where), rule: 'session-worktree' });
    if (where.kind === 'main') {
      if (handoff(where, targetAbs, facts)) return out({ decision: 'allow', why: 'passation locale (.escadrille/, jamais commitée)', rule: 'handoff' });
      return out({ decision: 'deny', why: `checkout principal de ${where.project} : main ne bouge que par fusion`, path: WORKTREE_WAY(where, canon(targetAbs, facts)), rule: 'main-checkout' });
    }
    if (where.kind === 'mac') {
      const p = canon(targetAbs, facts);
      if (isTmp(p, facts)) return out({ decision: 'allow', why: 'fichier temporaire', rule: 'mac-tmp' });
      return out({ decision: 'ask', why: `hors de tout projet : ${p}`, path: MAC_WAY(facts), rule: 'mac' });
    }
    const rel = relTo(where.root, canon(targetAbs, facts), facts);
    if (where.kind === 'worktree' && ESCADRILLE_GUARDED.some((g) => fold(g, facts) === fold(rel, facts)) && facts.exists(path.join(where.project, 'lib', 'guardrails.mjs'))) {
      return out({ decision: 'ask', why: `garde-fou d’Escadrille : ${rel}`, path: 'le développeur accepte l’écriture ; la branche ne se fusionne qu’après sa revue (docs/autonomy.md)', rule: 'guardrail' });
    }
    return out(fromSuggest(suggest({ tool, input, cwd: where.root, project: where.project }, facts.policy || {}), { where }));
  }

  if (tool === 'Bash') {
    // what the line writes, wherever its cd and its paths lead: a session's worktree, a main checkout, the Mac outside /tmp
    for (const p of bt.writes) {
      const w = placeOf(p, ctx, facts);
      if (w.kind === 'session') return out({ decision: 'deny', why: `worktree d’une session en cours : ${w.session} (${p})`, path: SESSION_WAY(w), rule: 'session-worktree' });
      if (w.kind === 'main' && !handoff(w, p, facts)) return out({ decision: 'deny', why: `checkout principal de ${w.project} : ${p}`, path: WORKTREE_WAY(w, canon(p, facts)), rule: 'main-checkout' });
      if (w.kind === 'mac' && !isTmp(canon(p, facts), facts)) return out({ decision: 'ask', why: `écriture hors de tout projet : ${canon(p, facts)}`, path: MAC_WAY(facts), rule: 'mac' });
    }
    const inline = parsed.map(inlineOf).find(Boolean);
    if (inline && ['main', 'mac'].includes(where.kind)) return out({ decision: 'ask', why: `script en ligne (${inline}) ${where.kind === 'main' ? `dans le checkout principal de ${where.project}` : 'hors de tout projet'} : ce qu’il touche ne se lit pas`, path: INLINE_WAY(where, facts), rule: 'inline-script' });
    if (where.kind === 'mac') {
      // outside every project the folder is never a worktree root: only /tmp and TMPDIR take a write
      if (bt.unknown) return out({ decision: 'ask', why: 'écriture vers un chemin qui n’est pas en clair, hors de tout projet', path: MAC_WAY(facts), rule: 'mac' });
      const edit = !isTmp(canon(dir, facts), facts) && parsed.map((x) => gitOf(x.run)).find((g) => g && !GIT_READ.has(g.sub));
      if (edit) return out({ decision: 'ask', why: `git ${edit.sub} hors de tout projet : ${dir}`, path: `ajoute le dépôt au registre des projets (docs/multiproject.md) et travaille dans un worktree ; sinon le développeur accepte dans Claude Code`, rule: 'mac' });
      const tmps = tmpsOf(facts);
      const s = suggest({ tool, input: { ...input, command: `cd '${start.replace(/'/g, `'\\''`)}' && ${cmd}` }, cwd: tmps[0], plan: { addDirs: tmps.slice(1) }, project: start }, facts.policy || {});
      if (s.rule === 'write-outside') return out({ decision: 'ask', why: `${s.reason}, hors de tout projet`, path: MAC_WAY(facts), rule: 'mac' });
      return out(fromSuggest(s, { where, mac: true }));
    }
    const s = suggest({ tool, input, cwd: where.root || dir, project: where.project || undefined }, facts.policy || {});
    const gits = parsed.map((x) => gitOf(x.run)).filter(Boolean);
    if (where.kind === 'session') {
      if (s.rule === 'read-only' || (s.rule === 'git-local' && gits.every((g) => GIT_READ.has(g.sub) || g.sub === 'branch'))) return out({ decision: 'allow', why: 'lecture dans le worktree d’une session', rule: 'session-read' });
      return out({ decision: 'deny', why: `worktree d’une session en cours : ${where.session}`, path: SESSION_WAY(where), rule: 'session-worktree' });
    }
    if (where.kind === 'main') {
      // the way that works starts here: a worktree, a branch, the local merge
      if (gits.length && gits.every((g) => g.sub === 'worktree' || g.sub === 'merge' || (g.sub === 'branch' && !g.rest.some((w) => /^-(D|d|-delete|f|-force)$/.test(w))) || ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'fetch'].includes(g.sub))
        && parsed.every((x) => !x.redirs.some((r) => r.out) && (gitOf(x.run) || ['cd', 'ls', 'pwd', 'echo'].includes(base(x.run[0]))))) {
        if (gits.some((g) => g.sub === 'fetch')) return out(fromSuggest(s, { where }));
        return out({ decision: 'allow', why: 'worktree, branche, fusion locale ou lecture git depuis le checkout principal', rule: 'main-way' });
      }
      const merging = facts.exists(path.join(where.project, '.git', 'MERGE_HEAD'));
      const edit = gits.find((g) => TREE_EDIT.has(g.sub) && !(merging && ['add', 'commit'].includes(g.sub)) && !(g.sub === 'stash' && ['list', 'show'].includes(g.rest[0])) && !(g.sub === 'checkout' && !g.rest.length));
      if (edit || ['write-inside', 'write-guarded'].includes(s.rule)) return out({ decision: 'deny', why: `checkout principal de ${where.project} : ${edit ? 'git ' + edit.sub : s.reason}`, path: WORKTREE_WAY(where, null), rule: 'main-checkout' });
    }
    return out(fromSuggest(s, { where, mac: false }));
  }
  if (tool === 'WebFetch') return out(fromSuggest(suggest({ tool, input, cwd: where.root || dir }, facts.policy || {}), { where, mac: where.kind === 'mac' }));
  return out({ decision: 'ask', why: `outil inconnu de la règle : ${tool}`, path: 'cet outil n’est pas dans la règle : passe par Read, Edit, Write ou Bash, ou le développeur l’accepte dans Claude Code', rule: 'unknown-tool' });
};
