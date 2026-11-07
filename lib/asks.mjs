// The « À toi » modal (docs/asks.md): every permission a session waits on, shown whole to the developer with a line
// written by code, no model. Pure functions, no I/O.
//   explain(tool, input, { cwd, home })   → { line, scope: 'local' | 'outside' | 'network', known }
//   commandOf(tool, input)                → the command or the whole input, never cut
//   hostsOf(tool, input)                  → the hosts a request names (curl, wget, WebFetch, npm install, git push…)
//   queue(rows, { pilotOn, now, guard })  → the asks that open the modal, oldest first (the 90-second rule)
// Scope: local (inside the session's folder), outside (a path out of it, or a place we cannot tell), network (leaves
// the machine). The widest wins: local < outside < network. In doubt, the wide one: no false comfort.
import path from 'node:path';
import { homedir } from 'node:os';
import { needsDev } from './todo.mjs';

export const PILOT_LATE_MS = 90e3; // with a pilot on, an ask still unanswered after 90 s comes to the developer
export const UNKNOWN_LINE = "Commande non reconnue : lis-la avant d'autoriser";
const RANK = { local: 0, outside: 1, network: 2 };
const wider = (a, b) => (RANK[b] > RANK[a] ? b : a);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;

// ---------------------------------------------------------------- the shell, cut into parts
// Splits on && || ; | & and new lines outside quotes; keeps the redirections apart. A $( … ), a backquote or a
// parenthesis marks the command as opaque (its inner part is not read).
export const splitShell = (src) => {
  const parts = []; let words = []; let redirs = []; let opaque = false;
  let buf = ''; let has = false; let quoted = false; let pendingOp = null;
  const endWord = () => {
    if (!has) return;
    if (pendingOp) { redirs.push({ op: pendingOp, target: buf }); pendingOp = null; } else words.push({ w: buf, q: quoted });
    buf = ''; has = false; quoted = false;
  };
  const endPart = (sep) => { endWord(); if (pendingOp) { redirs.push({ op: pendingOp, target: '' }); pendingOp = null; } if (words.length || redirs.length) parts.push({ words, redirs, sep }); words = []; redirs = []; };
  const s = String(src ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]; const n = s[i + 1];
    if (c === '\\' && i + 1 < s.length) { if (n !== '\n') { buf += n; has = true; } i++; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); const end = j < 0 ? s.length : j; buf += s.slice(i + 1, end); has = true; quoted = true; i = end; continue; }
    if (c === '"') {
      let j = i + 1; let t = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { t += s[j + 1]; j += 2; continue; } if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) opaque = true; t += s[j]; j++; }
      buf += t; has = true; quoted = true; i = j; continue;
    }
    if (c === '`' || (c === '$' && n === '(') || c === '(' || c === ')') { opaque = true; if (c === '(' || c === ')') { endWord(); continue; } buf += c; has = true; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === ';') { endPart(';'); continue; }
    if (c === '&' && n === '&') { endPart('&&'); i++; continue; }
    if (c === '|' && n === '|') { endPart('||'); i++; continue; }
    if (c === '|') { endPart('|'); continue; }
    if (c === '&' && n === '>') { endWord(); pendingOp = s[i + 2] === '>' ? '>>' : '>'; i += s[i + 2] === '>' ? 2 : 1; continue; }
    if (c === '&') { endPart('&'); continue; } // 2>&1 is read by the redirection below
    if (c === '>' || c === '<') {
      const fd = /^\d$/.test(buf) && !quoted ? buf : ''; if (fd) { buf = ''; has = false; } else endWord();
      let op = c; if (n === '>' && c === '>') { op = '>>'; i++; }
      if (s[i + 1] === '&') { // 2>&1, >&2: a stream joined to another, nothing written
        i++; let t = ''; while (i + 1 < s.length && /[\d-]/.test(s[i + 1])) t += s[++i];
        continue;
      }
      pendingOp = (fd && fd !== '1' && fd !== '0' ? fd : '') + op; continue;
    }
    buf += c; has = true;
  }
  endPart(null);
  return { parts, opaque };
};

