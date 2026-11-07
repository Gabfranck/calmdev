// Phase 9, session A: the one navigation (public/sidebar.js, docs/phase9/direction.md §2). No browser: the pure parts
// of the component (the current screen of a URL, the markup, the bottom line, the Conversation count) and the pages
// as served, which must hold no hand-written navigation any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { i18nInto } from './i18n-env.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const read = (f) => readFileSync(path.join(PUB, f), 'utf8');
const PAGES = ['index.html', 'resources.html', 'flow.html', 'plan.html', 'review.html', 'architecture.html', 'signaler.html'];

const load = () => {
  const window = { document: { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, hidden: false }, location: { pathname: '/', search: '', hash: '', host: 'localhost:3078' }, localStorage: { getItem: () => null, setItem() {} }, fetch: async () => ({ ok: false }) };
  window.window = window; Object.assign(window, { Promise, URLSearchParams, Date, console });
  i18nInto(window); runInNewContext(read('sidebar.js'), window);
  return window;
};

test('the current screen of every URL of the cahier, one per page, none on /signaler', () => {
  const { escadrilleSidebar: sb } = load();
  const cases = [
    ['/', '', 'conversation'], ['/', '#conversation', 'conversation'], ['/e/abc', '', 'conversation'],
    ['/resources', '', 'resources'], ['/flow', '', 'flow'], ['/plan/2026-11-01-x', '#sessions', 'flow'],
    ['/review', '', 'review'], ['/review/0123abcd', '', 'review'],
    ['/', '#memoire', 'memory'], ['/', '#acces', 'access'], ['/', '#acces-network', 'access'],
    ['/', '#rafale', 'burst'], ['/', '#limite', 'burst'], ['/', '#pilote', 'pilot'], ['/', '#phone', 'conversation'],
    ['/architecture', '', 'architecture'], ['/learning', '', 'learning'], ['/signaler.html', '', null], ['/signaler', '', null],
  ];
  for (const [pathname, hash, want] of cases) assert.equal(sb.current({ pathname, hash }), want, `${pathname}${hash}`);
});

test('the markup: the entry, the place of the projects, the add line, the bottom line; no primary button', () => {
  const { escadrilleSidebar: sb } = load();
  const h = sb.markup();
  const labels = [...h.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['calmdev', 'Ajouter un projet…'], 'the menus belong to the projects, drawn in #sbProjects');
  assert.ok(!h.includes('class="mark"'), 'no brand block at the head of the bar (Dev, 2026-11-02 04:30): the mark only leads the entry row');
  assert.ok(h.indexOf('class="lang-pick"') > h.indexOf('id="sbProjects"') && h.indexOf('class="lang-pick"') < h.indexOf('class="bottom-line"') && /data-lang="en"[^>]*>EN</.test(h) && /data-lang="fr"[^>]*>FR</.test(h), 'the language in two letters beside the bottom line, not folded in it (Dev, 04:35)');
  assert.ok(!/id="sbProject"|pp-trigger|ppPanel|role="listbox"/.test(h), 'no project picker any more (session NAV)');
  assert.ok(h.indexOf('data-entry') < h.indexOf('id="sbProjects"') && h.indexOf('id="sbProjects"') < h.indexOf('data-pp-add') && h.indexOf('data-pp-add') < h.indexOf('class="bottom-line"'), 'the entry, the projects, the add line, the bottom line');
  assert.match(h, /<a class="nav-item entry" data-entry href="\/#\/entree"[^>]*><svg[^]*<span class="label">calmdev<\/span><\/a>/, 'the entry « calmdev » first, to the entry conversation');
  assert.match(h, /Ajouter un projet…/);
  for (const id of ['mac', 'phone', 'live', 'host', 'bottomLine']) assert.match(h, new RegExp(`id="${id}"`), id);
  assert.match(h, /Signaler un défaut/); assert.match(h, /Exporter le JSON/);
  assert.ok(!/btn primary/.test(h), 'no primary button in the bar'); assert.ok(!/Nouvelle escadrille/.test(h));
  assert.ok(!/class="count">0</.test(h), 'a zero count is never drawn');
});

