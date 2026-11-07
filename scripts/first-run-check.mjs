#!/usr/bin/env node
// Judges a run of scripts/first-run.sh, step by step: green, red, or « expected » (the dry run with a fake claude).
//   node scripts/first-run-check.mjs <run dir> [--report <dir>]
// Reads steps.jsonl and env.txt from the run, prints one line per step (verdict, duration, why) and writes report.md
// next to them (and into --report). Exit 0 when nothing is red, 1 otherwise. No network, no process, read only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_LABEL } from '../lib/names.mjs';

// What a new developer must see at each step; facts are the key=value pairs scripts/first-run.sh recorded
export const CRITERIA = {
  login: { title: 'Claude Code answers, logged in, under a fresh HOME', judge: (s, env) => {
    if (env.fake) return ['expected', 'fake claude: no login to check'];
    if (s.version_rc !== 0) return ['red', 'claude --version failed'];
    // A new developer's Claude Code is not logged in yet: that is their one gesture, not a defect of the product
    if (s.print_rc !== 0 && /not logged in/i.test(String(s.answer))) return ['manual', `« ${s.answer} »: the developer's one gesture, run claude once in a terminal and type /login (docs/first-run.md)`];
    if (s.print_rc !== 0) return ['red', `claude -p failed (exit ${s.print_rc}): ${s.answer || 'no answer'}; the one gesture: run claude once and log in`];
    return /\bok\b/i.test(String(s.answer)) ? ['green', `answered « ${s.answer} »`] : ['red', `unexpected answer « ${s.answer} »`];
  } },
  clone: { title: 'The committed tree is cloned', judge: (s) => (s.rc === 0 && s.install_sh === 'yes' ? ['green', `${s.kind} ${String(s.sha).slice(0, 10)}, ${s.files} files`] : ['red', `clone failed (rc ${s.rc}, install.sh ${s.install_sh})`]) },
  install: { title: './install.sh starts the server (window in dry mode)', judge: (s, env) => {
    if (s.http !== 200) return ['red', `the page never answered (http ${s.http}, install.sh ${s.alive ? 'alive' : 'exited'}); see install.log`];
    if (s.fail_lines > 0) return ['red', `${s.fail_lines} FAIL line(s) in install.log`];
    if (env.loggedOut && s.login_warn === 0) return ['red', 'Claude Code is not logged in and install.sh did not say so'];
    if (s.ms > 30000) return ['red', `the page took ${Math.round(s.ms / 1000)} s (more than 30 s)`];
    return ['green', `${s.ok_lines} ok, ${s.warn_lines} warn, page up in ${(s.ms / 1000).toFixed(1)} s`];
  } },
  page: { title: 'The first page answers, empty state', judge: (s) => {
    if (s.http !== 200) return ['red', `GET / answered ${s.http}`];
    if (s.projects !== 0) {
      const inherited = String(s.via) === 'migration' && s.plans_committed > 0;
      return ['red', `the fresh install lists ${s.projects} project(s)${inherited ? `, via migration from the ${s.plans_committed} plans/*.json the source commits (their folders exist on this Mac; on a new Mac they would not; the public export must ship no plan, docs/publication.md)` : ': a fresh home must be empty'}`];
    }
    return ['green', `200, ${s.bytes} bytes, no project, guard-link ${s.guard_link}`];
  } },
  project: { title: 'The throwaway project exists (three files, git)', judge: (s) => (s.rc === 0 && s.files === 3 ? ['green', s.path] : ['red', `git init/commit rc ${s.rc}, ${s.files} files`]) },
  window: { title: 'The window install.sh opens sets the guard cookie', judge: (s) => {
    if (!s.opened) return ['red', 'install.sh opened nothing (no open-app.sh line in install.log)'];
    return s.cookie === 1 ? ['green', `${s.opened} → ${s.http}, cookie set`] : ['red', `the window loads ${s.opened} without the guard cookie: every action of its page answers 403`];
  } },
  add_nocookie: { title: 'A tab without the cookie (localhost typed in the usual browser): Add a project', judge: (s) => {
    if (s.http !== 403) return ['red', `answered ${s.http}: the gate let a request without proof through`];
    return /guard-link/.test(String(s.error)) ? ['green', `403 with the path: « ${s.error} »`] : ['warn', `403 « ${s.error} »: true, but it does not give the path that works (open ${CONFIG_LABEL}/guard-link once)`];
  } },
  add: { title: 'The project is added from the window and listed', judge: (s) => {
    if (s.http === 200 && s.listed === 'yes') return s.cookie === 2 ? ['red', `only after opening ${CONFIG_LABEL}/guard-link by hand: the window had no cookie`] : ['green', 'at once'];
    return ['red', `http ${s.http}, listed ${s.listed}`];
  } },
  plan_request: { title: 'The first plan is asked for (POST /api/escadrille)', judge: (s) => (s.http === 200 && s.id ? ['green', `escadrille ${s.id}`] : ['red', `http ${s.http}, no id`]) },
  plan: { title: 'The escadrille:plan block arrives', judge: (s, env) => {
    if (s.plan === 'yes') return ['green', `plan in ${Math.round(s.ms / 1000)} s${s.replied ? ' (after one « take your recommendations »)' : ''}; ${s.page}`];
    if (env.loggedOut && s.status === 'error') return ['manual', `no plan until the login: the page shows « ${s.error || 'Not logged in · Please run /login'} »; rerun after /login`];
    if (env.fake) return s.status === 'error' ? ['expected', `fake claude: the planner stops cleanly (status error, ${Math.round(s.ms / 1000)} s)`] : ['red', `fake claude, but status ${s.status}: the failure is not clean`];
    return ['red', `no plan: status ${s.status}${s.ms >= s.timeout * 1000 ? `, after ${s.timeout} s` : ''}; see escadrille-final.json`];
  } },
};

export const readEnv = (text) => Object.fromEntries(String(text).split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
export const judge = (steps, env) => {
  const login = steps.find((s) => s.step === 'login');
  const e = { ...env, fake: env.fake === '1' || env.fake === 1 || env.fake === true, loggedOut: !!login && /not logged in/i.test(String(login.answer || '')) };
  return steps.map((s) => {
    const c = CRITERIA[s.step]; if (!c) return { step: s.step, title: s.step, verdict: 'red', why: 'unknown step', ms: s.ms };
    const [verdict, why] = c.judge(s, e); return { step: s.step, title: c.title, verdict, why, ms: s.ms };
  });
};
const MARK = { green: 'green', red: 'RED  ', expected: 'expct', warn: 'warn ', manual: 'hand ' };
export const lines = (rows) => rows.map((r) => `${MARK[r.verdict]}  ${String((r.ms / 1000).toFixed(1)).padStart(6)} s  ${r.title}: ${r.why}`);
export const markdown = (rows, env) => [
  `# First run, ${env.started || ''}`, '',
  `Source ${env.source} @ ${env.ref}, port ${env.port}, ${env.fake === '1' ? 'fake claude (dry run)' : `claude ${env.claude_real}`}, ${env.node}, ${env.git}, macOS ${env.macos}, plan budget ${env.budget} $.`, '',
  '| | Step | Time | Why |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.verdict === 'green' ? '🟢' : r.verdict === 'red' ? '🔴' : r.verdict === 'warn' ? '🟠' : r.verdict === 'manual' ? '✋' : '⚪'} | ${r.title} | ${(r.ms / 1000).toFixed(1)} s | ${String(r.why).replace(/\|/g, '\\|')} |`),
  '', `${rows.filter((r) => r.verdict === 'red').length} red, ${rows.filter((r) => r.verdict === 'warn').length} warn, ${rows.filter((r) => r.verdict === 'manual').length} by hand, ${rows.filter((r) => r.verdict === 'green').length} green, ${rows.filter((r) => r.verdict === 'expected').length} expected.`, '',
].join('\n');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir || !existsSync(path.join(dir, 'steps.jsonl'))) { console.error('usage: node scripts/first-run-check.mjs <run dir> [--report <dir>]'); process.exit(2); }
  const report = rest[0] === '--report' ? rest[1] : null;
  const steps = readFileSync(path.join(dir, 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const env = readEnv(existsSync(path.join(dir, 'env.txt')) ? readFileSync(path.join(dir, 'env.txt'), 'utf8') : '');
  const rows = judge(steps, env);
  console.log(lines(rows).join('\n'));
  const md = markdown(rows, env);
  writeFileSync(path.join(dir, 'report.md'), md);
  if (report) { mkdirSync(report, { recursive: true }); writeFileSync(path.join(report, 'report.md'), md); }
  const red = rows.filter((r) => r.verdict === 'red').length;
  console.log(red ? `${red} red: ${path.join(dir, 'report.md')}` : `all green: ${path.join(dir, 'report.md')}`);
  process.exit(red ? 1 : 0);
}
