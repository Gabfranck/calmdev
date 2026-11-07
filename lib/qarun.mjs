// The QA of a session without a terminal (phase 13, session QR; docs/qarun.md). A session writes one line,
//   QA: <chemin de parcours.json>
// and the server replays those journeys in Playwright's chrome-headless-shell, driven over CDP with Node's own
// WebSocket (as lib/capture.mjs does), outside the sandbox, then hands the session one line: ok/failures and the
// paths of resultats.json and planche.html. A second line photographs a page behind a login,
//   CAPTURE: <url> compte=<nom de compte de test>
// at 1440 and 390 px, light and dark when the page has a dark theme.
//
// The file is data, never code: every step is one of a closed list (STEPS), everything else is refused in one line,
// and the only JavaScript that runs in the page is the fixed PAGE_FN below, which receives the step's strings as
// arguments. Passwords never live in the file: a value is `{compte.motDePasse}` (the account named by the journey,
// read in the project's `environment` setting) and a clear value typed into a password field is refused.
// The browser reaches localhost, 127.0.0.1 and the LAN hosts the project declares, nothing else: the host resolver
// maps every other name to nothing (a redirect escapes a route, not the resolver) and every request to another host
// is failed and counted. A temporary profile, a bounded time per journey, the process killed whatever happens.
//
//   runQa({ file, worktree, project, environment, name?, timeoutMs?, chromePath?, driver? })
//     -> { ok: true, dir, total, passed, failed, blocked, blockedHosts, results, files: { results, board } }
//      | { ok: false, error, missing? }
//   captureConnected({ target, account, worktree, project, environment, name?, ... })
//     -> { ok: true, dir, files, url, account, dark, errors, warnings, blocked, blockedHosts } | { ok: false, error }
//   Neither throws.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findHeadlessShell } from './capture.mjs';
import { projectDir } from './names.mjs';

export const TIMEOUT_MS = 120000; // one journey, login included
export const CLICK_MS = 8000; // an element to click or fill must appear within this
export const WAIT_MS = 10000; // attendre_texte, attendre_url
export const MAX_PAUSE_MS = 5000; // the `attendre` step
export const MAX_STEPS = 200;
export const MAX_PARCOURS = 100;
export const MAX_PER_TURN = 5; // QA: lines of one turn; connected captures follow capture.mjs's own cap
export const WIDTHS = [1440, 390];
export const DEFAULT_WIDTH = 1280;
const MAX_HEIGHT = 16000;
const MAX_TEXT = 2000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// The closed list of steps: key -> what its value must be. `remplir` and `choisir` also take `valeur`.
export const STEPS = Object.freeze({
  aller: 'url', // http://<hôte autorisé>:<port>/…
  cliquer: 'cible', // visible text, else a CSS selector; « >> nth=N » picks the N-th visible match
  remplir: 'cible+valeur', // a field (selector, placeholder or label) and the text to type; \n is a line break
  choisir: 'cible+valeur', // a <select> and the option (its text or its value)
  touche: 'touche', // one key of KEYS
  attendre_texte: 'texte', // a visible text, within WAIT_MS
  attendre_url: 'texte', // a fragment of the address, within WAIT_MS
  attendre: 'ms', // a pause, MAX_PAUSE_MS at most
  capture: 'nom', // a PNG name: letters, digits, - and _
});
export const KEYS = Object.freeze({
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 }, Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
  Space: { code: 'Space', key: ' ', windowsVirtualKeyCode: 32, text: ' ' }, ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 }, Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 }, End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
});
// The keys a journey may carry besides its steps (the pilot's real files, qa/2026-11-02/parcours.json)
const TOP_KEYS = new Set(['id', 'titre', 'etapes', 'compte', 'app', 'sprint', 'ticket', 'attendu', 'incertain', 'note', 'prerequis', 'connexion', 'largeur']);

// ---------- the project's environment: LAN hosts, accounts, login routines ----------

const isPrivateIp = (h) => /^10\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h);
// The LAN hosts a project may declare: private IPv4 literals and .local names only; anything else is an error line
export function checkHosts(list) {
  const hosts = []; const errors = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const h = String(raw ?? '').trim().toLowerCase();
    if (!h) continue;
    if (isPrivateIp(h) || /^[a-z0-9-]+\.local$/.test(h)) { if (!hosts.includes(h)) hosts.push(h); } else errors.push(`hôte ${h} refusé : une adresse LAN privée (10.x, 172.16-31.x, 192.168.x) ou un nom .local`);
  }
  return { hosts, errors };
}
export const allowedHost = (hostname, hosts = []) => LOCAL_HOSTS.has(String(hostname).toLowerCase()) || hosts.includes(String(hostname).toLowerCase());
const isAllowedUrl = (url, hosts) => {
  if (/^(data|blob|about|chrome|devtools):/i.test(url)) return true;
  try { const u = new URL(url); return u.protocol === 'http:' && allowedHost(u.hostname, hosts); } catch { return false; }
};
export const resolverRules = (hosts = []) => '--host-resolver-rules=' + ['MAP * ~NOTFOUND', 'EXCLUDE localhost', 'EXCLUDE 127.0.0.1', ...hosts.map((h) => `EXCLUDE ${h}`)].join(', ');