// ---------------------------------------------------------------- paths
const ctxOf = ({ cwd, home } = {}) => {
  const root = cwd ? path.resolve(String(cwd)) : '/__projet__'; // no folder given: relative stays inside, absolute is outside
  return { root, here: root, home: home || homedir() };
};
const resolvePath = (p, ctx) => {
  const s = String(p ?? '');
  if (s === '~' || s.startsWith('~/')) return path.join(ctx.home, s.slice(2));
  return path.resolve(ctx.here, s);
};
const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
export const pathScope = (p, ctx) => {
  const s = String(p ?? '');
  if (!s) return 'local';
  if (/[$`]/.test(s) || /^~[^/]/.test(s)) return 'outside'; // a variable or another user's home: we cannot tell where
  if (DEVICES.has(s)) return 'local';
  const r = resolvePath(s, ctx);
  return r === ctx.root || r.startsWith(ctx.root + '/') ? 'local' : 'outside';
};
const show = (p, ctx) => {
  const s = String(p ?? ''); if (/[$`]/.test(s)) return s;
  const r = resolvePath(s, ctx);
  if (r === ctx.root) return 'le dossier du projet';
  if (r.startsWith(ctx.root + '/')) return r.slice(ctx.root.length + 1);
  if (r === ctx.home) return '~';
  if (r.startsWith(ctx.home + '/')) return '~/' + r.slice(ctx.home.length + 1);
  return r;
};
const list = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' et ' + xs[xs.length - 1]);
const quote = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return `« ${t.length > n ? t.slice(0, n - 1) + '…' : t} »`; };

// ---------------------------------------------------------------- hosts
const hostOfUrl = (u) => {
  const s = String(u ?? '').trim(); if (!s) return null;
  try { const x = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? new URL(s) : new URL('//' + s, 'http://x'); return x.host || null; } catch { return null; } // a bare host: read against a neutral base
};
const looksUrl = (w) => /^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(w) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/|$)/i.test(w);
const isLocalHost = (h) => LOCAL_HOST.test(String(h || '').replace(/:\d+$/, ''));

// ---------------------------------------------------------------- one part of a command
const R = (text, scope = 'local', known = true, hosts = []) => ({ text, scope, known, hosts });
const unknown = (name, scope = 'outside') => R(`une commande non reconnue (${name})`, scope, false);
const pathsScope = (ps, ctx) => ps.reduce((s, p) => wider(s, pathScope(p, ctx)), 'local');
const args = (ws) => ws.filter((w) => !/^-/.test(w));
const READS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'sort', 'uniq', 'diff', 'which', 'true', 'false', 'test', '[', 'sleep', 'date', 'basename', 'dirname', 'realpath', 'du', 'file', 'stat', 'tree', 'jq', 'grep', 'rg', 'find', 'sed', 'touch', 'chmod', 'cut', 'tr', 'xargs']);
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'command', 'exec']);

