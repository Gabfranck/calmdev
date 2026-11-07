// The local permission rule (docs/policy.md): the server proposes, the developer decides.
// suggest({ tool, input, cwd, plan: { network, addDirs }, project }) → { allow: true|false|null, reason, rule }
// An ordered list of pure rules over a parsed call; the facts the rules need (does this file exist, is this
// binary installed, what are the remotes, what does .claude/settings.json deny) are gathered once, before.
// A reason is right rather than wide: in doubt, the rule says nothing (null). Never true for the network
// outside the plan, outside the sandbox or a push.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isNetwork } from './planner.mjs';

// ---------------------------------------------------------------- the facts (the only impure part)
const realFacts = {
  exists: (p) => { try { fs.statSync(p); return true; } catch { return false; } },
  read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  pathDirs: () => String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  remotes: (dir) => { try { return execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((l) => l.split(/\s+/)).filter((x) => x[1]).map(([name, url]) => ({ name, url })); } catch { return []; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
};

// ---------------------------------------------------------------- reading a shell command
// Heredoc bodies are data: dropped, line by line, up to their closing tag
const dropHeredocs = (src) => {
  const out = []; let tags = [];
  for (const line of String(src).split('\n')) {
    if (tags.length) { if (line.trim() === tags[0]) tags.shift(); continue; }
    out.push(line);
    for (const m of line.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) tags.push(m[2]);
  }
  return out.join('\n');
};

// Words (quotes removed, with a flag), separators, redirections; $(…) and `…` are kept aside as commands of their own
const lex = (src) => {
  const toks = []; const subs = []; const n = src.length; let cur = null; let i = 0;
  const word = () => (cur ??= { t: 'word', v: '', quoted: false, dyn: false });
  const flush = () => { if (cur) { toks.push(cur); cur = null; } };
  const readSub = (start) => { let depth = 1; let q = null; let j = start;
    for (; j < n; j++) { const c = src[j]; if (q) { if (c === '\\' && q === '"') j++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"') q = c; else if (c === '(') depth++; else if (c === ')' && --depth === 0) break; }
    subs.push(src.slice(start, j)); return j + 1; };
  const readTick = (start) => { const k = src.indexOf('`', start); const e = k < 0 ? n : k; subs.push(src.slice(start, e)); return e + 1; };
  while (i < n) {
    const c = src[i];
    if (c === '\\') { if (src[i + 1] !== '\n') word().v += src[i + 1] ?? ''; i += 2; continue; }
    if (c === "'") { const k = src.indexOf("'", i + 1); const e = k < 0 ? n : k; const w = word(); w.v += src.slice(i + 1, e); w.quoted = true; i = e + 1; continue; }
    if (c === '"') { const w = word(); w.quoted = true; let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { w.v += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { j = readSub(j + 2); w.dyn = true; continue; }
        if (src[j] === '`') { j = readTick(j + 1); w.dyn = true; continue; }
        if (src[j] === '$') w.dyn = true;
        w.v += src[j++];
      }
      i = j + 1; continue; }
    if (c === '$' && src[i + 1] === '(') { i = readSub(i + 2); word().dyn = true; continue; }
    if (c === '`') { i = readTick(i + 1); word().dyn = true; continue; }
    if (c === '$') { word().dyn = true; word().v += c; i++; continue; }
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { flush(); toks.push({ t: 'op' }); i++; continue; }
    if (c === '&' && src[i + 1] === '>') { flush(); i += src[i + 2] === '>' ? 3 : 2; toks.push({ t: 'redir', out: true }); continue; }
    if (c === '&' || c === '|') { flush(); i += src[i + 1] === c || (c === '|' && src[i + 1] === '&') ? 2 : 1; toks.push({ t: 'op' }); continue; }
    if (c === '>' || c === '<') {
      if (cur && !cur.quoted && /^\d+$/.test(cur.v)) cur = null; else flush();
      let j = i + 1; if (src[j] === c) j++; if (c === '<' && src[j] === '-') j++;
      if (src[j] === '&') { j++; while (/[\d-]/.test(src[j] ?? '')) j++; i = j; continue; } // 2>&1, >&2: no file
      toks.push({ t: 'redir', out: c === '>' }); i = j; continue;
    }
    word().v += c; i++;
  }
  flush();
  return { toks, subs };
};

// Segments of a command line, subcommands included: { words: [{v, quoted, dyn}], redirs: [{out, w}] }
const segmentsOf = (src, depth = 0) => {
  if (depth > 4) return [{ words: [{ v: 'eval', dyn: true }], redirs: [] }];
  const { toks, subs } = lex(dropHeredocs(src));
  const segs = []; let s = { words: [], redirs: [] };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'op') { segs.push(s); s = { words: [], redirs: [] }; continue; }
    if (t.t === 'redir') { const w = toks[i + 1]?.t === 'word' ? toks[++i] : null; s.redirs.push({ out: t.out, w }); continue; }
    s.words.push(t);
  }
  segs.push(s);
  return [...segs.filter((x) => x.words.length || x.redirs.length), ...subs.flatMap((x) => segmentsOf(x, depth + 1))];
};

// ---------------------------------------------------------------- hosts and paths
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;
const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$|^\d{1,3}(\.\d{1,3}){3}$/i;
const inPlan = (host, network) => (Array.isArray(network) ? network : []).some((d) => { d = String(d).toLowerCase(); return d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d; });
// A destination as written (a URL, host:port/path, user@host:path) → { host, label, local, plan, real } or null when unreadable
const hostOf = (target, network, { scp = false } = {}) => {
  let t = String(target);
  if (/^file:\/\//i.test(t)) return { host: 'file', label: t, local: true };
  if (/^:\d/.test(t)) return { host: 'localhost', label: 'localhost' + t.split('/')[0], local: true }; // httpie's :3094/path
  t = t.replace(/^[a-z][\w+.-]*:\/\//i, '');
  const auth = t.split(/[/?#]/)[0].replace(/^[^@]*@/, '');
  const host = (scp ? auth.split(':')[0] : auth.replace(/:\d*$/, '')).toLowerCase();
  const label = scp ? host : auth.toLowerCase();
  if (LOCAL_HOST.test(host)) return { host, label, local: true };
  if (!DOMAIN.test(host)) return null;
  return inPlan(host, network) ? { host, label, plan: true } : { host, label, real: true };
};
// The real path of the longest existing prefix: /tmp and /private/tmp, /var and /private/var are one place
const canon = (p, facts) => { let head = p; const tail = []; while (head !== path.dirname(head)) { const r = facts.realpath(head); if (r) return path.join(r, ...tail.reverse()); tail.push(path.basename(head)); head = path.dirname(head); } return p; };
const under = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

// ---------------------------------------------------------------- the deny rules of .claude/settings.json (read, never copied)
const denyRulesOf = (dirs, facts) => {
  const seen = new Set(); const rules = [];
  for (const d of dirs.filter(Boolean)) for (const f of ['settings.json', 'settings.local.json']) {
    const file = path.join(d, '.claude', f); const key = facts.realpath(file) || file; if (seen.has(key)) continue; seen.add(key);
    const txt = facts.read(file); if (!txt) continue;
    let json; try { json = JSON.parse(txt); } catch { continue; }
    for (const r of json?.permissions?.deny || []) if (typeof r === 'string' && !rules.includes(r)) rules.push(r);
  }
  return rules;
};
const globRe = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const parseRule = (r) => { const m = /^([\w*-]+)(?:\((.*)\))?$/.exec(r); return m && { tool: m[1], content: m[2] ?? null, text: r }; };
// Bash(git push*) against "git push origin main"; the legacy "npm:*" is a prefix
const bashDenied = (rules, line) => rules.map(parseRule).find((r) => r && r.tool === 'Bash' && r.content != null && (r.content.endsWith(':*') ? line === r.content.slice(0, -2) || line.startsWith(r.content.slice(0, -2) + ' ') : globRe(r.content).test(line)))?.text || null;
const toolDenied = (rules, tool) => rules.map(parseRule).find((r) => r && r.content == null && globRe(r.tool).test(tool))?.text || null;

// ---------------------------------------------------------------- one segment, analysed
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'echo', 'printf', 'pwd', 'cd', 'jq', 'sort', 'uniq', 'diff', 'cmp', 'true', 'false', 'sleep', 'test', '[', 'which', 'type', 'file', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'date', 'cut', 'tr', 'tree', 'sed', 'nl', 'column', 'comm', 'md5', 'shasum', 'sha256sum', 'xxd', 'od']);
const WRITERS = new Set(['touch', 'mkdir', 'cp', 'mv', 'tee', 'rm', 'rmdir']);
const NET_TOOLS = new Set(['curl', 'wget', 'xh', 'http', 'https']);
const REMOTE_SHELLS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);
const GIT_LOCAL = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe', 'add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'mv', 'grep', 'cherry-pick', 'merge-base', 'cat-file', 'reflog', 'branch', 'tag', 'worktree', 'stash', 'config']);
const GIT_NET = new Set(['fetch', 'pull', 'clone', 'ls-remote']);
// Options that take a value, per tool: the value is never a destination
const CURL_VAL = new Set(['-o', '--output', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-H', '--header', '-F', '--form', '-T', '--upload-file', '-X', '--request', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-w', '--write-out', '-b', '--cookie', '-c', '--cookie-jar', '-m', '--max-time', '--connect-timeout', '-K', '--config', '-r', '--range', '-C', '--retry', '-E', '--cert', '--cacert', '-D', '--dump-header', '--resolve', '-O', '--output-document', '-P', '--directory-prefix', '-U', '--post-data', '--post-file', '--body-file']);
const CURL_SHORT_VAL = 'odHFTXuAewbcmKrCEDUP';
const CURL_OUT = new Set(['-o', '--output', '-O', '--output-document', '-P', '--directory-prefix', '-D', '--dump-header', '-c', '--cookie-jar']);

const analyse = (seg, ctx) => {
  const a = { kind: null, unknown: false, hosts: [], writes: [], files: [], denied: null, push: false, detail: '' };
  const write = (w) => { if (!w || w.dyn) { a.unknown = true; return; } const v = expandHome(w.v); if (/^\/dev\/(null|stdout|stderr|tty)$/.test(v)) return; a.writes.push(ctx.place(path.resolve(ctx.dir, v))); };
  for (const r of seg.redirs) if (r.out) write(r.w); else if (!r.w) a.unknown = true;
  let words = seg.words; while (words[0] && !words[0].quoted && /^[A-Za-z_]\w*=/.test(words[0].v)) words = words.slice(1);
  while (words[0] && ['env', 'time', 'command', 'nohup'].includes(words[0].v)) words = words.slice(1);
  if (!words.length) { a.kind = a.writes.length ? 'write' : 'read'; return a; }
  const line = words.map((w) => w.v).join(' ');
  a.denied = bashDenied(ctx.denyRules, line);
  const [head, ...rest] = words; const cmd = head.dyn ? '' : path.basename(head.v);
  const args = rest.map((w) => w.v); const pos = rest.filter((w) => !w.v.startsWith('-'));
  if (!cmd) { a.unknown = true; return a; }
  if (cmd === 'git') {
    let i = 0; let dir = ctx.dir;
    while (i < rest.length && rest[i].v.startsWith('-')) { if (['-C', '-c', '--git-dir', '--work-tree'].includes(rest[i].v)) { if (rest[i].v === '-C') dir = path.resolve(ctx.dir, rest[i + 1]?.v || '.'); i += 2; } else i++; }
    const sub = rest[i]?.v; const after = rest.slice(i + 1); const apos = after.filter((w) => !w.v.startsWith('-'));
    if (sub === 'push') { a.push = true; return a; }
    if (GIT_NET.has(sub)) {
      const target = apos[0]?.v; a.kind = 'git';
      const looksUrl = (t) => /:\/\//.test(t) || /^[\w.-]+@[\w.-]+:/.test(t);
      const looksPath = (t) => /^(\/|\.\.?\/|~)/.test(t);
      if (target && (looksUrl(target) || sub === 'clone')) { if (looksPath(target) && !looksUrl(target)) { a.detail = 'git en local'; return a; } const h = hostOf(target.replace(/^([\w.-]+@[\w.-]+):/, 'ssh://$1/'), ctx.network); if (!h) { a.kind = null; return a; } a.hosts.push(h); a.detail = h.local ? 'git vers la machine locale' : ''; return a; }
      if (target && looksPath(target)) { a.detail = 'git en local'; return a; }
      const remotes = ctx.facts.remotes(dir);
      if (!remotes.length) { a.detail = 'git en local, sans remote'; return a; }
      const chosen = remotes.filter((r) => r.name === (target || 'origin'));
      if (!chosen.length) { a.kind = null; return a; }
      for (const r of chosen) { if (looksPath(r.url) || /^file:/.test(r.url)) continue; const h = hostOf(r.url.replace(/^([\w.-]+@[\w.-]+):/, 'ssh://$1/'), ctx.network); if (!h) { a.kind = null; return a; } a.hosts.push(h); }
      a.detail = a.hosts.every((h) => h.local) ? 'git en local' : '';
      return a;
    }
    if (sub === 'remote') { if (!apos.length || ['add', 'get-url', 'set-url', 'rename', 'remove', 'rm'].includes(apos[0].v)) { a.kind = 'git'; a.detail = 'git en local'; } return a; }
    if (!GIT_LOCAL.has(sub)) return a;
    if (sub === 'branch' && after.some((w) => /^-(D|d|-delete|f|-force|m|M)$/.test(w.v))) return a;
    if (sub === 'worktree' && apos[0]?.v !== 'list') return a;
    if (sub === 'stash' && !['list', 'show'].includes(apos[0]?.v)) return a;
    if (sub === 'config' && !after.some((w) => /^(--get|--list|-l|--get-regexp)$/.test(w.v))) return a;
    if (sub === 'tag' && apos.length) return a;
    a.kind = 'git'; a.detail = 'git en local'; return a;
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd)) {
    const sub = pos[0]?.v;
    if (['run', 'test', 't', 'start', 'run-script'].includes(sub)) { a.kind = 'run'; a.detail = `${cmd} ${sub}${sub === 'run' && pos[1] ? ' ' + pos[1].v : ''}`; return a; }
    if (sub === 'exec' && cmd !== 'yarn') return bin(a, rest.slice(rest.indexOf(pos[0]) + 1), ctx);
    return a;
  }
  if (['npx', 'pnpx', 'bunx'].includes(cmd)) return bin(a, rest, ctx);
  if (cmd === 'node') {
    const ev = rest.findIndex((w) => /^(-e|--eval|-p|--print)$/.test(w.v));
    if (ev >= 0) for (const m of String(rest[ev + 1]?.v || '').matchAll(/https?:\/\/[^\s'"`)]+/g)) { const h = hostOf(m[0], ctx.network); if (h) a.hosts.push(h); }
    a.kind = 'run'; a.detail = ['node', pos[0]?.v].filter(Boolean).join(' '); return a;
  }
  if (NET_TOOLS.has(cmd)) {
    a.kind = 'net';
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]; const v = w.v;
      if (v === '--url') { const t = rest[++i]; if (!t || t.dyn) { a.unknown = true; continue; } const h = hostOf(t.v, ctx.network); h ? a.hosts.push(h) : (a.unknown = true); continue; }
      if (/^-x$|^--proxy$/.test(v)) { const t = rest[++i]; const h = t && hostOf(t.v, ctx.network); if (h) a.hosts.push(h); else a.unknown = true; continue; }
      if (CURL_VAL.has(v)) { const val = rest[++i]; if (CURL_OUT.has(v)) write(val); continue; }
      if (/^--[\w-]+=/.test(v)) continue;
      if (/^-[a-zA-Z]{2,}$/.test(v)) { const k = [...v.slice(1)].findIndex((c) => CURL_SHORT_VAL.includes(c)); if (k >= 0) { const c = v[k + 1]; const val = k === v.length - 2 ? rest[++i] : { v: v.slice(k + 2) }; if ('oODPc'.includes(c)) write(val); } continue; }
      if (v.startsWith('-')) continue;
      if (w.dyn) { a.unknown = true; continue; }
      const h = hostOf(v, ctx.network); if (h) a.hosts.push(h); else a.unknown = true;
    }
    if (!a.hosts.length) a.unknown = true;
    return a;
  }
  // ssh, scp, rsync…: only ever refused (a real host outside the plan) or left to the developer
  if (REMOTE_SHELLS.has(cmd)) { for (const w of pos) { if (w.dyn) continue; const h = hostOf(w.v, ctx.network, { scp: true }); if (h?.real) a.hosts.push(h); } return a; }
  if (cmd === 'gh') { if (!inPlan('api.github.com', ctx.network)) a.hosts.push({ host: 'api.github.com', label: 'api.github.com (gh)', real: true }); return a; }
  if (cmd === 'sed' && args.some((x) => /^-i/.test(x))) { a.kind = 'write'; for (const w of pos.slice(1)) write(w); return a; }
  if (cmd === 'find' && args.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint\w*)$/.test(x))) return a;
  if (READ_ONLY.has(cmd)) {
    a.kind = 'read';
    if (cmd === 'cd') { const t = pos[0]; if (t?.dyn) a.unknown = true; else ctx.dir = path.resolve(ctx.dir, expandHome(t?.v || '~')); }
    return a;
  }
  if (WRITERS.has(cmd)) {
    if (pos.some((w) => w.dyn)) { a.unknown = true; return a; }
    const targets = ['cp', 'mv'].includes(cmd) ? pos.slice(-1) : pos;
    if (!targets.length) { a.unknown = true; return a; }
    targets.forEach(write); a.kind = ['rm', 'rmdir'].includes(cmd) ? 'rm' : 'write'; return a;
  }
  return a;
};
// npx eslint: an installed binary (node_modules/.bin of the worktree or the project, or the PATH), no version asked
const bin = (a, rest, ctx) => {
  let i = 0; while (i < rest.length && rest[i].v.startsWith('-')) { if (/^(-p|--package|-c|--call)$/.test(rest[i].v)) return a; i++; }
  const w = rest[i]; if (!w || w.dyn) return a;
  const name = w.v; if (name.lastIndexOf('@') > 0 || name.includes('/') && !name.startsWith('@')) return a;
  const short = name.startsWith('@') ? name.split('/')[1] : name; if (!short) return a;
  const dirs = [ctx.dir, ctx.root, ctx.project].filter(Boolean).map((d) => path.join(d, 'node_modules', '.bin'));
  if ([...dirs, ...ctx.facts.pathDirs()].some((d) => ctx.facts.exists(path.join(d, short)))) { a.kind = 'bin'; a.detail = short; }
  return a;
};