// { hosts, accounts: { name: { identifiant, motDePasse } }, logins: { origin: { aller, identifiant, motDePasse, valider, attendre_texte? } }, env: { NAME: value } }
// read from the project's `environment` setting (session ENV; lanHosts/hosts, accounts/comptes, logins/connexions)
export function readEnvironment(e) {
  const o = e && typeof e === 'object' ? e : {};
  const { hosts, errors } = checkHosts(o.lanHosts ?? o.hosts ?? []);
  const accounts = {};
  for (const [name, a] of Object.entries(o.accounts ?? o.comptes ?? {})) if (a && typeof a === 'object') accounts[name] = { identifiant: String(a.identifiant ?? a.login ?? name), motDePasse: String(a.motDePasse ?? a.password ?? '') };
  const logins = {};
  for (const [k, l] of Object.entries(o.logins ?? o.connexions ?? {})) {
    if (!l || typeof l !== 'object') continue;
    let origin; try { origin = new URL(l.aller || k).origin; } catch { errors.push(`connexion ${k} : adresse illisible`); continue; }
    logins[origin] = { aller: String(l.aller || k), identifiant: String(l.identifiant || ''), motDePasse: String(l.motDePasse || ''), valider: String(l.valider || ''), attendre_texte: l.attendre_texte ? String(l.attendre_texte) : null };
  }
  const env = {}; for (const [k, v] of Object.entries(o.env ?? o.variables ?? {})) if (/^[A-Z][A-Z0-9_]*$/.test(k)) env[k] = String(v);
  return { hosts, accounts, logins, env, errors };
}

// ---------- the lines a session writes ----------

// QA: lines of a turn's text and of the state block's string fields; unique, in order, MAX_PER_TURN at most
export function parseQaLines(text, state) {
  const out = [];
  const scan = (s) => { for (const m of String(s ?? '').matchAll(/^[ \t>*-]*QA:[ \t]*(\S+)[ \t]*$/gm)) if (!out.includes(m[1])) out.push(m[1]); };
  scan(text);
  if (state && typeof state === 'object') for (const v of Object.values(state)) if (typeof v === 'string') scan(v);
  return out.slice(0, MAX_PER_TURN);
}
// CAPTURE: <url> compte=<nom> lines (lib/capture.mjs ignores a line with two tokens, so these are ours)
export function parseConnectedCaptures(text, state) {
  const out = []; const seen = new Set();
  const scan = (s) => { for (const m of String(s ?? '').matchAll(/^[ \t>*-]*CAPTURE:[ \t]*(\S+)[ \t]+compte=(\S+)[ \t]*$/gm)) { const k = m[1] + '|' + m[2]; if (!seen.has(k)) { seen.add(k); out.push({ target: m[1], account: m[2] }); } } };
  scan(text);
  if (state && typeof state === 'object') for (const v of Object.values(state)) if (typeof v === 'string') scan(v);
  return out.slice(0, 30);
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);
// The journeys file: a .json whose real path is inside the session's worktree or the project
export function checkQaFile(target, { worktree, project } = {}) {
  const t = String(target ?? '').trim();
  if (!t) return { ok: false, error: 'QA refusée : fichier vide' };
  if (!/\.json$/i.test(t)) return { ok: false, error: `QA refusée : un fichier de parcours finit en .json (${t})` };
  const roots = [worktree, project].filter(Boolean).map((r) => { try { return realpathSync(r); } catch { return null; } }).filter(Boolean);
  if (!roots.length) return { ok: false, error: 'QA refusée : ni worktree ni projet pour situer le fichier' };
  let real; try { real = realpathSync(path.resolve(worktree || project, t)); } catch { return { ok: false, error: `QA refusée : fichier introuvable (${t})` }; }
  if (!roots.some((r) => inside(r, real))) return { ok: false, error: `QA refusée : ${t} sort du worktree et du projet (${real})` };
  if (!statSync(real).isFile()) return { ok: false, error: `QA refusée : ${t} n’est pas un fichier` };
  return { ok: true, file: real };
}
export function checkCaptureUrl(target, hosts) {
  const t = String(target ?? '').trim();
  let u; try { u = new URL(t); } catch { return { ok: false, error: `capture refusée : adresse illisible (${t})` }; }
  if (u.protocol !== 'http:') return { ok: false, error: `capture refusée : seul http:// est accepté (${t})` };
  if (!allowedHost(u.hostname, hosts)) return { ok: false, error: `capture refusée : hôte ${u.hostname} hors du Mac et des hôtes LAN déclarés` };
  if (u.username || u.password) return { ok: false, error: 'capture refusée : identifiants dans l’adresse' };
  return { ok: true, url: u.href };
}

// ---------- the journeys: validation and preparation ----------

const slugOk = (s) => /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(s);
const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;

// One step -> { kind, ...fields } or { error } (one line, the step's number first)
export function validateStep(step, n, hosts = []) {
  const at = `étape ${n} : `;
  if (!step || typeof step !== 'object' || Array.isArray(step)) return { error: at + 'une étape est un objet' };
  const keys = Object.keys(step); const kinds = keys.filter((k) => k in STEPS);
  if (kinds.length !== 1) return { error: at + (kinds.length ? `une seule action par étape (${kinds.join(', ')})` : `étape inconnue « ${keys.join(', ') || '(vide)'} » ; connues : ${Object.keys(STEPS).join(', ')}`) };
  const kind = kinds[0]; const shape = STEPS[kind];
  const extra = keys.filter((k) => k !== kind && !(shape === 'cible+valeur' && k === 'valeur'));
  if (extra.length) return { error: at + `clé inconnue « ${extra[0]} » sur ${kind}` };
  const v = step[kind];
  if (shape === 'ms') { if (!Number.isInteger(v) || v < 0 || v > MAX_PAUSE_MS) return { error: at + `attendre : un entier de 0 à ${MAX_PAUSE_MS} ms` }; return { kind, ms: v }; }
  if (!str(v)) return { error: at + `${kind} : un texte non vide de ${MAX_TEXT} caractères au plus` };
  if (shape === 'url') { const r = checkCaptureUrl(v, hosts); if (!r.ok) return { error: at + r.error.replace(/^capture refusée : /, '') }; return { kind, url: r.url }; }
  if (shape === 'touche') { if (!(v in KEYS)) return { error: at + `touche inconnue « ${v} » ; connues : ${Object.keys(KEYS).join(', ')}` }; return { kind, key: v }; }
  if (shape === 'nom') { if (!slugOk(v)) return { error: at + `capture : un nom en lettres, chiffres, - et _ (${v})` }; return { kind, name: v }; }
  if (shape === 'cible+valeur') { if (!str(step.valeur) && step.valeur !== '') return { error: at + `${kind} : valeur manquante` }; return { kind, target: v, value: String(step.valeur) }; }
  return { kind, [shape === 'texte' ? 'text' : 'target']: v };
}

