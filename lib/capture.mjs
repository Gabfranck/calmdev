// The screen capture of a session (docs/capture.md): Playwright's chrome-headless-shell, driven over CDP with
// Node's own WebSocket, photographs a local page at 1440 and 390 px and keeps its console. No npm
// dependency, no shell, never a visible window (docs/decisions.md, « Rien ne s'ouvre à l'écran », 10:40).
//
//   captureTarget({ target, worktree, name?, timeoutMs?, chromePath?, widths? })
//     -> { ok: true, dir, files, url, errors, warnings, blocked } | { ok: false, error, missing? }
//   It never throws; the browser process is killed and its profile removed whatever happens.
//
// A target is http://localhost:<port>, http://127.0.0.1:<port>, or a .html file whose real path (links followed)
// is inside the worktree. The browser loads nothing off the machine: every request to another host is failed by
// Fetch.requestPaused and counted in `blocked`; the host resolver maps every other name to nothing as well.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectDir, envVar } from './names.mjs';

export const WIDTHS = [1440, 390];
export const TIMEOUT_MS = 30000;
export const MAX_PER_TURN = 30; // a stop may ask for all its screens: they go through one queue, one at a time
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const MAX_HEIGHT = 16000; // a runaway page stops here rather than filling the disk

// The chrome-headless-shell of Playwright's cache, the newest revision; CHROME_PATH wins when set. The Mac's
// own browsers (anything in an .app bundle) are refused: they can bring a window or switch the screen.
export function findHeadlessShell({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (env.CHROME_PATH) return /\.app\/Contents\/MacOS\//.test(env.CHROME_PATH) || !existsSync(env.CHROME_PATH) ? null : env.CHROME_PATH;
  const cache = env.PLAYWRIGHT_BROWSERS_PATH || (platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : path.join(home, '.cache', 'ms-playwright'));
  let names; try { names = readdirSync(cache); } catch { return null; }
  const revs = names.map((n) => /^chromium_headless_shell-(\d+)$/.exec(n)).filter(Boolean).sort((a, b) => Number(b[1]) - Number(a[1]));
  const arch = platform === 'darwin' ? ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64'] : platform === 'win32' ? ['chrome-headless-shell-win64'] : ['chrome-headless-shell-linux64'];
  for (const [dir] of revs) for (const a of arch) {
    const exe = path.join(cache, dir, a, platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

// { ok, url, file? } or { ok: false, error } with one clear line
export function checkTarget(target, worktree) {
  const t = String(target ?? '').trim();
  if (!t) return { ok: false, error: 'capture refusée : cible vide' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) {
    let u; try { u = new URL(t); } catch { return { ok: false, error: `capture refusée : adresse illisible (${t})` }; }
    if (u.protocol !== 'http:') return { ok: false, error: `capture refusée : seul http:// local est accepté (${t})` };
    if (!LOCAL_HOSTS.has(u.hostname)) return { ok: false, error: `capture refusée : hôte ${u.hostname} hors de la machine (localhost ou 127.0.0.1 seulement)` };
    if (!u.port) return { ok: false, error: `capture refusée : port manquant (${t})` };
    if (u.username || u.password) return { ok: false, error: 'capture refusée : identifiants dans l’adresse' };
    return { ok: true, url: u.href };
  }
  if (!worktree) return { ok: false, error: 'capture refusée : pas de worktree pour situer le fichier' };
  if (!/\.html?$/i.test(t)) return { ok: false, error: `capture refusée : un fichier doit finir en .html (${t})` };
  let root, real;
  try { root = realpathSync(worktree); } catch { return { ok: false, error: `capture refusée : worktree introuvable (${worktree})` }; }
  try { real = realpathSync(path.resolve(worktree, t)); } catch { return { ok: false, error: `capture refusée : fichier introuvable (${t})` }; }
  if (!inside(root, real)) return { ok: false, error: `capture refusée : ${t} sort du worktree (${real})` };
  if (!statSync(real).isFile()) return { ok: false, error: `capture refusée : ${t} n’est pas un fichier` };
  return { ok: true, url: pathToFileURL(real).href, file: real };
}

// The CAPTURE: lines of a stop's text and of its escadrille:state block (each string field, line by line):
// the targets, unique, in order, at most MAX_PER_TURN. Nothing else of what the session wrote is read.
export function parseCaptures(text, state) {
  const out = [];
  const scan = (s) => { for (const m of String(s ?? '').matchAll(/^[ \t>*-]*CAPTURE:[ \t]*(\S+)[ \t]*$/gm)) if (!out.includes(m[1])) out.push(m[1]); };
  scan(text);
  if (state && typeof state === 'object') for (const v of Object.values(state)) if (typeof v === 'string') scan(v);
  return out.slice(0, MAX_PER_TURN);
}

// A folder name from the stop and the target: "0-test-page-html", "1-localhost-3078"
export function folderName(stop, target) {
  const slug = String(target).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(-60) || 'page';
  return `${stop ?? 'tour'}-${slug}`;
}

// The line handed back to the session and shown in the page
export function captureNote(r, target) {
  if (!r.ok) return `CAPTURE ${target} : ${r.error}`;
  const n = r.errors.length;
  return `CAPTURE ${target} : ${r.dir} (${n} erreur${n > 1 ? 's' : ''} de console${r.blocked ? `, ${r.blocked} requête${r.blocked > 1 ? 's' : ''} hors machine bloquée${r.blocked > 1 ? 's' : ''}` : ''})`;
}

// How many pages a batch photographs at once, each in its own browser context of one shared browser (phase 16, FAST).
// ESCADRILLE_CAPTURE_CONCURRENCY sets it (1 to 8); 1 is the old one-at-a-time behaviour.
export const CONCURRENCY = 4;
export function concurrencyOf(env = process.env) {
  const n = Number(envVar('CAPTURE_CONCURRENCY', env));
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : CONCURRENCY;
}

// At most `n` of fn(item, i) at a time; onEach(item, result, i) is called in the order of `items`, never out of it,
// so the lines read the same whatever the concurrency. A throw becomes { ok: false, error }. Resolves to the results.
export async function pool(items, n, fn, onEach = () => {}) {
  const results = new Array(items.length); const done = new Array(items.length).fill(false);
  let next = 0; let emitted = 0;
  const flush = () => { while (emitted < items.length && done[emitted]) { try { onEach(items[emitted], results[emitted], emitted); } catch {} emitted++; } };
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = { ok: false, error: 'capture impossible : ' + e.message }; }
      done[i] = true; flush();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return results;
}

// The queue of a session's captures: the jobs waiting when it drains form a batch, photographed `concurrency` at a
// time in one browser; the notes still come in order, a failure said in one line and the queue goes on.
// enqueue(key, jobs) with jobs = [{ target, worktree, name }]; onNote(key, job, line, result) after each;
// onIdle(key, lines) once, when the queue of that key is empty again (the lines of the whole run).
// `capture` (one job -> result) replaces the batch for the tests; `batch` (jobs, { concurrency, onEach }) is the default.
export function createCaptureQueue({ capture, batch = captureBatch, concurrency = concurrencyOf(), onNote = () => {}, onIdle = () => {} } = {}) {
  const queues = new Map(); // key -> { jobs, lines, running }
  const run = capture ? (jobs, onEach) => pool(jobs, concurrency, capture, onEach) : (jobs, onEach) => batch(jobs, { concurrency, onEach });
  const drain = async (key, q) => {
    q.running = true;
    while (q.jobs.length) {
      const jobs = q.jobs.splice(0);
      const onEach = (job, r) => {
        const line = captureNote(r, job.target); q.lines.push(line);
        try { onNote(key, job, line, r); } catch {}
      };
      let seen = 0;
      try { await run(jobs, (job, r, i) => { seen = i + 1; onEach(job, r); }); }
      catch (e) { for (const job of jobs.slice(seen)) onEach(job, { ok: false, error: 'capture impossible : ' + e.message }); }
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
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small CDP client on the browser socket, flat sessions
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

function launch(exe, profile, extra = []) {
  const args = [...extra,
    '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars', '--disable-gpu',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--force-color-profile=srgb', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank',
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

const isAllowed = (url) => {
  if (/^(data|blob|about|chrome|devtools):/i.test(url) || url.startsWith('file:')) return true;
  try { const u = new URL(url); return LOCAL_HOSTS.has(u.hostname) || u.hostname === '[::1]'; } catch { return false; }
};

// Ready = the page set data-ready on <html> (the signal a screen may give), or the network has been quiet for
// QUIET_MS (the live event stream aside), whichever comes first; never longer than READY_MS, the old fixed delay, so a
// page that gives no signal and keeps loading is photographed exactly as before.
export const READY_MS = 400;
export const QUIET_MS = 120;
export const READY_ATTR = 'data-ready';
async function waitReady(client, sessionId, net, capMs = READY_MS) {
  const end = Date.now() + capMs;
  while (Date.now() < end) {
    if (net.inflight.size === 0 && Date.now() - net.last >= QUIET_MS) return 'quiet';
    const r = await client.send('Runtime.evaluate', { expression: `document.documentElement.hasAttribute(${JSON.stringify(READY_ATTR)}) && document.readyState === 'complete'`, returnByValue: true }, sessionId).catch(() => null);
    if (r?.result?.value === true) return 'signal';
    await sleep(40);
  }
  return 'cap';
}

// One frame painted after a resize: two requestAnimationFrame, capped
const frame = (client, sessionId) => Promise.race([
  client.send('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', awaitPromise: true }, sessionId).catch(() => null),
  sleep(250),
]);

// legacy: true keeps the old timing (a fixed 400 ms after load, the page loaded again at every width) for the bench
async function shoot(client, sessionId, url, width, net, { first = true, legacy = false } = {}) {
  await client.send('Emulation.setDeviceMetricsOverride', { width, height: width <= 480 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 480 }, sessionId);
  if (first || legacy) { // the same URL at the next width is not loaded again: the viewport changes, the page reflows
    const loaded = new Promise((ok) => { const off = client.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { off(); ok(); } }); });
    net.last = Date.now();
    await client.send('Page.navigate', { url }, sessionId);
    await Promise.race([loaded, sleep(10000)]);
    if (legacy) await sleep(READY_MS); else await waitReady(client, sessionId, net);
  } else {
    await frame(client, sessionId);
    await waitReady(client, sessionId, net, 200);
  }
  const { cssContentSize } = await client.send('Page.getLayoutMetrics', {}, sessionId);
  const height = Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(cssContentSize?.height || 900)));
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
  return Buffer.from(data, 'base64');
}

async function openBrowser(exe, profile, track) {
  let { proc, ws } = launch(exe, profile); track.proc = proc;
  let endpoint;
  try { endpoint = await ws; } catch (e) { // in a session's sandbox the mach port rendezvous is refused: one process then
    if (!/mach_port|bootstrap_check_in/.test(e.message)) throw e;
    ({ proc, ws } = launch(exe, profile, ['--single-process', '--no-zygote'])); track.proc = proc; endpoint = await ws;
  }
  const client = cdp(endpoint); track.client = client; await client.open;
  return client;
}

async function run({ exe, url, widths, profile, track, legacy }) {
  const client = await openBrowser(exe, profile, track);
  return shootIn(client, url, widths, { legacy, isolate: false });
}

// One page in a browser already open: its own browser context (cookies, storage and cache apart from the other pages
// of the batch) unless isolate is false, disposed at the end.
async function shootIn(client, url, widths, { legacy = false, isolate = true } = {}) {
  const { browserContextId } = isolate ? await client.send('Target.createBrowserContext', { disposeOnDetach: true }) : {};
  try {
    return await shootTarget(client, url, widths, browserContextId, legacy);
  } finally {
    if (browserContextId) await client.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

async function shootTarget(client, url, widths, browserContextId, legacy) {
  const { targetId } = await client.send('Target.createTarget', browserContextId ? { url: 'about:blank', browserContextId } : { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = []; const warnings = []; let blocked = 0; const blockedHosts = new Set();
  const net = { inflight: new Set(), last: Date.now() };
  const keep = (list, text) => { text = String(text).slice(0, 500); if (!list.includes(text)) list.push(text); };
  const off = client.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === 'Network.requestWillBeSent') { if (p.type !== 'EventSource' && !/\/api\/events\b/.test(p.request?.url || '')) { net.inflight.add(p.requestId); net.last = Date.now(); } }
    else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { if (net.inflight.delete(p.requestId)) net.last = Date.now(); }
    else if (m.method === 'Fetch.requestPaused') {
      if (isAllowed(p.request.url)) client.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
      else { blocked++; try { blockedHosts.add(new URL(p.request.url).host); } catch {} client.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {}); }
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (p.type === 'error' || p.type === 'assert') keep(errors, text); else if (p.type === 'warning') keep(warnings, text);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {}; keep(errors, d.exception?.description || d.text || 'exception');
    } else if (m.method === 'Log.entryAdded') {
      const e = p.entry || {}; if (/BlockedByClient/.test(e.text || '')) return;
      const text = e.url ? `${e.text} (${e.url})` : e.text;
      if (e.level === 'error') keep(errors, text); else if (e.level === 'warning') keep(warnings, text);
    }
  });
  try {
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    for (const d of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await client.send(d, {}, sessionId);
    const shots = [];
    for (const [i, w] of widths.entries()) shots.push([w, await shoot(client, sessionId, url, w, net, { first: i === 0, legacy })]);
    return { shots, errors, warnings, blocked, blockedHosts: [...blockedHosts] };
  } finally {
    off();
    if (browserContextId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// One browser for a batch of pages: shoot(url, widths) per page, close() at the end (process killed, profile removed).
// The browser starts on the first shoot, so a batch of refused targets never launches it.
export function chromeBrowser({ exe, legacy = false } = {}) {
  const track = {}; let profile = null; let opening = null;
  return {
    track,
    async shoot(url, widths) {
      if (!opening) { profile = mkdtempSync(path.join(tmpdir(), 'escadrille-capture-')); opening = openBrowser(exe, profile, track); }
      const client = await opening;
      return shootIn(client, url, widths, { legacy });
    },
    async close() { if (opening) { await opening.catch(() => {}); await cleanup(track, profile); } },
  };
}

// A batch of jobs ({ target, worktree, name }) in one browser, `concurrency` pages at a time; onEach(job, result, i)
// in the order of the jobs. Resolves to the results, in order. The browser is killed whatever happens.
export async function captureBatch(jobs, { concurrency = concurrencyOf(), onEach, chromePath, env = process.env, legacy = false, timeoutMs = TIMEOUT_MS, openBrowser: open = chromeBrowser } = {}) {
  const exe = chromePath || findHeadlessShell({ env });
  const browser = exe ? open({ exe, legacy }) : null;
  try {
    return await pool(jobs, concurrency, (job) => captureTarget({ timeoutMs, ...job, chromePath: exe, env, browser }), onEach);
  } finally {
    if (browser) await browser.close();
  }
}

// Kill the browser and wait for it, then remove the profile: always, whatever happened before
async function cleanup(track, profile) {
  track.client?.close();
  const p = track.proc;
  if (p && p.exitCode === null && p.signalCode === null) {
    const gone = new Promise((ok) => p.once('exit', ok));
    try { p.kill('SIGKILL'); } catch {}
    await Promise.race([gone, sleep(3000)]);
  }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

// The driver is the part that launches and drives the browser: ({ exe, url, widths, profile, track }) ->
// { shots: [[width, pngBuffer]], errors, warnings, blocked, blockedHosts }; it puts the process in track.proc so
// cleanup can kill it. The tests inject a fake one; the server uses chromeDriver.
export const chromeDriver = run;

// With `browser` (a chromeBrowser of a batch), the page is shot in that browser and nothing is launched or killed
// here; a timeout then fails this page only.
export async function captureTarget({ target, worktree, name, timeoutMs = TIMEOUT_MS, chromePath, widths = WIDTHS, env = process.env, driver = chromeDriver, browser, legacy = false } = {}) {
  const t = checkTarget(target, worktree);
  if (!t.ok) return t;
  if (!worktree) return { ok: false, error: 'capture refusée : pas de worktree pour ranger les images' };
  const exe = chromePath || findHeadlessShell({ env });
  if (!exe) return { ok: false, missing: true, error: 'capture impossible : chrome-headless-shell introuvable (npx playwright install chromium-headless-shell, ou CHROME_PATH)' };
  if (typeof WebSocket === 'undefined') return { ok: false, error: `capture impossible : Node 22+ requis (${process.version})` };
  const dir = projectDir(worktree, 'captures', name || folderName(null, target));
  if (browser) return shotInBrowser({ browser, url: t.url, widths, dir, timeoutMs });
  let profile;
  try { profile = mkdtempSync(path.join(tmpdir(), 'escadrille-capture-')); } catch (e) { return { ok: false, error: 'capture impossible : profil temporaire : ' + e.message }; }
  const track = {}; let timer;
  try {
    const timeout = new Promise((_, ko) => { timer = setTimeout(() => ko(new Error(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`)), timeoutMs); });
    const work = Promise.resolve().then(() => driver({ exe, url: t.url, widths, profile, track, legacy }));
    work.catch(() => {}); // after a timeout the killed browser rejects it: never an unhandled rejection in the server
    return writeShots(await Promise.race([work, timeout]), t.url, dir);
  } catch (e) {
    return { ok: false, error: 'capture impossible : ' + e.message };
  } finally {
    clearTimeout(timer);
    await cleanup(track, profile);
  }
}

function writeShots(r, url, dir) {
  mkdirSync(dir, { recursive: true });
  const files = r.shots.map(([w, png]) => { const f = path.join(dir, `${w}.png`); writeFileSync(f, png); return f; });
  const report = { url, at: new Date().toISOString(), errors: r.errors, warnings: r.warnings, blocked: r.blocked, blockedHosts: r.blockedHosts };
  writeFileSync(path.join(dir, 'console.json'), JSON.stringify(report, null, 2) + '\n');
  files.push(path.join(dir, 'console.json'));
  return { ok: true, dir, files, ...report };
}

async function shotInBrowser({ browser, url, widths, dir, timeoutMs }) {
  let timer;
  try {
    const timeout = new Promise((_, ko) => { timer = setTimeout(() => ko(new Error(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`)), timeoutMs); });
    const work = Promise.resolve().then(() => browser.shoot(url, widths));
    work.catch(() => {}); // the batch kills the browser at the end: never an unhandled rejection
    return writeShots(await Promise.race([work, timeout]), url, dir);
  } catch (e) {
    return { ok: false, error: 'capture impossible : ' + e.message };
  } finally { clearTimeout(timer); }
}
