// The resources of a project (docs/resources.md): what the developer gives a project so its sessions work
// better, read from disk on demand (nothing copied into the database), plus the folder
// <project>/.escadrille/ressources/ where the Resources screen drops what the developer adds (never committed).
// Also the ranked list of capabilities worth adding, from local sources only: the marketplaces already under
// ~/.claude/plugins/marketplaces/, the planners' install proposals, and catalog/capabilities.json.
// Nothing here touches the network, nothing installs.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { projectDir, configDirIn, PROJECT_DIR, LEGACY_PROJECT_DIR } from './names.mjs';
import { msg } from './i18n.mjs'; // the capabilities' reasons, decoded by the language of the request

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const PROMPT_LINES = 40;
const ADDED_DIR = (project) => projectDir(project, 'ressources');
const NOTES = (project) => path.join(ADDED_DIR(project), 'notes.json');
const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return dflt; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const ls = (d) => { try { return readdirSync(d); } catch { return []; } };

// ------------------------------------------------------------------ the pieces
const memoryOf = (project) => {
  const d = path.join(project, 'docs', 'decisions.md'); const file = existsSync(d) ? d : projectDir(project, 'memoire.md');
  if (!isFile(file)) return { file: null, lines: 0 };
  return { file, lines: readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length };
};
// docs/regles.md (session Q): the bullets under « ## Règles »
const rulesOf = (project) => {
  const file = path.join(project, 'docs', 'regles.md'); if (!isFile(file)) return { file: null, count: 0 };
  let inRules = false; let count = 0;
  for (const l of readFileSync(file, 'utf8').split('\n')) { if (/^##\s/.test(l)) inRules = /^##\s+R[èe]gles\b/i.test(l); else if (inRules && /^\s*[-*]\s+\S/.test(l)) count++; }
  return { file, count };
};
// The description of a SKILL.md, from its frontmatter (a one-line value, or a folded/literal block)
export const frontmatterOf = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!m) return {};
  const out = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]); if (!kv) continue;
    let v = kv[2].trim();
    if (/^[|>][-+]?$/.test(v) || v === '') { const block = []; while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]) && !/^[A-Za-z_][\w-]*:/.test(lines[i + 1])) block.push(lines[++i].trim()); v = block.filter(Boolean).join(' '); }
    out[kv[1]] = v.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
};
const settingsFile = (project) => path.join(project, '.claude', 'settings.json');
const denied = (project) => new Set((readJson(settingsFile(project), {})?.permissions?.deny || []).map(String));
const skillLine = (name) => `Skill(${name})`;
const skillsIn = (dir, scope, deny) => ls(dir).map((n) => path.join(dir, n, 'SKILL.md')).filter(isFile).map((p) => {
  const fm = frontmatterOf(readFileSync(p, 'utf8')); const name = fm.name || path.basename(path.dirname(p));
  return { name, path: p, scope, description: (fm.description || '').slice(0, 400), enabled: !deny.has(skillLine(name)) };
});
const skillsOf = (project, home) => { const deny = denied(project); return [...skillsIn(path.join(project, '.claude', 'skills'), 'project', deny), ...skillsIn(path.join(home, '.claude', 'skills'), 'user', deny)]; };
// enabledPlugins of the user's settings, then of the project's (the project wins), and the installed ones
const pluginsOf = (project, home) => {
  const map = new Map();
  for (const [file, scope] of [[path.join(home, '.claude', 'settings.json'), 'user'], [settingsFile(project), 'project'], [path.join(project, '.claude', 'settings.local.json'), 'project']]) {
    for (const [name, on] of Object.entries(readJson(file, {})?.enabledPlugins || {})) map.set(name, { name, enabled: on === true, file, scope });
  }
  for (const name of Object.keys(readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {})?.plugins || {})) if (!map.has(name)) map.set(name, { name, enabled: true, file: null, scope: 'user' });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
};
// .git/config, or the main repository's when .git is a worktree's file (gitdir: <repo>/.git/worktrees/<name>)
const gitConfigOf = (project) => {
  const g = path.join(project, '.git');
  try { if (isFile(g)) { const d = /gitdir:\s*(.+)/.exec(readFileSync(g, 'utf8'))?.[1]?.trim(); const common = d && path.resolve(project, d, '..', '..'); return readFileSync(path.join(common, 'config'), 'utf8'); } return readFileSync(path.join(g, 'config'), 'utf8'); } catch { return ''; }
};
const remoteOf = (project) => { const c = gitConfigOf(project); return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(c)?.[1] || null; };
// Connectors: GitHub when origin is on github.com (the gh of the Mac opens the PR, session A), Linear when a key is
// stored for the project (only whether it exists: the key itself is never read out)
const connectorsOf = (project, home, secretsFile) => {
  const remote = remoteOf(project); const sec = readJson(secretsFile || configDirIn(home, 'secrets.json'), {});
  const out = [];
  if (remote && /github\.com/i.test(remote)) out.push({ name: 'GitHub', ready: true, why: 'remote origin sur github.com, gh du Mac' });
  if (sec?.[project]?.linear) out.push({ name: 'Linear', ready: true, why: msg('srv.r.keyStored') });
  return out;
};

