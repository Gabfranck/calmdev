// The services of a project's docker-compose (phase 16, session DOCK; docs/docker.md), read and driven by the docker CLI,
// outside the sessions' sandbox, on the model of ENV: (lib/devenv.mjs). Never the Docker socket in a sandbox; never a
// gesture that deletes a database or a volume (no down, no rm, no prune, no -v): the argv below are the only ones built.
//
//   validateDocker(raw)                → { value, errors }: environment.docker = { exec: [services], files: [compose files] }
//   argvFor(verb, { service, words, environment }) → the argv after the binary, from a closed list of verbs
//   parsePs(stdout)                    → [{ service, container, state, health, status, ports }] (NDJSON or a JSON array)
//   services({ environment, project }) → { services } | { error }  (a clear sentence when Docker is absent or stopped)
//   act({ action, service, … })        → { ok, code, lines, error? } : restart | stop | build (the developer's click)
//   sessionRun({ verb, service, words, … }) → { ok, code, lines, error? } : status | logs | restart | exec (a DOCKER: line)
//   streamLogs({ service, onLine, onEnd, … }) → stop(): 200 lines then the flow
//   parseDocker(text, state)           → the DOCKER: requests of a turn, unique, in order
//   dockerNote(r, req)                 → the lines handed to the session
//   createDocker({ … })                → { handle(req, res, url, { guardKey }), ofTurn(…), busy(planId, sid) } for the server
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { safeEnv } from './planner.mjs';
import { notConfigured, redactor, secretValues } from './devenv.mjs';
import { envVar, CONFIG_LABEL } from './names.mjs';

export const SESSION_VERBS = Object.freeze(['status', 'logs', 'restart', 'exec']);
export const DEV_ACTIONS = Object.freeze(['restart', 'stop', 'build']);
export const MAX_LINES = 60;
export const LOG_TAIL = 200;
export const MAX_PER_TURN = 4;
export const TIMEOUT_MS = Object.freeze({ status: 20000, services: 20000, logs: 20000, restart: 90000, stop: 90000, build: 900000, exec: 60000 });
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const NO_DOCKER = 'Docker n’est pas installé sur ce Mac (commande docker introuvable).';
export const DAEMON_DOWN = 'Docker ne tourne pas : lance Docker Desktop. calmdev ne le démarre ni ne l’arrête.';

