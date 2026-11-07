// The dev environment a project declares (phase 13, session ENV; docs/devenv.md): the commands that start, stop,
// reset and show it, run by the server outside the sessions' sandbox, on the model of CAPTURE: (lib/capture.mjs).
// A session writes one line, `ENV: up | down | reset | status`; the server runs the argv the developer declared in
// the project's settings (no shell, never a text the session wrote), waits for the health URLs after `up`, and hands
// the session one line plus the last MAX_LINES lines of output, secrets blanked. The test accounts live in
// ~/.config/escadrille/secrets.json (lib/secrets.mjs, unreadable by the sessions): a session only ever sees their names.
//
//   validateEnvironment(raw)          → { value, accounts, errors }: the setting to store (never a password) and the accounts apart
//   publicView(value, accounts)       → what GET /api/project/settings returns (usernames, never passwords)
//   parseEnv(text, state)             → the actions asked by the ENV: lines of a turn, unique, in order
//   runEnv({ action, environment, accounts, project }) → { ok, action, code, lines, health, … } ; never throws
//   envNote(r, action, names)         → the lines handed to the session and shown in the page
//   createEnvQueue({ run, onNote, onIdle }) → one command at a time per project, like the capture queue
//   testsFor(environment, project, root) → the declared tests of the repository `root` (a kit holds several), or null
//   testLayout({ project, root, entry })  → { cmd, links, siblings } for lib/testbox.mjs: the reads the session's box lacked
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { SECRET_NAME, safeEnv } from './planner.mjs';