const KINDS = [['image', /\.(png|jpe?g|gif|webp|svg|avif)$/i], ['table', /\.(csv|tsv|xlsx?)$/i], ['pdf', /\.pdf$/i], ['text', /\.(md|txt|json|ya?ml|html?)$/i]];
const kindOf = (name) => KINDS.find(([, re]) => re.test(name))?.[0] || 'other';
const FOUND = /^(tickets|backlog)\.md$|\.(csv|tsv)$/i;
const filesOf = (project) => {
  const notes = readJson(NOTES(project), {}); const out = [];
  const entry = (abs, added) => { const rel = path.relative(project, abs); const st = statSync(abs); return { path: abs, rel, kind: kindOf(abs), size: st.size, addedAt: notes[rel]?.addedAt || (added ? st.mtime.toISOString() : null), note: notes[rel]?.note || '', added }; };
  for (const n of ls(ADDED_DIR(project)).sort()) { const p = path.join(ADDED_DIR(project), n); if (n !== 'notes.json' && isFile(p)) out.push(entry(p, true)); }
  for (const d of [project, path.join(project, 'docs'), path.join(project, 'data')]) for (const n of ls(d).sort()) { const p = path.join(d, n); if (FOUND.test(n) && isFile(p)) out.push(entry(p, false)); }
  return out;
};

export const resourcesOf = (project, { home = homedir(), addDirs = [], secretsFile } = {}) => ({
  project, memory: memoryOf(project), rules: rulesOf(project), skills: skillsOf(project, home), plugins: pluginsOf(project, home),
  addDirs: addDirs.slice(), connectors: connectorsOf(project, home, secretsFile), files: filesOf(project),
});

// ------------------------------------------------------------------ the writes
// The name of a dropped file: refused when it tries to leave the folder, else cleaned to [A-Za-z0-9._ -]
export const cleanName = (raw) => {
  const s = String(raw ?? '');
  if (!s.trim() || /[/\\]|\.\.|[\x00-\x1f\x7f]/.test(s)) throw new Error('name : nom de fichier refusé');
  const n = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._ -]/g, '-').replace(/^[.\s-]+/, '').trim().slice(0, 120);
  if (!n || n === 'notes.json') throw new Error('name : nom de fichier refusé');
  return n;
};
const oneLine = (v, max, label) => { const s = String(v ?? '').trim(); if (/[\r\n]/.test(s)) throw new Error(`${label} : une seule ligne`); if (s.length > max) throw new Error(`${label} : ${max} caractères au plus`); return s; };
const saveNote = (project, rel, note, addedAt) => { const all = readJson(NOTES(project), {}); all[rel] = { note, addedAt: addedAt || all[rel]?.addedAt || new Date().toISOString() }; mkdirSync(ADDED_DIR(project), { recursive: true }); writeFileSync(NOTES(project), JSON.stringify(all, null, 1)); };