const git = (ws, ctx) => {
  let i = 0; let scope = 'local';
  while (i < ws.length && /^-/.test(ws[i])) {
    if (ws[i] === '-C' && ws[i + 1] !== undefined) { scope = wider(scope, pathScope(ws[i + 1], ctx)); ctx = { ...ctx, here: resolvePath(ws[i + 1], ctx) }; i += 2; continue; }
    if (ws[i] === '-c' || ws[i] === '--git-dir' || ws[i] === '--work-tree') { if (ws[i] !== '-c') scope = wider(scope, pathScope(ws[i + 1], ctx)); i += 2; continue; }
    i++;
  }
  const sub = ws[i]; const rest = ws.slice(i + 1); const a = args(rest);
  const L = (text, sc = 'local') => R(text, wider(scope, sc));
  switch (sub) {
    case 'status': return L("lit l'état du dépôt git (git status)");
    case 'diff': return L('lit les différences git (git diff)');
    case 'log': return L("lit l'historique git (git log)");
    case 'show': return L('lit un commit git (git show)');
    case 'add': { const ps = a.length ? a : ['.']; return L(`ajoute à l'index git : ${rest.some((w) => w === '-A' || w === '--all') ? 'tous les fichiers' : list(ps.map((p) => show(p, ctx)))}`, pathsScope(a, ctx)); }
    case 'commit': { const k = rest.findIndex((w) => w === '-m' || w === '--message'); return L(`crée un commit git local${k >= 0 && rest[k + 1] !== undefined ? ' ' + quote(rest[k + 1]) : ''}`); }
    case 'checkout': case 'switch': {
      const b = rest.findIndex((w) => w === '-b' || w === '-c' || w === '-B');
      if (b >= 0) return L(`crée la branche git ${rest[b + 1] || '?'} et s'y place`);
      const dd = rest.indexOf('--'); if (dd >= 0) { const ps = rest.slice(dd + 1); return L(`restaure depuis git : ${list(ps.map((p) => show(p, ctx)))} (les changements non commités sont perdus)`, pathsScope(ps, ctx)); }
      return L(`change de branche git : ${a[0] || '?'}`);
    }
    case 'restore': return L(`restaure depuis git : ${list(a.map((p) => show(p, ctx)))} (les changements non commités sont perdus)`, pathsScope(a, ctx));
    case 'worktree': {
      const op = a[0]; const p = a[1];
      if (op === 'list') return L('liste les worktrees git');
      if (op === 'add') return L(`crée un worktree git dans ${show(p, ctx)}`, pathScope(p, ctx));
      if (op === 'remove') return L(`supprime le worktree git ${show(p, ctx)}`, pathScope(p, ctx));
      if (op === 'prune') return L('nettoie les worktrees git (prune) : touche ceux des autres sessions', 'outside');
      return R(`une commande git worktree non reconnue (${op || '?'})`, 'outside', false);
    }
    case 'push': return L(`pousse vers GitHub (git push${a.length ? ' ' + a.join(' ') : ''})`, 'network');
    case 'pull': case 'fetch': case 'clone': case 'ls-remote': case 'submodule': case 'remote':
      return L(`échange avec le dépôt distant (git ${sub})`, 'network');
    case 'reset': return L(rest.includes('--hard') ? 'annule les changements non commités (git reset --hard)' : 'déplace la branche git (git reset)');
    case 'clean': return L('efface les fichiers non suivis par git (git clean)');
    case 'stash': return L('met de côté des changements (git stash, partagé avec les autres worktrees)', 'outside');
    case 'config': return rest.includes('--global') || rest.includes('--system') ? L('change la configuration git de la machine', 'outside') : L('lit ou change la configuration git du dépôt');
    case 'branch': case 'tag': case 'merge': case 'rebase': case 'rm': case 'mv': case 'rev-parse': case 'merge-base': case 'blame': case 'grep': case 'cherry-pick': case 'revert': case 'ls-files': case 'shortlog': case 'describe':
      return L(`lance git ${sub} (local)`);
    default: return R(`une commande git non reconnue (${sub || 'git'})`, 'outside', false);
  }
};

const node = (ws, ctx) => {
  if (ws.includes('--test')) { const fs = args(ws); return R(`lance les tests Node (node --test${fs.length ? ' ' + fs.map((p) => show(p, ctx)).join(' ') : ''})`, pathsScope(fs, ctx)); }
  if (ws.some((w) => ['-e', '--eval', '-p', '--print'].includes(w))) return R('exécute du code Node écrit dans la commande (non lu)', 'outside', false);
  if (ws.some((w) => w === '-v' || w === '--version')) return R('affiche la version de Node');
  let i = 0; while (i < ws.length && /^-/.test(ws[i])) i++;
  const script = ws[i]; if (!script) return unknown('node');
  return R(`exécute le script ${show(script, ctx)} avec Node`, pathScope(script, ctx));
};

