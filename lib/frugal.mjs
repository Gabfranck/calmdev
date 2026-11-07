// The frugal rule, held by the tool instead of the prompt (docs/frugal.md): a PreToolUse hook on Read
// (lib/frugal-hook.mjs) keeps big files out of the context, since every later call reads them again. A long file,
// an image, a big JSON, a transcript or a database is refused once, with one line on what to do instead; the same
// read tried again passes (an image goes through Haiku first). Bash is left whole: Claude Code refused every
// rewrite of a command (docs/frugal.md, « La réécriture de Bash, écartée »).
//
//   import { FRUGAL_SETTINGS, withFrugal, decide } from './frugal.mjs';
//   startSession({ settings: withFrugal(SANDBOX_SETTINGS) })   the hook merged into other settings
//   decide({ file_path, offset, limit }, cwd, { limits, retry })   → { allow: true } | { allow: false, reason, kind }
import { openSync, readSync, closeSync, statSync, readFileSync, existsSync } from 'node:fs';
import { extname, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CAP_DEFAULTS } from './frugal-cap.mjs';
import { vars, envVar, envPairs, projectDir } from './names.mjs';
export const MAX_LINES = 300;
export const MAX_BYTES = 200 * 1024;
// The thresholds, per project in <project>/.escadrille/frugal.json (found from the session's folder up, so a
// worktree under <project>/.claude/worktrees takes its project's), or ESCADRILLE_FRUGAL (JSON) for a run.
//   jsonBytes: a .json file past it is refused once, with a filter to run
//   readLines, readBytes: a Read without limit past readLines, or of a file past readBytes, is refused once
//   images: 'triage' (refused once, then Haiku says if it is usable), 'ask' (refused once), 'allow'
//   off: true turns the hook off for the project
export const LIMITS = { ...CAP_DEFAULTS, readLines: MAX_LINES, readBytes: MAX_BYTES, images: 'triage', off: false };
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const DATA = new Set(['.jsonl', '.sqlite', '.sqlite3', '.db']);

export const limitsFor = (cwd = process.cwd(), env = process.env) => {
  let limits = { ...LIMITS };
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const f = projectDir(d, 'frugal.json');
    if (existsSync(f)) { try { limits = { ...limits, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch {} break; }
    if (dirname(d) === d) break;
  }
  const given = envVar('FRUGAL', env); if (given) { try { limits = { ...limits, ...JSON.parse(given) }; } catch {} }
  return limits;
};

const HOOK = fileURLToPath(new URL('./frugal-hook.mjs', import.meta.url));
// process.execPath rather than a bare `node`: the hook runs whatever PATH the session inherits. 60 s: an image's
// Haiku check runs inside the hook.
export const FRUGAL_SETTINGS = {
  hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(HOOK)}`, timeout: 60 }] }] },
};

// Settings with the frugal hook added, keeping hooks the settings already have.
export const withFrugal = (settings = {}) => {
  const hooks = { ...(settings.hooks || {}) };
  for (const [event, list] of Object.entries(FRUGAL_SETTINGS.hooks)) hooks[event] = [...(hooks[event] || []), ...list];
  return { ...settings, hooks };
};

// Counts lines in 64 KB chunks: the file is never held in memory whole.
export const countLines = (path) => {
  const fd = openSync(path, 'r'); const buf = Buffer.allocUnsafe(65536);
  let lines = 0, last = 10, n;
  try {
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
      last = buf[n - 1];
    }
  } finally { closeSync(fd); }
  return last === 10 ? lines : lines + 1;
};

const kb = (b) => `${Math.round(b / 1024)} Ko`;
const AGAIN = ' Si tu en as vraiment besoin, refais exactement la même lecture : elle passera.';
const no = (kind, reason) => ({ allow: false, kind, reason: `Lecture refusée par calmdev : ${reason}${AGAIN}` });

// A Read: refused once when it would bring a lot into the context; `retry` (the same read just refused) passes.
export const decide = ({ file_path, offset, limit } = {}, cwd = process.cwd(), { limits = LIMITS, retry = false } = {}) => {
  if (!file_path || retry || limits.off) return { allow: true };
  const path = resolve(cwd, String(file_path));
  const ext = extname(path).toLowerCase();
  if (IMAGES.has(ext)) {
    if (limits.images === 'allow') return { allow: true };
    return no('image', `une image est relue à chaque appel suivant (≈ 1 600 tokens). Une capture de contrôle se juge par son rapport texte ; une capture à montrer, relis-la${limits.images === 'triage' ? ' : Haiku vérifie d’abord qu’elle est exploitable' : ''}.`);
  }
  if (DATA.has(ext)) return no('data', `${ext} (transcription ou base) est trop gros pour le contexte. Grep ce qu'il te faut, ou filtre-le avec node -e (node:sqlite pour une base).`);
  let st; try { st = statSync(path); } catch { return { allow: true }; }
  if (!st.isFile()) return { allow: true };
  if (ext === '.json' && st.size > limits.jsonBytes) return no('json', `${file_path} est un JSON de ${kb(st.size)}. Filtre-le avant de le lire : jq '.clé' ${file_path}, ou node -e "const j=JSON.parse(require('fs').readFileSync('${file_path}','utf8'));console.log(Object.keys(j))".`);
  if (st.size > limits.readBytes) return no('big', `${file_path} pèse ${kb(st.size)} (plus de ${kb(limits.readBytes)}). Grep ce qu'il te faut dans ce fichier.`);
  const lim = Number(limit);
  if (limit != null && lim > 0 && lim <= limits.readLines) return { allow: true };
  const lines = countLines(path);
  if (lines <= limits.readLines) return { allow: true };
  return no('long', `${file_path} a ${lines} lignes, plus de ${limits.readLines}. Lis la partie utile avec offset et limit (${limits.readLines} au plus, offset 1 limit 60 pour l'en-tête), ou Grep ce qu'il te faut.`);
};

