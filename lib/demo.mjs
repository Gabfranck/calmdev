// The live software demo (docs/demo.md): one prompt, a throwaway branch escadrille/demo/<stamp> in its own worktree, a
// quick Claude Code session told to touch public/ only, and the files of public/ it adds or changes served over the
// server's own (the overlay), live, as they are written. Remove cuts the overlay, stops the session, deletes the
// worktree and the branch. Alone after an hour. One demo at a time; nothing in the database, never merged, never pushed.
//
//   createDemo({ root, onChange, ttlMs, start, claude })
//     .start({ prompt, model }) → { id, status }        .view() → GET /api/demo
//     .remove()                 → { ok, removed }       .overlay(rel) → the file of the branch to serve for public/<rel>, or null
//     .route(req, res, url, { json, readBody })         → true when it answered (/api/demo, /api/demo/remove)
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import * as worktree from './worktree.mjs';
import { startSession } from './planner.mjs';
import { listModels, isModel } from './models.mjs';

export const TTL_MS = 60 * 60e3;
export const BUDGET_USD = 2;
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit']; // no Bash: no git, no network, nothing but files
// Never taken from the branch even inside public/: events.js reloads the page, a demo that broke it could not be removed from view
export const NEVER = new Set(['public/events.js']);
const SCAN_MS = 1000;

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 30000, maxBuffer: 4e6 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))));
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
export const stampOf = (t = new Date()) => t.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase(); // 20261102t213000z

export const instruction = () => [
  "Tu es la session de démo de calmdev : une modification visible, tout de suite, devant des spectateurs.",
  'Ne touche que des fichiers sous public/ (HTML, CSS, JS de la page) : tout fichier écrit ailleurs est ignoré.',
  'Ne commite pas, ne lance aucune commande, pas de réseau. Va droit au but : quelques modifications nettes, la page doit rester utilisable.',
  'Écris la première modification visible le plus tôt possible, puis affine si besoin.',
].join('\n');

export const pickModel = (m) => {
  const want = String(m || '').trim() || DEFAULT_MODEL;
  if (isModel(want)) return want;
  return listModels().find((x) => x.available && x.id.includes(want.toLowerCase()))?.id || null;
};

// What the worktree changed against its start: the files of public/ to serve, the rest refused
export const classify = (wt, paths) => {
  const files = []; const refused = [];
  for (const p of [...new Set(paths)].sort()) {
    const abs = path.join(wt, p);
    let st; try { st = lstatSync(abs); } catch { continue; } // deleted in the branch: main's file stays
    if (!p.startsWith('public/') || p.includes('..') || NEVER.has(p) || !st.isFile()) { refused.push(p); continue; }
    files.push(p);
  }
  return { files, refused };
};