const npm = (cmd, ws) => {
  const offline = ws.includes('--offline'); const net = offline ? 'local' : 'network'; const warn = offline ? '' : ', peut joindre le réseau';
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') { const p = args(ws)[0]; return R(`lance ${cmd} ${p || '?'} (peut télécharger le paquet)`, net, true, offline ? [] : ['registry.npmjs.org']); }
  if (ws.some((w) => w === '-v' || w === '--version')) return R(`affiche la version de ${cmd}`);
  const a = args(ws); const sub = a[0];
  if (['install', 'i', 'ci', 'add', 'update', 'upgrade'].includes(sub) || (cmd === 'yarn' && !sub)) return R(`installe des paquets depuis le registre (${cmd} ${sub || 'install'})`, net, true, offline ? [] : ['registry.npmjs.org']);
  if (sub === 'test' || sub === 't') return R(`lance les tests (${cmd} test${warn})`, net);
  if (sub === 'run' || sub === 'run-script') return R(`lance le script ${cmd} « ${a[1] || '?'} »${warn ? ' (peut joindre le réseau)' : ''}`, net);
  if (sub === 'publish') return R(`publie le paquet sur le registre (${cmd} publish)`, 'network', true, ['registry.npmjs.org']);
  return R(`lance ${cmd} ${sub || ''}`.trim() + (warn ? ' (peut joindre le réseau)' : ''), net);
};

const http = (cmd, ws, ctx) => {
  const urls = ws.filter((w) => !/^-/.test(w) && looksUrl(w)); const hosts = urls.map(hostOfUrl).filter(Boolean);
  let out = null; const o = ws.findIndex((w) => w === '-o' || w === '--output' || w === '-O' && cmd === 'wget');
  if (o >= 0 && ws[o + 1] !== undefined && !(cmd === 'wget' && ws[o] === '-O' && ws[o + 1] === '-')) out = ws[o + 1];
  if (!hosts.length) return R(`une requête ${cmd} vers une adresse non lue`, 'network', false);
  const local = hosts.every(isLocalHost);
  let text = cmd === 'wget' ? `télécharge depuis ${list(hosts)}` : `fait une requête HTTP vers ${list(hosts)}`;
  if (local) text += ' (cette machine)';
  let scope = local ? 'local' : 'network';
  if (out) { text += ` et écrit ${show(out, ctx)}`; scope = wider(scope, pathScope(out, ctx)); }
  return R(text, scope, true, local ? [] : hosts);
};

const reads = (cmd, ws, ctx) => {
  const a = args(ws);
  switch (cmd) {
    case 'pwd': return R('affiche le dossier courant');
    case 'echo': case 'printf': return R('affiche un texte');
    case 'true': case 'false': case 'test': case '[': case 'sleep': case 'date': return R(`lance ${cmd}`);
    case 'which': return R(`cherche le programme ${a[0] || '?'}`);
    case 'ls': case 'tree': case 'du': return R(`liste ${a.length ? list(a.map((p) => show(p, ctx))) : 'le dossier courant'}`, pathsScope(a, ctx));
    case 'grep': case 'rg': { const ps = a.slice(1); return R(`cherche ${quote(a[0] || '', 40)}${ps.length ? ' dans ' + list(ps.map((p) => show(p, ctx))) : ''}`, pathsScope(ps, ctx)); }
    case 'find': {
      const ps = ws.slice(0, ws.findIndex((w) => /^[-(!]/.test(w)) >= 0 ? ws.findIndex((w) => /^[-(!]/.test(w)) : ws.length);
      if (ws.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w))) return R('une commande find qui exécute autre chose (-exec)', 'outside', false);
      const where = ps.length ? list(ps.map((p) => show(p, ctx))) : 'le dossier courant';
      return R(ws.includes('-delete') ? `efface les fichiers trouvés dans ${where}` : `cherche des fichiers dans ${where}`, pathsScope(ps, ctx));
    }
    case 'sed': {
      const inPlace = ws.some((w) => /^-i/.test(w) || w === '--in-place'); const ps = a.slice(1);
      return R(inPlace ? `modifie en place ${list(ps.map((p) => show(p, ctx)))}` : `transforme un texte (sed)${ps.length ? ' lu dans ' + list(ps.map((p) => show(p, ctx))) : ''}`, pathsScope(ps, ctx));
    }
    case 'touch': return R(`crée ou met à jour ${list(a.map((p) => show(p, ctx)))}`, pathsScope(a, ctx));
    case 'chmod': { const ps = a.slice(1); return R(`change les droits de ${list(ps.map((p) => show(p, ctx)))}`, pathsScope(ps, ctx)); }
    case 'xargs': return R('une commande lancée par xargs (non lue)', 'outside', false);
    case 'cut': case 'tr': case 'sort': case 'uniq': case 'jq': case 'wc': { const ps = cmd === 'jq' || cmd === 'tr' ? a.slice(1) : a; return R(`traite un texte (${cmd})${ps.length ? ' lu dans ' + list(ps.map((p) => show(p, ctx))) : ''}`, pathsScope(ps, ctx)); }
    default: return R(`lit ${a.length ? list(a.map((p) => show(p, ctx))) : "l'entrée"}`, pathsScope(a, ctx)); // cat head tail diff file stat realpath basename dirname
  }
};