// Split « cible >> nth=N » (and the harmless « >> visible »)
export function parseTarget(spec) {
  let nth = 0; let s = String(spec);
  for (const part of s.split('>>').slice(1)) { const m = /^\s*nth=(\d+)\s*$/.exec(part); if (m) nth = Number(m[1]); else if (!/^\s*visible\s*$/.test(part)) return { error: `cible illisible « ${spec} » (seul >> nth=N est connu)` }; }
  return { spec: s.split('>>')[0].trim(), nth };
}

// `{compte.identifiant}`, `{compte.motDePasse}`, `{env.NOM}` and the pilot's `{NOM}` are the only holes; a hole that
// stays open means the journey is not played (the pilot's « non joué : valeur à résoudre »)
export function resolveValue(value, { account, env = {} } = {}) {
  const holes = [...String(value).matchAll(/\{([A-Za-z_][\w.]*)\}/g)];
  let out = String(value); let secret = false;
  for (const [hole, name] of holes) {
    let v = null;
    if (name === 'compte.identifiant') v = account?.identifiant ?? null;
    else if (name === 'compte.motDePasse') { v = account?.motDePasse || null; secret = true; }
    else if (/^env\./.test(name)) { v = env[name.slice(4)] ?? null; secret = true; }
    else if (/^[A-Z][A-Z0-9_]*$/.test(name)) { v = env[name] ?? null; secret = true; }
    if (v === null) return { error: `valeur à résoudre (${hole})` };
    out = out.split(hole).join(v);
  }
  return { value: out, secret };
}

// One journey of the file -> { id, meta, width, steps } or { id, meta, error }; the login routine is prepended when
// the journey names an account (docs/qarun.md, « La connexion »)
export function prepareParcours(p, i, list, environment) {
  const meta = { id: null, sprint: null, ticket: null, app: null, compte: null, titre: null, attendu: null, incertain: false };
  const bad = (error) => ({ ...meta, error });
  if (!p || typeof p !== 'object' || Array.isArray(p)) return bad(`parcours ${i + 1} : un objet`);
  for (const k of ['id', 'sprint', 'ticket', 'app', 'compte', 'titre', 'attendu']) if (p[k] != null) meta[k] = String(p[k]).slice(0, 1000);
  meta.incertain = p.incertain === true;
  if (!slugOk(String(p.id ?? ''))) return bad(`parcours ${i + 1} : id manquant ou illisible`);
  const unknown = Object.keys(p).filter((k) => !TOP_KEYS.has(k));
  if (unknown.length) return bad(`clé inconnue « ${unknown[0]} » (connues : ${[...TOP_KEYS].join(', ')})`);
  if (!Array.isArray(p.etapes) || !p.etapes.length) return bad('etapes : une liste non vide');
  if (p.etapes.length > MAX_STEPS) return bad(`etapes : ${MAX_STEPS} au plus`);
  let width = DEFAULT_WIDTH;
  if (p.largeur !== undefined) { if (!Number.isInteger(p.largeur) || p.largeur < 320 || p.largeur > 2560) return bad('largeur : un entier de 320 à 2560'); width = p.largeur; }
  const { hosts, accounts, logins, env } = environment;
  const accountName = meta.compte && !/^(aucun|jeton)\b/i.test(meta.compte) ? meta.compte : null;
  const account = accountName ? accounts[accountName] : null;
  const ctx = { account, env };
  const steps = [];
  const add = (raw, n, routine) => {
    const s = validateStep(raw, n, hosts); if (s.error) return s.error;
    if (s.kind === 'cliquer' || s.kind === 'remplir' || s.kind === 'choisir') { const t = parseTarget(s.target); if (t.error) return `étape ${n} : ${t.error}`; s.spec = t.spec; s.nth = t.nth; }
    if ('value' in s) { const r = resolveValue(s.value, ctx); if (r.error) return `étape ${n} : non joué : ${r.error}`; s.value = r.value; s.secret = r.secret; }
    steps.push({ ...s, n, routine: !!routine }); return null;
  };
  // The login routine: the journey of the file whose id is base-login-<app> (its `remplir` of its own account becomes
  // this account; its captures are dropped), else the environment's login for the origin of the first `aller`
  const login = accountName && p.connexion !== 'incluse' && !/^base-login-/.test(meta.id) ? loginSteps(p, list, environment, accountName) : null;
  if (login?.error) return bad(login.error);
  if (login) for (const [k, raw] of login.steps.entries()) { const e = add(raw, `c${k + 1}`, true); if (e) return bad(e.replace(/^étape c\d+ : /, 'connexion : ')); }
  for (const [k, raw] of p.etapes.entries()) { const e = add(raw, k + 1); if (e) return bad(e); }
  return { ...meta, width, steps, account: accountName };
}