test('the bottom line: this Mac, the phone, the quota, the rank; honest when nothing is known', () => {
  const { escadrilleSidebar: sb } = load();
  assert.equal(sb.line({ running: { ours: [{ kind: 'session' }, { kind: 'session' }, { kind: 'worktree' }] }, devices: { devices: [{ name: 'iPhone de Dev' }] }, horizon: { usedPct: 74.2 }, game: { rank: 'Pilote confirmé', xp: 320 } }), 'Ce Mac · 2 sessions · iPhone de Dev · quota 74 % · Pilote confirmé');
  assert.equal(sb.line({ running: { ours: [] }, devices: { devices: [] }, horizon: { usedPct: null }, game: { off: true } }), 'Ce Mac · rien ne tourne · sans téléphone');
  assert.equal(sb.line({}), 'Ce Mac');
});

// Session NAV (Dev, 2026-11-02): no picker; every project stacked, the current one unfolded with its menu
test('the order of the bar: the current project first, then the others as the API gives them (by recent activity)', () => {
  const { escadrilleSidebar: sb } = load();
  const list = [`${USERS}/dev/Dev/mon-app`, `${USERS}/dev/Dev/escadrille`, `${USERS}/dev/Dev/Orchard-v2`];
  assert.deepEqual([...sb.order(list, `${USERS}/dev/Dev/escadrille`)], [`${USERS}/dev/Dev/escadrille`, `${USERS}/dev/Dev/mon-app`, `${USERS}/dev/Dev/Orchard-v2`]);
  assert.deepEqual([...sb.order(list, '/p/new')], ['/p/new', ...list], 'a project the API does not list is still shown, first');
  assert.deepEqual([...sb.order(list, null)], list, 'no current project: all folded, in the API order');
  assert.deepEqual([...sb.order(null, null)], []);
});