// ---------------------------------------------------------------- the setting environment.docker
export const validateDocker = (raw) => {
  if (raw === undefined || raw === null) return { value: null, errors: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { value: null, errors: ['environment.docker : un objet { exec: [services], files: [fichiers compose] }'] };
  const errors = []; const value = { exec: [], files: [] };
  for (const k of Object.keys(raw)) if (!['exec', 'files'].includes(k)) errors.push(`environment.docker.${k} : inconnu (exec, files)`);
  if (raw.exec !== undefined && !Array.isArray(raw.exec)) errors.push('environment.docker.exec : une liste de services');
  else for (const s of raw.exec || []) { const n = String(s ?? '').trim(); if (!SERVICE.test(n)) errors.push(`environment.docker.exec : ${n || '(vide)'} n’est pas un nom de service`); else if (!value.exec.includes(n)) value.exec.push(n); }
  if (raw.files !== undefined && !Array.isArray(raw.files)) errors.push('environment.docker.files : une liste de fichiers compose');
  else for (const f of raw.files || []) { const n = String(f ?? '').trim(); if (!n || n.startsWith('-') || /[\r\n]/.test(n) || n.length > 300) errors.push(`environment.docker.files : ${n || '(vide)'} illisible`); else if (!value.files.includes(n)) value.files.push(n); }
  return errors.length ? { value: null, errors } : { value, errors: null };
};

// ---------------------------------------------------------------- the only argv ever built
const composeOf = (environment) => ['compose', ...(environment?.docker?.files || []).flatMap((f) => ['-f', f])];
export const argvFor = (verb, { service = null, words = [], environment = null, follow = false } = {}) => {
  const c = composeOf(environment);
  switch (verb) {
    case 'services': return [...c, 'config', '--services'];
    case 'status': return [...c, 'ps', '--all', '--format', 'json'];
    case 'logs': return [...c, 'logs', '--no-color', '--timestamps', '--tail', String(follow ? LOG_TAIL : MAX_LINES), ...(follow ? ['--follow'] : []), service];
    case 'restart': return [...c, 'restart', service];
    case 'stop': return [...c, 'stop', service];
    case 'build': return [...c, 'up', '-d', '--build', '--no-deps', service];
    case 'exec': return [...c, 'exec', '-T', service, ...words];
    default: throw new Error(`verbe inconnu (${verb})`);
  }
};

// ---------------------------------------------------------------- one docker command
// ESCADRILLE_DOCKER (an absolute path; a .mjs/.js file runs under this node, for test/fake-docker.mjs), else docker on the PATH
export const binOf = (env = process.env) => { const b = envVar('DOCKER', env) || 'docker'; return /\.m?js$/.test(b) ? [process.execPath, b] : [b]; };
const envOf = (environment, env) => ({ ...safeEnv(env), ...(environment?.env || {}) });
const cwdOf = (environment, project) => environment?.cwd || project;

const explain = (stderr, code) => {
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|docker daemon is not running/i.test(stderr)) return DAEMON_DOWN;
  if (/no configuration file provided|Can't find a suitable configuration file/i.test(stderr)) return 'NO_COMPOSE';
  if (/no such service/i.test(stderr)) return 'NO_SERVICE';
  return null;
};

// → { code, stdout, lines, error? }; never throws. stdout kept whole (1 MB at most) for ps; lines: the last maxLines of both
export const run = ({ args, environment, project, env = process.env, timeoutMs = 60000, spawn = nodeSpawn, maxLines = MAX_LINES }) => new Promise((resolve) => {
  const [bin, ...pre] = binOf(env); const cwd = cwdOf(environment, project);
  if (!cwd || !existsSync(cwd)) { resolve({ code: null, stdout: '', lines: [], error: `dossier introuvable (${cwd || 'aucun'})` }); return; }
  let child;
  try { child = spawn(bin, [...pre, ...args], { cwd, env: envOf(environment, env), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true }); }
  catch (e) { resolve({ code: null, stdout: '', lines: [], error: e.code === 'ENOENT' ? NO_DOCKER : e.message }); return; }
  let stdout = ''; let stderr = ''; const lines = []; const rest = { out: '', err: '' };
  const take = (k, chunk) => {
    const s = String(chunk); if (k === 'out' && stdout.length < 1e6) stdout += s; if (k === 'err' && stderr.length < 1e5) stderr += s;
    rest[k] += s.replace(ANSI, ''); const parts = rest[k].split(/\r?\n/); rest[k] = parts.pop();
    for (const p of parts) { if (p.trim()) lines.push(clip(p, 300)); if (lines.length > maxLines) lines.shift(); }
  };
  child.stdout?.on('data', (c) => take('out', c)); child.stderr?.on('data', (c) => take('err', c));
  let done = false; let killed = false;
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } }; // the docker CLI's group, never Docker itself
  const timer = setTimeout(() => { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref(); }, timeoutMs);
  const finish = (r) => {
    if (done) return; done = true; clearTimeout(timer);
    for (const k of ['out', 'err']) if (rest[k].trim()) { lines.push(clip(rest[k], 300)); if (lines.length > maxLines) lines.shift(); }
    resolve(r);
  };
  child.on('error', (e) => finish({ code: null, stdout, lines, error: e.code === 'ENOENT' ? NO_DOCKER : e.message }));
  child.on('exit', (code, signal) => {
    const c = code ?? (signal ? 128 : 1); const why = c !== 0 ? explain(stderr, c) : null;
    finish({ code: c, stdout, lines, ...(killed ? { error: `délai de ${Math.round(timeoutMs / 1000)} s dépassé` } : why === DAEMON_DOWN ? { error: DAEMON_DOWN } : why === 'NO_COMPOSE' ? { error: `Aucun docker-compose dans ${cwdOf(environment, project)}.` } : {}) });
  });
});

