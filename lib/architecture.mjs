// The architecture map of a repository, read from git at any commit without a checkout (docs/architecture.md).
// mapOf(repo, ref) → modules, edges, routes, tables, deps; deltaOf / architectureDelta → what a branch changes.
// Regexes, not parsers: the map says what it sees. No dependency.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

export const MAX_FILES = 10000;
export const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_SIZE = 32;

const CODE = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'py', 'prisma', 'sql', 'html', 'css', 'scss', 'json', 'yml', 'yaml', 'toml', 'sh', 'go', 'rb', 'php', 'java', 'kt', 'swift', 'rs']);
const JS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte']);
const CONFIG_EXT = new Set(['json', 'yml', 'yaml', 'toml']);
const IGNORED_DIR = /(^|\/)(node_modules|dist|build|\.next|coverage|vendor|\.git|\.expo|__pycache__|\.venv|venv|\.turbo|\.cache|out)\//;
const IGNORED_FILE = /(\.min\.[a-z]+$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock)$)/;
const MONO = new Set(['apps', 'packages', 'services']);

const extOf = (p) => { const b = path.posix.basename(p); if (/^Dockerfile/.test(b)) return 'dockerfile'; const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
const wanted = (p) => !IGNORED_DIR.test(p) && !IGNORED_FILE.test(p) && (CODE.has(extOf(p)) || extOf(p) === 'dockerfile');

// ---------------------------------------------------------------- git
const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split('\n')[0])) : resolve(String(out)))));

const resolveSha = async (repo, ref) => {
  try { return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim(); } catch { throw new Error(`ref inconnue : ${ref}`); }
};
// The subfolder of the repository the project is (a project may live inside a bigger repo)
const prefixOf = async (repo) => { try { return (await git(repo, ['rev-parse', '--show-prefix'])).trim(); } catch { throw new Error(`pas un dépôt git : ${repo}`); } };

// Every blob's content in one `git cat-file --batch` process: "<oid> blob <size>\n<bytes>\n"
const readBlobs = (repo, oids) => new Promise((resolve, reject) => {
  if (!oids.length) return resolve([]);
  const p = spawn('git', ['cat-file', '--batch'], { cwd: repo });
  const chunks = []; let err = '';
  p.stdout.on('data', (c) => chunks.push(c));
  p.stderr.on('data', (c) => { err += c; });
  p.on('error', reject);
  p.on('close', (code) => {
    if (code) return reject(new Error('git cat-file : ' + err.trim()));
    const buf = Buffer.concat(chunks); const out = []; let at = 0;
    for (let i = 0; i < oids.length && at < buf.length; i++) {
      const nl = buf.indexOf(10, at); const head = buf.toString('utf8', at, nl).split(' ');
      if (head[1] === 'missing') { out.push(''); at = nl + 1; continue; }
      const size = Number(head[2]); out.push(buf.toString('utf8', nl + 1, nl + 1 + size)); at = nl + 1 + size + 1;
    }
    resolve(out);
  });
  p.stdin.end(oids.join('\n') + '\n');
});