export const ACTIONS = Object.freeze(['up', 'down', 'reset', 'status']);
export const MAX_LINES = 40;
export const TIMEOUT_MS = Object.freeze({ up: 180000, down: 60000, reset: 240000, status: 20000 });
export const HEALTH_MS = 90000; // after up: the health URLs are waited for this long at most
export const MAX_PER_TURN = 4;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const NAME = /^[\w.-]{1,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && h.split('.').every((n) => Number(n) <= 255);
const isHost = (h) => isIp(h) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------- the setting
const argvOf = (v, what, errors) => {
  if (!Array.isArray(v) || !v.length || !v.every((a) => typeof a === 'string') || !v[0].trim()) { errors.push(`environment.commands.${what} : une liste de mots (argv, sans shell), le premier étant le programme`); return null; }
  if (v.some((a) => a.length > 500 || /[\r\n]/.test(a))) { errors.push(`environment.commands.${what} : un mot de 500 caractères au plus, sans retour à la ligne`); return null; }
  return v.map((a) => (a === v[0] ? a.trim() : a));
};
const healthOf = (u, lanHosts, errors) => {
  let url; try { url = new URL(String(u)); } catch { errors.push(`environment.health : adresse illisible (${u})`); return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { errors.push(`environment.health : http(s) seulement (${u})`); return null; }
  if (!LOCAL_HOSTS.has(url.hostname) && !lanHosts.includes(url.hostname)) { errors.push(`environment.health : ${url.hostname} n’est ni localhost ni un hôte LAN déclaré (lanHosts)`); return null; }
  if (url.username || url.password) { errors.push('environment.health : identifiants dans l’adresse'); return null; }
  return url.href;
};
// raw: { cwd?, commands: { up?, down?, reset?, status? }, env?, health?, lanHosts?, accounts?, timeouts?, healthTimeoutMs?, tests?, note? }
export const validateEnvironment = (raw, { project = null } = {}) => {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, accounts: null, errors: ['environment : un objet { commands, env, health, lanHosts, accounts, tests }'] };
  const value = {};
  if (raw.cwd !== undefined && raw.cwd !== null) { const c = String(raw.cwd).trim(); if (!path.isAbsolute(c) || !existsSync(c) || !statSync(c).isDirectory()) errors.push(`environment.cwd : ${c || '(vide)'} n’est pas un dossier absolu existant`); else value.cwd = path.resolve(c); }
  if (raw.note !== undefined && raw.note !== null) { if (typeof raw.note !== 'string' || raw.note.length > 2000) errors.push('environment.note : un texte court'); else value.note = raw.note; }
  const commands = {};
  if (raw.commands !== undefined && (!raw.commands || typeof raw.commands !== 'object' || Array.isArray(raw.commands))) errors.push('environment.commands : un objet { up, down, reset, status }');
  else for (const [k, v] of Object.entries(raw.commands || {})) { if (!ACTIONS.includes(k)) { errors.push(`environment.commands.${k} : inconnu (up, down, reset, status)`); continue; } if (v === null) continue; const a = argvOf(v, k, errors); if (a) commands[k] = a; }
  value.commands = commands;
  const env = {};
  if (raw.env !== undefined && (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env))) errors.push('environment.env : un objet { NOM: "valeur" }');
  else for (const [k, v] of Object.entries(raw.env || {})) { if (!ENV_KEY.test(k)) { errors.push(`environment.env : nom de variable illisible (${k})`); continue; } if (typeof v !== 'string' && typeof v !== 'number') { errors.push(`environment.env.${k} : une chaîne`); continue; } if (String(v).length > 2000) { errors.push(`environment.env.${k} : 2000 caractères au plus`); continue; } env[k] = String(v); }
  value.env = env;
  const lanHosts = [];
  if (raw.lanHosts !== undefined && !Array.isArray(raw.lanHosts)) errors.push('environment.lanHosts : une liste d’hôtes (192.168.1.x, mac.local)');
  else for (const h of raw.lanHosts || []) { const s = String(h ?? '').trim().toLowerCase(); if (!s || !isHost(s) || /:/.test(s)) errors.push(`environment.lanHosts : ${s || '(vide)'} n’est pas un hôte`); else if (!lanHosts.includes(s)) lanHosts.push(s); }
  value.lanHosts = lanHosts;
  const health = [];
  if (raw.health !== undefined && !Array.isArray(raw.health)) errors.push('environment.health : une liste d’adresses http://');
  else for (const u of raw.health || []) { const h = healthOf(u, lanHosts, errors); if (h && !health.includes(h)) health.push(h); }
  value.health = health;
  const timeouts = {};
  if (raw.timeouts !== undefined && (!raw.timeouts || typeof raw.timeouts !== 'object' || Array.isArray(raw.timeouts))) errors.push('environment.timeouts : un objet { up: ms, … }');
  else for (const [k, v] of Object.entries(raw.timeouts || {})) { if (!ACTIONS.includes(k)) { errors.push(`environment.timeouts.${k} : inconnu`); continue; } const n = Number(v); if (!Number.isInteger(n) || n < 1000 || n > 3600000) { errors.push(`environment.timeouts.${k} : des millisecondes, de 1 000 à 3 600 000`); continue; } timeouts[k] = n; }
  if (Object.keys(timeouts).length) value.timeouts = timeouts;
  if (raw.healthTimeoutMs !== undefined && raw.healthTimeoutMs !== null) { const n = Number(raw.healthTimeoutMs); if (!Number.isInteger(n) || n < 1000 || n > 1800000) errors.push('environment.healthTimeoutMs : des millisecondes, de 1 000 à 1 800 000'); else value.healthTimeoutMs = n; }
  const tests = {};
  if (raw.tests !== undefined && (!raw.tests || typeof raw.tests !== 'object' || Array.isArray(raw.tests))) errors.push('environment.tests : un objet { "<dépôt>": { command, reads } }');
  else for (const [repo, t] of Object.entries(raw.tests || {})) {
    const key = repo.trim().replace(/\/+$/, '') || '.';
    if (key !== '.' && (path.isAbsolute(key) || key.split('/').some((s) => s === '..' || s === ''))) { errors.push(`environment.tests : ${repo} doit être un chemin relatif au projet (ou « . »)`); continue; }
    if (!t || typeof t !== 'object' || typeof t.command !== 'string' || !t.command.trim() || t.command.length > 500 || /[\r\n]/.test(t.command)) { errors.push(`environment.tests.${key} : { command: "une ligne", reads: [chemins] }`); continue; }
    const reads = [];
    if (t.reads !== undefined && !Array.isArray(t.reads)) { errors.push(`environment.tests.${key}.reads : une liste de chemins`); continue; }
    for (const r of t.reads || []) { const s = String(r ?? '').trim(); if (!s) { errors.push(`environment.tests.${key}.reads : un chemin vide`); continue; } const abs = path.isAbsolute(s) ? path.resolve(s) : project ? path.resolve(project, s) : null; if (!abs) { errors.push(`environment.tests.${key}.reads : ${s} doit être absolu sans projet`); continue; } if (!reads.includes(abs)) reads.push(abs); }
    tests[key] = { command: t.command.trim(), reads };
  }
  value.tests = tests;
  let accounts = null;
  if (raw.accounts !== undefined && raw.accounts !== null) {
    if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) errors.push('environment.accounts : un objet { nom: { username, password } }');
    else {
      accounts = {};
      for (const [name, a] of Object.entries(raw.accounts)) {
        if (!NAME.test(name)) { errors.push(`environment.accounts : nom illisible (${name})`); continue; }
        const username = String(a?.username ?? a?.identifiant ?? '').trim(); const password = String(a?.password ?? a?.motDePasse ?? '');
        if (!username || username.length > 200 || !password || password.length > 200) { errors.push(`environment.accounts.${name} : { username, password } non vides`); continue; }
        accounts[name] = { username, password };
      }
    }
  }
  return { value: errors.length ? null : value, accounts: errors.length ? null : accounts, errors: errors.length ? errors : null };
};