function loginSteps(p, list, { accounts, logins }, accountName) {
  if (!accounts[accountName]) return { error: `non joué : compte « ${accountName} » inconnu dans le réglage environment du projet` };
  const routine = Array.isArray(list) ? list.find((q) => q && (q.id === `base-login-${p.app}` || (q.connexion === 'routine' && q.app === p.app))) : null;
  if (routine && Array.isArray(routine.etapes)) {
    // Reused for this account: its own name becomes {compte.identifiant}; a clear value typed into a field whose
    // target names a password becomes {compte.motDePasse} (the pilot's files wrote « password » there)
    const own = routine.compte ? String(routine.compte) : null;
    return { steps: routine.etapes.filter((s) => !(s && typeof s === 'object' && 'capture' in s)).map((s) => {
      if (!s || typeof s !== 'object' || !('remplir' in s)) return s;
      if (own && s.valeur === own) return { ...s, valeur: '{compte.identifiant}' };
      if (/pass|mdp|mot.de.passe/i.test(String(s.remplir)) && !/\{[\w.]+\}/.test(String(s.valeur))) return { ...s, valeur: '{compte.motDePasse}' };
      return s;
    }) };
  }
  const first = p.etapes.find((s) => s && typeof s === 'object' && typeof s.aller === 'string');
  let origin = null; try { origin = first ? new URL(first.aller).origin : null; } catch {}
  const l = origin ? logins[origin] : null;
  if (!l) return { error: `non joué : aucune routine de connexion pour ${origin || 'ce parcours'} (parcours base-login-${p.app || '<app>'} du fichier, ou logins du réglage environment)` };
  return { steps: loginFromEnvironment(l) };
}
const loginFromEnvironment = (l) => [{ aller: l.aller }, { remplir: l.identifiant, valeur: '{compte.identifiant}' }, { remplir: l.motDePasse, valeur: '{compte.motDePasse}' }, { cliquer: l.valider }, ...(l.attendre_texte ? [{ attendre_texte: l.attendre_texte }] : [])];

// The whole file -> { prepared: [...] } or { error }
export function prepareFile(file, environment) {
  let list; try { list = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { error: `QA refusée : ${path.basename(file)} illisible (${e.message.slice(0, 80)})` }; }
  if (!Array.isArray(list)) return { error: 'QA refusée : le fichier est une liste de parcours' };
  if (!list.length) return { error: 'QA refusée : aucun parcours' };
  if (list.length > MAX_PARCOURS) return { error: `QA refusée : ${MAX_PARCOURS} parcours au plus (${list.length})` };
  const prepared = list.map((p, i) => prepareParcours(p, i, list, environment));
  const ids = new Set(); for (const p of prepared) { if (p.id && ids.has(p.id)) return { error: `QA refusée : id en double (${p.id})` }; if (p.id) ids.add(p.id); }
  return { prepared };
}

// ---------- notes, folder names, the board ----------

export const qaFolderName = (stop, file) => `${stop ?? 'tour'}-${path.basename(String(file)).replace(/\.json$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(-60) || 'parcours'}`;

