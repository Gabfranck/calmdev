// Pre-review: reads a diff, the developer's rules and the guarded domains, and returns what the
// "Files changed" page puts first. Pure: no network, no claude. Only `run: true` spawns the
// project's declared checks, inside the worktree. Contract: docs/prereview.md.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

// ---------- globs ----------


// What the review shows of a reason: one line of ten words at most (Dev, 10:25, « une ligne par élément, détails au
// clic »); the whole reason stays in `reasons`.
export const tenWords = (s) => { const w = String(s ?? '').trim().split(/\s+/).filter(Boolean); return w.length > 10 ? w.slice(0, 10).join(' ') + '…' : w.join(' '); };

export const globToRegex = (glob) => {
  let g = String(glob).trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  const anyDepth = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${re}$`);
};
const splitGlobs = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
export const matchGlobs = (globs, p) => globs.find((g) => globToRegex(g).test(p)) ?? null;

// ---------- file kinds ----------

const base = (p) => p.split('/').pop();
const LOCKS = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'Cargo.lock',
  'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'Pipfile.lock', 'bun.lockb', 'uv.lock']);
export const isGenerated = (p) => LOCKS.has(base(p))
  || /(^|\/)(dist|build|vendor|node_modules|__snapshots__|coverage)\//.test(p)
  || /\.(min\.[a-z]+|map|snap)$/.test(p) || /\.generated\./.test(p);
export const isTest = (p) => /(^|\/)(test|tests|__tests__|spec)\//.test(p)
  || /\.(test|spec)\.[^/]+$/.test(p) || /(^|\/)test_[^/]+$/.test(p) || /_test\.[a-z]+$/.test(p);
const CODE = /\.(m?js|cjs|jsx|tsx?|py|go|rb|rs|java|kt|swift|php|cs|c|cc|cpp|h|vue|svelte|dart|ex|exs|scala)$/;
export const isCode = (p) => CODE.test(p) && !isTest(p) && !isGenerated(p);
// "src/user.service.ts" -> "user"; "test/user.test.mjs" -> "user"; "test_user.py" -> "user"
export const stem = (p) => base(p).replace(/^test_/, '').replace(/_test(?=\.)/, '').split('.')[0].toLowerCase();
const isMigration = (p) => /(^|\/)migrations?\//i.test(p) || /migrat/i.test(base(p))
  || /(^|\/)db\/.*\.sql$/i.test(p) || /schema\.prisma$/.test(p);
const isAuth = (p) => !/\.(md|txt)$/i.test(p)
  && /(auth|login|logout|session|token|crypto|permission|password|passwd|secret|security|jwt|oauth|acl|rbac|csrf)/i.test(p);
const CONFIG = new Set(['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile', 'pyproject.toml',
  'composer.json', 'Dockerfile', 'Makefile', 'Pipfile', '.env.example', 'app.json', 'eas.json', 'Podfile', 'build.gradle']);
const isConfig = (p) => CONFIG.has(base(p)) || /^docker-compose.*\.ya?ml$/.test(base(p)) || /^tsconfig.*\.json$/.test(base(p))
  || /\.config\.[a-z]+$/.test(base(p)) || /^\.github\//.test(p) || /(^|\/)\.[a-z]+rc(\.[a-z]+)?$/.test(p);

// ---------- diff ----------

const parseHunks = (lines) => {
  const hunks = [];
  let h = null, o = 0, n = 0;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      h = { header: line, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], lines: [] };
      hunks.push(h); o = h.oldStart; n = h.newStart; continue;
    }
    if (!h) continue;
    if (line.startsWith('+')) h.lines.push({ kind: 'add', old: null, new: n++, text: line.slice(1) });
    else if (line.startsWith('-')) h.lines.push({ kind: 'del', old: o++, new: null, text: line.slice(1) });
    else if (line.startsWith(' ') || line === '') h.lines.push({ kind: 'ctx', old: o++, new: n++, text: line.slice(1) });
    else if (line.startsWith('\\') && h.lines.length) h.lines[h.lines.length - 1].noEol = true;
  }
  return hunks;
};

// `git diff base...head` output -> the files shape of docs/review.md
export const parseDiff = (text) => {
  const files = [];
  const chunks = String(text ?? '').split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.replace(/\n$/, '').split('\n');
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0]) || [];
    let oldPath = m[1] ?? null, newPath = m[2] ?? null, status = 'modified', binary = false;
    for (const l of lines.slice(1)) {
      if (l.startsWith('@@')) break;
      if (l.startsWith('new file mode')) status = 'added';
      else if (l.startsWith('deleted file mode')) status = 'deleted';
      else if (l.startsWith('rename from ')) { oldPath = l.slice(12); status = 'renamed'; }
      else if (l.startsWith('rename to ')) newPath = l.slice(10);
      else if (l.startsWith('Binary files')) binary = true;
      else if (l.startsWith('--- a/')) oldPath = l.slice(6);
      else if (l.startsWith('+++ b/')) newPath = l.slice(6);
    }
    const at = lines.findIndex((l) => l.startsWith('@@'));
    const hunks = at < 0 ? [] : parseHunks(lines.slice(at));
    const all = hunks.flatMap((h) => h.lines);
    files.push({
      path: status === 'deleted' ? oldPath : newPath,
      oldPath: status === 'renamed' ? oldPath : null,
      status, binary,
      additions: all.filter((l) => l.kind === 'add').length,
      deletions: all.filter((l) => l.kind === 'del').length,
      generated: isGenerated(status === 'deleted' ? oldPath : newPath),
      hunks,
    });
  }
  return files;
};

// accepts R's shape (hunks) or a raw unified `patch`
const normalize = (f) => {
  const hunks = f.hunks ?? (f.patch ? parseHunks(String(f.patch).split('\n')) : []);
  const all = hunks.flatMap((h) => h.lines);
  return {
    ...f,
    status: f.status ?? 'modified',
    hunks,
    additions: f.additions ?? all.filter((l) => l.kind === 'add').length,
    deletions: f.deletions ?? all.filter((l) => l.kind === 'del').length,
  };
};
const added = (f) => f.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add');

// ---------- rules ----------

const KINDS = new Set(['deny', 'immutable', 'requires-test', 'deps']);

// Markdown -> { rules: [{ text, kind, args, error? }], checks: [command] }
export const parseRules = (md) => {
  const rules = [], checks = [];
  const text = String(md ?? '');
  const hasRulesHeading = /^#+\s*r[èe]gles\b/im.test(text);
  let section = hasRulesHeading ? null : 'rules';
  let last = null;
  for (const line of text.split('\n')) {
    const h = /^#+\s*(.+?)\s*$/.exec(line);
    if (h) {
      const t = h[1].toLowerCase();
      section = /^r[èe]gles\b/.test(t) ? 'rules' : /^v[ée]rifications?\b/.test(t) ? 'checks' : (hasRulesHeading ? null : 'other');
      last = null; continue;
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b && section === 'rules') { last = { raw: b[1].trim() }; rules.push(last); continue; }
    if (b && section === 'checks') {
      const code = /`([^`]+)`/.exec(b[1]);
      const cmd = (code ? code[1] : b[1]).trim();
      if (cmd) checks.push(cmd);
      last = null; continue;
    }
    if (last && /^\s+\S/.test(line)) last.raw += ' ' + line.trim();
    else if (!line.trim()) last = null;
  }
  return {
    rules: rules.map(({ raw }) => {
      const m = /\{\s*([a-z-]+)\s*:\s*(.+?)\s*\}\s*\.?$/.exec(raw);
      if (!m) return { text: raw, kind: null, args: null };
      const t = raw.slice(0, m.index).trim();
      if (!KINDS.has(m[1])) return { text: t, kind: null, args: m[2], error: `motif inconnu « ${m[1]} »` };
      if (m[1] === 'deny') {
        const at = m[2].lastIndexOf(' in ');
        const src = at >= 0 ? m[2].slice(0, at).trim() : m[2];
        const globs = at >= 0 ? splitGlobs(m[2].slice(at + 4)) : [];
        try { return { text: t, kind: 'deny', args: { regex: new RegExp(src), source: src, globs } }; }
        catch (e) { return { text: t, kind: null, args: m[2], error: `regex illisible : ${e.message}` }; }
      }
      return { text: t, kind: m[1], args: { globs: splitGlobs(m[2]) } };
    }),
    checks,
  };
};

