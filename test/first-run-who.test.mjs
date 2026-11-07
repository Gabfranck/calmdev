// « Qui décide quand je ne suis pas là ? » (backlog, Dev 6 November, premier contact): a project added from the app
// starts with « Je valide le goût et la sécurité » (mode guide), asked once, and no automatic burst; an old autoBurst
// stays readable; the burst screen no longer turns the automatic burst on
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const repo = () => { const root = path.join(tmp('escadrille-who-'), 'hello'); mkdirSync(root, { recursive: true }); try { execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' }); } catch { mkdirSync(path.join(root, '.git')); } return root; }; // a sandbox without git: the folder alone
const DB = path.join(tmp('escadrille-who-db-'), 'db.sqlite');
const fresh = repo(); const old = repo();
mkdirSync(path.join(fresh, 'docs')); writeFileSync(path.join(fresh, 'docs', 'backlog.md'), '- [ ] Une tâche\n');
{ // an old project, set before the change: autoBurst on, no autonomy
  const db = new DatabaseSync(DB);
  db.exec('create table if not exists project_settings (project text primary key, json text, at text)');
  db.prepare('insert into project_settings values (?, ?, ?)').run(old, JSON.stringify({ autoBurst: { on: true, minMarginPct: 30, maxHoursLeft: 8 } }), '2026-11-01');
  db.close();
}
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-who-plans-'), ESCADRILLE_PROJECTS: path.join(tmp('escadrille-who-reg-'), 'projects.json') }, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const call = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const ready = (async () => { for (let i = 0; i < 100; i++) { try { await call('/api/plans'); return; } catch { await new Promise((r) => setTimeout(r, 150)); } } throw new Error('server down: ' + err); })();
const q = encodeURIComponent;

test('a new project: the question asked with « Je valide le goût et la sécurité » checked, no automatic burst', async () => {
  await ready;
  const add = await call('/api/projects', { path: fresh }); assert.equal(add.status, 200, JSON.stringify(add.body)); assert.equal(add.body.added, true);
  const s = (await call(`/api/project/settings?project=${q(fresh)}`)).body;
  assert.equal(s.autonomy.mode, 'guide'); assert.equal(s.autonomy.ask, true, 'the first run asks once');
  assert.equal(s.autonomy.cran, 'moi', 'nothing written but the mode until « Garder ce choix »: the pilot is still off');
  assert.deepEqual(s.autonomy.caps, { wake: 2, day: 15, plan: 10 }, 'what it costs at most');
  assert.equal(s.autoBurst, null, 'no automatic burst');
  const { caps, ask, cran, pilotOn, ...a } = s.autonomy; // « Garder ce choix » (the mode half of the cran Pilote)
  const r = await call('/api/project/settings', { project: fresh, autonomy: { ...a, mode: 'guide' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.settings.autonomy.ask, false, 'asked once only');
  assert.equal((await call('/api/projects', { path: fresh })).body.added, false);
  assert.equal((await call(`/api/project/settings?project=${q(fresh)}`)).body.autonomy.mode, 'guide', 'adding again changes nothing');
});

test('an old autoBurst setting is still read, and turned off by null', async () => {
  await ready;
  const s = await call(`/api/project/settings?project=${q(old)}`);
  assert.equal(s.status, 200); assert.deepEqual(s.body.autoBurst, { on: true, minMarginPct: 30, maxHoursLeft: 8 });
  assert.equal(s.body.autonomy.mode, 'surveille', 'an old project keeps the defaults'); assert.equal(s.body.autonomy.ask, false);
  const off = await call('/api/project/settings', { project: old, autoBurst: null }); assert.equal(off.status, 200); assert.equal(off.body.settings.autoBurst, null);
});

test('« Avancer le backlog »: an hour already past is refused before anything starts', async () => {
  await ready;
  const r = await call('/api/burst', { project: fresh, capUsd: 5, until: '2020-01-01T10:00:00Z' });
  assert.equal(r.status, 400); assert.match(r.body.error, /until/, 'a refusal that says why');
});

test('the screen: no switch for the automatic burst, the question and the words in both languages', () => {
  const js = readFileSync(path.join(HERE, '..', 'public', 'burst.js'), 'utf8');
  assert.ok(!js.includes('burstAutoOn'), 'the autoBurst switch is gone'); assert.ok(js.includes('burstUntil'), 'until what hour');
  assert.match(js, /input\[type=time\] \{ width: 1\d\dpx/, 'the hour field shows the whole hour, never « 10: »');
  const css = readFileSync(path.join(HERE, '..', 'public', 'mainchat.css'), 'utf8');
  assert.match(css, /\.mc-scroll\.mc-first \{[^}]*align-content: safe center/, 'the first-run question is never cut at its top');
  const mc = readFileSync(path.join(HERE, '..', 'public', 'mainchat.js'), 'utf8');
  assert.match(mc, /class="btn\$\{whoAsks\(\) \? '' : ' primary'\}" id="send"/, '« Garder ce choix » is the one primary action while asked');
  assert.match(mc, /const toEnd = \(c\) => \{ if \(c && stick && !c\.classList\.contains\('mc-first'\)\)/, 'an empty project is read from its top, never scrolled to its foot');
  assert.match(mc, /\$\{who \|\| `<p>/, 'the question stands in for the starters: together they cut its head');
  for (const lang of ['fr', 'en']) {
    const t = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', lang + '.json'), 'utf8'));
    for (const k of ['who.title', 'who.moi', 'who.pilote', 'who.autonome', 'who.left', 'who.moiLeft', 'who.piloteLeft', 'who.autonomeLeft', 'who.never', 'pilot.what', 'burst.advancing', 'burst.until', 'burst.atMost']) assert.ok(t[k], `${lang} ${k}`);
  }
  const fr = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', 'fr.json'), 'utf8'));
  // the three crans of docs/nextstep.md, with what stays with the developer (HUMAN_KINDS)
  assert.deepEqual(['who.moi', 'who.pilote', 'who.autonome'].map((k) => fr[k]), ['Moi', 'Pilote', 'Pilote autonome']);
  assert.equal(fr['who.piloteLeft'], 'le goût, les données, la sécurité, la livraison'); assert.equal(fr['who.autonomeLeft'], 'les données, la sécurité, la livraison');
  assert.equal(fr['burst.toLimit'], 'Avancer le backlog');
  const html = readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /const WHO_CRANS = \{ moi: \{ on: false, mode: 'surveille' \}, pilote: \{ on: true, mode: 'guide' \}, autonome: \{ on: true, mode: 'autonome' \} \}/, 'a cran writes pilot.on and autonomy.mode as lib/nextstep.mjs storedOf');
  assert.match(html, /const whoChecked = \(a\) => \(a\.ask \? 'pilote'/, 'the first run checks Pilote, the cran of Guidé');
});