// Nothing opens on the Mac's screen (docs/decisions.md, « Rien ne s'ouvre à l'écran », 10:40): open -a/-b or a URL, osascript,
// expo --ios/--android or run:ios/android, Simulator.app; the captures go through a headless Chromium, a simulator only by xcrun simctl
const WINDOW = [[/(?:^|[;&|(\n])\s*open\s+(?:[^;&|]*\s)?(?:-[a-zA-Z]*[ab]\b|['"]?https?:)/, 'open'], [/(?:^|[^\w-])osascript\b/, 'osascript'], [/\bexpo\b[^;&|]*(?:\s--(?:ios|android)\b|\brun:(?:ios|android)\b)/, 'expo'], [/Simulator\.app/, 'Simulator.app']];
const windowOf = (cmd) => (WINDOW.find(([re]) => re.test(cmd)) || [])[1] || null;

// ---------------------------------------------------------------- the rules, in order (docs/policy.md)
const safeSeg = (s) => s.kind && s.kind !== 'rm' && !s.unknown && !s.denied && !s.push && s.hosts.every((h) => h.local || h.plan) && s.writes.every((w) => w.inside && !w.guarded);
const firstOf = (c, f) => { for (const s of c.segs) { const r = f(s); if (r) return r; } return null; };
const NET_WORD = /(^|[^\w-])(curl|wget|gh|npx|pnpx|bunx|ssh|scp|rsync|brew|pip3?|npm|pnpm|yarn|git|aws|vercel|netlify|fly|gcloud|stripe|docker)(?![\w-])/;

export const RULES = [
  { id: 'sandbox-off', allow: false, match: (c) => c.input.dangerouslyDisableSandbox === true && 'x', reason: () => 'Hors bac à sable : à décider soi-même' },
  { id: 'deny-settings', allow: false, match: (c) => c.toolDenied || firstOf(c, (s) => s.denied), reason: (d) => `Interdit par .claude/settings.json : ${d}` },
  { id: 'git-push', allow: false, match: (c) => firstOf(c, (s) => s.push && 'x'), reason: () => 'Un push : jamais sans le développeur' },
  { id: 'open-window', allow: false, match: (c) => c.tool === 'Bash' && windowOf(String(c.input.command || '')), reason: (d) => `Aucune fenêtre ni app ouverte sur le Mac : ${d}` },
  { id: 'real-host', allow: false, match: (c) => firstOf(c, (s) => s.hosts.find((h) => h.real)?.label), reason: (d) => `Hôte hors du plan : ${d}` },
  { id: 'write-outside', allow: false, match: (c) => firstOf(c, (s) => s.writes.find((w) => !w.inside)?.short), reason: (d) => `Écriture hors du worktree : ${d}` },
  { id: 'write-guarded', allow: null, match: (c) => firstOf(c, (s) => s.writes.find((w) => w.guarded)?.short), reason: (d) => `Écriture protégée : ${d}` },
  { id: 'file-not-host', allow: true, match: (c) => c.safe && c.net && c.fileWord, reason: (d) => `Un fichier, pas un domaine : ${d}` },
  { id: 'quoted-word', allow: true, match: (c) => c.safe && c.net && c.quotedWord, reason: (d) => `Un mot dans un texte, pas une commande : ${d}` },
  { id: 'local-bin', allow: true, match: (c) => c.safe && firstOf(c, (s) => s.kind === 'bin' && s.detail), reason: (d) => `Outil déjà installé : ${d}` },
  { id: 'local-host', allow: true, match: (c) => c.safe && firstOf(c, (s) => s.hosts.find((h) => h.local && h.host !== 'file')?.label), reason: (d) => `Vers la machine locale : ${d}` },
  { id: 'git-local', allow: true, match: (c) => c.safe && firstOf(c, (s) => s.kind === 'git' && (s.detail || 'git en local')), reason: (d) => d },
  { id: 'plan-domain', allow: true, match: (c) => c.safe && firstOf(c, (s) => s.hosts.find((h) => h.plan)?.host), reason: (d) => `Domaine ouvert par le plan : ${d}` },
  { id: 'write-inside', allow: true, match: (c) => c.safe && firstOf(c, (s) => { const w = s.writes[0]; return w && `${w.addDir ? 'Écriture dans un dossier ouvert' : 'Écriture dans le worktree'} : ${w.short}`; }), reason: (d) => d },
  { id: 'local-run', allow: true, match: (c) => c.safe && firstOf(c, (s) => s.kind === 'run' && s.detail), reason: (d) => `Commande locale : ${d}` },
  { id: 'read-only', allow: true, match: (c) => c.safe && c.segs.length > 0 && 'x', reason: () => 'Lecture seule' },
];

// ---------------------------------------------------------------- the call
const KNOWN_EXT = /\.(m?[jt]sx?|cjs|json|md|txt|html?|css|sqlite|db|ya?ml|toml|lock|sh|py|rb|rs|go|java|png|jpe?g|gif|svg|webp|pdf|log|csv|xml|ini|conf|map|env|out|bak|tmp)$/i;

export const suggest = ({ tool, input = {}, cwd, plan = {}, project } = {}, facts = realFacts) => {
  facts = { ...realFacts, ...facts };
  const root = canon(path.resolve(cwd || '.'), facts);
  const addDirs = (Array.isArray(plan.addDirs) ? plan.addDirs : []).map((d) => canon(path.resolve(root, expandHome(String(d))), facts));
  const home = os.homedir();
  const place = (abs) => {
    const p = canon(abs, facts);
    const base = [root, ...addDirs].find((r) => under(p, r));
    const rel = base ? path.relative(base, p) : null;
    const short = base ? rel || '.' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
    const guarded = base != null && (/^(\.git|\.claude)(\/|$)/.test(rel) || /^\.env(\..*)?$/.test(path.basename(p)));
    return { path: p, inside: !!base, addDir: !!base && base !== root, guarded, short };
  };
  const ctx = { dir: root, root, project: project ? path.resolve(project) : null, network: plan.network, facts, place, denyRules: denyRulesOf([root, project], facts) };
  const c = { tool, input, segs: [], net: false, toolDenied: null };
  if (/^mcp__/.test(tool) || !['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch'].includes(tool)) c.toolDenied = toolDenied(ctx.denyRules, tool);
  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    c.net = isNetwork('Bash', input);
    c.segs = segmentsOf(cmd).map((s) => analyse(s, ctx));
    if (c.net) {
      // The words isNetwork may have read as hosts that are files: if the call is no longer network without them, they were the false positive
      const dests = new Set(c.segs.flatMap((s) => s.hosts.map((h) => h.label)));
      const words = segmentsOf(cmd).flatMap((s) => [...s.words, ...s.redirs.map((r) => r.w).filter(Boolean)]).filter((w) => !w.quoted && !w.dyn && /[\w-]\.[a-z]{2,}/i.test(w.v) && !/:\/\/|@/.test(w.v) && !dests.has(w.v));
      const files = words.filter((w) => facts.exists(path.resolve(root, w.v)) || w.v.includes('/') || KNOWN_EXT.test(w.v)).map((w) => w.v);
      if (files.length) { let rest = cmd; for (const f of files) rest = rest.split(f).join('file'); if (!isNetwork('Bash', { command: rest })) c.fileWord = files[0]; }
      // The network word only inside a quoted string (a commit message, an echo)
      const blanked = cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
      if (!isNetwork('Bash', { command: blanked })) { const q = (cmd.match(/'[^']*'|"(?:[^"\\]|\\.)*"/g) || []).map((s) => NET_WORD.exec(s)).find(Boolean); if (q) c.quotedWord = q[2]; }
    }
  } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = input.file_path || input.notebook_path;
    if (p) c.segs = [{ kind: 'write', unknown: false, hosts: [], writes: [place(path.resolve(root, expandHome(String(p))))], denied: null, push: false, detail: '' }];
  } else if (tool === 'WebFetch') {
    const h = hostOf(String(input.url || ''), plan.network);
    c.segs = [{ kind: h ? 'net' : null, unknown: !h, hosts: h ? [h] : [], writes: [], denied: null, push: false, detail: '' }];
  }
  c.safe = c.segs.length > 0 && c.segs.every(safeSeg);
  for (const r of RULES) { const d = r.match(c); if (d) return { allow: r.allow, reason: r.reason(d), rule: r.id }; }
  return { allow: null, reason: '', rule: null };
};