// <project>/docs/regles.md, else the "Règles" section of its CLAUDE.md
export const loadRules = (project) => {
  if (!project) return { source: null, text: '' };
  const regles = path.join(project, 'docs', 'regles.md');
  if (existsSync(regles)) return { source: regles, text: readFileSync(regles, 'utf8') };
  const claude = path.join(project, 'CLAUDE.md');
  if (existsSync(claude)) {
    const md = readFileSync(claude, 'utf8');
    const m = /^(#+)\s*r[èe]gles\b.*$/im.exec(md);
    if (m) {
      const rest = md.slice(m.index);
      const next = rest.slice(m[0].length).search(new RegExp(`^#{1,${m[1].length}}\\s`, 'm'));
      return { source: claude, text: next < 0 ? rest : rest.slice(0, m[0].length + next) };
    }
  }
  return { source: null, text: '' };
};

const DECISIONS = /(^|\/)decisions\.md$/;
const DEP_FILES = /^(requirements.*\.txt|go\.mod|Cargo\.toml|Gemfile|pyproject\.toml|Pipfile|Podfile|build\.gradle)$/;
const VERSIONISH = /^([\^~<>=*\d]|workspace:|npm:|file:|git|github:|link:|latest|next)/;

// added dependency lines of a dependency file: [{ name, line }]
export const addedDeps = (f) => {
  const name = base(f.path);
  const out = [];
  if (name === 'package.json' || name === 'composer.json') {
    for (const h of f.hunks) {
      const removed = new Set(h.lines.filter((l) => l.kind === 'del').map((l) => (/"([^"]+)"\s*:/.exec(l.text) || [])[1]));
      let section = /dependencies/i.test(h.header ?? '') ? 'deps' : null;
      for (const l of h.lines) {
        if (/"[\w-]*(dependencies|require(-dev)?)"\s*:\s*\{/i.test(l.text)) { section = 'deps'; continue; }
        if (/"[^"]+"\s*:\s*\{/.test(l.text)) { section = 'other'; continue; }
        if (/^\s*\}/.test(l.text)) { section = section === 'deps' ? 'other' : section; continue; }
        if (l.kind !== 'add') continue;
        const m = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(l.text);
        if (!m || removed.has(m[1])) continue;
        if (section === 'deps' || (section === null && m[1] !== 'version' && VERSIONISH.test(m[2]))) out.push({ name: m[1], line: l.new });
      }
    }
  } else if (DEP_FILES.test(name)) {
    const dels = new Set(f.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del').map((l) => l.text.trim().split(/[\s=<>~^!@[;]/)[0]));
    for (const l of added(f)) {
      const t = l.text.trim();
      if (!t || /^(#|\/\/|\[|module |go |\)|\(|end$|source |require \($)/.test(t)) continue;
      const n = t.replace(/^(require|gem|pod|implementation)\s+/, '').replace(/['"]/g, '').split(/[\s=<>~^!@,;[]/)[0];
      if (n && !dels.has(n)) out.push({ name: n, line: l.new });
    }
  }
  return out;
};

const hasTestFor = (p, paths) => {
  const s = stem(p);
  return paths.some((q) => q !== p && isTest(q) && stem(q) === s);
};

// -> [{ rule, path, line, text, level }]
export const checkRules = (parsed, files, { repoFiles = [] } = {}) => {
  const out = [];
  const diffPaths = files.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const known = [...diffPaths, ...repoFiles];
  for (const r of parsed.rules) {
    if (r.error) { out.push({ rule: r.text, path: null, line: null, text: `motif illisible : ${r.error}`, level: 'warn' }); continue; }
    if (!r.kind) { out.push({ rule: r.text, path: null, line: null, text: 'à vérifier par la revue', level: 'warn' }); continue; }
    const { globs } = r.args;
    const inScope = (f) => !globs.length || matchGlobs(globs, f.path) || (f.oldPath && matchGlobs(globs, f.oldPath));
    for (const f of files) {
      if (!inScope(f)) continue;
      if (r.kind === 'deny' && f.status !== 'deleted') {
        for (const l of added(f)) if (r.args.regex.test(l.text)) out.push({ rule: r.text, path: f.path, line: l.new, text: l.text.trim().slice(0, 200), level: 'error' });
      } else if (r.kind === 'immutable' && f.status !== 'added') {
        const what = { modified: 'fichier existant modifié', deleted: 'fichier existant supprimé', renamed: `renommé depuis ${f.oldPath}` }[f.status] ?? 'fichier existant modifié';
        out.push({ rule: r.text, path: f.path, line: null, text: what, level: 'error' });
      } else if (r.kind === 'requires-test' && f.status === 'added' && !isTest(f.path) && !hasTestFor(f.path, known)) {
        out.push({ rule: r.text, path: f.path, line: null, text: `aucun test pour « ${stem(f.path)} »`, level: 'error' });
      } else if (r.kind === 'deps') {
        const deps = addedDeps(f);
        const noted = files.some((g) => DECISIONS.test(g.path) && g.additions > 0);
        if (!noted) for (const d of deps) out.push({ rule: r.text, path: f.path, line: d.line, text: `nouvelle dépendance « ${d.name} » sans ligne dans decisions.md`, level: 'error' });
      }
    }
  }
  return out;
};

// ---------- risk ----------

// a test in the same domain: under the file's grandparent folder when it is at least two levels deep
// (server/domains/questions/controllers/x.ts <- server/domains/questions/__tests__/y.test.ts), else its folder
const testNearby = (p, tests) => {
  const dir = path.posix.dirname(p), up = path.posix.dirname(dir);
  const scope = up.split('/').filter((s) => s && s !== '.').length >= 2 ? up : dir;
  return scope !== '.' && tests.some((t) => t.startsWith(scope + '/'));
};

export const assessRisk = (files, { guarded = [], others = [], violations = [] } = {}) => {
  const testPaths = files.filter((f) => f.status !== 'deleted' && isTest(f.path)).map((f) => f.path);
  return files.map((f) => {
    const reasons = []; let score = 0;
    const add = (pts, why) => { score += pts; reasons.push(why); };
    if (f.generated ?? isGenerated(f.path)) return { path: f.path, risk: 'low', reasons: ['généré'], generated: true, score: 0, size: f.additions + f.deletions };
    const errs = violations.filter((v) => v.level === 'error' && v.path === f.path);
    if (errs.length) add(3, `règle enfreinte : ${errs[0].rule}`);
    const g = matchGlobs(guarded, f.path) || (f.oldPath && matchGlobs(guarded, f.oldPath));
    if (g) add(3, `domaine sous garde (${g})`);
    if (isMigration(f.path)) add(3, 'migration');
    if (isAuth(f.path)) add(2, 'auth ou sécurité');
    if (isConfig(f.path)) add(2, 'config ou dépendances');
    if (f.status === 'deleted') add(2, `fichier supprimé (${f.deletions} lignes)`);
    else if (f.deletions >= 100 || (f.deletions >= 50 && f.deletions > f.additions)) add(2, `${f.deletions} lignes supprimées`);
    const by = others.filter((o) => (o.files ?? []).includes(f.path)).map((o) => o.session);
    if (by.length) add(2, `aussi modifié par la session ${by.join(', ')}`);
    if (f.status !== 'deleted' && isCode(f.path) && !hasTestFor(f.path, testPaths) && !testNearby(f.path, testPaths)) add(1, 'code touché sans test à côté');
    const risk = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
    return { path: f.path, risk, reasons, score, size: f.additions + f.deletions };
  });
};

// ---------- checks ----------

const TAIL = 4000;
export const runCheck = (cmd, cwd, timeoutMs = 120000) => new Promise((resolve) => {
  let out = '', err = '', timedOut = false;
  const p = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, CI: '1' }, detached: true });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); } }, timeoutMs);
  p.stdout.on('data', (d) => { out = (out + d).slice(-TAIL * 2); });
  p.stderr.on('data', (d) => { err = (err + d).slice(-TAIL * 2); });
  const done = (code) => {
    clearTimeout(timer);
    let output = (out + (err ? `\n${err}` : '')).trim();
    if (timedOut) output += `\n(délai de ${Math.round(timeoutMs / 1000)} s dépassé)`;
    resolve({ name: cmd, ok: !timedOut && code === 0, output: output.length > TAIL ? '…' + output.slice(-TAIL) : output });
  };
  p.on('error', (e) => { err += String(e.message); done(1); });
  p.on('close', done);
});