export function qaNote(r, target) {
  if (!r.ok) return `QA ${target} : ${r.error}`;
  const b = r.blocked ? `, ${r.blocked} requête${r.blocked > 1 ? 's' : ''} hors Mac bloquée${r.blocked > 1 ? 's' : ''}` : '';
  return `QA ${target} : ${r.passed}/${r.total} ok, ${r.failed} échec${r.failed > 1 ? 's' : ''}${b} : ${r.files.results} et ${r.files.board}`;
}
export function connectedCaptureNote(r, target, account) {
  if (!r.ok) return `CAPTURE ${target} (compte ${account}) : ${r.error}`;
  const n = r.errors.length;
  return `CAPTURE ${target} (compte ${account}) : ${r.dir} (${n} erreur${n > 1 ? 's' : ''} de console, sombre : ${r.dark ? 'oui' : 'non'}${r.blocked ? `, ${r.blocked} requête${r.blocked > 1 ? 's' : ''} hors Mac bloquée${r.blocked > 1 ? 's' : ''}` : ''})`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The pilot's board (qa/2026-11-02/planche.html): failures first, each with its console, its HTTP errors, its raw keys
// and its captures; relative paths, so the folder moves as one
export function renderBoard({ title, results, blocked = 0, blockedHosts = [] }) {
  const ko = results.filter((r) => !r.ok); const ok = results.filter((r) => r.ok);
  const details = (label, list) => list.length ? `<details><summary>${list.length} ${label}</summary><pre>${esc(list.join('\n'))}</pre></details>` : '';
  const art = (r) => `<article class="${r.ok ? 'ok' : 'ko'}"><h2>${esc(r.id)} · ${esc(r.titre || '')}</h2><p class="m">${esc([r.sprint, r.ticket, r.app, r.compte, r.incertain ? 'incertain' : null].filter(Boolean).join(' · '))}</p>
<p>${r.ok ? '✓ joué' : '✗ ' + esc(r.echec)}</p>${r.attendu ? `<p class="m">Attendu : ${esc(r.attendu)}</p>` : ''}
${details('erreurs console', r.console)}${details('réponses ≥ 400', r.http)}${details('clés brutes', r.cles)}${r.bloquees ? `<p class="w">${r.bloquees} requête(s) hors Mac bloquée(s) : ${esc(r.hotesBloques.join(', '))}</p>` : ''}
${r.captures.map((c) => `<img loading="lazy" src="captures/${esc(c)}" alt="">`).join('')}</article>`;
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px;background:#f6f7f8;color:#15191e}h1{font-size:20px}article{background:#fff;border-radius:10px;padding:14px 16px;margin:0 0 14px;border-left:4px solid #2a9d5c}article.ko{border-left-color:#d64545}h2{font-size:15px;margin:0}.m{color:#5b6570;margin:2px 0}.w{color:#b26b00}img{max-width:100%;border:1px solid #e3e6ea;border-radius:6px;margin-top:8px}pre{white-space:pre-wrap;font-size:12px}</style>
<h1>${esc(title)} · ${results.length} parcours · ${ok.length} joués · ${ko.length} en échec</h1>
<p class="m">À juger : chaque capture ; les échecs d'abord.${blocked ? ` ${blocked} requête(s) hors Mac bloquée(s) (${esc(blockedHosts.join(', '))}).` : ''}</p>
${[...ko, ...ok].map(art).join('\n')}
`;
}

// ---------- the browser ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 1; const waiting = new Map(); const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && waiting.has(msg.id)) { const { ok, ko } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? ko(new Error(msg.error.message)) : ok(msg.result); }
    else if (msg.method) for (const fn of listeners) fn(msg);
  };
  ws.onclose = () => { for (const { ko } of waiting.values()) ko(new Error('CDP fermé')); waiting.clear(); };
  return {
    open: new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('CDP injoignable')); }),
    send: (method, params = {}, sessionId) => new Promise((ok, ko) => { const id = next++; waiting.set(id, { ok, ko }); ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); }),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    close: () => { try { ws.close(); } catch {} },
  };
}

function launch(exe, profile, hosts, extra = []) {
  const args = [...extra,
    '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars', '--disable-gpu',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--force-color-profile=srgb', '--no-proxy-server', '--lang=fr-FR',
    resolverRules(hosts), 'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
  const ws = new Promise((ok, ko) => {
    let buf = '';
    proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) ok(m[1]); });
    proc.on('error', (e) => ko(new Error('lancement impossible : ' + e.message)));
    proc.on('exit', (code) => ko(new Error(`le navigateur s’est arrêté (code ${code}) : ${buf.trim().split('\n').pop() || ''}`)));
  });
  return { proc, ws };
}

// One browser process, started on demand and killed on a timeout, so the next journey gets a fresh one
function browserOf({ exe, profile, hosts, track }) {
  let client = null;
  return {
    async client() {
      if (client) return client;
      let { proc, ws } = launch(exe, profile, hosts); track.proc = proc; let endpoint;
      try { endpoint = await ws; } catch (e) { // a session's sandbox refuses the mach port rendezvous: one process then
        if (!/mach_port|bootstrap_check_in/.test(e.message)) throw e;
        ({ proc, ws } = launch(exe, profile, hosts, ['--single-process', '--no-zygote'])); track.proc = proc; endpoint = await ws;
      }
      client = cdp(endpoint); track.client = client; await client.open; return client;
    },
    async kill() { client?.close(); client = null; track.client = null; const p = track.proc; track.proc = null; if (p && p.exitCode === null && p.signalCode === null) { const gone = new Promise((ok) => p.once('exit', ok)); try { p.kill('SIGKILL'); } catch {} await Promise.race([gone, sleep(3000)]); } },
  };
}

// The only code run in a page. It receives the step's strings as arguments and returns plain data: the N-th
// visible element matching `spec` (exact visible text, else CSS selector, else a text fragment, else a placeholder or
// aria-label), scrolled into view, with its centre; `mode` focus selects its content, `mode` select picks an option.
const PAGE_FN = `function (spec, mode, nth, arg) {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    for (let p = el; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden') return false; if (p === el && Number(cs.opacity) === 0) return false; }
    const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1;
  };
  const innermost = (list) => list.filter((el) => !list.some((o) => o !== el && el.contains(o)));
  const byText = (text, exact) => { const out = []; for (const el of document.querySelectorAll('body *')) { if (!el.childNodes.length || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue; const t = norm(el.innerText != null ? el.innerText : el.textContent); if (t && (exact ? t === text : t.includes(text))) out.push(el); } return innermost(out); };
  const byField = (text) => [...document.querySelectorAll('input, textarea, select, button, [aria-label]')].filter((el) => norm(el.placeholder) === text || norm(el.getAttribute('aria-label')) === text || (el.labels && [...el.labels].some((l) => norm(l.innerText) === text)));
  let text = /^text=/.test(spec) ? spec.slice(5).replace(/^"(.*)"$/, '$1') : spec;
  let all = byText(text, true).filter(visible);
  if (!all.length && !/^text=/.test(spec)) { try { all = [...document.querySelectorAll(spec)].filter(visible); } catch (e) { all = []; } }
  if (!all.length) all = byField(text).filter(visible);
  if (!all.length) all = byText(text, false).filter(visible);
  const el = all[nth] || null;
  if (!el) return { count: all.length };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const out = { count: all.length, x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase() };
  if (mode === 'focus') { el.focus(); if (typeof el.select === 'function') { try { el.select(); } catch (e) {} } else if (el.isContentEditable) getSelection().selectAllChildren(el); }
  if (mode === 'select') {
    const opt = [...(el.options || [])].find((o) => norm(o.textContent) === norm(arg) || o.value === arg);
    if (!opt) return { count: all.length, missing: true, tag: out.tag };
    el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return out;
}`;
const TEXT_FN = `function () { return document.body ? document.body.innerText : ''; }`;
const HREF_FN = `function () { return location.href; }`;
const RAW_KEY = /\b[a-z]+(\.[a-zA-Z]+){2,}\b/g; // « home.tasks.title »: a translation key shown raw
const NOT_KEYS = /^(www\.|localhost|\d|[a-z0-9-]+\.(com|fr|org|net|io|dev|local)\b)/i;

// A page (one target of one browser context) with the step engine
async function openPage(client, width, hosts, collect) {
  const { browserContextId } = await client.send('Target.createBrowserContext', { disposeOnDetach: true });
  // « Copier le lien » then « Lien copié » : the clipboard is refused in a headless context unless granted
  try { await client.send('Browser.grantPermissions', { browserContextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); } catch {}
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => client.send(m, p, sessionId);
  const requests = new Map(); let ctxId = null; let curWidth = width; let mainFrame = null;
  const off = client.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === 'Runtime.executionContextCreated') { const aux = p.context?.auxData || {}; if (aux.isDefault !== false && (!mainFrame || aux.frameId === mainFrame)) ctxId = p.context.id; }
    else if (m.method === 'Runtime.executionContextsCleared') ctxId = null;
    else if (m.method === 'Fetch.requestPaused') {
      if (isAllowedUrl(p.request.url, hosts)) S('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      else { collect.blocked(p.request.url); S('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    } else if (m.method === 'Network.requestWillBeSent') requests.set(p.requestId, p.request?.method || 'GET');
    else if (m.method === 'Network.responseReceived') {
      const st = p.response?.status || 0;
      if (st >= 400) { let u = p.response.url; try { u = new URL(u).pathname; } catch {} collect.http(`${st} ${requests.get(p.requestId) || 'GET'} ${u}`); }
      requests.delete(p.requestId);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (p.type === 'error' || p.type === 'assert') collect.error(text); else if (p.type === 'warning') collect.warning(text);
    } else if (m.method === 'Runtime.exceptionThrown') { const d = p.exceptionDetails || {}; collect.error(d.exception?.description || d.text || 'exception'); }
    else if (m.method === 'Log.entryAdded') {
      const e = p.entry || {}; if (/BlockedByClient|ERR_NAME_NOT_RESOLVED/.test(e.text || '')) return;
      const text = e.url ? `${e.text} (${e.url})` : e.text;
      if (e.level === 'error') collect.error(text); else if (e.level === 'warning') collect.warning(text);
    }
  });
  await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  for (const d of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await S(d, {});
  try { mainFrame = (await S('Page.getFrameTree', {})).frameTree?.frame?.id || null; } catch {} // only the top frame's context runs PAGE_FN
  const viewport = async (w) => { curWidth = w; await S('Emulation.setDeviceMetricsOverride', { width: w, height: w <= 480 ? 844 : w >= 1440 ? 900 : 800, deviceScaleFactor: 1, mobile: w <= 480 }); };
  await viewport(width);
  // The fixed function source, the step's strings as arguments: nothing of the file is ever part of the code
  const evalFn = async (fn, args = []) => {
    if (ctxId === null) { await sleep(100); if (ctxId === null) return undefined; }
    try { const r = await S('Runtime.callFunctionOn', { functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, executionContextId: ctxId }); return r.result?.value; }
    catch { return undefined; } // the context went away with a navigation: the caller polls again
  };
  const find = async (spec, nth, mode, arg, deadline) => {
    let last = { count: 0 };
    while (Date.now() < deadline) { last = (await evalFn(PAGE_FN, [spec, mode, nth, arg ?? null])) || { count: 0 }; if (last.x !== undefined || last.missing) return last; await sleep(150); }
    return last;
  };
  const click = async (x, y) => { // a real pointer: move with no button held, then press and release
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
  };
  const page = {
    viewport,
    async goto(url) {
      const loaded = new Promise((ok) => { const o = client.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { o(); ok(); } }); });
      await S('Page.navigate', { url }); await Promise.race([loaded, sleep(WAIT_MS)]); await sleep(400);
    },
    async run(step) {
      const fail = (why) => { throw new Error(`étape ${step.n} : ${why}`); };
      const nothing = (r, what) => fail(r.count ? `${what} « ${step.spec} » : ${r.count} visible${r.count > 1 ? 's' : ''}, pas de n° ${step.nth}` : `${what} « ${step.spec} » introuvable ou caché (${Math.round(CLICK_MS / 1000)} s)`);
      switch (step.kind) {
        case 'aller': return page.goto(step.url);
        case 'cliquer': { const r = await find(step.spec, step.nth, 'find', null, Date.now() + CLICK_MS); if (r.x === undefined) nothing(r, 'cliquer'); return click(r.x, r.y); }
        case 'remplir': {
          const r = await find(step.spec, step.nth, 'focus', null, Date.now() + CLICK_MS); if (r.x === undefined) nothing(r, 'remplir');
          if (r.type === 'password' && !step.secret) fail('mot de passe en clair dans le parcours : écris {compte.motDePasse}');
          await S('Input.insertText', { text: step.value }); await sleep(150); return;
        }
        case 'choisir': { const r = await find(step.spec, step.nth, 'select', step.value, Date.now() + CLICK_MS); if (r.x === undefined && !r.missing) nothing(r, 'choisir'); if (r.missing) fail(`choisir « ${step.spec} » : option « ${step.value} » absente`); if (r.tag !== 'select') fail(`choisir « ${step.spec} » : pas un <select>`); await sleep(150); return; }
        case 'touche': { const k = KEYS[step.key]; await S('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k }); await S('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined }); await sleep(250); return; }
        case 'attendre_texte': { const want = step.text.replace(/\s+/g, ' ').trim(); const end = Date.now() + WAIT_MS; while (Date.now() < end) { const t = String(await evalFn(TEXT_FN) || '').replace(/\s+/g, ' '); if (t.includes(want)) return; await sleep(200); } fail(`attendre_texte « ${step.text} » : absent après ${Math.round(WAIT_MS / 1000)} s`); break; }
        case 'attendre_url': { const end = Date.now() + WAIT_MS; while (Date.now() < end) { if (String(await evalFn(HREF_FN) || '').includes(step.text)) return; await sleep(200); } fail(`attendre_url « ${step.text} » : adresse ${await evalFn(HREF_FN)} après ${Math.round(WAIT_MS / 1000)} s`); break; }
        case 'attendre': return sleep(step.ms);
        case 'capture': return; // the caller shoots: it knows the folder
        default: fail(`étape inconnue ${step.kind}`);
      }
    },
    async shoot() {
      const { cssContentSize } = await S('Page.getLayoutMetrics', {});
      const height = Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(cssContentSize?.height || 900)));
      const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: curWidth, height, scale: 1 } });
      return Buffer.from(data, 'base64');
    },
    async rawKeys() { const t = String(await evalFn(TEXT_FN) || ''); return [...new Set((t.match(RAW_KEY) || []).filter((k) => !NOT_KEYS.test(k)))]; },
    dark: (on) => S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }] }),
    async close() { off(); try { await client.send('Target.closeTarget', { targetId }); } catch {} try { await client.send('Target.disposeBrowserContext', { browserContextId }); } catch {} },
  };
  return page;
}

const collector = () => {
  const o = { errors: [], warnings: [], http: [], blocked: 0, blockedHosts: new Set() };
  const keep = (list, t) => { t = String(t).slice(0, 500); if (!list.includes(t)) list.push(t); };
  return { ...o, error: (t) => keep(o.errors, t), warning: (t) => keep(o.warnings, t), http: (t) => keep(o.http, t), blocked: (url) => { o.blocked++; try { o.blockedHosts.add(new URL(url).host); } catch {} }, state: o };
};
const hide = (text, secrets) => { let t = String(text); for (const s of secrets) if (s && s.length >= 3) t = t.split(s).join('•••'); return t; };

// The real driver: every journey in one browser, a fresh context each, a bounded time each, the browser killed on a
// timeout and started again for the next. Writes the PNG of each capture (and <id>-echec.png on a failure) in
// `captures`, returns the results in the order of the file.
async function runParcours({ exe, profile, hosts, prepared, timeoutMs, captures, track, secrets }) {
  const browser = browserOf({ exe, profile, hosts, track });
  const results = [];
  let totalBlocked = 0; const allHosts = new Set();
  for (const p of prepared) {
    const base = { id: p.id, sprint: p.sprint, ticket: p.ticket, app: p.app, compte: p.compte, titre: p.titre, attendu: p.attendu, incertain: p.incertain, ok: false, echec: null, console: [], http: [], cles: [], captures: [], bloquees: 0, hotesBloques: [], ms: 0 };
    if (p.error) { results.push({ ...base, echec: hide(p.error, secrets) }); continue; }
    const t0 = Date.now(); const c = collector(); let page = null; let timer;
    const shot = async (name) => { const f = `${p.id}-${name}.png`; writeFileSync(path.join(captures, f), await page.shoot()); base.captures.push(f); for (const k of await page.rawKeys()) if (!base.cles.includes(k)) base.cles.push(k); };
    const work = (async () => {
      page = await openPage(await browser.client(), p.width, hosts, c);
      for (const step of p.steps) { if (step.kind === 'capture') await shot(step.name); else await page.run(step); }
    })();
    const timeout = new Promise((_, ko) => { timer = setTimeout(() => ko(new Error(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`)), timeoutMs); });
    work.catch(() => {});
    try { await Promise.race([work, timeout]); base.ok = true; }
    catch (e) {
      if (!page && /lancement impossible|s’est arrêté|CDP/.test(e.message)) { clearTimeout(timer); await browser.kill(); throw e; } // no browser at all: the whole QA is impossible, not 39 failures
      base.echec = hide(e.message, secrets);
      if (page && !/délai de/.test(e.message)) { try { await Promise.race([shot('echec'), sleep(5000)]); } catch {} }
    } finally {
      clearTimeout(timer);
      if (/délai de/.test(base.echec || '')) await browser.kill(); else if (page) await Promise.race([page.close(), sleep(3000)]);
    }
    const s = c.state;
    base.console = [...s.errors, ...s.warnings].map((t) => hide(t, secrets)); base.http = s.http; base.bloquees = s.blocked; base.hotesBloques = [...s.blockedHosts];
    totalBlocked += s.blocked; for (const h of s.blockedHosts) allHosts.add(h);
    base.ms = Date.now() - t0;
    results.push(base);
  }
  await browser.kill();
  return { results, blocked: totalBlocked, blockedHosts: [...allHosts] };
}
export const chromeQaDriver = runParcours;