// The setting as the developer's page reads it: everything but the passwords
export const publicView = (value, accounts) => {
  if (!value) return { set: false, accounts: [] };
  return { set: true, ...value, accounts: Object.entries(accounts || {}).map(([name, a]) => ({ name, username: a.username })) };
};
export const accountNames = (accounts) => Object.keys(accounts || {});
// The accounts, read back from the secrets file (a JSON string there)
export const parseAccounts = (s) => { try { const j = JSON.parse(s || 'null'); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };

// ---------------------------------------------------------------- the ENV: lines of a turn
export const parseEnv = (text, state) => {
  const out = [];
  const scan = (s) => { for (const m of String(s ?? '').matchAll(/^[ \t>*-]*ENV:[ \t]*(up|down|reset|status)[ \t]*$/gmi)) { const a = m[1].toLowerCase(); if (!out.includes(a)) out.push(a); } };
  scan(text);
  if (state && typeof state === 'object') for (const v of Object.values(state)) if (typeof v === 'string') scan(v);
  return out.slice(0, MAX_PER_TURN);
};

// ---------------------------------------------------------------- the secrets never reach a session
export const secretValues = (value, accounts) => {
  const out = new Set();
  for (const a of Object.values(accounts || {})) if (a?.password && a.password.length >= 3) out.add(a.password);
  for (const [k, v] of Object.entries(value?.env || {})) if (SECRET_NAME.test(k) && v && v.length >= 3) out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
};
export const redactor = (values) => (line) => { let s = String(line); for (const v of values) s = s.split(v).join('•••'); return s; };

// ---------------------------------------------------------------- one command, its last lines
// → { code, lines, killed, error? }: the last MAX_LINES lines of stdout and stderr together, ANSI stripped, 300 chars each
export const runCommand = ({ argv, cwd, env, timeoutMs = 60000, spawn = nodeSpawn, maxLines = MAX_LINES }) => new Promise((resolve) => {
  let child;
  try { child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true }); } catch (e) { resolve({ code: null, lines: [], killed: false, error: e.message }); return; }
  const lines = []; let rest = '';
  const take = (chunk) => { rest += String(chunk).replace(ANSI, ''); const parts = rest.split(/\r?\n/); rest = parts.pop(); for (const p of parts) { if (p.trim()) lines.push(clip(p, 300)); if (lines.length > maxLines) lines.shift(); } };
  child.stdout?.on('data', take); child.stderr?.on('data', take);
  let done = false; let killed = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); if (rest.trim()) { lines.push(clip(rest, 300)); if (lines.length > maxLines) lines.shift(); } resolve(r); };
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  const timer = setTimeout(() => { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref(); }, timeoutMs);
  child.on('error', (e) => finish({ code: null, lines, killed, error: e.message }));
  child.on('exit', (code, signal) => finish({ code: code ?? (signal ? 128 : 1), lines, killed, ...(killed ? { error: `délai de ${Math.round(timeoutMs / 1000)} s dépassé` } : {}) }));
});