test('the current project: its head folds its menu (the four steps, then the project screens), its labels under its name', () => {
  const { escadrilleSidebar: sb } = load();
  const p = `${USERS}/dev/Dev/escadrille`;
  const h = sb.projectHtml(p, { cur: true, open: true });
  assert.match(h, /^<div class="pj is-current" role="listitem" data-path="\/Users\/dev\/Dev\/escadrille" data-current>/);
  assert.match(h, /<button type="button" class="pj-head" data-pj-toggle aria-expanded="true" aria-controls="pjMenu" aria-label="Replier escadrille"/);
  assert.match(h, /<span class="pj-logo" aria-hidden="true"><img alt="" loading="lazy" src="\/api\/projects\/logo\?project=%2FUsers%2Fdev%2FDev%2Fescadrille"><i class="pj-initial">E<\/i><\/span><span class="pj-n">escadrille<\/span>/, 'the logo by GET /api/projects/logo over its initial');
  const labels = [...h.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Conversation', 'Ressources', 'Flot', 'Revue', 'Backlog', 'Mémoire', 'Accès', 'Avancer le backlog', 'Pilote', 'Équipe', 'Architecture', 'Apprentissage', 'Réponses', 'Communication']);
  for (const k of ['1', '2', '3', '4']) assert.match(h, new RegExp(`aria-keyshortcuts="${k}"`));
  assert.match(h, /touche 3/);
  assert.ok(!/pj-x/.test(h), 'the current project is never removed from the bar');
  assert.match(h, /class="pj-wait" hidden/, 'unfolded: its counts say what waits, no dot');
  const folded = sb.projectHtml(p, { cur: true, open: false, wait: sb.waitOf({ flow: 1 }) });
  assert.match(folded, /aria-expanded="false"[^>]*aria-label="Déplier escadrille"/); assert.match(folded, /<div class="pj-menu" id="pjMenu" hidden>/);
  assert.match(folded, /class="pj-wait" role="img" aria-label="1 en attente de toi"/, 'folded: the dot comes back');
});

test('a folded project: one line, a link to the same screen in that project, the dot when something waits, « Retirer »', () => {
  const { escadrilleSidebar: sb } = load();
  const p = `${USERS}/dev/Dev/Orchard-v2`;
  const loc = { pathname: '/flow', search: '?project=%2FUsers%2Fdev%2FDev%2Fescadrille', hash: '' };
  assert.equal(sb.hrefFor(p, loc), '/flow?project=%2FUsers%2Fdev%2FDev%2FOrchard-v2', 'the same screen, one click');
  assert.equal(sb.hrefFor(p, { pathname: '/plan/2026-11-02-x', search: '?project=a&tab=sessions', hash: '#sessions' }), '/flow?project=%2FUsers%2Fdev%2FDev%2FOrchard-v2', 'an object of the other project goes to its screen');
  assert.equal(sb.hrefFor(p, { pathname: '/', search: '', hash: '#memoire' }), '/?project=%2FUsers%2Fdev%2FDev%2FOrchard-v2#memoire', 'the screen of an anchor is kept');
  assert.equal(sb.hrefFor(p, { pathname: '/', search: '', hash: '#/entree' }), '/?project=%2FUsers%2Fdev%2FDev%2FOrchard-v2', 'from the entry, the project\'s Conversation');
  const w = sb.waitOf({ flow: 2, review: 1 });
  assert.deepEqual({ ...w }, { n: 3, text: '2 en attente de toi · 1 à relire' });
  assert.deepEqual({ ...sb.waitOf({}) }, { n: 0, text: '' }); assert.deepEqual({ ...sb.waitOf({ review: 4 }) }, { n: 4, text: '4 à relire' });
  const h = sb.projectHtml(p, { cur: false, wait: w });
  assert.match(h, /^<div class="pj" role="listitem" data-path="\/Users\/dev\/Dev\/Orchard-v2"><div class="pj-row"><a class="pj-head" data-pj-go="\/Users\/dev\/Dev\/Orchard-v2" href="[^"]*" title="\/Users\/dev\/Dev\/Orchard-v2">/);
  assert.match(h, /<span class="pj-wait" role="img" aria-label="2 en attente de toi · 1 à relire" title="2 en attente de toi · 1 à relire"><\/span>/, 'the dot says what waits, in words');
  assert.ok(!/pj-menu|data-nav/.test(h), 'folded: no menu');
  assert.match(h, /<button type="button" class="pj-x" data-pp-remove="\/Users\/dev\/Dev\/Orchard-v2" aria-label="Retirer Orchard-v2 de la liste \(rien n’est supprimé\)">Retirer<\/button>/);
  assert.match(sb.projectHtml(p, { cur: false }), /class="pj-wait" hidden/, 'nothing waits: no dot');
  assert.match(sb.projectHtml('/p/a"b', { cur: false }), /src="\/api\/projects\/logo\?project=%2Fp%2Fa%22b"/, 'the path is encoded, never breaks the attribute');
});

test('the add line: one button that unfolds a path field in place, completed by the server', () => {
  const { escadrilleSidebar: sb } = load();
  const h = sb.addMarkup();
  assert.match(h, /<button type="button" class="nav-item pj-add-open" data-pp-add aria-expanded="false" aria-controls="ppAdd"><span class="label">Ajouter un projet…<\/span><\/button>/);
  assert.match(h, /<form class="pj-add" id="ppAdd" hidden novalidate>/); assert.match(h, /list="ppDirs"/); assert.match(h, /aria-describedby="ppErr"/); assert.match(h, /Récents dans Claude Code/);
  assert.ok(!/<select/.test(h));
});

test('the entry is its own current screen; the CSS draws no border and keeps the labels on the name', () => {
  const { escadrilleSidebar: sb } = load();
  assert.equal(sb.ENTRY, '/#/entree');
  assert.equal(sb.current({ pathname: '/', hash: '#/entree' }), 'entry'); assert.equal(sb.current({ pathname: '/entree', hash: '' }), 'entry');
  const css = read('app.css');
  assert.match(css, /\.pj-menu \.nav-item \{ padding-left: 36px; \}/, 'the menu under the name, aligned on it');
  assert.match(css, /\.pj-wait \{[^}]*width: 6px; height: 6px;[^}]*background: var\(--accent\)/, 'the waiting dot: 6px, the one hue');
  assert.match(css, /\.pj-logo\.has-logo \.pj-initial \{ visibility: hidden; \}/, 'the initial goes once a logo has loaded');
  assert.ok(!/\.pp-trigger|\.pp-panel|\.proj-pick/.test(css), 'the picker\'s rules are gone');
});

