#!/usr/bin/env node
// Proves the README's install on a machine that has never seen Escadrille (phase 12):
//   node scripts/fresh-install.mjs [--source <git repo>] [--keep]
// It clones the repository from a local path (never the network) into a temporary folder, with a temporary HOME
// and a free port, and runs ./install.sh --no-open exactly as the README says. Two runs:
//   1. no Claude Code (ESCADRILLE_CLAUDE points at a path that does not exist): install.sh must stop at once
//      and say in one sentence that Claude Code is missing; no server may start;
//   2. a Claude Code stub that answers --version: the server must start, the home must be the empty state
//      (no project, no plan, no conversation: never an example), /api/status must answer;
//   0. before both, the tracked files of the clone hold no private trace (scripts/trace-scan.mjs, no exemption);
//   3. the install firewall (lib/selfedit.mjs) on that same server: a plan on Escadrille itself is refused (403, « fork »)
//      when the clone's origin is the official repository, and passes on a fork and for a maintainer. The origin is only
//      rewritten (git remote set-url, no connection); selfEdit reads origin, the maintainer file and the env at each call,
//      so no restart is needed. The temporary HOME keeps the developer's own maintainer file out of it.
// Everything is removed at the end, failure or not (the server's process group is killed first); --keep leaves
// the folder for a look. Exit 0 when every check passes, 1 otherwise. What the clone contains is what the source
// has COMMITTED: commit before you run it.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { scanTracked } from './trace-scan.mjs';
import { PREFIX, LEGACY_PREFIX, configDirIn } from '../lib/names.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// The URL of the official repository, as a fresh clone from GitHub has it; any other URL is a fork
export const OFFICIAL = 'https://github.com/Gabfranck/calmdev-private.git';
export const FORK = 'https://github.com/someone-else/Escadrille.git';
/** Points the repository's origin at url (adds it when missing); no network: git only writes .git/config. */
export const setOrigin = (repo, url) => {
  try { execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: repo, stdio: 'pipe' }); }
  catch { execFileSync('git', ['remote', 'add', 'origin', url], { cwd: repo, stdio: 'pipe' }); }
};
// What the server must not inherit from the developer's shell: their folders, their guard dir, their self-edit switch
export const SCRUBBED = ['ESCADRILLE_GUARD_DIR', 'ESCADRILLE_SELF_EDIT', 'ESCADRILLE_SUPERVISED', 'ESCADRILLE_CLAUDE_PROJECTS', 'ESCADRILLE_HOST', 'ESCADRILLE_ENTRY', 'ESCADRILLE_SECRETS', 'ESCADRILLE_MODELS', 'ESCADRILLE_DB', 'ESCADRILLE_PLANS', 'ESCADRILLE_PROJECTS'];
export const installEnv = (base, { home, port }) => { const env = { ...base, HOME: home, PORT: String(port) }; for (const k of SCRUBBED) { delete env[k]; delete env[PREFIX + k.slice(LEGACY_PREFIX.length)]; } return env; };
/** A one-session plan on the clone itself, the smallest POST /api/plan accepts. */
export const selfPlan = (clone, title) => ({ title, project: clone, sessions: [{ id: 'A', name: 'probe', path: clone, prompt: 'probe', stops: ['probe'] }] });
const answers = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status; } catch { return 0; } };

