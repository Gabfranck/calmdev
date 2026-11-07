// Phase 7, the plan templates (plans/templates): they load with every field, GET /api/templates lists them
// without their hints, POST /api/escadrille refuses an unknown one and keeps a known one, and the planner's
// system prompt gets "## Le gabarit choisi" only then.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const TDIR = path.join(HERE, '..', 'plans', 'templates');
const files = readdirSync(TDIR).filter((f) => f.endsWith('.json'));

test('the three templates load, each with all its fields, and every hole of the idea has a field', () => {
  assert.deepEqual(files.map((f) => f.replace(/\.json$/, '')).sort(), ['passe-design', 'revue-pr', 'sprint-linear']);
  for (const f of files) {
    const t = JSON.parse(readFileSync(path.join(TDIR, f), 'utf8'));
    assert.equal(t.id, f.replace(/\.json$/, ''));
    for (const k of ['title', 'summary', 'idea']) assert.ok(typeof t[k] === 'string' && t[k].length > 5, `${t.id}.${k}`);
    assert.ok(!t.summary.includes('\n'), 'the summary is one line');
    assert.ok(Array.isArray(t.hints) && t.hints.length >= 3 && t.hints.every((h) => typeof h === 'string' && h), `${t.id}.hints`);
    assert.ok(Array.isArray(t.fields) && t.fields.length >= 1 && t.fields.every((x) => x.key && x.label), `${t.id}.fields`);
    const holes = [...t.idea.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    assert.ok(holes.length >= 1);
    for (const h of holes) assert.ok(t.fields.some((x) => x.key === h), `${t.id}: no field for [${h}]`);
  }
});

const proj = tmp('escadrille-tpl-'); mkdirSync(proj, { recursive: true }); writeFileSync(path.join(proj, 'x'), '');
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-tpl-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-tpl-plans-'), ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill('SIGINT'));
const call = async (p, body) => { const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const ready = until(async () => { try { await call('/api/plans'); return true; } catch { return false; } });
const promptWith = (idea) => until(() => { try { const a = JSON.parse(readFileSync(path.join(fake.dir, 'args.json'), 'utf8')); const sp = a[a.indexOf('--append-system-prompt') + 1]; const last = readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').pop(); return last.includes(idea) ? sp : null; } catch { return null; } });

test('GET /api/templates lists them without the hints', async () => {
  await ready;
  const r = await call('/api/templates');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((t) => t.id), ['passe-design', 'revue-pr', 'sprint-linear']);
  for (const t of r.body) { assert.ok(!('hints' in t)); assert.ok(t.title && t.summary && t.idea && t.fields.length); }
});

test('an unknown template is refused, a known one is kept and reaches the planner’s system prompt', async () => {
  await ready;
  const base = { project: proj, model: 'claude-sonnet-5-5' };
  const bad = await call('/api/escadrille', { ...base, idea: 'Idée A', template: 'inconnu' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /gabarit/);
  const none = await call('/api/escadrille', { ...base, idea: 'Idée sans gabarit' });
  assert.equal(none.status, 200);
  assert.ok(!/^## Le gabarit choisi$/m.test(await promptWith('Idée sans gabarit')), 'the skill quotes the title, the heading is the server’s');
  assert.equal((await call(`/api/escadrille/${none.body.id}`)).body.escadrille.template, null);
  const ok = await call('/api/escadrille', { ...base, idea: 'Idée Sprint', template: 'sprint-linear' });
  assert.equal(ok.status, 200);
  const sp = await promptWith('Idée Sprint');
  const t = JSON.parse(readFileSync(path.join(TDIR, 'sprint-linear.json'), 'utf8'));
  const at = sp.search(/^## Le gabarit choisi$/m); const sec = sp.slice(at);
  assert.ok(sp.indexOf('## Cette planification') < at);
  assert.ok(sec.includes(t.title) && sec.includes(t.summary) && t.hints.every((h) => sec.includes(h)));
  assert.equal((await call(`/api/escadrille/${ok.body.id}`)).body.escadrille.template, 'sprint-linear');
});