export const addFile = (project, { name, base64, text, note } = {}) => {
  const n = note === undefined ? '' : oneLine(note, 300, 'note');
  let buf;
  if (typeof base64 === 'string') { if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) throw new Error('base64 : contenu illisible'); buf = Buffer.from(base64, 'base64'); }
  else if (typeof text === 'string') { if (!text.trim()) throw new Error('text : un texte vide'); buf = Buffer.from(text, 'utf8'); }
  else throw new Error('base64 ou text : il faut un contenu');
  if (buf.length > MAX_FILE_BYTES) { const e = new Error('fichier : 20 Mo au plus'); e.code = 413; throw e; }
  const d = new Date(); const base = cleanName(name ?? (typeof text === 'string' ? `note-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md` : ''));
  mkdirSync(ADDED_DIR(project), { recursive: true });
  const ext = path.extname(base); const stem = base.slice(0, base.length - ext.length); let final = base;
  for (let i = 2; existsSync(path.join(ADDED_DIR(project), final)); i++) final = `${stem}-${i}${ext}`;
  const abs = path.join(ADDED_DIR(project), final); writeFileSync(abs, buf);
  saveNote(project, path.relative(project, abs), n, d.toISOString());
  return { ok: true, file: filesOf(project).find((f) => f.path === abs) };
};
export const setNote = (project, { path: rel, note } = {}) => {
  const f = filesOf(project).find((x) => x.rel === rel || x.path === rel); if (!f) throw new Error('path : fichier inconnu');
  saveNote(project, f.rel, oneLine(note, 300, 'note')); return { ok: true };
};
export const removeFile = (project, rel) => {
  const f = filesOf(project).find((x) => x.rel === rel || x.path === rel);
  if (!f || !f.added) throw new Error('path : seul un fichier ajouté par l’écran se supprime');
  unlinkSync(f.path); const all = readJson(NOTES(project), {}); delete all[f.rel]; writeFileSync(NOTES(project), JSON.stringify(all, null, 1));
  return { ok: true };
};

// The SKILL.md of a listed skill, to read it on the screen (50 kB at most)
export const readSkill = (project, name, { home = homedir() } = {}) => {
  const skill = skillsOf(project, home).find((s) => s.name === name); if (!skill) throw new Error('name : skill inconnu');
  return { ...skill, text: readFileSync(skill.path, 'utf8').slice(0, 50000) };
};
// Switch a skill or a plugin for the project, in <project>/.claude/settings.json; without confirm, only the preview
const writeSettings = (project, fn) => { const f = settingsFile(project); const s = readJson(f, {}); fn(s); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s, null, 2) + '\n'); };
export const switchSkill = (project, { name, enabled, confirm } = {}, { home = homedir() } = {}) => {
  const skill = skillsOf(project, home).find((s) => s.name === name); if (!skill) throw new Error('name : skill inconnu');
  const file = settingsFile(project); const line = `"permissions": { "deny": [ … "${skillLine(name)}" … ] }`;
  const want = enabled !== false; const action = want ? 'remove' : 'add';
  if (want === skill.enabled) return { ok: true, file, line, unchanged: true };
  if (confirm !== true) return { ok: false, preview: { file, line, action } };
  writeSettings(project, (s) => { s.permissions ||= {}; const deny = (s.permissions.deny || []).filter((r) => r !== skillLine(name)); if (!want) deny.push(skillLine(name)); s.permissions.deny = deny; });
  return { ok: true, file, line };
};
export const switchPlugin = (project, { name, enabled, confirm } = {}) => {
  if (!/^[\w.-]+@[\w.-]+$/.test(String(name || ''))) throw new Error('name : un plugin nom@marketplace');
  const file = settingsFile(project); const want = enabled !== false; const line = `"enabledPlugins": { "${name}": ${want} }`;
  if (confirm !== true) return { ok: false, preview: { file, line, action: want ? 'enable' : 'disable' } };
  writeSettings(project, (s) => { s.enabledPlugins = { ...(s.enabledPlugins || {}), [name]: want }; });
  return { ok: true, file, line };
};

// ------------------------------------------------------------------ the planner's section
const rel = (project, p) => (p.startsWith(project + path.sep) ? path.relative(project, p) : p);
export const resourcesSection = (r) => {
  if (!r) return '';
  const lines = [];
  if (r.memory.file) lines.push(`- mémoire : ${rel(r.project, r.memory.file)} (${r.memory.lines} lignes)`);
  if (r.rules.file) lines.push(`- règles : ${rel(r.project, r.rules.file)} (${r.rules.count})`);
  for (const s of r.skills.filter((x) => x.enabled && x.scope === 'project')) lines.push(`- skill ${s.name} : ${rel(r.project, s.path)}${s.description ? ', ' + s.description.slice(0, 60) : ''}`);
  for (const f of r.files) lines.push(`- fichier ${f.rel}${f.note ? ' : ' + f.note : ''}`);
  for (const d of r.addDirs) lines.push(`- dossier ajouté : ${d}`);
  for (const c of r.connectors) lines.push(`- connecteur ${c.name}`);
  if (!lines.length) return '';
  const max = PROMPT_LINES - 2; const shown = lines.length > max ? [...lines.slice(0, max - 1), `- … et ${lines.length - max + 1} autres (écran Ressources)`] : lines;
  return `\n\n## Les ressources du projet\n\n${shown.join('\n')}`;
};

