// The fixed context of a session: what every call to the model reads again before any work (the system
// prompt and the tools, CLAUDE.md, MEMORY.md, the skills list, the instruction of the sessions, the plan's
// prompt). Measured, never guessed: the first call of each transcript (lib/usage.mjs `first`: input +
// cache written + cache read) is that context, since nothing else was read yet. Phase 14, docs/frugal.md
// « Le contexte fixe ».
//
//   fixedContext({ sessions, project, now })   { tokens, sessions, before, beforeSessions, since, growth, alert, … }
//   contextPieces({ project, home, sessions })  the pieces on disk, in characters and estimated tokens
//   contextReport({ sessions, project, now, home })   both, GET /api/learning `context`
//
// The pieces are sized in characters and turned into tokens at CHARS_PER_TOKEN (4, the usual order of
// magnitude for English prose; French runs a little denser): an estimate, said as such. The first-call
// figure is the real one; `rest` is what it holds beyond the pieces found on disk (the system prompt, the
// tools, what Claude Code adds).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { median, repoRoot } from './usage.mjs';

export const DAYS = 7;
export const ALERT_GROWTH = 0.2; // the line turns into an alert above +20 % (the brief of phase 14)
export const CHARS_PER_TOKEN = 4;
export const tokensOf = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const DAY = 864e5;
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

const sameProject = (a, b) => !!a && !!b && (a === b || repoRoot(a) === repoRoot(b));
const startOf = (s) => Date.parse(s.first?.at || s.firstAt || '');
const withFirst = (sessions, project) => sessions
  .filter((s) => s.first && s.first.context > 0 && (!project || sameProject(s.project, project)))
  .map((s) => ({ sessionId: s.sessionId, tokens: s.first.context, at: startOf(s), model: s.first.model || s.model }))
  .filter((s) => Number.isFinite(s.at))
  .sort((a, b) => a.at - b.at);

// The median first-call context of the project's sessions of the last `days` days, against the sessions of
// the `days` days before: `growth` = tokens / before − 1, `alert` above ALERT_GROWTH. A young project has no
// earlier window: the base is then the sessions of the window's first day (`since` says the date), so the
// line can still say where the figure comes from. Nothing to compare: growth null, no alert.
export const fixedContext = ({ sessions = [], project = null, now = Date.now(), days = DAYS, threshold = ALERT_GROWTH } = {}) => {
  const all = withFirst(sessions, project);
  const recent = all.filter((s) => s.at >= now - days * DAY && s.at <= now);
  let before = all.filter((s) => s.at >= now - 2 * days * DAY && s.at < now - days * DAY);
  let since = before.length ? null : recent.length ? new Date(recent[0].at).toISOString() : null;
  if (!before.length && recent.length > 1) { const day = new Date(recent[0].at).toISOString().slice(0, 10); before = recent.filter((s) => new Date(s.at).toISOString().slice(0, 10) === day); if (before.length === recent.length) before = recent.slice(0, Math.max(1, Math.floor(recent.length / 2))); }
  const tokens = recent.length ? Math.round(median(recent.map((s) => s.tokens))) : null;
  const base = before.length ? Math.round(median(before.map((s) => s.tokens))) : null;
  const growth = tokens != null && base ? round(tokens / base - 1, 4) : null;
  const latest = recent.length ? recent[recent.length - 1] : all.length ? all[all.length - 1] : null;
  return {
    tokens, sessions: recent.length, before: base, beforeSessions: before.length, since, days, growth, threshold,
    alert: growth != null && growth > threshold,
    latest: latest ? { sessionId: latest.sessionId, tokens: latest.tokens, at: new Date(latest.at).toISOString(), model: latest.model } : null,
  };
};