const partOf = (part, ctx, depth) => {
  let ws = part.words.map((x) => x.w);
  while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) ws = ws.slice(1); // FOO=bar cmd
  for (;;) {
    const b = path.basename(ws[0] || '');
    if (b === 'env') { ws = ws.slice(1); while (ws.length && (/^-/.test(ws[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0]))) { if (ws[0] === '-u' || ws[0] === '-C') ws = ws.slice(1); ws = ws.slice(1); } continue; }
    if (WRAPPERS.has(b)) { ws = ws.slice(1); continue; }
    break;
  }
  let r;
  const cmd = path.basename(ws[0] || ''); const rest = ws.slice(1);
  if (!ws.length) r = R('', 'local');
  else if (cmd === 'git') r = git(rest, ctx);
  else if (cmd === 'node') r = node(rest, ctx);
  else if (['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx'].includes(cmd)) r = npm(cmd, rest);
  else if (cmd === 'curl' || cmd === 'wget') r = http(cmd, rest, ctx);
  else if (cmd === 'rm' || cmd === 'rmdir') {
    const a = args(rest); if (!a.length) r = unknown(cmd);
    else { const rec = rest.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive'); r = R(`efface ${list(a.map((p) => show(p, ctx)))}${rec ? (a.length > 1 ? ' et tout leur contenu' : ' et tout son contenu') : ''}`, pathsScope(a, ctx)); }
  } else if (cmd === 'mkdir') { const a = args(rest); r = a.length ? R(`crée le dossier ${list(a.map((p) => show(p, ctx)))}`, pathsScope(a, ctx)) : unknown(cmd); }
  else if (cmd === 'cp' || cmd === 'mv') {
    const a = args(rest); if (a.length < 2) r = unknown(cmd);
    else { const dst = a[a.length - 1]; const src = a.slice(0, -1); r = R(`${cmd === 'cp' ? 'copie' : 'déplace'} ${list(src.map((p) => show(p, ctx)))} vers ${show(dst, ctx)}`, pathsScope(a, ctx)); }
  } else if (cmd === 'cd' || cmd === 'pushd') {
    const to = args(rest)[0] ?? '~'; const sc = pathScope(to, ctx);
    r = R(`va dans ${show(to, ctx)}`, sc); if (!/[$`]/.test(to)) ctx.here = resolvePath(to, ctx); else ctx.here = '/__ailleurs__';
  } else if (cmd === 'popd') { r = R('revient au dossier précédent', 'outside'); ctx.here = '/__ailleurs__'; }
  else if ((cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') && rest[0] === '-c' && rest[1] !== undefined && depth < 3) {
    const inner = explainShell(rest[1], ctx, depth + 1); r = { text: inner.text, scope: inner.scope, known: inner.known, hosts: inner.hosts };
  } else if (cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') { const s = args(rest)[0]; r = s ? R(`exécute le script shell ${show(s, ctx)}`, pathScope(s, ctx)) : unknown(cmd); }
  else if (cmd === 'sudo') r = R('une commande lancée en administrateur (sudo)', 'outside', false);
  else if (READS.has(cmd)) r = reads(cmd, rest, ctx);
  else r = unknown(cmd || ws[0]);
  // the redirections: the file written or read
  const extra = [];
  for (const d of part.redirs) {
    if (!d.target || DEVICES.has(d.target)) continue;
    if (/^\d?>>?$/.test(d.op) || d.op === '>' || d.op === '>>') { extra.push(`${/>>/.test(d.op) ? 'ajoute à la fin de' : 'écrit dans'} ${show(d.target, ctx)}`); r = { ...r, scope: wider(r.scope, pathScope(d.target, ctx)) }; }
    else if (d.op === '<') { extra.push(`lit ${show(d.target, ctx)}`); r = { ...r, scope: wider(r.scope, pathScope(d.target, ctx)) }; }
  }
  if (extra.length) r = { ...r, text: [r.text, ...extra].filter(Boolean).join(', et ') };
  return r;
};

const explainShell = (command, ctx, depth = 0) => {
  const { parts, opaque } = splitShell(command);
  const rs = parts.map((p) => partOf(p, ctx, depth)).filter((r) => r.text);
  if (opaque) rs.push(R('une commande imbriquée $( … ) non lue', 'outside', false));
  if (!rs.length) return { text: '', scope: 'outside', known: false, hosts: [] };
  let text = rs[0].text;
  for (let i = 1; i < rs.length; i++) text += (parts[i - 1]?.sep === '|' ? ', envoyé à : ' : ', puis ') + rs[i].text;
  return { text, scope: rs.reduce((s, r) => wider(s, r.scope), 'local'), known: rs.every((r) => r.known), hosts: [...new Set(rs.flatMap((r) => r.hosts || []))], all: rs.every((r) => !r.known) };
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lineOf = (r) => {
  if (r.known) return cap(r.text) + '.';
  if (r.all || !r.text) return UNKNOWN_LINE;
  return cap(r.text) + " : lis-la avant d'autoriser.";
};

// ---------------------------------------------------------------- the explainer
export const explain = (tool, input = {}, opts = {}) => {
  const ctx = ctxOf(opts); input = input || {};
  const file = (p) => ({ scope: pathScope(p, ctx), name: show(p, ctx) });
  switch (tool) {
    case 'Bash': {
      const r = explainShell(String(input.command ?? ''), ctx);
      return { line: lineOf(r), scope: r.known || r.scope !== 'local' ? r.scope : 'outside', known: r.known };
    }
    case 'Write': { if (!input.file_path) break; const f = file(input.file_path); return { line: `Écrit le fichier ${f.name}${f.scope === 'outside' ? ', hors du projet' : ''}.`, scope: f.scope, known: true }; }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': { const p = input.file_path || input.notebook_path; if (!p) break; const f = file(p); return { line: `Modifie le fichier ${f.name}${f.scope === 'outside' ? ', hors du projet' : ''}.`, scope: f.scope, known: true }; }
    case 'Read': { if (!input.file_path) break; const f = file(input.file_path); return { line: `Lit le fichier ${f.name}.`, scope: f.scope, known: true }; }
    case 'Glob': case 'Grep': { const f = input.path ? file(input.path) : { scope: 'local', name: 'le projet' }; return { line: `Cherche ${quote(input.pattern || '', 40)} dans ${f.name}.`, scope: f.scope, known: true }; }
    case 'WebFetch': { const h = hostOfUrl(input.url); return { line: `Lit la page web ${h || 'à une adresse non lue'}.`, scope: 'network', known: !!h }; }
    case 'WebSearch': return { line: `Cherche sur le web : ${quote(input.query || '', 80)}.`, scope: 'network', known: true };
  }
  return { line: UNKNOWN_LINE, scope: 'outside', known: false };
};

// The hosts a request names; [] when it leaves the machine without a host we can read
export const hostsOf = (tool, input = {}, opts = {}) => {
  input = input || {};
  if (tool === 'WebFetch') { const h = hostOfUrl(input.url); return h ? [h] : []; }
  if (tool !== 'Bash') return [];
  const r = explainShell(String(input.command ?? ''), ctxOf(opts));
  const hs = [...r.hosts]; if (/(^|[\s;&|(])git\s+(push|pull|fetch|clone)\b/.test(String(input.command || '')) && !hs.length) hs.push('github.com');
  return hs;
};

// The command or the whole input, never cut: what the developer reads before allowing
export const commandOf = (tool, input = {}) => {
  input = input || {};
  if (tool === 'Bash') return String(input.command ?? '');
  if (tool === 'Write') return `${input.file_path ?? ''}\n\n${input.content ?? ''}`;
  if (tool === 'Edit') return `${input.file_path ?? ''}\n--- avant\n${input.old_string ?? ''}\n+++ après\n${input.new_string ?? ''}`;
  if (tool === 'WebFetch') return String(input.url ?? '') + (input.prompt ? `\n\n${input.prompt}` : '');
  if (tool === 'WebSearch') return String(input.query ?? '');
  return JSON.stringify(input, null, 2);
};

// ---------------------------------------------------------------- the queue
// rows: [{ plan, session, sessionName, project, cwd, pending: [...] }]; pilotOn: a boolean or project → boolean;
// now: ms; guard(entry, row) → true when the ask touches a guardrail (docs/autonomy.md). An ask opens the modal at once
// when needsDev gives it to the developer (no pilot, network, guardrail), else after PILOT_LATE_MS without an answer.
export const queue = (rows = [], { pilotOn = false, now = Date.now(), guard = () => false, kept = null } = {}) => {
  const out = [];
  for (const row of rows || []) for (const p of row.pending || []) {
    if (!p || p.kind !== 'permission') continue;
    const input = p.input || (p.tool === 'Bash' ? { command: p.text } : {}); // an old pending kept only its text
    const ex = explain(p.tool, input, { cwd: row.cwd });
    const isNet = !!p.network || ex.scope === 'network';
    const pilot = typeof pilotOn === 'function' ? !!pilotOn(row.project) : !!pilotOn;
    const dev = needsDev({ kind: 'permission', pilot, guard: !!guard(p, row) }) || isNet;
    const t = Date.parse(p.at); const age = Number.isFinite(t) ? now - t : Infinity;
    const why = dev ? 'dev' : age > PILOT_LATE_MS ? 'pilot-late' : null;
    if (!why) { if (kept) kept.push({ plan: row.plan, session: row.session, sessionName: row.sessionName || row.session, project: row.project || null, kind: 'permission', pendingId: p.id, at: p.at || null }); continue; }
    out.push({ plan: row.plan, session: row.session, sessionName: row.sessionName || row.session, project: row.project || null, pendingId: p.id, tool: p.tool || null,
      command: commandOf(p.tool, input), explain: ex, network: isNet ? hostsOf(p.tool, input, { cwd: row.cwd }) : null,
      suggest: p.suggest && typeof p.suggest === 'object' ? { allow: p.suggest.allow, reason: p.suggest.reason } : null, at: p.at || null, why });
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
};

// ---------------------------------------------------------------- the stops (6 Nov.)
// The replies a session waits for: its pending reply, or a turn ended (status 'waiting') with nothing pending. One per
// session, none for a session asking a permission (it is in queue). rows: as queue, plus status and human (a taste, data, security or release stop: lib/projectflow.mjs humanOf).
// To the developer (`why: 'dev'`) when needsDev says so: no pilot, or a human stop; else kept for the pilot.
const byAt = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
export const replies = (rows = [], { pilotOn = false, kept = null } = {}) => {
  const out = [];
  for (const row of rows || []) {
    const p = (row.pending || []).filter((x) => x && x.kind === 'reply').pop() || null;
    // a session asking a permission waits for that answer (queue), never counted twice
    if ((row.pending || []).some((x) => x && x.kind === 'permission')) continue;
    if (!p && row.status !== 'waiting') continue;
    const pilot = typeof pilotOn === 'function' ? !!pilotOn(row.project) : !!pilotOn;
    const it = { plan: row.plan, session: row.session, sessionName: row.sessionName || row.session, project: row.project || null, kind: 'reply', pendingId: p ? p.id : null, stop: p && Number.isInteger(p.stop) ? p.stop : null, human: !!row.human, at: (p && p.at) || row.at || null };
    if (needsDev({ kind: 'reply', pilot, human: !!row.human })) out.push({ ...it, why: 'dev' });
    else if (kept) kept.push(it);
  }
  return out.sort(byAt);
};

// GET /api/asks: the permissions (the modal), the stops (« À toi »), what the pilot keeps, and the developer's count
export const listOf = (rows = [], opts = {}) => {
  const kept = [];
  const asks = queue(rows, { ...opts, kept });
  const stops = replies(rows, { ...opts, kept });
  return { asks, replies: stops, kept: kept.sort(byAt), count: asks.length + stops.length };
};