// ------------------------------------------------------------------ the capabilities worth adding
// The signals of a project, read on disk: its languages, dependencies, notable files, ticket ids
const SKIP = new Set(['node_modules', '.git', '.claude', PROJECT_DIR, LEGACY_PROJECT_DIR, 'dist', 'build', '.next', 'vendor', '.venv', 'venv', 'Pods']);
const LANGS = { '.js': 'javascript', '.mjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.java': 'java', '.cs': 'csharp', '.html': 'html', '.css': 'css', '.vue': 'vue', '.svelte': 'svelte', '.sql': 'sql', '.lua': 'lua', '.c': 'c', '.cpp': 'cpp' };
export const signalsOf = (project) => {
  const langs = {}; const files = new Set(); let seen = 0;
  const walk = (d, depth) => {
    for (const n of ls(d)) {
      if (seen++ > 4000) return; const p = path.join(d, n);
      if (isDir(p)) { if (depth === 0) files.add(n + '/'); if (n === '.github') files.add('.github/'); if (!SKIP.has(n) && depth < 3) walk(p, depth + 1); continue; }
      if (depth === 0) files.add(n); else if (/^(playwright|vitest|jest|docker-compose)\b|schema\.prisma$|\.sql$/i.test(n)) files.add(n);
      const l = LANGS[path.extname(n).toLowerCase()]; if (l) langs[l] = (langs[l] || 0) + 1;
    }
  };
  walk(project, 0);
  const pkg = readJson(path.join(project, 'package.json'), {}); const deps = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  for (const f of ['requirements.txt', 'pyproject.toml', 'Gemfile', 'go.mod', 'Cargo.toml']) { try { for (const m of readFileSync(path.join(project, f), 'utf8').matchAll(/^\s*["']?([A-Za-z][\w.-]*)/gm)) deps.add(m[1].toLowerCase()); } catch {} }
  const tickets = new Set();
  for (const f of ['tickets.md', 'backlog.md', path.join('docs', 'backlog.md')]) { try { for (const m of readFileSync(path.join(project, f), 'utf8').matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) tickets.add(m[0]); } catch {} }
  return { langs: Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l]) => l), deps: [...deps], files: [...files], tickets: [...tickets], remote: remoteOf(project) };
};
// The plugins of the marketplaces already on disk (their manifests), without reading anything else
export const marketplacePlugins = (home = homedir()) => {
  const dir = path.join(home, '.claude', 'plugins', 'marketplaces'); const out = [];
  for (const m of ls(dir)) { const j = readJson(path.join(dir, m, '.claude-plugin', 'marketplace.json'), null); for (const p of j?.plugins || []) if (p?.name) out.push({ id: `${p.name}@${j.name || m}`, name: p.name, marketplace: j.name || m, description: String(p.description || '').slice(0, 300), category: p.category || '', keywords: (p.keywords || []).map(String) }); }
  return out;
};

export const loadCatalog = (file) => readJson(file, []).filter((c) => c && c.id && c.name);

const lc = (s) => String(s || '').toLowerCase();
const words = (c) => [c.id, c.name, ...(c.match?.words || [])].map(lc).filter(Boolean);
// The rule, one sentence each, in docs/resources.md:
//   +3 a planner proposed it (install block of an escadrille of the project)
//   +3 a session of the project asked for it or was refused it (journal: a request that names one of its words)
//   +2 a file of the project calls for it (a dependency, a file, a ticket id, the remote)
//   +1 the project's language is one it serves
//   +1 it is ready locally (a marketplace already on the Mac has it, or it is installed and off), only on top of another signal
// What is already active is not listed; a score of 0 is not listed; ten at most, by score then name.
// A word of an entry found in a text as a whole word (expo is not export, tsc is not tsconfig)
const WORD = new Map();
const hasWord = (text, w) => { if (!WORD.has(w)) WORD.set(w, new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i')); return WORD.get(w).test(text); };
// A planner's proposal to switch something off or remove it is not a recommendation to add it
const REMOVAL = /d[ée]sactiv|retir|supprim|enl[eè]v|[ée]teind|disable|remove|uninstall|:\s*false/i;
export const capabilitiesOf = (project, { home = homedir(), catalog = [], installs: allInstalls = [], asks = [], signals } = {}) => {
  const installs = allInstalls.filter((it) => !REMOVAL.test(`${it.how || ''} ${it.name || ''}`));
  const sig = signals || signalsOf(project); const res = resourcesOf(project, { home });
  const market = marketplacePlugins(home); const marketById = new Map(market.map((p) => [p.id, p])); const marketByName = new Map(market.map((p) => [p.name, p]));
  const plugins = new Map(res.plugins.map((p) => [p.name, p])); const skills = new Map(res.skills.map((s) => [s.name, s]));
  const cands = new Map();
  for (const c of catalog) cands.set(c.id, { ...c, source: 'catalogue' });
  // A marketplace plugin enters when a dependency or a language of the project names it (stripe, prisma, typescript-lsp…)
  const depNames = new Set(sig.deps.map(lc).map((d) => d.replace(/^@/, '').split('/')[0]));
  for (const p of market) {
    const base = p.name.replace(/-(lsp|skills|mcp|cli|plugin)$/, '');
    const known = [...cands.values()].some((c) => c.plugin === p.id);
    if (!known && (depNames.has(base) || sig.langs.slice(0, 3).includes(base))) cands.set(p.id, { id: p.id, kind: 'plugin', name: p.name, what: p.description.split(/(?<=\.)\s/)[0].slice(0, 160), plugin: p.id, how: `/plugin install ${p.id}`, match: { deps: [base], langs: sig.langs.includes(base) ? [base] : [] }, source: p.marketplace });
  }
  // A planner's proposal that no entry covers enters as itself
  for (const it of installs) {
    const n = lc(it.name); if (!n) continue;
    const hit = [...cands.values()].find((c) => words(c).some((w) => n.includes(w) || w.includes(n)));
    if (!hit) cands.set('install:' + n, { id: 'install:' + n, kind: it.kind || 'skill', name: it.name, what: it.why || '', how: it.how || '', match: {}, source: 'planificateur' });
  }
  const out = [];
  for (const c of cands.values()) {
    const why = []; let score = 0; const ws = words(c);
    const pr = installs.filter((it) => { const n = lc(it.name); return c.id === 'install:' + n || ws.some((w) => n.includes(w) || w.includes(n)); });
    if (pr.length) { score += 3; why.push(msg('srv.r.byPlanner')); }
    const ak = asks.filter((a) => ws.some((w) => w.length > 2 && hasWord(a.text, w)));
    if (ak.length) { score += 3; why.push(msg(ak.some((a) => a.refused) ? 'srv.r.asksRefused' : 'srv.r.asks', { n: ak.length })); }
    const m = c.match || {}; const fileHits = [];
    for (const d of m.deps || []) if (depNames.has(lc(d)) || sig.deps.map(lc).includes(lc(d))) fileHits.push(msg('srv.r.dep', { d }));
    for (const f of m.files || []) { const re = new RegExp('^' + f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); const hit = sig.files.find((x) => re.test(x)); if (hit) fileHits.push(msg('srv.r.file', { f: hit })); }
    if (m.tickets && sig.tickets.length) fileHits.push(`tickets ${sig.tickets.slice(0, 2).join(', ')}`);
    if (m.remote && sig.remote && new RegExp(m.remote, 'i').test(sig.remote)) fileHits.push(`remote ${m.remote.replace(/\\/g, '')}`);
    if (fileHits.length) { score += 2; why.push(fileHits.slice(0, 2).join(', ')); }
    const lang = (m.langs || []).find((l) => sig.langs.includes(l)); if (lang) { score += 1; why.push(lang); }
    // Where it stands on this Mac
    const plug = c.plugin ? plugins.get(c.plugin) : null; const skill = c.skill ? skills.get(c.skill) : null;
    if ((plug && plug.enabled) || (skill && skill.enabled)) continue; // already a resource
    let activate = null; let local = false;
    if (plug && !plug.enabled) { activate = { type: 'plugin', name: c.plugin }; local = true; }
    else if (skill && !skill.enabled) { activate = { type: 'skill', name: c.skill }; local = true; }
    else if (c.plugin && (marketById.has(c.plugin) || marketByName.has(c.plugin.split('@')[0]))) local = true;
    if (!score) continue; // being on the Mac is a bonus, never a reason on its own
    if (local) { score += 1; why.push(msg(activate ? 'srv.r.offHere' : 'srv.r.onMac')); }
    out.push({ id: c.id, kind: c.kind, name: c.name, what: c.what || '', why: why.join(' · '), score, how: c.how || '', activate, network: !activate, source: c.source });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 10);
};
