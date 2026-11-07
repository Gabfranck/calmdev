// Phase 7, session O: the resources of a project (docs/resources.md). The module on a fixture project and a
// throwaway home, then the routes and the planner's section against the server on a spare port.
import { freePort } from './free-port.mjs';
import { plain as plainText } from '../lib/i18n.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import * as R from '../lib/resources.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const put = (root, rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

// The fixture: a TypeScript project on GitHub with a memory, rules, a project skill, tickets and a CSV; a home with
// one user skill, an installed plugin switched off for the project, and a marketplace that knows Playwright
const home = tmp('escadrille-res-home-');
put(home, '.claude/skills/shadcn/SKILL.md', '---\nname: shadcn\ndescription: >\n  Manages shadcn\n  components.\n---\nbody');
put(home, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'sentry@claude-plugins-official': [{}] } }));
put(home, '.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json', JSON.stringify({ name: 'claude-plugins-official', plugins: [{ name: 'playwright', description: 'Browser automation. More.' }, { name: 'stripe', description: 'Payments.' }, { name: 'sentry', description: 'Errors.' }] }));
const project = tmp('escadrille-res-proj-');
put(project, '.git/config', '[remote "origin"]\n\turl = git@github.com:gab/fixture.git\n');
put(project, 'docs/decisions.md', '- une\n\n- deux\n- trois\n');
put(project, 'docs/regles.md', '# Règles\n\n## Règles\n\n- une {deny: x}\n- deux\n\n## Vérifications\n\n- npm test\n');
put(project, '.claude/skills/plan/SKILL.md', '---\nname: plan\ndescription: "Plans the work"\n---\n');
put(project, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'sentry@claude-plugins-official': false }, permissions: { deny: ['Bash(git push*)'] } }, null, 2));
put(project, 'tickets.md', '- ORC-88 les avatars\n');
put(project, 'data/scores.csv', 'a,b\n1,2\n');
put(project, 'package.json', JSON.stringify({ dependencies: { stripe: '1', '@sentry/node': '1' }, devDependencies: { typescript: '5' } }));
put(project, 'src/index.ts', 'export {}');
put(project, 'src/b.ts', 'export {}');
const catalog = R.loadCatalog(path.join(HERE, '..', 'catalog', 'capabilities.json'));

test('the resources of a fixture project, read from disk', () => {
  const r = R.resourcesOf(project, { home, addDirs: ['/tmp'], secretsFile: path.join(home, 'none.json') });
  assert.deepEqual(r.memory, { file: path.join(project, 'docs', 'decisions.md'), lines: 3 });
  assert.deepEqual(r.rules, { file: path.join(project, 'docs', 'regles.md'), count: 2 });
  assert.deepEqual(r.skills.map((s) => [s.name, s.scope, s.description, s.enabled]), [['plan', 'project', 'Plans the work', true], ['shadcn', 'user', 'Manages shadcn components.', true]]);
  assert.deepEqual(r.plugins.map((p) => [p.name, p.enabled]), [['sentry@claude-plugins-official', false]]);
  assert.deepEqual(r.addDirs, ['/tmp']);
  assert.deepEqual(r.connectors.map((c) => c.name), ['GitHub']);
  assert.deepEqual(r.files.map((f) => [f.rel, f.kind, f.added]), [['tickets.md', 'text', false], [path.join('data', 'scores.csv'), 'table', false]]);
});

test('a file added, a note, a delete; dangerous names refused', () => {
  const r = R.addFile(project, { name: 'Réf écran.png', base64: Buffer.from('png').toString('base64'), note: 'la capture de référence' });
  assert.equal(r.file.rel, path.join('.calmdev', 'ressources', 'Ref ecran.png'));
  assert.deepEqual([r.file.kind, r.file.size, r.file.note, r.file.added], ['image', 3, 'la capture de référence', true]);
  assert.equal(R.addFile(project, { name: 'Réf écran.png', base64: 'cG5n' }).file.rel, path.join('.calmdev', 'ressources', 'Ref ecran-2.png'));
  const t = R.addFile(project, { text: 'collé', note: 'un texte' }); assert.match(t.file.rel, /note-.*\.md$/);
  for (const name of ['../evil.sh', '/etc/passwd', 'a/b.txt', '..', 'a\\b', 'x\u0000y', 'notes.json', '...']) assert.throws(() => R.addFile(project, { name, text: 'x' }), /nom de fichier refusé/, name);
  assert.throws(() => R.addFile(project, { name: 'a.md', text: 'x', note: 'deux\nlignes' }), /une seule ligne/);
  R.setNote(project, { path: 'tickets.md', note: 'les tickets du trimestre' });
  assert.equal(R.resourcesOf(project, { home }).files.find((f) => f.rel === 'tickets.md').note, 'les tickets du trimestre');
  assert.throws(() => R.removeFile(project, 'tickets.md'), /seul un fichier ajouté/);
  assert.throws(() => R.removeFile(project, '../x'), /seul un fichier ajouté/);
  R.removeFile(project, t.file.rel); assert.ok(!existsSync(t.file.path));
});