// ---------------------------------------------------------------- modules and roles
const dirsOf = (file) => path.posix.dirname(file).split('/').filter((s) => s && s !== '.');
export const moduleOf = (file, depth = null) => {
  const dirs = dirsOf(file);
  if (!dirs.length) return '.';
  const keep = depth ?? (MONO.has(dirs[0]) && dirs.length > 1 ? 4 : 2);
  return dirs.slice(0, keep).join('/');
};
// A module too big to read (over 40 files and a fifth of the repository) splits one level deeper, down to 5 levels
export const moduleIds = (paths) => {
  const depth = new Map(paths.map((f) => { const d = dirsOf(f); return [f, MONO.has(d[0]) && d.length > 1 ? 4 : 2]; }));
  const limit = Math.max(40, paths.length / 5);
  for (let round = 0; round < 3; round++) {
    const by = new Map(); for (const f of paths) { const id = moduleOf(f, depth.get(f)); if (!by.has(id)) by.set(id, []); by.get(id).push(f); }
    let split = false;
    for (const fs of by.values()) if (fs.length > limit && fs.some((f) => dirsOf(f).length > depth.get(f))) { for (const f of fs) if (depth.get(f) < 5) depth.set(f, depth.get(f) + 1); split = true; }
    if (!split) break;
  }
  return new Map(paths.map((f) => [f, moduleOf(f, depth.get(f))]));
};
const SEG = {
  tests: new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__']),
  migrations: new Set(['migrations', 'migration', 'migrate', 'prisma', 'seeders', 'seeds', 'db']),
  routes: new Set(['routes', 'route', 'api', 'controllers', 'controller', 'handlers', 'endpoints']),
  pages: new Set(['pages', 'app', 'public', 'views', 'components', 'screens', 'layouts', 'templates']),
  scripts: new Set(['scripts', 'bin', 'tools']),
  config: new Set(['config', '.github', '.circleci', '.husky', '.vscode']),
};
const isTestFile = (f) => /\.(test|spec)\.[a-z]+$/.test(f) || /(^|\/)test_[^/]+\.py$/.test(f);
const isConfigFile = (f) => CONFIG_EXT.has(extOf(f)) || extOf(f) === 'dockerfile' || /(\.config\.[a-z]+|rc\.[a-z]+)$/.test(f);
const roleOf = (id, files, hasRoutes) => {
  const segs = id === '.' ? [] : id.split('/');
  const has = (k) => segs.some((s) => SEG[k].has(s));
  if (has('tests') || files.filter(isTestFile).length > files.length / 2) return 'tests';
  if (has('migrations')) return 'migrations';
  if (has('routes') || hasRoutes) return 'routes';
  if (has('pages')) return 'pages';
  if (has('scripts')) return 'scripts';
  if (has('config') || files.every(isConfigFile)) return 'config';
  return 'lib';
};
export const ROLES = ['pages', 'routes', 'lib', 'migrations', 'scripts', 'config', 'tests'];