test('the keyboard goes both ways: ↓ and ↑ wrap at each end, start from the first or the last row', () => {
  const { escadrilleSidebar: sb } = load();
  assert.equal(sb.step(0, 3, 1), 1); assert.equal(sb.step(2, 3, 1), 0, '↓ on the last row goes to the first');
  assert.equal(sb.step(1, 3, -1), 0); assert.equal(sb.step(0, 3, -1), 2, '↑ on the first row goes to the last');
  assert.equal(sb.step(-1, 3, 1), 0); assert.equal(sb.step(-1, 3, -1), 2); assert.equal(sb.step(0, 0, 1), -1);
});

test('the folder said short (~/Dev), the server refusals said in words, in both languages', () => {
  const { escadrilleSidebar: sb } = load();
  assert.equal(sb.short(`${USERS}/dev/Dev/escadrille`), '~/Dev'); assert.equal(sb.short(`${HOMES}/x/a/b`), '~/a'); assert.equal(sb.short('/srv/app'), '/srv'); assert.equal(sb.short(`${USERS}/dev/escadrille`), '~');
  assert.equal(sb.addError('not-found'), 'Ce dossier n’existe pas.');
  assert.equal(sb.addError('not-absolute'), 'Un chemin complet, qui commence par / ou ~/');
  assert.equal(sb.addError('boom'), 'Pas ajouté : boom');
  const en = JSON.parse(readFileSync(path.join(PUB, 'i18n', 'en.json'), 'utf8'));
  for (const k of ['nav.pp.add', 'nav.pp.remove', 'nav.pp.removed', 'nav.pp.undo', 'nav.pp.err.not-found', 'nav.pp.recent']) assert.ok(en[k], k);
});

test('the Conversation count: a plan proposed, questions after the last dev message, nothing else', () => {
  const { escadrilleSidebar: sb } = load();
  const msgs = (list) => ({ messages: list }); // newest first
  assert.equal(sb.conversationCount(msgs([{ role: 'claude', data: { proposal: { status: 'proposed' } } }, { role: 'dev' }])), 1);
  assert.equal(sb.conversationCount(msgs([{ role: 'claude', data: { proposal: { status: 'launched' } } }])), 0);
  assert.equal(sb.conversationCount(msgs([{ role: 'claude', data: { questions: [{}] } }, { role: 'dev' }])), 1);
  assert.equal(sb.conversationCount(msgs([{ role: 'dev' }, { role: 'claude', data: { questions: [{}] } }])), 0, 'questions already answered');
  assert.equal(sb.conversationCount(null), 0);
});

test('render on a bare element draws the skeleton and never throws without a DOM', () => {
  const w = load(); const el = { innerHTML: '', classList: { contains: () => false, toggle() {} } };
  w.escadrilleSidebar.render(el, { project: '/p/x' });
  assert.match(el.innerHTML, /id="sbProjects"/); assert.match(el.innerHTML, /data-entry/);
  w.escadrilleSidebar.render(el, { project: null });
});