// ---------------------------------------------------------------- reading the compose
const portsOf = (c) => {
  if (Array.isArray(c.Publishers)) return c.Publishers.filter((p) => p.PublishedPort).map((p) => ({ host: p.PublishedPort, container: p.TargetPort, protocol: p.Protocol || 'tcp' }))
    .filter((p, i, a) => a.findIndex((q) => q.host === p.host && q.container === p.container && q.protocol === p.protocol) === i);
  const out = []; // older compose: "0.0.0.0:8080->80/tcp, :::8080->80/tcp"
  for (const m of String(c.Ports || '').matchAll(/:(\d+)->(\d+)\/(\w+)/g)) { const p = { host: Number(m[1]), container: Number(m[2]), protocol: m[3] }; if (!out.some((q) => q.host === p.host && q.container === p.container)) out.push(p); }
  return out;
};
export const parsePs = (stdout) => {
  const s = String(stdout || '').trim(); if (!s) return [];
  let rows;
  if (s.startsWith('[')) { try { rows = JSON.parse(s); } catch { rows = []; } }
  else rows = s.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return rows.map((c) => ({ service: c.Service || c.Name, container: c.Name || null, state: String(c.State || '').toLowerCase() || null, health: c.Health || null, status: c.Status || null, ports: portsOf(c) }))
    .sort((a, b) => a.service.localeCompare(b.service));
};
export const serviceNames = async (opts) => {
  const r = await run({ ...opts, args: argvFor('services', { environment: opts.environment }), timeoutMs: TIMEOUT_MS.services, maxLines: 500 });
  if (r.error) return { error: r.error };
  if (r.code !== 0) return { error: `docker compose config : code ${r.code}${r.lines.length ? ' · ' + r.lines.at(-1) : ''}` };
  return { names: r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
};
export const services = async ({ environment, project = null, env = process.env, spawn = nodeSpawn } = {}) => {
  if (!environment) return { error: notConfigured(project) };
  const r = await run({ args: argvFor('status', { environment }), environment, project, env, spawn, timeoutMs: TIMEOUT_MS.status, maxLines: 500 });
  if (r.error) return { error: r.error };
  if (r.code !== 0) return { error: `docker compose ps : code ${r.code}${r.lines.length ? ' · ' + r.lines.at(-1) : ''}` };
  return { services: parsePs(r.stdout) };
};

// ---------------------------------------------------------------- what leaves: masked
const PATTERNS = [
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE)[A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1$2•••'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 •••'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1•••@'],
];
export const masker = (environment, accounts) => { const hide = redactor(secretValues(environment, accounts)); return (line) => { let s = hide(line); for (const [re, to] of PATTERNS) s = s.replace(re, to); return s; }; };

// ---------------------------------------------------------------- the checks before any command
const checkService = async (service, opts) => {
  if (!SERVICE.test(String(service || ''))) return `${service ? `« ${clip(String(service), 40)} »` : 'aucun service'} : un nom de service du compose est attendu`;
  const s = await serviceNames(opts); if (s.error) return s.error;
  if (!s.names.includes(service)) return `${service} n’est pas un service du compose (${s.names.join(', ') || 'aucun'}).`;
  return null;
};
const finishRun = (r, hide, extra = {}) => ({ ...extra, ok: !r.error && r.code === 0, code: r.code, lines: r.lines.map(hide), ...(r.error ? { error: hide(r.error) } : {}) });

// The developer's click: restart, stop or build one service of the compose
export const act = async ({ action, service, environment, accounts = null, project = null, env = process.env, spawn = nodeSpawn } = {}) => {
  if (!DEV_ACTIONS.includes(action)) return { ok: false, code: null, lines: [], error: `action refusée (${action}) : restart, stop ou build` };
  if (!environment) return { ok: false, code: null, lines: [], error: notConfigured(project) };
  const opts = { environment, project, env, spawn };
  const bad = await checkService(service, opts); if (bad) return { ok: false, code: null, lines: [], error: bad };
  const r = await run({ ...opts, args: argvFor(action, { service, environment }), timeoutMs: TIMEOUT_MS[action] });
  return finishRun(r, masker(environment, accounts), { action, service });
};

// A DOCKER: line of a session: status, logs, restart, exec (exec only in a service declared in environment.docker.exec)
export const sessionRun = async ({ verb, service = null, words = [], environment, accounts = null, project = null, env = process.env, spawn = nodeSpawn } = {}) => {
  const base = { verb, service, code: null, lines: [] };
  if (!SESSION_VERBS.includes(verb)) return { ...base, ok: false, error: 'verbe refusé (status, logs, restart, exec).' };
  if (!environment) return { ...base, ok: false, error: notConfigured(project) };
  const hide = masker(environment, accounts); const opts = { environment, project, env, spawn };
  if (verb === 'status') {
    const s = await services(opts); if (s.error) return { ...base, ok: false, error: hide(s.error) };
    return { ...base, ok: true, code: 0, services: s.services };
  }
  if (verb === 'exec') {
    if (!(environment.docker?.exec || []).includes(service)) return { ...base, ok: false, error: `exec refusé : ${service || '(aucun service)'} n’est pas déclaré exec-permis (Accès › Réglages › environment.docker.exec).` };
    if (!words.length) return { ...base, ok: false, error: 'exec : la commande manque (DOCKER: exec <service> <mots…>)' };
    if (words[0].startsWith('-') || words.length > 40 || words.some((w) => w.length > 500)) return { ...base, ok: false, error: 'exec : la commande commence par un programme, 40 mots de 500 caractères au plus' };
  }
  const bad = await checkService(service, opts); if (bad) return { ...base, ok: false, error: hide(bad) };
  const r = await run({ ...opts, args: argvFor(verb, { service, words, environment }), timeoutMs: TIMEOUT_MS[verb] });
  return finishRun(r, hide, base);
};

// The developer's logs: LOG_TAIL lines then the flow, masked; stop() kills the docker CLI. onEnd({ code, error? })
export const streamLogs = async ({ service, environment, accounts = null, project = null, env = process.env, spawn = nodeSpawn, onLine, onEnd }) => {
  if (!environment) { onEnd({ code: null, error: notConfigured(project) }); return () => {}; }
  const opts = { environment, project, env, spawn };
  const bad = await checkService(service, opts); if (bad) { onEnd({ code: null, error: bad }); return () => {}; }
  const hide = masker(environment, accounts); const [bin, ...pre] = binOf(env);
  let child;
  try { child = spawn(bin, [...pre, ...argvFor('logs', { service, environment, follow: true })], { cwd: cwdOf(environment, project), env: envOf(environment, env), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true }); }
  catch (e) { onEnd({ code: null, error: e.message }); return () => {}; }
  let stderr = ''; let ended = false; const rest = { out: '', err: '' };
  const take = (k, chunk) => { const s = String(chunk); if (k === 'err' && stderr.length < 1e5) stderr += s; rest[k] += s.replace(ANSI, ''); const parts = rest[k].split(/\r?\n/); rest[k] = parts.pop(); for (const p of parts) if (p.trim()) onLine(hide(clip(p, 2000))); };
  child.stdout?.on('data', (c) => take('out', c)); child.stderr?.on('data', (c) => take('err', c));
  const end = (r) => { if (ended) return; ended = true; for (const k of ['out', 'err']) if (rest[k].trim()) onLine(hide(rest[k])); onEnd(r); };
  child.on('error', (e) => end({ code: null, error: e.code === 'ENOENT' ? NO_DOCKER : e.message }));
  child.on('exit', (code) => { const why = code ? explain(stderr, code) : null; end({ code, ...(why === DAEMON_DOWN ? { error: DAEMON_DOWN } : {}) }); });
  return () => { if (ended) return; try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } };
};