// Haiku looks at an image before the session opens it: one line, `bonne`, `vide`, `connexion` or `erreur`
// (Dev, 2 November: the pilot opened a capture stuck on the student app's sign-in screen). ESCADRILLE_FRUGAL_OFF
// keeps the hook out of that run. → { ok, verdict, line } ; ok null when Haiku could not say (the read passes).
export const TRIAGE_MODEL = 'claude-haiku-5-5';
export const triageImage = (path, { claude = vars.CLAUDE || 'claude', timeout = 45e3, env = process.env } = {}) => {
  const prompt = `Lis l'image ${path} avec Read. Réponds une seule ligne : un mot parmi bonne, vide, connexion, erreur, puis « : » et six mots au plus. vide : page blanche ou presque. connexion : bloquée sur un écran de connexion. erreur : page d'erreur, 404, plantage, écran de chargement. bonne : l'écran attendu, exploitable.`;
  const r = spawnSync(claude, ['-p', prompt, '--model', TRIAGE_MODEL, '--allowedTools', 'Read', '--permission-mode', 'dontAsk', '--max-budget-usd', '0.05', '--output-format', 'text'],
    { cwd: dirname(path), encoding: 'utf8', timeout, env: { ...env, ...envPairs({ FRUGAL_OFF: '1' }) } });
  const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  const verdict = (line.toLowerCase().match(/\b(bonne|vide|connexion|erreur)\b/) || [])[1];
  if (r.status !== 0 || !verdict) return { ok: null, verdict: null, line };
  return { ok: verdict === 'bonne', verdict, line: line.slice(0, 160) };
};

// The cost of a planning run up to its first answer, from its Claude Code transcript (JSONL):
// usage counted once per message.id (a message spans several lines), up to the second prompt.
//   node lib/frugal.mjs ~/.claude/projects/<project>/<session_id>.jsonl
export const firstTurn = (text) => {
  const usage = new Map(); const reads = []; let prompts = 0, tools = 0;
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user' && typeof e.message?.content === 'string' && ++prompts > 1) break;
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    usage.set(e.message.id, e.message.usage);
    for (const b of e.message.content || []) if (b.type === 'tool_use') { tools++; if (b.name === 'Read') reads.push([b.input.file_path, b.input.offset, b.input.limit].filter((x) => x != null).join(' ')); }
  }
  const s = { calls: usage.size, tools, input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  for (const u of usage.values()) { s.input += u.input_tokens || 0; s.cacheCreation += u.cache_creation_input_tokens || 0; s.cacheRead += u.cache_read_input_tokens || 0; s.output += u.output_tokens || 0; }
  return { ...s, read: s.input + s.cacheCreation + s.cacheRead, reads };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(firstTurn(readFileSync(process.argv[2], 'utf8')), null, 1));
}