// ---------------------------------------------------------------- imports
const IMPORT_RES = [
  /(?:^|[\s;])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const TRY_EXT = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.vue', '.svelte', '.json', '/index.js', '/index.mjs', '/index.ts', '/index.tsx', '/index.jsx'];
const tryFile = (base, has) => {
  for (const e of TRY_EXT) if (has.has(base + e)) return base + e;
  const noJs = base.replace(/\.(m|c)?js$/, ''); // TypeScript: './x.js' is x.ts
  if (noJs !== base) for (const e of ['.ts', '.tsx', '.mts']) if (has.has(noJs + e)) return noJs + e;
  return null;
};
const resolveJs = (from, spec, has, aliases = []) => {
  if (spec.startsWith('.')) return tryFile(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)), has);
  for (const a of aliases) {
    if (!spec.startsWith(a.prefix) || (a.dir && !from.startsWith(a.dir))) continue;
    for (const t of a.targets) { const r = tryFile(path.posix.normalize(path.posix.join(t || '.', spec.slice(a.prefix.length))).replace(/^\.\//, ''), has); if (r) return r; }
  }
  return null;
};
const resolvePy = (from, spec, has) => {
  const dots = /^\.*/.exec(spec)[0].length; const rest = spec.slice(dots).split('.').filter(Boolean);
  const roots = dots ? [path.posix.join(path.posix.dirname(from), ...Array(Math.max(0, dots - 1)).fill('..'))] : ['', path.posix.dirname(from)];
  for (const r of roots) {
    const b = path.posix.join(r || '.', ...rest).replace(/^\.\//, '');
    for (const c of [b + '.py', b + '/__init__.py']) if (has.has(c)) return c;
  }
  return null;
};
// JSON with comments and trailing commas (tsconfig), read by a scanner that knows when it is inside a string
const stripJsonc = (t) => {
  let out = ''; let str = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (str) { out += c; if (c === '\\') { out += t[++i] ?? ''; } else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; out += c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && t[i + 1] === '*') { i = t.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
};
// The path aliases of a tsconfig.json or jsconfig.json ("@/*": ["./src/*"]), relative to the repository
export const aliasesOf = (file, text) => {
  let j; try { j = JSON.parse(stripJsonc(text)); } catch { return []; }
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  const baseUrl = path.posix.join(dir || '.', j.compilerOptions?.baseUrl || '.');
  return Object.entries(j.compilerOptions?.paths || {}).filter(([k]) => k.endsWith('/*') || !k.includes('*')).map(([k, ts]) => ({
    prefix: k.replace(/\*$/, ''), dir: dir ? dir + '/' : '',
    targets: [].concat(ts).map((t) => path.posix.normalize(path.posix.join(baseUrl, String(t).replace(/\*$/, ''))).replace(/^\.\/?/, '').replace(/\/$/, '')),
  })).sort((a, b) => b.prefix.length - a.prefix.length);
};
export const importsOf = (file, text, has, aliases = []) => {
  const ext = extOf(file); const out = [];
  if (JS.has(ext)) {
    for (const re of IMPORT_RES) for (const m of text.matchAll(re)) if (m[1].startsWith('.') || aliases.length) { const t = resolveJs(file, m[1], has, aliases); if (t) out.push(t); }
  } else if (ext === 'py') {
    for (const m of text.matchAll(/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s/gm)) { const t = resolvePy(file, m[1], has); if (t && t !== file) out.push(t); }
  }
  return out;
};

// ---------------------------------------------------------------- routes
const HTTP = 'get|post|put|patch|delete|all|head|options';
const routePath = (segs) => '/' + segs.filter((s) => !/^\(.*\)$/.test(s) && !/^@/.test(s)).map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1')).filter((s) => s !== 'index').join('/');
export const routesOf = (file, text, ctx = {}) => {
  const out = []; const ext = extOf(file);
  if (JS.has(ext) || ext === 'py') {
    for (const m of text.matchAll(new RegExp(`\\b(app|router|\\w+Router|server|fastify)\\.(${HTTP})\\(\\s*['"\`](\\/[^'"\`]*)['"\`]`, 'g'))) out.push({ method: m[2].toUpperCase(), path: m[3], kind: m[1] === 'fastify' ? 'fastify' : 'express' });
    for (const m of text.matchAll(/\.route\(\s*\{[^}]*?method:\s*['"](\w+)['"][^}]*?url:\s*['"]([^'"]+)['"]/g)) out.push({ method: m[1].toUpperCase(), path: m[2], kind: 'fastify' });
    if (/createServer|node:http|req\.method/.test(text)) {
      for (const line of text.split('\n')) {
        const method = /req\.method\s*===\s*['"](\w+)['"]/.exec(line)?.[1] || '*';
        for (const m of line.matchAll(/pathname\s*===\s*['"](\/[^'"]*)['"]/g)) out.push({ method, path: m[1], kind: 'node' });
        for (const m of line.matchAll(/pathname\.startsWith\(\s*['"](\/[^'"]*)['"]/g)) out.push({ method, path: m[1].replace(/\/?$/, '/*'), kind: 'node' });
      }
    }
  }
  if (/\.(jsx?|tsx?)$/.test(file)) {
    const segs = file.split('/'); const name = path.posix.basename(file).replace(/\.[^.]+$/, '');
    const pi = segs.lastIndexOf('pages'); const ai = segs.lastIndexOf('app');
    if (ctx.next && pi >= 0 && !name.startsWith('_')) {
      const rest = segs.slice(pi + 1); rest[rest.length - 1] = name;
      out.push({ method: rest[0] === 'api' ? '*' : 'GET', path: routePath(rest), kind: 'next' });
    } else if (ctx.next && ai >= 0 && (name === 'page' || name === 'route')) {
      const p = routePath(segs.slice(ai + 1, -1));
      if (name === 'page') out.push({ method: 'GET', path: p, kind: 'next' });
      else { const ms = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]); for (const method of ms.length ? ms : ['*']) out.push({ method, path: p, kind: 'next' }); }
    } else if (ctx.expo && ai >= 0 && !name.startsWith('_') && !name.startsWith('+')) {
      const rest = segs.slice(ai + 1); rest[rest.length - 1] = name;
      out.push({ method: 'GET', path: routePath(rest), kind: 'expo' });
    }
  }
  return out;
};

// ---------------------------------------------------------------- tables
export const tablesOf = (file, text) => {
  const out = []; const ext = extOf(file);
  if (ext === 'prisma') { for (const m of text.matchAll(/^model\s+(\w+)\s*\{/gm)) out.push({ name: m[1], kind: 'prisma' }); return out; }
  if (!(JS.has(ext) || ext === 'py' || ext === 'sql')) return out;
  for (const m of text.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[`"'[]?([A-Za-z_][\w.]*)/gi)) out.push({ name: m[1], kind: 'sql' });
  if (!JS.has(ext)) return out;
  for (const m of text.matchAll(/\.define(?:<[^>()]*>)?\(\s*['"](\w+)['"]/g)) out.push({ name: m[1], kind: 'sequelize' });
  for (const m of text.matchAll(/\bcreateTable\(\s*['"](\w+)['"]/g)) out.push({ name: m[1], kind: 'sequelize' });
  if (/\.init\(/.test(text)) for (const m of text.matchAll(/modelName:\s*['"](\w+)['"]/g)) out.push({ name: m[1], kind: 'sequelize' });
  for (const m of text.matchAll(/@Entity\([^)]*\)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g)) out.push({ name: m[1], kind: 'typeorm' });
  return out;
};

// ---------------------------------------------------------------- deps
const depsOf = (file, text) => {
  const b = path.posix.basename(file);
  if (b === 'package.json') {
    let j; try { j = JSON.parse(text); } catch { return []; }
    return [...Object.entries(j.dependencies || {}).map(([name, version]) => ({ name, version: String(version), dev: false, file })), ...Object.entries(j.devDependencies || {}).map(([name, version]) => ({ name, version: String(version), dev: true, file }))];
  }
  if (b === 'requirements.txt') return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => /^[A-Za-z0-9]/.test(l)).map((l) => { const m = /^([A-Za-z0-9_.\-[\]]+)\s*(.*)$/.exec(l); return { name: m[1], version: m[2] || '', dev: false, file }; });
  return [];
};

// ---------------------------------------------------------------- the map
const cache = new Map();
const remember = (key, val) => { cache.set(key, val); if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value); return val; };
const uniq = (list, key) => { const seen = new Set(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

export const mapOf = async (repoDir, ref = 'HEAD') => {
  const repo = path.resolve(repoDir);
  const prefix = await prefixOf(repo);
  const sha = await resolveSha(repo, ref);
  const key = `${repo}\0${sha}`;
  if (cache.has(key)) return cache.get(key);
  const raw = await git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha]);
  let entries = raw.split('\0').filter(Boolean).map((l) => { const tab = l.indexOf('\t'); const [, type, oid, size] = l.slice(0, tab).split(/\s+/); return { type, oid, size: Number(size), path: l.slice(tab + 1) }; })
    .filter((e) => e.type === 'blob' && (!prefix || e.path.startsWith(prefix))).map((e) => ({ ...e, path: prefix ? e.path.slice(prefix.length) : e.path }))
    .filter((e) => wanted(e.path));
  const truncated = entries.length > MAX_FILES; if (truncated) entries = entries.slice(0, MAX_FILES);
  const big = entries.filter((e) => e.size > MAX_BYTES); const read = entries.filter((e) => e.size <= MAX_BYTES);
  const texts = await readBlobs(repo, read.map((e) => e.oid));
  const files = read.map((e, i) => ({ path: e.path, text: texts[i] || '' }));
  const has = new Set(files.map((f) => f.path));
  const ids = moduleIds(files.map((f) => f.path)); const idOf = (p) => ids.get(p) ?? moduleOf(p);
  const aliases = files.filter((f) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(f.path)).flatMap((f) => aliasesOf(f.path, f.text)).sort((a, b) => b.dir.length - a.dir.length || b.prefix.length - a.prefix.length);
  const deps = files.flatMap((f) => depsOf(f.path, f.text));
  const ctx = { next: deps.some((d) => d.name === 'next'), expo: deps.some((d) => d.name === 'expo-router') };
  const mods = new Map(); const edgeCount = new Map(); const routes = []; const tables = [];
  for (const f of files) {
    const id = idOf(f.path);
    if (!mods.has(id)) mods.set(id, { id, files: [], lines: 0, exts: {}, routes: 0 });
    const m = mods.get(id); m.files.push(f.path); m.lines += f.text ? f.text.split('\n').length : 0; const x = extOf(f.path); m.exts[x] = (m.exts[x] || 0) + 1;
    for (const t of importsOf(f.path, f.text, has, aliases)) { const to = idOf(t); if (to === id) continue; const k = `${id}\0${to}`; edgeCount.set(k, (edgeCount.get(k) || 0) + 1); }
    const rs = isTestFile(f.path) ? [] : routesOf(f.path, f.text, ctx); m.routes += rs.length; for (const r of rs) routes.push({ ...r, file: f.path, module: id });
    for (const t of isTestFile(f.path) ? [] : tablesOf(f.path, f.text)) tables.push({ ...t, file: f.path, module: id });
  }
  const modules = [...mods.values()].map((m) => ({
    id: m.id, files: m.files.sort(), lines: m.lines,
    lang: Object.entries(m.exts).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    role: roleOf(m.id, m.files, m.routes > 0),
    entry: m.files.find((f) => /^(index|main|server|app)\.[a-z]+$/.test(path.posix.basename(f))) || null,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeCount.entries()].map(([k, count]) => { const [from, to] = k.split('\0'); return { from, to, count }; }).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const out = {
    repo, ref, sha, files: files.length, skipped: big.length, truncated, modules, edges,
    routes: uniq(routes, (r) => `${r.module}\0${r.method} ${r.path}`),
    tables: uniq(tables, (t) => `${t.module}\0${t.name}`),
    deps: uniq(deps, (d) => `${d.file}\0${d.name}`),
  };
  Object.defineProperty(out, 'moduleOfFile', { value: idOf, enumerable: false });
  return remember(key, out);
};

// ---------------------------------------------------------------- the delta
const plural = (n, one, many = one + 's') => `${n} ${n > 1 ? many : one}`;
const list = (xs, n = 3) => (xs.length > n ? xs.slice(0, n).join(', ') + ` et ${xs.length - n} autre${xs.length - n > 1 ? 's' : ''}` : xs.join(', '));
const numstat = async (repo, base, head) => {
  const out = await git(repo, ['diff', '--numstat', '--no-renames', '--relative', `${base}...${head}`]);
  return out.split('\n').filter(Boolean).map((l) => { const [a, d, ...p] = l.split('\t'); return { path: p.join('\t'), additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d) }; });
};
const summaryOf = (added, removed, changed) => {
  const parts = [];
  if (added.routes.length) parts.push(plural(added.routes.length, 'route'));
  if (added.tables.length) parts.push(plural(added.tables.length, 'table'));
  if (added.modules.length) parts.push(plural(added.modules.length, 'module'));
  const lead = parts.length ? `Ce plan ajoute ${parts.join(', ')}, touche ${plural(changed.length, 'module')}.` : changed.length ? `Ce plan touche ${plural(changed.length, 'module')}, sans rien ajouter.` : 'Ce plan ne change rien au code.';
  const news = [...added.modules.map((m) => `module ${m}`), ...added.routes.map((r) => `route ${r.method} ${r.path}`), ...added.tables.map((t) => `table ${t.name}`)];
  const gone = [...removed.modules.map((m) => `module ${m}`), ...removed.routes.map((r) => `route ${r.method} ${r.path}`), ...removed.tables.map((t) => `table ${t.name}`)];
  const deps = added.deps.length ? ` Nouvelle${added.deps.length > 1 ? 's' : ''} dépendance${added.deps.length > 1 ? 's' : ''} : ${list(added.deps.map((d) => d.name))}.` : '';
  return [lead, news.length ? `Nouveau : ${list(news)}.` : 'Rien de nouveau.', (gone.length ? `Retiré : ${list(gone)}.` : 'Rien de retiré.') + deps];
};

// R calls this one (docs/review.md): `files` is the review's file list ({ path, additions, deletions }), else numstat
export const architectureDelta = async ({ repo, base, head, files } = {}) => {
  repo = path.resolve(String(repo || ''));
  if (!base || !head) throw new Error('base et head sont requis');
  const headSha = await resolveSha(repo, head); await resolveSha(repo, base);
  let baseSha; try { baseSha = (await git(repo, ['merge-base', base, head])).trim(); } catch { throw new Error(`pas de base commune entre ${base} et ${head}`); }
  const [a, b] = await Promise.all([mapOf(repo, baseSha), mapOf(repo, headSha)]);
  const diff = (x, y, key) => { const ks = new Set(y.map(key)); return x.filter((v) => !ks.has(key(v))); };
  const kinds = {
    modules: [(m) => m.id, (m) => m.id], edges: [(e) => `${e.from}>${e.to}`], routes: [(r) => `${r.method} ${r.path}`], tables: [(t) => t.name], deps: [(d) => d.name],
  };
  const side = (x, y) => Object.fromEntries(Object.entries(kinds).map(([k, [key, view]]) => [k, uniq(diff(x[k], y[k], key), key).map(view || ((v) => v))]));
  const added = side(b, a); const removed = side(a, b);
  const changed = new Map();
  for (const f of files || (await numstat(repo, baseSha, headSha))) {
    const id = b.modules.some((m) => m.files.includes(f.path)) ? b.moduleOfFile(f.path) : a.modules.some((m) => m.files.includes(f.path)) ? a.moduleOfFile(f.path) : moduleOf(f.path); const c = changed.get(id) || { id, additions: 0, deletions: 0 };
    c.additions += Number(f.additions) || 0; c.deletions += Number(f.deletions) || 0; changed.set(id, c);
  }
  const changedModules = [...changed.values()].sort((x, y) => y.additions + y.deletions - (x.additions + x.deletions));
  return { repo, base, head, baseSha, headSha, added, removed, changedModules, summary: summaryOf(added, removed, changedModules) };
};
export const deltaOf = (repoDir, base, head) => architectureDelta({ repo: repoDir, base, head });