/** Runs both installs; resolves { checks: [{ name, ok, detail }], failures: n }. */
export async function freshInstall({ source = ROOT, keep = false, log = () => {} } = {}) {
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ': ' + detail : ''}`); return !!ok; };
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-fresh-')));
  const clone = path.join(base, 'escadrille'), home = path.join(base, 'home');
  mkdirSync(home);
  const kids = [];
  try {
    // The command of the README, with a local path instead of GitHub
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', path.resolve(source), clone], { stdio: 'pipe' });
    check('the repository clones from its local path', existsSync(path.join(clone, 'install.sh')));
    // No private trace in the tracked files, with no exemption (docs/decisions.md and docs/backlog.md included):
    // red until the pilot has run `node scripts/trace-scan.mjs --living` on main, which is meant (docs/publication.md)
    const traces = scanTracked({ root: clone });
    const traced = [...new Set(traces.map((t) => t.file))];
    check('no private trace in the tracked files', traces.length === 0, `${traces.length} trace(s) in ${traced.length} file(s): ${traced.slice(0, 8).join(', ')}${traced.length > 8 ? ', …' : ''}`);
    const env = installEnv(process.env, { home, port: await freePort() });
    const install = (extraEnv) => {
      const child = spawn('./install.sh', ['--no-open'], { cwd: clone, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const run = { child, out: '', exited: new Promise((r) => child.on('exit', (code) => r(code))) };
      child.stdout.on('data', (d) => { run.out += d; }); child.stderr.on('data', (d) => { run.out += d; });
      kids.push(child);
      return run;
    };
    const stop = async (run) => { try { process.kill(-run.child.pid, 'SIGTERM'); } catch { /* already gone */ } await Promise.race([run.exited, sleep(5000)]); try { process.kill(-run.child.pid, 'SIGKILL'); } catch { /* gone */ } };
    const url = `http://localhost:${env.PORT}`;

    // 1. no Claude Code: one clear sentence, no server
    const missing = install({ ESCADRILLE_CLAUDE: path.join(base, 'no-such-claude') });
    const code = await Promise.race([missing.exited, sleep(15000).then(() => 'timeout')]);
    check('without Claude Code, install.sh stops with a failure', code === 1, `exit ${code}`);
    const sentence = missing.out.split('\n').find((l) => /claude code is not installed/i.test(l));
    check('it says in one sentence that Claude Code is missing', sentence && /cannot start a session/.test(sentence), JSON.stringify(missing.out.slice(0, 300)));
    check('and it started no server', (await answers(url)) === 0);
    await stop(missing);

    // 2. a Claude Code stub: the server starts
    const stub = path.join(base, 'claude');
    writeFileSync(stub, '#!/bin/sh\necho "2.1.316 (Claude Code)"\n'); chmodSync(stub, 0o755);
    const ok = install({ ESCADRILLE_CLAUDE: stub });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { up = (await answers(url)) === 200; if (!up) { if (ok.child.exitCode !== null) break; await sleep(200); } }
    check('install.sh starts the server on a free port', up, JSON.stringify(ok.out.slice(-400)));
    if (up) {
      check('install.sh checked node, git and claude', /ok\s+node/.test(ok.out) && /ok\s+git/.test(ok.out) && /ok\s+claude/.test(ok.out), JSON.stringify(ok.out.slice(0, 300)));
      const get = async (p) => { const r = await fetch(url + p, { signal: AbortSignal.timeout(5000) }); return { status: r.status, text: await r.text() }; };
      const jget = async (p) => { const r = await get(p); try { return { status: r.status, body: JSON.parse(r.text) }; } catch { return { status: r.status, body: null }; } };
      const home_ = await get('/');
      check('the home page is served', home_.status === 200 && /<html/i.test(home_.text));
      const projects = await jget('/api/projects'), plans = await jget('/api/plans'), escs = await jget('/api/escadrilles');
      check('the home is the empty state: no project', projects.status === 200 && Array.isArray(projects.body?.projects) && projects.body.projects.length === 0, JSON.stringify((projects.body?.projects || []).map((p) => p.path)));
      check('the home is the empty state: no plan', plans.status === 200 && Array.isArray(plans.body) && plans.body.length === 0, JSON.stringify((plans.body || []).map((p) => p.id)).slice(0, 300));
      check('the home is the empty state: no conversation', escs.status === 200 && Array.isArray(escs.body) && escs.body.length === 0);
      const fr = await jget('/i18n/fr.json');
      check('the empty state asks for a first project folder', fr.status === 200 && !!fr.body && 'main.addFirst' in fr.body, `HTTP ${fr.status}`);
      const status = await jget('/api/status?project=' + encodeURIComponent(clone));
      check('/api/status answers', status.status === 200 && status.body && typeof status.body === 'object', `HTTP ${status.status}`);

      // 3. the install firewall: a plan on Escadrille itself
      const post = async (title) => { const r = await fetch(url + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selfPlan(clone, title)), signal: AbortSignal.timeout(5000) }); return { status: r.status, text: await r.text() }; };
      const maintainer = configDirIn(home, 'maintainer');
      setOrigin(clone, OFFICIAL);
      const refused = await post('firewall official');
      check('a clone of the official repository cannot plan on Escadrille (403, fork)', refused.status === 403 && /fork/i.test(refused.text), `HTTP ${refused.status} ${refused.text.slice(0, 200)}`);
      setOrigin(clone, FORK);
      const fork = await post('firewall fork');
      check('a fork plans on Escadrille', fork.status === 200, `HTTP ${fork.status} ${fork.text.slice(0, 200)}`);
      setOrigin(clone, OFFICIAL);
      mkdirSync(path.dirname(maintainer), { recursive: true }); writeFileSync(maintainer, '');
      const maint = await post('firewall maintainer');
      check('a maintainer plans on the official clone', maint.status === 200, `HTTP ${maint.status} ${maint.text.slice(0, 200)}`);
      rmSync(maintainer, { force: true });
    }
    await stop(ok);
    check('the server is stopped', (await answers(url)) === 0);
  } catch (e) {
    check('the install ran to the end', false, e.message);
  } finally {
    for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (keep) log(`kept: ${base}`); else rmSync(base, { recursive: true, force: true });
  }
  return { checks, failures: checks.filter((c) => !c.ok).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const source = a.includes('--source') ? a[a.indexOf('--source') + 1] : ROOT;
  console.log('Fresh install of ' + source);
  const { failures } = await freshInstall({ source, keep: a.includes('--keep'), log: (l) => console.log(l) });
  console.log(failures ? `${failures} check(s) failed.` : 'A developer who has never seen Escadrille gets it running with the README command.');
  process.exit(failures ? 1 : 0);
}