// ---------------------------------------------------------------- the pieces on disk
const sizeOf = (file) => { try { return statSync(file).isFile() ? readFileSync(file, 'utf8').length : 0; } catch { return 0; } };
const frontmatter = (file) => {
  let text; try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^---\n([\s\S]*?)\n---/.exec(text); if (!m) return null;
  const get = (k) => { const r = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m[1]); return r ? r[1].trim().replace(/^["']|["']$/g, '') : ''; };
  return { name: get('name') || path.basename(path.dirname(file)), description: get('description'), chars: text.length };
};
const skillsIn = (dir, source) => {
  const out = [];
  let names = []; try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const n of names) { const fm = frontmatter(path.join(dir, n, 'SKILL.md')); if (fm) out.push({ ...fm, source, listed: fm.name.length + fm.description.length + 4 }); }
  return out;
};
// Claude Code's folder for a project's transcripts and memory: the path with every non-alphanumeric turned into a dash
export const projectFolder = (project) => String(project || '').replace(/[^a-zA-Z0-9]/g, '-');

// What a session of the project reads at its first call, found on disk: CLAUDE.md (project and global),
// MEMORY.md of the project, the skills listed (their name and description go in every system prompt; the
// body only when invoked), the prompts of the project's sessions (median of the first user message, the
// instruction of the sessions included). Skills come from ~/.claude/skills, the installed plugins
// (~/.claude/plugins/installed_plugins.json, <installPath>/skills) and <project>/.claude/skills.
export const contextPieces = ({ project, home = homedir(), sessions = [] } = {}) => {
  const root = project ? repoRoot(project) : null;
  const claude = [root && path.join(root, 'CLAUDE.md'), project && project !== root && path.join(project, 'CLAUDE.md'), path.join(home, '.claude', 'CLAUDE.md')].filter(Boolean)
    .map((f) => ({ file: f, chars: sizeOf(f) })).filter((x) => x.chars > 0);
  const memoryFile = path.join(home, '.claude', 'projects', projectFolder(root || project), 'memory', 'MEMORY.md');
  const memoryChars = sizeOf(memoryFile);
  const skills = [...skillsIn(path.join(home, '.claude', 'skills'), 'user')];
  try {
    const inst = JSON.parse(readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [id, list] of Object.entries(inst.plugins || {})) for (const p of Array.isArray(list) ? list : [list]) if (p && p.installPath) skills.push(...skillsIn(path.join(p.installPath, 'skills'), id.split('@')[0]));
  } catch {}
  if (root) skills.push(...skillsIn(path.join(root, '.claude', 'skills'), 'project'));
  const prompts = sessions.filter((s) => project && sameProject(s.project, project) && typeof s.promptChars === 'number' && s.promptChars > 0).map((s) => s.promptChars);
  const listed = skills.reduce((n, s) => n + s.listed, 0);
  const promptChars = prompts.length ? Math.round(median(prompts)) : 0;
  return {
    claudeMd: { files: claude.map((x) => x.file), chars: claude.reduce((n, x) => n + x.chars, 0), tokens: tokensOf(claude.reduce((n, x) => n + x.chars, 0)) },
    memory: { file: memoryFile, exists: existsSync(memoryFile), chars: memoryChars, tokens: tokensOf(memoryChars) },
    skills: { count: skills.length, chars: listed, tokens: tokensOf(listed), bodyChars: skills.reduce((n, s) => n + s.chars, 0), list: skills.map((s) => ({ name: s.name, source: s.source, listed: s.listed, chars: s.chars })).sort((a, b) => b.listed - a.listed) },
    prompt: { sessions: prompts.length, chars: promptChars, tokens: tokensOf(promptChars) },
    charsPerToken: CHARS_PER_TOKEN,
  };
};

export const contextReport = ({ sessions = [], project = null, now = Date.now(), home = homedir() } = {}) => {
  const fixed = fixedContext({ sessions, project, now });
  const pieces = contextPieces({ project, home, sessions });
  const known = pieces.claudeMd.tokens + pieces.memory.tokens + pieces.skills.tokens + pieces.prompt.tokens;
  const rest = fixed.tokens != null ? Math.max(0, fixed.tokens - known) : null;
  return { ...fixed, pieces: { ...pieces, rest } };
};
