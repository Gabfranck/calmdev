// The declared tests of a project (lesson of 3 November, session TST; docs/projecttests.md): a « TEST: <name> » line alone
// on its line asks the server to run the test the developer declared under that name, outside the sandbox, on the
// session's worktree, in the project's container when declared; one test at a time per project; the verdict (exit code,
// failing files or tests, a summary cut at 60 lines) leads the next message. Never a command written by the session.
//
//   validateTests(raw)                 → { value, errors }: environment.projectTests = { <name>: { command, dir?, service?, timeoutMs? } }
//   argvOf(entry, { project, worktree }) → the argv, the placeholders {project} and {worktree} replaced, nothing else
//   failures(out)                      → the failing files or tests read from node --test, PHPUnit, Pest and Pint
//   testRun({ name, environment, project, worktree, … }) → { ok, code, name, failed, lines, refused?, error? }
//   testNote(r)                        → the lines handed to the session (60 at most)
//   instruction(environment)           → the sentence of the session's instruction, '' when nothing is declared
//   createProjectTests({ … })          → { ofTurn(planId, sid, text, state, worktree), busy, queue } for the server
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import * as names from './names.mjs';
import { safeEnv } from './planner.mjs';
import { createQueue, argvFor, run as dockerRun, masker } from './docker.mjs';
import { parseLines, tokenize } from './gitops.mjs';
import { failingFiles } from './testbox.mjs';

export const MAX_LINES = 60;
export const MAX_PER_TURN = 2;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const KEYS = ['command', 'dir', 'service', 'timeoutMs', 'note'];

// ---------------------------------------------------------------- the setting environment.projectTests
export const validateTests = (raw) => {
  if (raw === undefined || raw === null) return { value: null, errors: null };
  const errors = []; const value = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { value: null, errors: ['environment.projectTests : un objet { "<nom>": { command, dir, service, timeoutMs } }'] };
  for (const [name, t] of Object.entries(raw)) {
    const at = `environment.projectTests.${name}`;
    if (!NAME.test(name)) { errors.push(`environment.projectTests : « ${clip(name, 40)} » n’est pas un nom (lettres, chiffres, - et _)`); continue; }
    if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.push(`${at} : un objet { command, dir, service, timeoutMs }`); continue; }
    for (const k of Object.keys(t)) if (!KEYS.includes(k)) errors.push(`${at}.${k} : inconnu (${KEYS.join(', ')})`);
    const c = typeof t.command === 'string' ? t.command.trim() : '';
    if (!c || c.length > 500 || /[\r\n]/.test(c)) { errors.push(`${at}.command : une ligne de commande (sans shell)`); continue; }
    const w = tokenize(c); if (w.error || !w.words.length) { errors.push(`${at}.command : ${w.error || 'vide'}`); continue; }
    const entry = { command: c };
    if (t.dir !== undefined && t.dir !== null && t.dir !== '.') {
      const d = String(t.dir).trim();
      if (t.service) { if (!path.isAbsolute(d)) errors.push(`${at}.dir : avec un service, le dossier dans le conteneur, absolu`); else entry.dir = d; }
      else if (!d || path.isAbsolute(d) || d.split('/').some((s) => s === '..')) errors.push(`${at}.dir : un chemin relatif au worktree de la session`);
      else entry.dir = d;
    }
    if (t.service !== undefined && t.service !== null) { const s = String(t.service).trim(); if (!SERVICE.test(s)) errors.push(`${at}.service : un nom de service du compose`); else entry.service = s; }
    if (t.timeoutMs !== undefined && t.timeoutMs !== null) { const n = Number(t.timeoutMs); if (!Number.isInteger(n) || n < 1000 || n > 3600000) errors.push(`${at}.timeoutMs : des millisecondes, de 1 000 à 3 600 000`); else entry.timeoutMs = n; }
    if (t.note !== undefined && t.note !== null) { if (typeof t.note !== 'string' || t.note.length > 500) errors.push(`${at}.note : un texte court`); else entry.note = t.note; }
    value[name] = entry;
  }
  return errors.length ? { value: null, errors } : { value: Object.keys(value).length ? value : null, errors: null };
};