// ---------------------------------------------------------------- the DOCKER: lines of a turn
export const parseDocker = (text, state) => {
  const out = []; const seen = new Set();
  const scan = (s) => {
    for (const m of String(s ?? '').matchAll(/^[ \t>*-]*DOCKER:[ \t]*(\S+)(?:[ \t]+(\S+))?(?:[ \t]+(.*?))?[ \t]*$/gm)) {
      const verb = m[1].toLowerCase(); const service = m[2] || null; const words = (m[3] || '').split(/[ \t]+/).filter(Boolean);
      const key = [verb, service, ...words].join(' '); if (seen.has(key)) continue; seen.add(key);
      out.push({ verb, service, words });
    }
  };
  scan(text);
  if (state && typeof state === 'object') for (const v of Object.values(state)) if (typeof v === 'string') scan(v);
  return out.slice(0, MAX_PER_TURN);
};

const STATE = { running: 'en marche', exited: 'arrêté', restarting: 'redémarre', paused: 'en pause', created: 'créé', dead: 'mort', removing: 'retiré' };
const HEALTH = { healthy: 'sain', unhealthy: 'malade', starting: 'démarre' };
export const serviceLine = (s) => `${s.service} ${STATE[s.state] || s.state || '?'}${s.health ? ` (${HEALTH[s.health] || s.health})` : ''}${s.ports.length ? ' ' + s.ports.map((p) => ':' + p.host).join(' ') : ''}`;
export const dockerNote = (r, req = r) => {
  const verb = req.verb; const head = `DOCKER ${verb}${req.service && verb !== 'status' ? ' ' + req.service : ''} : `;
  if (r.error && r.code === null) return (SESSION_VERBS.includes(verb) ? head : 'DOCKER : ') + r.error;
  let verdict;
  if (verb === 'status') verdict = `${r.services.length} service${r.services.length > 1 ? 's' : ''}${r.services.length ? ' · ' + r.services.map(serviceLine).join(', ') : ''}`;
  else if (r.error) verdict = `échec (code ${r.code}, ${r.error})`;
  else if (verb === 'logs') verdict = r.code === 0 ? `${r.lines.length} dernière${r.lines.length > 1 ? 's' : ''} ligne${r.lines.length > 1 ? 's' : ''}` : `échec (code ${r.code})`;
  else if (verb === 'restart') verdict = r.code === 0 ? 'redémarré (code 0)' : `échec (code ${r.code})`;
  else verdict = `code ${r.code}`;
  const out = (r.lines || []).length ? '\n' + r.lines.map((l) => '  │ ' + l).join('\n') : '';
  return head + verdict + out;
};