test('every page holds one empty sidebar and no navigation of its own; projnav.js is gone', () => {
  assert.ok(!existsSync(path.join(PUB, 'projnav.js')), 'projnav.js removed');
  for (const f of PAGES) {
    const html = read(f);
    const navs = html.match(/<nav class="sidebar"[^>]*>[\s\S]*?<\/nav>/g) || [];
    assert.equal(navs.length, 1, `${f}: one sidebar`);
    assert.equal(navs[0], '<nav class="sidebar" id="sidebar" aria-label="Navigation"></nav>', `${f}: the sidebar is empty, sidebar.js fills it`);
    const body = html.slice(html.indexOf('<body>'), html.indexOf('<script', html.indexOf('<body>')));
    for (const bad of ['class="nav-item"', 'projnav', 'nav-new', 'group-label', 'class="mark"', 'id="navMemory"']) assert.ok(!body.includes(bad), `${f} draws ${bad} by hand`);
    assert.match(html, /<script src="\/sidebar\.js"><\/script>/, `${f} loads sidebar.js`);
    assert.ok(!html.includes('projnav.js'), `${f} still loads projnav.js`);
    assert.match(body, /class="btn ghost menu-toggle"/, `${f}: the Menu button of the drawer`);
    assert.match(body, /<span class="crumb"><span class="proj" id="(crumbProj|project)"[^>]*><\/span>|<span class="crumb"><span class="proj" id="project">…<\/span>/, `${f}: the breadcrumb Projet / Écran`);
    assert.match(body, /<b id="crumb"[ >]/, `${f}: the screen's name in the breadcrumb`);
    assert.match(f === 'architecture.html' ? read('architecture.js') : html, /escadrilleSidebar\.render\(/, `${f} calls the sidebar`);
  }
});

test('the plan: the four views are tabs in the content, the other plans a select in the title', () => {
  const html = read('plan.html');
  assert.match(html, /class="tabs views" aria-label="\$\{esc\(T\('plan\.viewsAria'\)\)\}"/);
  for (const v of ['flow', 'sessions', 'journal', 'plan']) assert.match(html, new RegExp(`\\$\\{viewsBar\\(\\)\\}`), v);
  assert.match(html, /id="planPick" aria-label="\$\{esc\(T\('plan\.otherPlans'\)\)\}"/);
  assert.match(read('flow.html'), /id="plansNow"/, 'the plans in progress under the canvas');
});

// Phase 11 S: the home without a project offers the same list as the picker (the registry), never « a project
// Claude Code knows », and « Ajouter un projet… » (a folder the server validates); with none yet, the folder field
const mainchat = () => {
  const el = () => ({ style: {}, classList: { toggle() {} }, appendChild() {}, addEventListener() {} });
  const w = { document: { createElement: el, head: el(), addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: el() }, location: { hash: '', search: '', pathname: '/' }, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, setTimeout, clearTimeout, setInterval: () => 0, escId: null, esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`), console, URLSearchParams };
  w.window = w; i18nInto(w); runInNewContext(read('mainchat.js'), w);
  return w.escadrilleMain;
};
test('the home without a project: the registered projects and « Ajouter un projet… », nothing Claude Code alone knows', () => {
  const m = mainchat();
  const h = m.pickHtml([{ path: `${USERS}/dev/Dev/escadrille`, name: 'escadrille' }, { path: `${USERS}/dev/Dev/Orchard-v2` }]);
  assert.deepEqual([...h.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]), ['', `${USERS}/dev/Dev/escadrille`, `${USERS}/dev/Dev/Orchard-v2`, '__other']);
  assert.match(h, />Choisir un projet…</); assert.match(h, /value="__other">Ajouter un projet…</); assert.match(h, /name="path"[^>]* hidden>/);
  assert.match(h, />Orchard-v2</, 'the name from the path when the API gives none');
  assert.ok(!/Claude Code/.test(h)); assert.match(h, /aria-describedby="mcPickErr"/);
  const none = m.pickHtml([]);
  assert.ok(!/<select/.test(none), 'no project yet: no list to pick from'); assert.match(none, /name="path"[^>]*>/); assert.ok(!/name="path"[^>]* hidden/.test(none)); assert.match(none, />Ajouter</);
});