// The only argv ever run: the developer's words, {project} and {worktree} replaced inside a word, nothing from the session
export const argvOf = (entry, { project, worktree }) => tokenize(entry.command).words.map((w) => w.replaceAll('{project}', project || '').replaceAll('{worktree}', worktree || ''));

// ---------------------------------------------------------------- what failed
export const failures = (out) => {
  const found = [...failingFiles(out)];
  const add = (s) => { const t = clip(s.trim(), 200); if (t && !found.includes(t)) found.push(t); };
  for (const raw of String(out).split('\n')) {
    const l = raw.replace(ANSI, '');
    let m;
    if ((m = /^\s*\d+\) ([\w\\]+::\w+)/.exec(l))) add(m[1]); // PHPUnit
    else if ((m = /^\s*FAILED\s+(.+?)(?:\s+\S*Exception.*)?$/.exec(l))) add(m[1]); // Pest
    else if ((m = /^\s*[⨯✗✕]\s+(\S+\.php)\b/.exec(l))) add(m[1]); // Pint
    else if ((m = /^\s*not ok \d+ - (.+)$/.exec(l)) && !found.length) add(m[1]); // TAP without a location
  }
  return found.slice(0, 30);
};

// ---------------------------------------------------------------- one run, outside the sandbox
const realIn = (root, rel) => {
  let base; try { base = realpathSync(root); } catch { return { error: `worktree introuvable (${root})` }; }
  const abs = path.resolve(base, rel || '.');
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { error: `dossier ${rel} absent du worktree` };
  const r = realpathSync(abs);
  if (r !== base && !r.startsWith(base + path.sep)) return { error: `dossier ${rel} hors du worktree` };
  return { dir: r };
};
// → { code, out, lines, error? }; out kept whole (2 MB at most) for the failures, lines: the last maxLines
const hostRun = ({ argv, cwd, env, timeoutMs, spawn, maxLines = MAX_LINES }) => new Promise((resolve) => {
  let child;
  try { child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true }); }
  catch (e) { resolve({ code: null, out: '', lines: [], error: e.message }); return; }
  let out = ''; const lines = []; const rest = { out: '', err: '' };
  const take = (k, chunk) => { const s = String(chunk); if (out.length < 2e6) out += s; rest[k] += s.replace(ANSI, ''); const parts = rest[k].split(/\r?\n/); rest[k] = parts.pop(); for (const p of parts) { if (p.trim()) lines.push(clip(p, 300)); if (lines.length > maxLines) lines.shift(); } };
  child.stdout?.on('data', (c) => take('out', c)); child.stderr?.on('data', (c) => take('err', c));
  let done = false; let killed = false;
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  const timer = setTimeout(() => { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref(); }, timeoutMs);
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); for (const k of ['out', 'err']) if (rest[k].trim()) { lines.push(clip(rest[k], 300)); if (lines.length > maxLines) lines.shift(); } resolve(r); };
  child.on('error', (e) => finish({ code: null, out, lines, error: e.code === 'ENOENT' ? `${argv[0]} introuvable` : e.message }));
  child.on('exit', (code, signal) => finish({ code: code ?? (signal ? 128 : 1), out, lines, ...(killed ? { error: `délai de ${Math.round(timeoutMs / 1000)} s dépassé` } : {}) }));
});