export const createDemo = ({ root, onChange = () => {}, ttlMs = TTL_MS, start = startSession, claude } = {}) => {
  let cur = null; // { id, prompt, model, status, startedAt, endsAt, wt, branch, base, files, refused, error, proc, timer, scan, sig }

  const view = () => cur ? { on: true, id: cur.id, prompt: cur.prompt, model: cur.model, status: cur.status, startedAt: cur.startedAt, endsAt: cur.endsAt, files: cur.files.map((f) => f.slice(7)), refused: cur.refused, error: cur.error || null } : { on: false };

  const scan = async (d) => {
    if (d !== cur || !d.wt) return;
    let changed = []; try { changed = [...lines(await git(d.wt, ['diff', '--name-only', d.base])), ...lines(await git(d.wt, ['ls-files', '--others', '--exclude-standard']))]; } catch { return; }
    if (d !== cur) return;
    const { files, refused } = classify(d.wt, changed);
    // only what is served counts: the page reloads when the overlay changes, never for a refused file
    const sig = JSON.stringify(files.map((f) => { try { const s = statSync(path.join(d.wt, f)); return [f, s.size, s.mtimeMs]; } catch { return [f]; } }));
    d.files = files; d.refused = refused;
    if (files.length && d.status === 'preparing') d.status = 'live';
    if (sig !== d.sig) { d.sig = sig; if (files.length) onChange(view()); }
  };

  // The remains of a demo a stopped server left: its worktree and its branch
  const sweep = async () => {
    const wts = lines(await git(root, ['worktree', 'list', '--porcelain'])).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => path.basename(p).startsWith('demo-') && path.basename(path.dirname(p)) === 'worktrees');
    for (const p of wts) { try { await worktree.remove({ root, path: p }); } catch {} }
    for (const b of lines(await git(root, ['branch', '--list', 'escadrille/demo/*'])).map((l) => l.replace(/^[*+]\s*/, ''))) { try { await git(root, ['branch', '-D', b]); } catch {} }
  };

  const fail = (d, text) => { if (d !== cur || d.status !== 'preparing') return; d.status = 'failed'; d.error = text; };

  const begin = async (d) => {
    try {
      await sweep();
      const wt = await worktree.create({ root, plan: 'demo', session: d.id });
      if (d !== cur) { await cleanup({ wt: wt.path, branch: wt.branch }); return; }
      d.wt = wt.path; d.branch = wt.branch; d.base = await git(wt.path, ['rev-parse', 'HEAD']);
      d.proc = start({ cwd: wt.path, model: d.model, systemPrompt: instruction(), budget: BUDGET_USD, allowedTools: TOOLS, permissionMode: 'dontAsk', permissionPrompt: false, ...(claude ? { claude } : {}),
        onEvent: (e) => {
          if (d !== cur) return;
          if (e.type === 'turn' || e.type === 'exit') scan(d).then(() => { if (e.type === 'exit' && !d.files.length) fail(d, d.error || 'la session de démo s’est arrêtée sans rien écrire dans public/'); });
          if (e.type === 'error') d.error = e.text;
        } });
      d.proc.send(d.prompt);
      d.scan = setInterval(() => scan(d), SCAN_MS); d.scan.unref?.();
    } catch (e) { fail(d, e.message); }
  };

  const cleanup = async ({ wt, branch, proc }) => {
    try { proc?.stop(); } catch {}
    if (wt) { try { await worktree.remove({ root, path: wt }); } catch {} }
    if (branch) { try { await git(root, ['branch', '-D', branch]); } catch {} }
  };

  const api = {
    view,
    start: ({ prompt, model } = {}) => {
      const text = String(prompt || '').trim(); if (!text) { const e = new Error('prompt manquant'); e.status = 400; throw e; }
      if (cur) { const e = new Error('une démo tourne déjà : retire-la d’abord'); e.status = 409; throw e; }
      const m = pickModel(model); if (!m) { const e = new Error('modèle inconnu'); e.status = 400; throw e; }
      const t = Date.now();
      const d = cur = { id: stampOf(new Date(t)), prompt: text.slice(0, 2000), model: m, status: 'preparing', startedAt: new Date(t).toISOString(), endsAt: new Date(t + ttlMs).toISOString(), files: [], refused: [], sig: '' };
      d.timer = setTimeout(() => { if (cur === d) api.remove(); }, ttlMs); d.timer.unref?.();
      d.ready = begin(d);
      return { id: d.id, status: d.status };
    },
    // The overlay first (the next request gets main's file), then the page reloads, then the session, the worktree, the branch
    remove: async () => {
      const d = cur; if (!d) return { ok: true, removed: false };
      cur = null; clearTimeout(d.timer); clearInterval(d.scan);
      if (d.files.length) onChange(view());
      await d.ready; clearInterval(d.scan);
      await cleanup({ wt: d.wt, branch: d.branch, proc: d.proc });
      return { ok: true, removed: true, id: d.id };
    },
    overlay: (rel) => {
      const d = cur; if (!d?.wt || !d.files.length) return null;
      const p = 'public/' + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (p.includes('..') || !d.files.includes(p)) return null;
      const abs = path.join(d.wt, p);
      try { const real = realpathSync(abs); if (!real.startsWith(realpathSync(path.join(d.wt, 'public')) + path.sep) || !existsSync(real)) return null; return real; } catch { return null; }
    },
    route: async (req, res, url, { json, readBody }) => {
      if (url.pathname === '/api/demo' && req.method === 'GET') { json(res, 200, view()); return true; }
      if (url.pathname === '/api/demo' && req.method === 'POST') { try { json(res, 200, api.start(await readBody(req))); } catch (e) { json(res, e.status || 400, { error: e.message }); } return true; }
      if (url.pathname === '/api/demo/remove' && req.method === 'POST') { json(res, 200, await api.remove()); return true; }
      return false;
    },
    stop: () => { const d = cur; if (d) { clearInterval(d.scan); clearTimeout(d.timer); try { d.proc?.stop(); } catch {} } },
  };
  return api;
};