// ---------------------------------------------------------------- one command at a time per project
export const createQueue = () => {
  const queues = new Map(); // project -> { jobs, current }
  const busy = (planId, sid) => [...queues.values()].some((q) => [q.current, ...q.jobs].some((j) => j && j.planId === planId && j.sid === sid && planId));
  const drain = async (project, q) => {
    while (q.jobs.length) { const job = q.jobs.shift(); q.current = job; try { job.resolve(await job.fn()); } catch (e) { job.resolve({ ok: false, code: null, lines: [], error: 'commande impossible : ' + e.message }); } q.current = null; }
    queues.delete(project);
  };
  return {
    push(project, fn, meta = {}) {
      return new Promise((resolve) => {
        let q = queues.get(project); const fresh = !q; if (!q) { q = { jobs: [], current: null }; queues.set(project, q); }
        q.jobs.push({ ...meta, fn, resolve }); if (fresh) drain(project, q);
      });
    },
    busy,
  };
};

// ---------------------------------------------------------------- the server's side
// environmentOf(project), accountsOf(project), projectOf(raw) (validates, throws), guardOk(key), record({ project, planId,
// sessionId, kind, text }) (the pilot's log), onNote(planId, sid, line, r), onIdle(planId, sid), projectOfPlan(planId)
export const createDocker = ({ environmentOf, accountsOf = () => null, projectOf = (p) => p, guardOk, record = () => {}, onNote = () => {}, onIdle = () => {}, projectOfPlan = () => null, env = process.env, spawn = nodeSpawn } = {}) => {
  const queue = createQueue();
  const log = (r) => { try { record({ kind: 'note', ...r }); } catch {} };
  const sendJson = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const body = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) { reject(new Error('trop gros')); req.destroy(); } }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); });
  const ctxOf = (project) => ({ environment: environmentOf(project), accounts: accountsOf(project), project, env, spawn });

  // GET /api/docker?project= · GET /api/docker/logs?project=&service= (SSE) · POST /api/docker/action { project, service, action }
  const handle = async (req, res, url, { guardKey = null } = {}) => {
    if (!guardOk(guardKey)) return sendJson(res, 403, { error: 'le cookie du développeur est requis (lien de ' + CONFIG_LABEL + '/guard-link)' });
    const seg = url.pathname.split('/').filter(Boolean);
    try {
      if (!seg[2] && req.method === 'GET') { const project = projectOf(url.searchParams.get('project')); const s = await services(ctxOf(project)); return sendJson(res, 200, s.error ? { services: [], error: s.error } : s); }
      if (seg[2] === 'action' && req.method === 'POST') {
        const b = await body(req); const project = projectOf(b.project); const { action, service } = b;
        const r = await queue.push(project, () => act({ action, service, ...ctxOf(project) }));
        log({ project, text: `Docker ${action} ${service} (développeur) : ${r.ok ? 'ok' : r.error || `code ${r.code}`}` });
        return sendJson(res, 200, r);
      }
      if (seg[2] === 'logs' && req.method === 'GET') {
        const project = projectOf(url.searchParams.get('project')); const service = url.searchParams.get('service');
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        let closed = false; let stop = () => {};
        req.on('close', () => { closed = true; stop(); });
        stop = await streamLogs({ service, ...ctxOf(project),
          onLine: (l) => { if (!closed) res.write(`data: ${l}\n\n`); },
          onEnd: (r) => { if (closed) return; res.write(`event: end\ndata: ${JSON.stringify(r)}\n\n`); res.end(); } });
        if (closed) stop();
        return;
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) { if (!res.headersSent) return sendJson(res, e.status || 400, { error: e.message }); res.end(); }
  };

  // The DOCKER: lines of a session's turn: each through the project's queue, its note to the session, resumed when idle
  const ofTurn = (planId, sid, text, state, project = projectOfPlan(planId)) => {
    const reqs = parseDocker(text, state); if (!reqs.length) return 0;
    for (const q of reqs) {
      queue.push(project || '(aucun projet)', () => sessionRun({ ...q, ...ctxOf(project) }), { planId, sid }).then((r) => {
        const line = dockerNote(r, q);
        if (project) log({ project, planId, sessionId: sid, text: `Docker ${q.verb}${q.service ? ' ' + q.service : ''}${q.words.length ? ' `' + clip(q.words.join(' '), 200) + '`' : ''} (session ${sid}) : ${r.ok ? 'ok' : clip(r.error || `code ${r.code}`, 300)}` });
        try { onNote(planId, sid, line, r); } catch {}
        if (!queue.busy(planId, sid)) { try { onIdle(planId, sid); } catch {} }
      });
    }
    return reqs.length;
  };
  return { handle, ofTurn, busy: queue.busy, queue };
};

export const INSTRUCTION = 'Les services Docker du projet se lisent par une ligne seule `DOCKER: status`, `DOCKER: logs <service>`, `DOCKER: restart <service>` ou `DOCKER: exec <service> <commande>` (exec seulement dans un service que le développeur a permis) : le serveur l’exécute hors du bac et rend 60 lignes en tête de ton message suivant (docs/docker.md).';