// ---------------------------------------------------------------- the health URLs
const probeOne = async (url, { fetch: f, eachMs }) => {
  const t0 = Date.now(); const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), eachMs);
  try { const r = await f(url, { signal: ctl.signal, redirect: 'manual' }); return { url, ok: r.status < 500, status: r.status, ms: Date.now() - t0 }; }
  catch (e) { return { url, ok: false, status: null, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'délai' : (e.cause?.code || e.message) }; }
  finally { clearTimeout(t); }
};
// Every URL polled until it answers (any HTTP status under 500) or untilMs is spent; each try eachMs at most
export const probeHealth = async (urls, { untilMs = HEALTH_MS, everyMs = 2000, eachMs = 5000, fetch: f = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => {
  const t0 = now(); const out = new Map();
  let left = [...urls];
  for (;;) {
    const results = await Promise.all(left.map((u) => probeOne(u, { fetch: f, eachMs })));
    for (const r of results) out.set(r.url, { ...r, ms: now() - t0 });
    left = results.filter((r) => !r.ok).map((r) => r.url);
    if (!left.length || now() - t0 >= untilMs) break;
    await sleep(everyMs);
  }
  return urls.map((u) => out.get(u));
};

// ---------------------------------------------------------------- one action
export const notConfigured = (project) => `environnement non réglé pour ${project ? path.basename(project) : 'ce projet'} : le développeur le déclare dans Accès › Réglages (docs/devenv.md)`;
export const runEnv = async ({ action, environment, accounts = null, project = null, env = process.env, spawn = nodeSpawn, fetch: f = globalThis.fetch, healthOpts = {} } = {}) => {
  if (!ACTIONS.includes(action)) return { ok: false, action, error: `action inconnue (${action}) : up, down, reset ou status` };
  if (!environment) return { ok: false, action, configured: false, error: notConfigured(project) };
  const argv = environment.commands?.[action];
  if (!argv) return { ok: false, action, configured: true, error: `commande ${action} non déclarée dans le réglage environment` };
  const cwd = environment.cwd || project;
  if (!cwd || !existsSync(cwd)) return { ok: false, action, configured: true, error: `dossier introuvable (${cwd || 'aucun'})` };
  const timeoutMs = environment.timeouts?.[action] || TIMEOUT_MS[action];
  const r = await runCommand({ argv, cwd, env: { ...safeEnv(env), ...environment.env }, timeoutMs, spawn });
  const hide = redactor(secretValues(environment, accounts));
  const lines = r.lines.map(hide);
  const base = { action, code: r.code, lines, killed: !!r.killed, cwd, command: argv.join(' ') };
  if (r.error) return { ...base, ok: false, error: hide(r.error) };
  const urls = environment.health || [];
  if (action === 'up' && r.code === 0 && urls.length) { const health = await probeHealth(urls, { untilMs: environment.healthTimeoutMs || HEALTH_MS, fetch: f, ...healthOpts }); return { ...base, ok: health.every((h) => h.ok), health }; }
  if (action === 'status' && urls.length) { const health = await probeHealth(urls, { untilMs: 0, eachMs: 3000, fetch: f, ...healthOpts }); return { ...base, ok: r.code === 0, health, running: health.some((h) => h.ok) }; }
  return { ...base, ok: r.code === 0 };
};

// The lines handed to the session: one line of verdict, then the output, indented. Never a password.
const hostOf = (u) => { try { const x = new URL(u); return x.host + (x.pathname !== '/' ? x.pathname : ''); } catch { return u; } };
export const envNote = (r, action = r?.action, names = []) => {
  const head = `ENV ${action} : `;
  if (r.code === undefined) return head + r.error; // not run at all: nothing set, no such command
  const health = r.health ? ' · ' + r.health.map((h) => `${hostOf(h.url)} ${h.ok ? `ok (${h.status}, ${Math.round(h.ms / 1000)} s)` : `injoignable${h.error ? ` (${h.error})` : h.status ? ` (${h.status})` : ''}`}`).join(', ') : '';
  const who = names.length ? ` · comptes de test : ${names.join(', ')}` : '';
  let verdict;
  if (r.error && r.code === null) verdict = r.error;
  else if (action === 'status') verdict = `${r.running === undefined ? (r.code === 0 ? 'commande ok' : `code ${r.code}`) : r.running ? 'tourne' : 'ne tourne pas'}${health}${who}`;
  else if (action === 'up') verdict = r.code !== 0 ? `échec (code ${r.code}${r.error ? ', ' + r.error : ''})` : r.health ? `${r.ok ? 'prêt' : 'démarré mais incomplet'}${health}${who}` : `démarré (code 0)${who}`;
  else verdict = r.code === 0 ? (action === 'down' ? 'arrêté' : 'remis à neuf') + who : `échec (code ${r.code}${r.error ? ', ' + r.error : ''})`;
  const out = (r.lines || []).length ? '\n' + r.lines.map((l) => '  │ ' + l).join('\n') : '';
  return head + verdict + out;
};

// ---------------------------------------------------------------- the queue: one command at a time per project
// enqueue(jobs) with jobs = [{ project, planId, sid, action }]; onNote(job, line, result) after each; onIdle(planId, sid)
// when nothing of that session remains in any queue. busy(planId, sid) says whether one of its jobs waits or runs.
export const createEnvQueue = ({ run, onNote = () => {}, onIdle = () => {} } = {}) => {
  const queues = new Map(); // project -> { jobs, current }
  const pending = (planId, sid) => [...queues.values()].some((q) => (q.current && q.current.planId === planId && q.current.sid === sid) || q.jobs.some((j) => j.planId === planId && j.sid === sid));
  const drain = async (project, q) => {
    while (q.jobs.length) {
      const job = q.jobs.shift(); q.current = job; let r;
      try { r = await run(job); } catch (e) { r = { ok: false, action: job.action, code: null, lines: [], error: 'commande impossible : ' + e.message }; }
      q.current = null;
      const line = envNote(r, job.action, r.names || []);
      try { onNote(job, line, r); } catch {}
      if (!pending(job.planId, job.sid)) { try { onIdle(job.planId, job.sid); } catch {} }
    }
    queues.delete(project);
  };
  return {
    enqueue(jobs) {
      for (const job of jobs) {
        let q = queues.get(job.project); const fresh = !q;
        if (!q) { q = { jobs: [], current: null }; queues.set(job.project, q); }
        q.jobs.push(job);
        if (fresh) drain(job.project, q);
      }
    },
    busy: pending,
  };
};

// ---------------------------------------------------------------- the tests declared for a repository
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
// environment.tests is keyed by the repository's path relative to the project (« . » for the project itself)
export const testsFor = (environment, project, root) => {
  if (!environment?.tests || !project || !root) return null;
  const rel = path.relative(project, root).replace(/\\/g, '/');
  const key = !rel ? '.' : rel.startsWith('..') ? null : rel;
  return key && environment.tests[key] ? { key, ...environment.tests[key] } : null;
};
// What lib/testbox.mjs needs to run those tests on the branch merged dry: the reads inside the repository are linked
// into the verification worktree (node_modules: a cache the fresh worktree lacks), the others appear beside it under
// the same relative path (../Orchard-analytics: a `file:` dependency), so that the package.json of the branch resolves.
export const testLayout = ({ project, root, entry }) => {
  const links = []; const siblings = []; const missing = [];
  for (const r of entry?.reads || []) {
    if (!existsSync(r)) { missing.push(r); continue; }
    if (inside(root, r)) links.push({ at: path.relative(root, r), to: r });
    else siblings.push({ rel: path.relative(root, r), to: r });
  }
  return { cmd: entry?.command || null, links, siblings, missing };
};