export const testRun = async ({ name, environment, accounts = null, project = null, worktree = null, env = process.env, spawn = nodeSpawn } = {}) => {
  const base = { name, code: null, failed: [], lines: [] };
  const no = (error) => ({ ...base, ok: false, refused: true, error });
  const declared = environment?.projectTests || {};
  if (!NAME.test(String(name || ''))) return no('un nom de test est attendu : TEST: <nom>');
  const entry = Object.hasOwn(declared, name) ? declared[name] : null;
  if (!entry) { const names = Object.keys(declared); return no(`« ${clip(String(name), 40)} » n’est pas un test déclaré pour ce projet (${names.length ? 'déclarés : ' + names.join(', ') : 'aucun : Accès › Réglages › environment.projectTests'})`); }
  if (!worktree) return no('session sans worktree : rien ne tourne à la racine du projet');
  const root = realIn(worktree, '.'); if (root.error) return no(root.error);
  const w = entry.service ? root : realIn(worktree, entry.dir); if (w.error) return no(w.error);
  const argv = argvOf(entry, { project, worktree: root.dir });
  const hide = masker(environment, accounts); const timeoutMs = entry.timeoutMs || DEFAULT_TIMEOUT_MS;
  const vars = names.envPairs({ WORKTREE: root.dir, PROJECT: project || '', TEST: name });
  let r;
  if (entry.service) {
    // docker compose [-f …] exec [-w <dir>] -T <service> <argv>, from the project's folder (environment.cwd)
    const args = argvFor('exec', { service: entry.service, words: argv, environment });
    if (entry.dir) args.splice(args.indexOf('exec') + 1, 0, '-w', entry.dir);
    const d = await dockerRun({ args, environment, project, env, timeoutMs, spawn, maxLines: MAX_LINES });
    r = { code: d.code, out: d.stdout + '\n' + d.lines.join('\n'), lines: d.lines, error: d.error };
  } else {
    r = await hostRun({ argv, cwd: w.dir, env: { ...safeEnv(env), ...(environment?.env || {}), ...vars }, timeoutMs, spawn });
  }
  const failed = r.code === 0 ? [] : failures(r.out).map(hide);
  return { ...base, ok: !r.error && r.code === 0, code: r.code, failed, lines: r.lines.map(hide), service: entry.service || null, ...(r.error ? { error: hide(r.error) } : {}) };
};

// ---------------------------------------------------------------- the note: 60 lines at most
export const testNote = (r) => {
  const head = `TEST ${r.name}${r.service ? ` (conteneur ${r.service})` : ''} : `;
  const verdict = r.refused ? 'refusé : ' + r.error : r.ok ? `ok (code ${r.code})` : `échec (code ${r.code}${r.error ? ', ' + r.error : ''})${r.failed.length ? ` · ${r.failed.length} en échec` : ''}`;
  const fail = (r.failed || []).slice(0, 15).map((f) => '  ✖ ' + f);
  const room = MAX_LINES - 1 - fail.length;
  const tail = (r.lines || []).slice(-room).map((l) => '  │ ' + l);
  return [head + verdict, ...fail, ...tail].join('\n');
};

export const instruction = (environment) => {
  const names = Object.keys(environment?.projectTests || {}); if (!names.length) return '';
  return `Les tests du projet tournent hors du bac par une ligne seule \`TEST: <nom>\` (déclarés : ${names.join(', ')}) : le serveur lance la commande que le développeur a déclarée, un test à la fois par projet, et rend le code, les échecs et 60 lignes en tête de ton message suivant (docs/projecttests.md). Un plan n’est livré qu’une fois ses tests passés.`;
};

// ---------------------------------------------------------------- the server's side
// environmentOf(project), accountsOf(project), record({ project, planId, sessionId, kind, text }), onNote(planId, sid, line, r),
// onIdle(planId, sid), projectOfPlan(planId)
export const parseTests = (text, state) => parseLines('TEST', text, state, MAX_PER_TURN);
export const createProjectTests = ({ environmentOf = () => null, accountsOf = () => null, record = () => {}, onNote = () => {}, onIdle = () => {}, projectOfPlan = () => null, env = process.env, spawn = nodeSpawn } = {}) => {
  const queue = createQueue();
  const ofTurn = (planId, sid, text, state, worktree) => {
    const names = parseTests(text, state); if (!names.length) return 0;
    const project = projectOfPlan(planId);
    for (const name of names) {
      const t0 = Date.now();
      queue.push(project || '(aucun projet)', () => testRun({ name, environment: environmentOf(project), accounts: accountsOf(project), project, worktree, env, spawn }), { planId, sid }).then((r) => {
        if (project) try { record({ kind: 'note', project, planId, sessionId: sid, text: `Test ${clip(name, 40)} (session ${sid}) : ${r.refused ? 'refusé : ' + clip(r.error, 200) : `code ${r.code}${r.failed.length ? `, ${r.failed.length} en échec` : ''}`} en ${Math.round((Date.now() - t0) / 1000)} s` }); } catch {}
        try { onNote(planId, sid, testNote(r), r); } catch {}
        if (!queue.busy(planId, sid)) { try { onIdle(planId, sid); } catch {} }
      });
    }
    return names.length;
  };
  return { ofTurn, busy: queue.busy, queue };
};
