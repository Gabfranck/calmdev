#!/usr/bin/env node
// The real trial (docs/lancement.md): Escadrille against a REAL Claude Code, not the fake one of test/.
// A throwaway server (its own base, plans folder and port) launches one Sonnet session capped at 1 $ on a
// throwaway git repository; the session reaches a stop, gets an answer by the API, finishes, and its review
// opens. The journal of the run goes to docs/essai-reel-<date>.json. Everything is removed at the end.
//
//   node scripts/e2e-real.mjs            the real trial: bills a real Sonnet session, 1 $ at most
//   node scripts/e2e-real.mjs --dry      everything but claude (the fake of test/fake-claude.mjs plays it): free
//   --out <file>        the journal path (default docs/essai-reel-<date>.json, with -dry in the name for --dry)
//   --timeout-min <n>   give up after n minutes (default 10)
//   --keep              keep the throwaway folder and server log (default: removed)
//
// What it does on the Mac: starts a Node server on 127.0.0.1 on a free port, creates a folder under the system
// temp dir, runs git in it, runs `claude` once (sandboxed by Escadrille, no network domain opened), writes one
// file in docs/. Dev's own server, sessions.sqlite and projects are never touched. The only paid call is the
// Sonnet session, capped by --max-budget-usd 1.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vars } from '../lib/names.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
export const BUDGET_USD = 1;
export const MODEL = 'claude-sonnet-5-5';
const PROMPT = [
  'This is a throwaway trial of Escadrille. Do exactly this, nothing more, and keep it short:',
  '1. Create the file docs/essai.txt with one line: "Escadrille works with a real Claude."',
  '2. Run `git add docs/essai.txt && git commit -m "docs: the trial file"`.',
  '3. End your turn with the escadrille:state block, stop 0 reached, done false, and wait for my answer.',
  'When I answer, end that turn with the block again: stops [0,1], done true. Do not read or explore anything else.',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const parseArgs = (argv) => {
  const o = { dry: false, keep: false, out: null, timeoutMin: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) throw new Error('--timeout-min: a positive number');
  return o;
};

export const run = async (opts = {}) => {
  const o = { dry: false, keep: false, out: null, timeoutMin: 10, ...opts };
  const started = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const out = o.out ? path.resolve(o.out) : path.join(ROOT, 'docs', `essai-reel-${date}${o.dry ? '-dry' : ''}.json`);
  const journal = { date, mode: o.dry ? 'dry' : 'real', model: MODEL, budgetUsd: BUDGET_USD, steps: [], answers: [], ok: false };
  const step = (what, data) => { journal.steps.push({ t: Math.round((Date.now() - started) / 100) / 10, what, ...(data !== undefined ? { data } : {}) }); };
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-e2e-')));
  let server = null; let base = ''; let log = ''; let planId = ''; const sid = 'A';
  const get = async (p) => { const r = await fetch(base + p); const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${body.error || ''}`); return body; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${body.error || ''}`); return body; };
  try {
    // 1. the throwaway repository
    const repo = path.join(dir, 'repo'); mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'trial@example.com']); git(repo, ['config', 'user.name', 'Escadrille trial']);
    writeFileSync(path.join(repo, 'README.md'), '# Trial\n\nA throwaway repository for the real trial of Escadrille.\n');
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'init']);
    step('repo', repo);

    // 2. which claude: the real one, or the fake in --dry
    let claude = vars.CLAUDE || 'claude'; let env = {};
    if (o.dry) {
      const { fakeClaude } = await import('../test/fake-claude.mjs');
      const fake = fakeClaude(); claude = fake.file;
      // one turn asks a local command and writes + commits the file, the next one (the answer) finishes
      env = { FAKE_CLAUDE_TURNS: JSON.stringify([{ command: 'rm -f out.txt', rule: 'rm:*', write: 'docs/essai.txt', stops: [0], claude: 'Regarde docs/essai.txt' }, { stops: [0, 1], claude: 'Tout est dans docs/', done: true }]) };
    } else {
      try { journal.claudeVersion = execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim(); } catch { throw new Error('claude is not found on PATH (or ESCADRILLE_CLAUDE): install Claude Code first'); }
    }
    step('claude', o.dry ? 'fake (dry)' : journal.claudeVersion);

    // 3. the throwaway server
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    mkdirSync(path.join(dir, 'plans')); mkdirSync(path.join(dir, 'transcripts'));
    server = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, ...env, PORT: String(port), ESCADRILLE_DB: path.join(dir, 'db.sqlite'), ESCADRILLE_PLANS: path.join(dir, 'plans'), ESCADRILLE_TRANSCRIPTS: path.join(dir, 'transcripts'), ESCADRILLE_CLAUDE: claude }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    const deadline = started + o.timeoutMin * 60e3;
    const until = async (what, fn) => { for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`); if (server.exitCode !== null) throw new Error('the server stopped'); await sleep(500); } };
    await until('the server', async () => { try { await get('/api/plans'); return true; } catch { return false; } });
    step('server', { port });

    // 4. the plan: one Sonnet session, 1 $, no network domain
    planId = `essai-reel-${Date.now()}`;
    await post('/api/plan', { id: planId, title: 'Real trial', sessions: [{ id: sid, name: 'Trial', path: repo, model: MODEL, budget: BUDGET_USD, stops: ['The file is written and committed', 'The end'], prompt: PROMPT }] });
    const launched = await post('/api/launch', { plan: planId });
    step('launched', launched);
    const rowOf = async () => (await get(`/api/plan/${planId}`)).state.find((s) => s.id === sid);

    // 5. drive it: allow what is local, deny the network, answer the first stop once, wait for the end
    let answered = false; const seen = new Set();
    const final = await until('the session to finish', async () => {
      const row = await rowOf(); if (!row) return null;
      for (const p of row.pending || []) {
        if (p.kind !== 'permission' || seen.has(p.id)) continue;
        seen.add(p.id); const allow = !p.network;
        journal.answers.push({ kind: 'permission', tool: p.tool, text: String(p.text).slice(0, 200), network: !!p.network, allow });
        await post(`/api/plan/${planId}/session/${sid}/answer`, { id: p.id, allow, ...(allow ? {} : { message: 'No network in this trial.' }) });
        step('permission', { tool: p.tool, allow });
      }
      if (row.status === 'done') return row;
      if (['error', 'stopped'].includes(row.status)) throw new Error(`the session ended in ${row.status}: ${row.claude || ''}`);
      const reply = (row.pending || []).find((p) => p.kind === 'reply');
      if (reply && !answered && row.status === 'waiting') {
        answered = true; step('stop', { stop: reply.stop, text: String(reply.text).slice(0, 200) });
        const text = 'Yes, go on: finish now with stops [0,1] and done true.';
        journal.answers.push({ kind: 'reply', text }); await post(`/api/plan/${planId}/session/${sid}/message`, { text });
        step('answered');
      }
      return null;
    });
    step('done', { stops: final.stops, cost: final.usage?.cost ?? null });
    journal.session = { status: final.status, stops: final.stops, health: final.health, claude: final.claude, summary: final.summary ?? null, usage: final.usage, branch: final.worktree?.branch ?? null };

    // 6. the review of the session opens
    const rv = await get(`/api/review?plan=${encodeURIComponent(planId)}&session=${sid}`);
    journal.review = { id: rv.id, title: rv.title, base: rv.base, head: rv.head, files: (rv.files || []).map((f) => f.path), verdict: rv.verdict ?? null };
    step('review', { files: journal.review.files });
    journal.messages = (await get(`/api/plan/${planId}/session/${sid}/messages`)).messages.map((m) => ({ role: m.role, text: String(m.text).slice(0, 300), at: m.at }));

    const checks = {
      stopReached: answered,
      finished: final.status === 'done' && (final.stops || []).includes(1),
      underBudget: (final.usage?.cost ?? 0) <= BUDGET_USD,
      reviewOpens: journal.review.files.includes('docs/essai.txt'),
    };
    journal.checks = checks; journal.ok = Object.values(checks).every(Boolean);
  } catch (e) {
    journal.error = e.message; step('error', e.message);
    if (base && planId) { try { await post(`/api/plan/${planId}/session/${sid}/stop`, {}); } catch {} }
  } finally {
    journal.seconds = Math.round((Date.now() - started) / 100) / 10;
    if (server) { server.kill('SIGINT'); await new Promise((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r(); }, 3000); server.once('exit', () => { clearTimeout(t); r(); }); }); }
    if (o.keep) { writeFileSync(path.join(dir, 'server.log'), log); journal.kept = dir; }
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(journal, null, 1) + '\n');
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  }
  return { ok: journal.ok, out, journal, cleaned: !o.keep && !existsSync(dir), dir };
};

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const r = await run(opts);
  console.log(`${r.ok ? 'OK' : 'FAILED'} (${r.journal.mode}) · ${r.journal.seconds} s · cost ${r.journal.session?.usage?.cost ?? '?'} $ · journal: ${r.out}`);
  if (!r.ok) console.log(r.journal.error || JSON.stringify(r.journal.checks));
  process.exit(r.ok ? 0 : 1);
}
