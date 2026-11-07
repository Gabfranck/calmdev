// PIL (Dev, 3 November 23:55): the engine allows alone a read-only Bash command that cannot expose the developer. A command
// made of segments joined by ; && || | passes only when every segment is a known read. Never: a secret or private path
// (~/.ssh, .env*, ~/.config/escadrille, secrets.json, keychains, browser cookies or history, Library, personal folders
// outside the project, other worktrees, TMPDIR), the network, a write, kill, rm, a redirection > to a file, $( ) or backticks.
// readOnlyOf(command, { root }) → { ok, why }; root: the session's folder (its own paths are free).
const READS = new Set(['grep', 'egrep', 'rg', 'cat', 'head', 'tail', 'ls', 'lsof', 'ps', 'wc', 'awk', 'cut', 'sort', 'uniq', 'tr', 'file', 'stat', 'du', 'df', 'pwd', 'which', 'echo', 'printf', 'date', 'diff', 'jq', 'basename', 'dirname', 'realpath', 'true', 'test', 'column', 'nl', 'tree', 'cd', 'export', 'sed', 'find', 'git', 'node']);
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'branch', 'rev-parse', 'blame', 'ls-files', 'shortlog', 'describe', 'merge-base', 'cat-file', 'reflog', 'grep', 'remote']);
const SECRET = /(\.ssh\b|\.aws\b|\.gnupg|\.env\b|\.env\.|\.netrc|\.npmrc|\.config\/(calmdev|escadrille|gh|gcloud)|secrets?\.json|keychain|\.keychain|Cookies|\bHistory\b|Login Data|Library\/|\.claude\/worktrees|\$TMPDIR|\$\{TMPDIR|\/private\/tmp|\/var\/folders|id_rsa|id_ed25519|\.pem\b|\.key\b)/i;
const deny = (why) => ({ ok: false, why });
export const readOnlyOf = (command, { root = '' } = {}) => {
  const c = String(command || '').trim(); if (!c) return deny('vide');
  if (/\$\(|`|<\(/.test(c)) return deny('sous-commande');
  if (SECRET.test(c)) return deny('chemin de secret ou privé');
  // the home: ~ anywhere outside quoted text (« ~; », « ~/x », « cat ~ »)
  if (/~/.test(c.replace(/'[^']*'|"[^"]*"/g, ''))) return deny('dossier personnel hors projet');
  // an absolute path with a glob (/Us* at the root, or a ? or * in a user's folder name): what it reaches is not readable here
  if (/(^|[\s='"])\/[^\s'";|&)]*[*?[]/.test(c)) return deny('glob dans un chemin absolu');
  for (const m of c.matchAll(/(?:^|[\s='"])(\/(?:Users|home|Volumes)\/[^\s'";|&)]*)/g)) if (!root || !(m[1] + '/').startsWith(root.replace(/\/?$/, '/'))) return deny('chemin hors du projet');
  // a relative path that climbs (../x, a/../../b, cd ..): refused whole, a session reads from its own folder down
  if (/(^|[\s/='"])\.\.(\/|[\s'";|&)]|$)/.test(c)) return deny('chemin relatif qui remonte');
  for (const m of c.matchAll(/(\d?)>>?\s*(&\d|\S+)/g)) if (!/^(&\d|\/dev\/null)$/.test(m[2])) return deny('redirection vers un fichier');
  for (const seg of c.split(/\|\||&&|;|\||\n/).map((s) => s.trim()).filter(Boolean)) {
    const words = seg.replace(/^(\w+=\S*\s+)+/, '').split(/\s+/); const cmd = words[0].split('/').pop();
    if (!READS.has(cmd)) return deny(`commande non reconnue : ${cmd}`);
    // a variable in a path ($HOME, ${HOME}, "$X"): only $PWD, and $PATH in a PATH= assignment; single-quoted text (awk '{print $1}') is not a path
    const vars = [...seg.replace(/'[^']*'/g, '').matchAll(/\$(\{?)([A-Za-z_]\w*)/g)].map((m) => m[2]);
    if (vars.some((v) => v !== 'PWD' && !(v === 'PATH' && /^(export\s+)?PATH=\S*$/.test(seg)))) return deny('variable dans un chemin');
    if (cmd === 'cd') { const to = words[1]; if (!to || to === '-' || (to.startsWith('/') && !(root && (to.replace(/\/?$/, '/')).startsWith(root.replace(/\/?$/, '/'))))) return deny('cd hors du projet'); }
    if ((cmd === 'sort' && /\s(-o\S*|--output\b)/.test(seg)) || (cmd === 'tree' && /\s-o\b/.test(seg)) || (cmd === 'git' && /\s--output\b/.test(seg))) return deny('écriture par option');
    if (cmd === 'git' && !GIT_READS.has(words.find((w, i) => i > 0 && !w.startsWith('-')) || '')) return deny('git hors lecture');
    if (cmd === 'git' && /\bremote\b/.test(seg) && !/remote\s+-v\b/.test(seg)) return deny('git remote hors lecture');
    if (cmd === 'git' && words[words.findIndex((w, i) => i > 0 && !w.startsWith('-'))] === 'branch') {
      const args = words.slice(words.indexOf('branch') + 1).filter((w) => !/^2?>/.test(w) && w !== '/dev/null');
      if (!args.every((a) => ['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--show-current'].includes(a))) return deny('git branch hors lecture');
    }
    if (cmd === 'node' && !/^node\s+(--check|-c|--version|-v)\b/.test(seg.replace(/^(\w+=\S*\s+)+/, ''))) return deny('node hors --check');
    if (cmd === 'sed' && (/\s-i/.test(seg) || !/\s-n\b/.test(seg))) return deny('sed hors -n');
    if (cmd === 'find' && /\s-(delete|exec|execdir|ok|okdir|fprint|fls)/.test(seg)) return deny('find qui agit');
    if (cmd === 'awk' && /system\s*\(|print\s*>|\|\s*"/.test(seg)) return deny('awk qui écrit');
  }
  return { ok: true, why: 'lecture seule' };
};