async function cleanup(track, profile) {
  track.client?.close();
  const p = track.proc;
  if (p && p.exitCode === null && p.signalCode === null) { const gone = new Promise((ok) => p.once('exit', ok)); try { p.kill('SIGKILL'); } catch {} await Promise.race([gone, sleep(3000)]); }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

// ---------- the two entry points ----------

export async function runQa({ file, worktree, project, environment, name, timeoutMs = TIMEOUT_MS, chromePath, env = process.env, driver = chromeQaDriver, outDir } = {}) {
  const f = checkQaFile(file, { worktree, project });
  if (!f.ok) return f;
  const E = readEnvironment(environment);
  if (E.errors.length) return { ok: false, error: 'QA refusée : réglage environment : ' + E.errors[0] };
  const { prepared, error } = prepareFile(f.file, E);
  if (error) return { ok: false, error };
  const exe = chromePath || findHeadlessShell({ env });
  if (!exe) return { ok: false, missing: true, error: 'QA impossible : chrome-headless-shell introuvable (npx playwright install chromium-headless-shell, ou CHROME_PATH)' };
  if (typeof WebSocket === 'undefined') return { ok: false, error: `QA impossible : Node 22+ requis (${process.version})` };
  const root = outDir || projectDir(worktree || project, 'qa', name || qaFolderName(null, f.file));
  const captures = path.join(root, 'captures');
  let profile;
  try { mkdirSync(captures, { recursive: true }); profile = mkdtempSync(path.join(tmpdir(), 'escadrille-qa-')); } catch (e) { return { ok: false, error: 'QA impossible : ' + e.message }; }
  const secrets = [...Object.values(E.accounts).map((a) => a.motDePasse), ...Object.values(E.env)].filter(Boolean);
  const track = {};
  try {
    const r = await driver({ exe, profile, hosts: E.hosts, prepared, timeoutMs, captures, track, secrets });
    const results = r.results; const passed = results.filter((x) => x.ok).length;
    const files = { results: path.join(root, 'resultats.json'), board: path.join(root, 'planche.html') };
    writeFileSync(files.results, JSON.stringify(results, null, 1) + '\n');
    writeFileSync(files.board, renderBoard({ title: `QA ${path.basename(f.file)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, results, blocked: r.blocked, blockedHosts: r.blockedHosts }));
    return { ok: true, dir: root, total: results.length, passed, failed: results.length - passed, blocked: r.blocked, blockedHosts: r.blockedHosts, results, files };
  } catch (e) {
    return { ok: false, error: 'QA impossible : ' + hide(e.message, secrets) };
  } finally {
    await cleanup(track, profile);
  }
}

// A page behind a login, photographed at WIDTHS, light then dark (kept only when the page changes)
async function connectedDriver({ exe, profile, hosts, steps, url, track, captures }) {
  const browser = browserOf({ exe, profile, hosts, track });
  const c = collector();
  const page = await openPage(await browser.client(), WIDTHS[0], hosts, c);
  for (const step of steps) await page.run(step);
  await page.goto(url);
  const shots = []; let dark = false;
  for (const w of WIDTHS) { await page.viewport(w); await sleep(300); shots.push([`${w}.png`, await page.shoot()]); }
  await page.dark(true); await sleep(400);
  for (const [i, w] of WIDTHS.entries()) { await page.viewport(w); await sleep(300); const png = await page.shoot(); if (!png.equals(shots[i][1])) { dark = true; shots.push([`${w}-sombre.png`, png]); } }
  await page.close(); await browser.kill();
  const s = c.state;
  return { shots, dark, errors: s.errors, warnings: s.warnings, http: s.http, blocked: s.blocked, blockedHosts: [...s.blockedHosts] };
}
export const chromeConnectedDriver = connectedDriver;

export async function captureConnected({ target, account, worktree, project, environment, name, timeoutMs = TIMEOUT_MS, chromePath, env = process.env, driver = chromeConnectedDriver } = {}) {
  const E = readEnvironment(environment);
  if (E.errors.length) return { ok: false, error: 'capture refusée : réglage environment : ' + E.errors[0] };
  const t = checkCaptureUrl(target, E.hosts);
  if (!t.ok) return t;
  if (!worktree && !project) return { ok: false, error: 'capture refusée : pas de worktree pour ranger les images' };
  const acc = E.accounts[String(account)];
  if (!acc) return { ok: false, error: `capture refusée : compte « ${account} » inconnu dans le réglage environment du projet` };
  const l = E.logins[new URL(t.url).origin];
  if (!l) return { ok: false, error: `capture refusée : aucune routine de connexion pour ${new URL(t.url).origin} dans le réglage environment (logins)` };
  const steps = []; const ctx = { account: acc, env: E.env };
  for (const [k, raw] of loginFromEnvironment(l).entries()) {
    const s = validateStep(raw, `c${k + 1}`, E.hosts); if (s.error) return { ok: false, error: 'capture refusée : connexion : ' + s.error };
    if (s.target !== undefined) { const p = parseTarget(s.target); s.spec = p.spec; s.nth = p.nth; }
    if ('value' in s) { const r = resolveValue(s.value, ctx); if (r.error) return { ok: false, error: 'capture refusée : connexion : ' + r.error }; s.value = r.value; s.secret = r.secret; }
    steps.push({ ...s, n: `connexion ${k + 1}` });
  }
  const exe = chromePath || findHeadlessShell({ env });
  if (!exe) return { ok: false, missing: true, error: 'capture impossible : chrome-headless-shell introuvable (npx playwright install chromium-headless-shell, ou CHROME_PATH)' };
  if (typeof WebSocket === 'undefined') return { ok: false, error: `capture impossible : Node 22+ requis (${process.version})` };
  const dir = projectDir(worktree || project, 'captures', name || `tour-${String(account).replace(/[^a-z0-9]+/gi, '-')}-${t.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(-50)}`);
  let profile;
  try { profile = mkdtempSync(path.join(tmpdir(), 'escadrille-qa-')); } catch (e) { return { ok: false, error: 'capture impossible : ' + e.message }; }
  const secrets = [acc.motDePasse, ...Object.values(E.env)].filter(Boolean);
  const track = {}; let timer;
  try {
    const timeout = new Promise((_, ko) => { timer = setTimeout(() => ko(new Error(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`)), timeoutMs); });
    const work = Promise.resolve().then(() => driver({ exe, profile, hosts: E.hosts, steps, url: t.url, track, captures: dir }));
    work.catch(() => {});
    const r = await Promise.race([work, timeout]);
    mkdirSync(dir, { recursive: true });
    const files = r.shots.map(([f, png]) => { const p = path.join(dir, f); writeFileSync(p, png); return p; });
    const report = { url: t.url, account: String(account), at: new Date().toISOString(), dark: r.dark, errors: r.errors.map((e) => hide(e, secrets)), warnings: r.warnings.map((e) => hide(e, secrets)), http: r.http, blocked: r.blocked, blockedHosts: r.blockedHosts };
    writeFileSync(path.join(dir, 'console.json'), JSON.stringify(report, null, 2) + '\n'); files.push(path.join(dir, 'console.json'));
    return { ok: true, dir, files, ...report };
  } catch (e) {
    return { ok: false, error: 'capture impossible : ' + hide(e.message, secrets) };
  } finally {
    clearTimeout(timer); await cleanup(track, profile);
  }
}