// ---------- the call ----------

const RANK = { high: 0, medium: 1, low: 2 };

const loadGuarded = async (project) => {
  try {
    const m = await import('./autonomy.mjs');
    if (typeof m.guardedPaths === 'function') return (await m.guardedPaths(project)) ?? [];
  } catch {}
  return [];
};

export const prereview = async ({ repo, base: baseRef = null, head = null, files = [], rules, guarded, project, others = [],
  repoFiles = [], run = false, timeoutMs = 120000, claude = false } = {}) => {
  const root = project || repo;
  const list = files.map(normalize);
  const parsed = rules == null ? parseRules(loadRules(root).text)
    : typeof rules === 'string' ? parseRules(rules) : rules;
  const guards = guarded ?? await loadGuarded(root);
  const violations = checkRules(parsed, list, { repoFiles });
  const assessed = assessRisk(list, { guarded: guards, others, violations })
    .sort((a, b) => RANK[a.risk] - RANK[b.risk] || b.score - a.score || isTest(a.path) - isTest(b.path) || b.size - a.size || a.path.localeCompare(b.path));
  const readFirst = assessed.filter((f) => !f.generated && f.risk !== 'low').slice(0, 5).map((f) => ({ path: f.path, why: tenWords(f.reasons[0]) }));
  const first = new Set(readFirst.map((f) => f.path));
  const outFiles = assessed.map(({ score, size, ...f }) => ({
    ...f, flag: first.has(f.path) || f.risk === 'high', why: f.reasons[0] != null ? tenWords(f.reasons[0]) : null,
  }));

  const adds = list.reduce((s, f) => s + f.additions, 0), dels = list.reduce((s, f) => s + f.deletions, 0);
  const errors = violations.filter((v) => v.level === 'error').length;
  const toReview = violations.filter((v) => v.level === 'warn').length;
  const high = outFiles.filter((f) => f.risk === 'high');
  const gen = outFiles.filter((f) => f.generated).length;
  // One line of ten words at most (Dev, 10:25): the volume, the rules, the risk; the paths are in readFirst
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const summary = [
    `${plural(list.length, 'fichier')} +${adds} −${dels}`,
    errors ? `${plural(errors, 'règle')} enfreinte${errors > 1 ? 's' : ''}` : toReview ? `${toReview} à vérifier` : 'règles tenues',
    high.length ? `${high.length} à risque` : null,
  ].filter(Boolean).join(' · ');

  const checks = [];
  if (run && repo) for (const cmd of parsed.checks) checks.push(await runCheck(cmd, repo, timeoutMs));

  const result = { repo: repo ?? null, base: baseRef, head, summary, readFirst, files: outFiles, rules: violations, checks };
  // Entry point for a later short read-only claude session over the rules without a pattern
  // (project setting `prereviewModel`). Nothing is launched today.
  if (claude) result.claude = { skipped: true, rules: parsed.rules.filter((r) => !r.kind).map((r) => r.text) };
  return result;
};
