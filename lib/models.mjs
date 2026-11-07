// The models Escadrille can launch a session on. Nothing here is a list written by hand for the pages:
// the list is built from three sources, read at startup and on GET /api/models (docs/models.md).
//
//   1. the models seen in Claude Code's transcripts (message.model), same folders as lib/usage.mjs; only the tail of the
//      most recent files is read (usage's full scan takes seconds on a large ~/.claude/projects, and startup must not wait)
//   2. a fallback in the code: the models of the price table of lib/usage.mjs (its keys), default Opus 5.5
//   3. a local override file, ~/.escadrille/models.json (ESCADRILLE_MODELS), never in the repository:
//        { "default": "claude-opus-5-5", "hide": ["claude-haiku-5-5"],
//          "add": [{ "id": "llama3.2", "name": "Llama 3.2", "provider": "ollama", "baseUrl": "http://localhost:11434" }] }
//      an entry of another provider than "claude" is listed with available: false until its adapter exists
//
//   listModels(opts?)    [{ id, name, provider, available, reason?, price?, default?, source }]; with opts, rebuilds
//   isModel(id)          true for an available model
//   modelName(id)        the readable name, derived from the id when the model is not known
//   defaultModel()       the first model marked default
//   plannerModel(...ids) the first available id given, else the default (escadrille, then project, then default)
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PRICES, priceOf, DEFAULT_ROOT } from './usage.mjs';
import { vars, homeDir } from './names.mjs';

export const OVERRIDE_FILE = vars.MODELS || homeDir('models.json');
export const FALLBACK_DEFAULT = 'claude-opus-5-5'; // Fable is nearly spent (decisions, 2026-11-01 08:45)
export const NO_ADAPTER = 'pas encore d’adaptateur';

// claude-opus-5-5 -> Opus 5.5, claude-3-5-sonnet-20241022 -> Sonnet 3.5, llama3.2 -> Llama3.2
export const nameOf = (id) => {
  const bare = String(id || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').replace(/^claude-/, '');
  const parts = bare.split('-').filter(Boolean);
  const words = parts.filter((p) => !/^\d+$/.test(p)).map((w) => w[0].toUpperCase() + w.slice(1));
  const nums = parts.filter((p) => /^\d+$/.test(p));
  return [words.join(' '), nums.join('.')].filter(Boolean).join(' ') || String(id);
};
// A model id as the transcripts write it, without a date suffix or a context tag; null for a synthetic one
const cleanSeen = (m) => (typeof m === 'string' && /^claude-[a-z0-9-]+/.test(m) ? m.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '') : null);

const priceView = (id, given) => {
  const p = given && typeof given === 'object' ? given : priceOf(id);
  return p && Number.isFinite(p.input) && Number.isFinite(p.output) ? { input: p.input, output: p.output, cacheRead: Number.isFinite(p.cacheRead) ? p.cacheRead : p.input / 10 } : undefined;
};
const readOverride = (file) => { try { const o = JSON.parse(readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };


// The claude-* model ids named in the tail of the recent transcripts (root/<folder>/*.jsonl, one level, like usage.mjs)
const RECENT_DAYS = 30, MAX_FILES = 80, TAIL_BYTES = 256 * 1024;
export const seenModels = (root = DEFAULT_ROOT, now = Date.now()) => {
  const files = [];
  let dirs = []; try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return new Set(); }
  for (const d of dirs) { let names = []; try { names = readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; } for (const f of names) { const fp = path.join(root, d.name, f); try { const st = statSync(fp); if (st.isFile() && now - st.mtimeMs < RECENT_DAYS * 864e5) files.push({ fp, mtime: st.mtimeMs, size: st.size }); } catch {} } }
  const seen = new Set();
  for (const x of files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)) {
    let text = ''; try { const fd = openSync(x.fp, 'r'); try { const n = Math.min(x.size, TAIL_BYTES); const buf = Buffer.alloc(n); readSync(fd, buf, 0, n, x.size - n); text = buf.toString('utf8'); } finally { closeSync(fd); } } catch { continue; }
    for (const m of text.matchAll(/"model":\s*"(claude-[A-Za-z0-9._-]+)"/g)) { const id = cleanSeen(m[1]); if (id) seen.add(id); }
  }
  return seen;
};

export const buildModels = ({ root = DEFAULT_ROOT, overrideFile = OVERRIDE_FILE } = {}) => {
  const byId = new Map();
  const put = (m) => { const old = byId.get(m.id); byId.set(m.id, old ? { ...old, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) } : m); };
  const claude = (id, source, extra = {}) => ({ id, name: nameOf(id), provider: 'claude', available: true, price: priceView(id), source, ...extra });
  // Order of the sources: transcripts, fallback, override (the later one wins on a field). Display order:
  // the fallback first (it is what the pages have always shown), then what the transcripts add, then the override.
  const seen = seenModels(root);
  for (const id of Object.keys(PRICES)) put(claude(id, 'fallback'));
  for (const id of [...seen].sort()) if (!byId.has(id)) put(claude(id, 'transcripts'));
  const o = readOverride(overrideFile);
  for (const a of Array.isArray(o.add) ? o.add : []) {
    if (!a || typeof a.id !== 'string' || !a.id.trim()) continue;
    const id = a.id.trim(); const provider = typeof a.provider === 'string' && a.provider ? a.provider : 'claude';
    const m = { id, name: typeof a.name === 'string' && a.name ? a.name : byId.get(id)?.name || nameOf(id), provider, price: priceView(id, a.price), source: 'override' };
    if (provider === 'claude') { m.available = true; m.reason = undefined; } else { m.available = false; m.reason = NO_ADAPTER; if (typeof a.baseUrl === 'string') m.baseUrl = a.baseUrl; }
    put(m);
  }
  for (const id of Array.isArray(o.hide) ? o.hide : []) byId.delete(id);
  const list = [...byId.values()];
  // The default: the override's, else the fallback's, else the first available model
  const usable = (id) => list.some((m) => m.id === id && m.available);
  const def = [o.default, FALLBACK_DEFAULT].find(usable) || list.find((m) => m.available)?.id;
  const out = list.map((m) => { const x = { ...m }; if (!x.price) delete x.price; if (x.reason === undefined) delete x.reason; if (x.id === def) x.default = true; return x; });
  return out.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0)); // the default first: pages that take the first option get it
};

let current = null; let currentOpts = {};
export const listModels = (opts) => { if (opts) { currentOpts = opts; current = null; } return (current ||= buildModels(currentOpts)); };
export const isModel = (id) => listModels().some((m) => m.id === id && m.available);
export const modelName = (id) => listModels().find((m) => m.id === id)?.name || (id ? nameOf(id) : '');
export const defaultModel = () => listModels().find((m) => m.default)?.id || FALLBACK_DEFAULT;
export const plannerModel = (...ids) => ids.find((id) => id && isModel(id)) || defaultModel();
// The pilot's model (Dev, 6 Nov.): its work is triage, so Sonnet by default, not the project's model; pilotModel overrides it
export const PILOT_DEFAULT = 'claude-sonnet-5-5';
export const pilotModel = (id) => (id && isModel(id) ? id : isModel(PILOT_DEFAULT) ? PILOT_DEFAULT : defaultModel());