// ---------- the queue: one run at a time per key (the project), a line per job, one idle call ----------
// jobs: { kind: 'qa', file, target, ... } or { kind: 'capture', target, account, ... }; run(job) -> result
export function createQaQueue({ run = (job) => (job.kind === 'capture' ? captureConnected(job) : runQa(job)), onNote = () => {}, onIdle = () => {} } = {}) {
  const queues = new Map();
  const drain = async (key, q) => {
    q.running = true;
    while (q.jobs.length) {
      const job = q.jobs.shift(); let r;
      try { r = await run(job); } catch (e) { r = { ok: false, error: (job.kind === 'capture' ? 'capture' : 'QA') + ' impossible : ' + e.message }; }
      const line = job.kind === 'capture' ? connectedCaptureNote(r, job.target, job.account) : qaNote(r, job.target || job.file); q.lines.push(line);
      try { onNote(key, job, line, r); } catch {}
    }
    queues.delete(key);
    try { onIdle(key, q.lines); } catch {}
  };
  return {
    enqueue(key, jobs) {
      if (!jobs.length) return;
      let q = queues.get(key); if (!q) { q = { jobs: [], lines: [], running: false }; queues.set(key, q); }
      q.jobs.push(...jobs);
      if (!q.running) drain(key, q);
    },
    busy: (key) => queues.has(key),
    pending: (key) => queues.get(key)?.jobs.length ?? 0,
  };
}