test('a skill switched off and on, with a preview first; a plugin switched on', () => {
  const pre = R.switchSkill(project, { name: 'shadcn', enabled: false }, { home });
  assert.deepEqual([pre.ok, pre.preview.action], [false, 'add']); assert.match(pre.preview.line, /Skill\(shadcn\)/);
  assert.ok(!readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8').includes('Skill('));
  assert.equal(R.switchSkill(project, { name: 'shadcn', enabled: false, confirm: true }, { home }).ok, true);
  let s = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, ['Bash(git push*)', 'Skill(shadcn)']);
  assert.equal(R.resourcesOf(project, { home }).skills.find((x) => x.name === 'shadcn').enabled, false);
  R.switchSkill(project, { name: 'shadcn', enabled: true, confirm: true }, { home });
  s = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, ['Bash(git push*)']);
  assert.throws(() => R.switchSkill(project, { name: 'nope', enabled: false }, { home }), /skill inconnu/);
  assert.throws(() => R.switchPlugin(project, { name: 'rm -rf', enabled: true }), /nom@marketplace/);
});

test('the planner section: one line each, no content, 40 lines at most', () => {
  const r = R.resourcesOf(project, { home, addDirs: ['/tmp/shared'] });
  const sec = R.resourcesSection(r);
  assert.match(sec, /^\n\n## Les ressources du projet\n\n- mémoire : docs\/decisions\.md \(3 lignes\)\n- règles : docs\/regles\.md \(2\)\n- skill plan : \.claude\/skills\/plan\/SKILL\.md, Plans the work\n/);
  assert.match(sec, /- fichier tickets\.md : les tickets du trimestre\n/);
  assert.match(sec, /- dossier ajouté : \/tmp\/shared\n- connecteur GitHub$/);
  assert.ok(!sec.includes('shadcn'), 'user skills stay out of the prompt');
  assert.ok(!sec.includes('ORC-88'), 'no file content');
  const many = { ...r, files: Array.from({ length: 60 }, (_, i) => ({ rel: `f${i}.csv`, note: '' })) };
  const lines = R.resourcesSection(many).trim().split('\n');
  assert.ok(lines.length <= 40, String(lines.length)); assert.match(lines.at(-1), /… et \d+ autres \(écran Ressources\)/);
  assert.equal(R.resourcesSection({ project, memory: { file: null }, rules: { file: null }, skills: [], files: [], addDirs: [], connectors: [] }), '');
});

test('the capabilities: ranked by the rule, the active ones out, ten at most', () => {
  const items = R.capabilitiesOf(project, { home, catalog, installs: [{ kind: 'mcp', name: 'Playwright', why: 'vérifier les écrans' }], asks: [{ text: 'Bash psql -c "select 1"', refused: true }] });
  const by = Object.fromEntries(items.map((c) => [c.id, c]));
  assert.ok(items.length <= 10);
  assert.ok(by['playwright-mcp'].score >= 4, JSON.stringify(by['playwright-mcp'])); assert.match(plainText(by['playwright-mcp'].why), /proposé par le planificateur/);
  assert.match(plainText(by.postgres.why), /demande.*refus/);
  assert.match(by['linear-mcp'].why, /tickets ORC-88/);
  assert.match(by['github-mcp'].why, /remote github\.com/);
  assert.deepEqual(by.sentry.activate, { type: 'plugin', name: 'sentry@claude-plugins-official' }); assert.equal(by.sentry.network, false);
  assert.equal(by.stripe.network, true); assert.match(by.stripe.how, /^\/plugin install/);
  assert.ok(!by.notion && !by.figma, 'no signal, not listed');
  assert.deepEqual(items.map((c) => c.score), items.map((c) => c.score).sort((a, b) => b - a));
});

// ------------------------------------------------------------------ the routes
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-res-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-res-plans-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_HOME: home, ESCADRILLE_TEST_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill('SIGINT'));
const ready = until(async () => { try { return (await fetch(BASE + '/api/templates')).ok; } catch { return false; } });
const q = encodeURIComponent;
const call = async (p, { method = 'POST', body } = {}) => { const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('the routes: list, add, refuse, delete, capabilities; the screen is served', async () => {
  await ready;
  const r = await (await fetch(`${BASE}/api/resources?project=${q(project)}`)).json();
  assert.equal(r.rules.count, 2); assert.ok(r.skills.some((s) => s.name === 'shadcn'));
  let a = await call('/api/resources/file', { body: { project, name: 'brief.md', text: '# Brief', note: 'le brief' } });
  assert.equal(a.status, 200); assert.equal(a.body.file.note, 'le brief');
  a = await call('/api/resources/file', { body: { project, name: '../../etc/x', text: 'x' } });
  assert.equal(a.status, 400); assert.match(a.body.error, /refusé/);
  a = await call('/api/resources/file', { body: { project, name: 'big.bin', base64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') } });
  assert.equal(a.status, 413);
  assert.equal((await call('/api/resources/note', { body: { project, path: path.join('.calmdev', 'ressources', 'brief.md'), note: 'le brief, v2' } })).status, 200);
  assert.equal((await call(`/api/resources/file?project=${q(project)}&path=tickets.md`, { method: 'DELETE' })).status, 400);
  assert.equal((await call(`/api/resources/file?project=${q(project)}&path=${q(path.join('.calmdev', 'ressources', 'brief.md'))}`, { method: 'DELETE' })).status, 200);
  const c = await (await fetch(`${BASE}/api/resources/capabilities?project=${q(project)}`)).json();
  assert.match(c.rule, /\+3/); assert.ok(c.items.length > 0 && c.items.length <= 10);
  assert.equal((await fetch(`${BASE}/api/resources?project=relative`)).status, 400);
  // the folders come from the project's settings (GET /api/project/settings), the same source
  const dir = tmp('escadrille-res-dir-');
  assert.equal((await call('/api/project/settings', { body: { project, addDirs: [dir] } })).status, 200);
  assert.deepEqual((await (await fetch(`${BASE}/api/resources?project=${q(project)}`)).json()).addDirs, [dir]);
  const page = await fetch(`${BASE}/resources?project=${q(project)}`); assert.equal(page.status, 200); assert.match(await page.text(), /Ressources/);
});

test('the planner gets « ## Les ressources du projet » in its system prompt', async () => {
  await ready;
  const r = await call('/api/escadrille', { body: { project, model: 'claude-sonnet-5-5', idea: 'Une idée' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sp = await until(() => { try { const a = JSON.parse(readFileSync(path.join(fake.dir, 'args.json'), 'utf8')); const s = a[a.indexOf('--append-system-prompt') + 1]; return s?.includes(`Projet : ${project}\n`) ? s : null; } catch { return null; } });
  assert.match(sp, /## Les ressources du projet\n\n- mémoire : docs\/decisions\.md/);
  assert.ok(sp.indexOf('## La mémoire du projet') < sp.indexOf('## Les ressources du projet'));
});

// The page's own script, run in node against the server with a tiny DOM: it must render every row (a page stuck on
// « Lecture… » passed the inspector once, /api/projects answering { projects } and the page expecting a list)
test('the screen renders its rows from the real API', async () => {
  await ready;
  const { runInNewContext } = await import('node:vm');
  const html = readFileSync(path.join(HERE, '..', 'public', 'resources.html'), 'utf8');
  const els = new Map(); const errors = [];
  const el = (id) => { if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', hidden: false, open: false, value: '', href: '', classList: { add() {}, remove() {}, toggle() { return false; } }, setAttribute() {}, addEventListener() {}, focus() {}, reset() {}, querySelector: () => null, querySelectorAll: () => [] }); return els.get(id); };
  const document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, title: '' };
  const store = new Map();
  const window = { document, fetch: (u, o) => fetch(BASE + u, o), localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, location: { search: '?project=' + q(project), hash: '', host: 'test' }, CSS: { escape: (s) => s }, alert: (m) => errors.push(m), confirm: () => false, console };
  window.window = window; Object.assign(window, { URLSearchParams, Promise, setTimeout, Buffer });
  (await import('./i18n-env.mjs')).i18nInto(window);
  for (const src of ['projects.js', 'sidebar.js']) runInNewContext(readFileSync(path.join(HERE, '..', 'public', src), 'utf8'), window);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  process.once('unhandledRejection', (e) => errors.push(String(e)));
  runInNewContext(script, window);
  const res = await until(() => (el('res').innerHTML.includes('Capacités à ajouter') && !el('res').innerHTML.includes('Lecture…') ? el('res').innerHTML : null));
  // phase 9 P1: four sections in the direction's order, the rest folded in one line
  const order = ['Ce qui attend', 'Fichiers et textes', 'Skills', 'Capacités à ajouter'].map((name) => res.indexOf(`aria-label="${name}"`));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'the sections in order: ' + order.join(','));
  for (const name of ['decisions.md', 'regles.md', 'tickets.md', 'scores.csv', 'plan', 'shadcn']) assert.ok(res.includes(`<b>${name}</b>`) || res.includes(`${name}</b>`), name);
  assert.ok(res.includes('Aussi : 1 plugin · 1 connecteur · 1 dossier ouvert'), 'plugins, connectors and folders folded in one line');
  assert.ok(res.includes('<span class="pill">désactivé ici</span>') === false || res.includes('skill désactivé ici'), 'disabled skills fold');
  assert.match(el('lede').textContent, /ressources$/);
  // NAV (2026-11-03): the projects are stacked in #sbProjects, filled by querySelector, which this tiny DOM lacks; the bar's
  // skeleton is on the element and the current project's menu holds the Ressources line
  assert.match(el('sidebar').innerHTML, /id="sbProjects"/, 'the one sidebar is drawn by sidebar.js');
  assert.match(window.escadrilleSidebar.projectHtml(project, { cur: true }), /data-nav="resources"/, 'the current project\'s menu has Ressources');
  assert.equal(el('crumb').textContent, 'Ressources');
  assert.deepEqual(errors, []);
});
