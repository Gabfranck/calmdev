// Phase 11 H, the home (public/mainchat.js, docs/phase11/ux.md §8, the mock-up docs/phase11/accueil.html validated by
// Dev on 2026-11-02). No browser: the script runs in a vm with the globals index.html gives it and a minimal document;
// the state the loaders would have fetched is set by hand. Checked: the three states, the state sentence under the
// title, the one primary button that says what it does (Planifier / Envoyer by the pilot), the panel as lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { i18nInto } from './i18n-env.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const read = (f) => readFileSync(path.join(PUB, f), 'utf8');
const PROJECT = `${USERS}/dev/escadrille`;
// the markup as the browser reads it: the escaped apostrophe back, the narrow spaces of Intl as plain ones
const norm = (h) => String(h).replace(/&#39;/g, "'").replace(/[\u00a0\u202f]/g, ' ');

const load = ({ project = PROJECT, projects = [{ path: PROJECT, name: 'escadrille' }] } = {}) => {
  const el = () => ({ appendChild() {}, classList: { toggle() {}, contains: () => false }, textContent: '', value: '', focus() {}, addEventListener() {} });
  const document = { head: el(), body: el(), createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, activeElement: null, hidden: false, documentElement: el() };
  const window = { document, location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {}, state: null }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, innerWidth: 1440, queueMicrotask: (f) => f(), setInterval: () => 0, clearTimeout() {}, setTimeout: () => 0 };
  window.window = window; Object.assign(window, { Promise, URLSearchParams, Date, console, JSON, Math, Number, String, Array, Object, Event: class {} });
  // index.html's globals the script uses
  Object.assign(window, { escId: null, project, meta: { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }], projects }, settings: null, render() {}, esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), md: (s) => `<p>${s}</p>`, api: async () => ({}), fmt: (n) => String(n), canvas: el(), setupSpeech() {},
    P: { name: (p) => (p ? p.split('/').pop() : ''), withProject: (h) => h } });
  i18nInto(window); runInNewContext(read('todo.js'), window); runInNewContext(read('mainchat.js'), window); // todo.js: the « À toi » rule, loaded by index.html before mainchat.js
  return window.escadrilleMain;
};
const status = {
  now: { running: 2, waiting: 1, queued: 3, errors: 0, more: 1, rows: [
    { plan: 'p11', session: 'D', name: 'Le cahier UX et la maquette', status: 'running', waitingFor: null, cost: 5.63, budget: 15, after: [] },
    { plan: 'p11', session: 'S', name: 'Le sélecteur de projets', status: 'running', waitingFor: null, cost: 1.2, budget: 10, after: [] },
    { plan: 'p11', session: 'F', name: 'Flot, plan, canevas', status: 'later', waitingFor: null, cost: 0, budget: 14, after: ['D'] }] },
  limits: { rows: [{ id: 'weekly', kind: 'weekly', label: 'weekly', pct: 31, resetsAt: new Date(Date.now() + 4 * 864e5).toISOString(), soft: 25, hard: 30, level: 'hard', lead: true, margin: -1 }, { id: 'model:fable', kind: 'model', label: 'Fable', pct: null, level: 'unmeasured' }, { id: 'fiveHour', kind: 'fiveHour', label: 'fiveHour', pct: null, level: 'unmeasured' }, { id: 'plan', kind: 'plan', label: 'Phase 11', pct: 33.7, usd: 5, capUsd: 15, level: 'ok' }], verdict: { level: 'ok' } },
  claude: { measuredAt: '2026-11-02T04:40:00Z', stale: false, measuring: false, account: { plan: 'Ultra', masked: 'd•••@gmail.com', email: 'dev@example.com' } },
  cost: { today: { usd: 24.1, pct: null }, week: { usd: 278, pct: null }, run: { plan: 'p11', title: 'Phase 11', usd: 6.83 }, calibrated: false },
  guard: { mode: 'surveille', network: [], burst: null, autoMerge: false },
};
const msgs = [{ seq: 1, role: 'dev', text: 'Phase 11 : une UX qui répond.', source: 'page', at: '2026-11-02T00:52:00Z' }, { seq: 2, role: 'claude', text: 'Le plan tient en trois vagues.', source: 'pilot:x', at: '2026-11-02T00:57:00Z' }];

test('a project with messages: the state sentence under the title, the search at its right, Planifier when the pilot is off, the hour always shown', () => {
  const m = load(); m.set({ st: { project: PROJECT, messages: msgs, more: false, total: 2 }, status, pilot: { on: false }, flow: { nodes: [{ plan: 'p11', session: 'B', name: 'b', status: 'waiting', waitingFor: 'dev' }], plans: [] }, reviews: [], escs: [] });
  const h = norm(m.view()); // « 1 t'attend »: the length of « À toi » (6 Nov.), here B's reply
  assert.match(h, /<h1>Conversation<\/h1><p class="sub">escadrille · <b class="num">2<\/b> en cours · <b class="num">1<\/b> t'attend<\/p>/, 'the state sentence: no cost on the home (Dev, 2026-11-02)');
  assert.match(h, /<input class="control mc-search" id="mcSearch" type="search"/); assert.ok(!/mc-tools/.test(h));
  assert.ok(!/title-row[^>]*>(?:(?!<\/div>).)*mc-pilot/.test(h), 'no switch in the title row');
  assert.match(h, /<button type="submit" class="btn primary" id="send">Planifier<\/button>/, 'the primary says what it does');
  assert.match(h, /class="mc-pilot"[^>]*><input type="checkbox" role="switch" id="mcPilot"><span class="mc-switch"[^>]*><\/span>Pilote <span class="mc-pilot-state" role="status">éteint · Planifier lance une planification<\/span>/, 'the switch in the bar, with its state');
  assert.ok(h.indexOf('id="mic"') < h.indexOf('id="mcPilot"') && h.indexOf('id="mcPilot"') < h.indexOf('id="send"'), 'Dicter, the pilot, then the primary');
  assert.equal((h.match(/class="btn primary"/g) || []).length, 1, 'one primary action on the screen');
  assert.match(h, /<p class="mc-meta"><time datetime="2026-11-02T00:52:00Z" data-tip="/, 'the hour carries its full date as a tip, not a title');
  assert.ok(!/ title="/.test(h), 'no title attribute: the tips are data-tip (ux.js)');
  assert.match(h, /<kbd>Entrée<\/kbd> envoie/); assert.ok(!/gabarit|mc-start/.test(h), 'no template line, no starting points on an active project');
});

test('the pilot on: Envoyer, and the switch says it reads; busy and the day cap say so', () => {
  const m = load(); m.set({ st: { project: PROJECT, messages: msgs, more: false, total: 2 }, status, pilot: { on: true, busy: false, spentToday: 0.2, daily: 2, budget: 0.5 }, flow: null, reviews: null, escs: null });
  assert.equal(m.primaryLabel(), 'Envoyer'); assert.equal(m.pilotState(), 'lit la Conversation');
  m.set({ pilot: { on: true, busy: true, spentToday: 0.2, daily: 2 } }); assert.equal(m.pilotState(), 'lit…');
  m.set({ pilot: { on: true, busy: false, spentToday: 2, daily: 2 } }); assert.equal(m.pilotState(), 'plafond du jour');
  assert.match(norm(m.view()), /id="send">Envoyer</);
});

test('the status panel: Maintenant as one line of figures and a floating card, Claude and Coût as lines, the guard, À toi at the foot', () => {
  const m = load(); m.set({ st: { project: PROJECT, messages: msgs, more: false, total: 2 }, status, pilot: null, flow: { nodes: [{ plan: 'p11', session: 'B', name: 'b', status: 'waiting', waitingFor: 'dev' }], plans: [{ id: 'p11', title: 'Phase 11' }] }, reviews: [{ id: 'r1', additions: 100, deletions: 20 }, { id: 'r2', additions: 10, deletions: 0 }], escs: [] });
  const a = norm(m.statusAside());
  assert.ok(!/class="cells"/.test(a), 'no cells any more');
  // « t'attend » is the length of « À toi » (6 Nov.): B's reply and the two reviews
  assert.match(a, /<section class="now"><h2>Maintenant<\/h2><p class="figs" tabindex="0" aria-describedby="mcNowRows"><b class="num">2<\/b> en cours · <b class="num">3<\/b> t'attend · <b class="num">3<\/b> à venir<\/p><div class="rows" id="mcNowRows">/);
  assert.match(a, /<a class="row" href="\/plan\/p11\?node=D"><span class="badge">D<\/span><span class="n">Le cahier UX et la maquette<\/span><span class="c num">5,63 \$ \/ 15 \$<\/span><span class="track" aria-hidden="true"><i style="width:38%"><\/i><\/span><\/a>/, 'a running row: letter, name, cost / cap, the bar at the true share');
  assert.match(a, /<a class="row later" href="\/plan\/p11\?node=F"><span class="badge">F<\/span><span class="n">Flot, plan, canevas<\/span><span class="c">à venir · après D<\/span><\/a>/, 'a queued row says what it waits for, no bar');
  assert.match(a, /<a class="more" href="\/flow">et 1 autre · Flot<\/a><\/div><\/section>/, 'the rest counted, inside the card');
  assert.match(a, /<h2>Claude<\/h2><ol class="limits"><li class="lim hard"><div class="line"><b>Quota hebdo <span class="num">31 %<\/span><\/b><span class="m">remise à zéro dans 4 j<\/span><\/div><div class="track" role="img"[^>]*><i style="width:31%"><\/i><s class="th soft" style="left:25%" data-tip="seuil doux 25 %"><\/s><s class="th hard" style="left:30%"/, 'one line and one bar per measured limit');
  assert.match(a, /<p class="nm">Hebdo Fable : non mesuré<\/p>/, 'not measured: one grey line, no bar; never the 5 h window');
  assert.ok(!/lim\.plan|Plan «|Plafond/.test(a), 'the caps of a plan or a burst stay on the Flot (Dev, 2026-11-02)');
  assert.match(a, /<p class="nm">Ultra · <span data-tip="dev@example.com">d•••@gmail.com<\/span> · mesuré à \d\d:\d\d · <a href="\/#acces-lim">Régler les seuils<\/a><\/p>/, 'the account, the measure and the link on one line; the e-mail as a tip');
  assert.ok(!/Coût|class="cost"/.test(a), 'no cost block on the home (Dev, 2026-11-02)');
  assert.match(a, /<details class="guard"><summary><b>Surveillé<\/b> · sans réseau<\/summary>/, 'the mode, no burst word when none runs');
  assert.match(a, /<section class="side-wait"><h2>À toi<\/h2><div class="await"/, '« À toi » at the foot'); assert.match(a, /<div class="line"><span class="badge">B<\/span><span class="t" data-tip="son tour est fini · Phase 11"><span class="do">Réponds à B<\/span><span class="why">son tour est fini · Phase 11<\/span><\/span><a class="btn" href="\/plan\/p11\?node=B">Répondre<\/a><\/div>/, '« À toi »: a verb and its object, the why in grey, one button'); assert.ok(!/attend ta réponse <span>/.test(a), 'never the old raw line');
  assert.equal((a.match(/<span class="do">Relis <\/span>/g) || []).length, 2, 'one line per review to read, written by Escadrille'); assert.match(a, /<span class="why">relecture avant fusion[^<]*<\/span><\/span><a class="btn" href="\/review\/r1">Ouvrir<\/a>/, 'the why and the one button');
  assert.ok(a.indexOf('class="side-wait"') > a.indexOf('class="guard"'), '« À toi » is the last block');
  assert.equal((a.match(/<section/g) || []).length, 4);
  // the line at 390: running, waiting, the quota; the sheet holds the same panel
  const l = norm(m.statusLine());
  assert.match(l, /<button type="button" class="status-line" id="mcStatusLine" aria-haspopup="dialog" aria-controls="mcStatus"><b>2<\/b> en cours · <b>3<\/b> t'attend · quota <b>31 %<\/b><\/button>/);
  assert.match(l, /<dialog class="status-sheet" id="mcStatus"[^>]*><div class="status-sheet-head"><h2>L'état du projet<\/h2><button type="button" class="btn" data-close-status>Fermer<\/button><\/div><aside class="status"/);
});

test('the panel when nothing runs, nothing is measured and nothing waits: one grey line each, never a bar, never a dash in large', () => {
  const m = load(); const s = { ...status, now: { running: 0, waiting: 0, queued: 0, errors: 0, more: 0, rows: [] }, limits: { rows: [{ id: 'weekly', kind: 'weekly', label: 'weekly', pct: null, level: 'unmeasured' }, { id: 'model:fable', kind: 'model', label: 'Fable', pct: null, level: 'unmeasured' }], verdict: { level: 'ok' } }, claude: { measuredAt: null, stale: false, measuring: false, account: null }, cost: { today: { usd: 0 }, week: { usd: 0 }, run: null, calibrated: false } };
  m.set({ st: { project: PROJECT, messages: [], more: false, total: 0 }, status: s, pilot: null, flow: { nodes: [], plans: [] }, reviews: [], escs: [] });
  const a = norm(m.statusAside());
  assert.match(a, /<section class="now"><h2>Maintenant<\/h2><p class="nm">Rien ne tourne.<\/p><\/section>/);
  assert.match(a, /<h2>Claude<\/h2><p class="nm">Quota hebdo : non mesuré<\/p>/); assert.ok(!/class="track"/.test(a), 'no bar');
  assert.match(a, /<p class="nm">aucune session n’a encore parlé à Claude · <a href="\/#acces-lim">Régler les seuils<\/a><\/p>/);
  assert.match(a, /<section class="side-wait"><h2>À toi<\/h2><p class="await-none">Rien ne t'attend.<\/p><\/section>/);
  // before the status is read: the skeletons in the final layout
  m.set({ status: null }); assert.match(norm(m.statusAside()), /<p class="figs"><b class="num"><i class="skel"><\/i><\/b> en cours/); assert.match(m.statusLine(), /disabled>/);
});

test('an empty project: `nom · rien encore`, no search, the sentence and four starting points, the composer at the foot, Planifier', () => {
  const m = load(); m.set({ st: { project: PROJECT, messages: [], more: false, total: 0 }, status: null, pilot: { on: false }, flow: { nodes: [], plans: [] }, reviews: [], escs: [] });
  const h = norm(m.view());
  assert.match(h, /<h1>Conversation<\/h1><p class="sub">escadrille · rien encore<\/p><\/div><\/div>/); assert.ok(!/mcSearch/.test(h), 'no search on an empty project');
  assert.match(h, /<div class="mc-empty"><p>Dis ton idée : Claude lit le projet, pose ses questions, écrit le plan.<\/p><div class="mc-start" aria-label="Pour commencer">/, 'the sentence, then the starting points');
  assert.equal((h.match(/class="mc-start-item"/g) || []).length, 4, 'four starting points, no more');
  assert.match(h, /<button type="button" class="mc-start-item" data-start="rules"><b>Écrire les règles du projet<\/b><span>Un CLAUDE.md : ce que Claude doit savoir et respecter avant de toucher au code.<\/span><\/button>/);
  for (const k of ['rules', 'map', 'tests', 'autonomy']) assert.match(h, new RegExp(`data-start="${k}"`));
  assert.ok(h.indexOf('mc-start') < h.indexOf('id="mainForm"'), 'the composer after, at the foot of the column');
  assert.match(h, /placeholder="Ton idée de fonctionnalité, en quelques mots ou en une page."/); assert.match(h, /id="send">Planifier</);
});

test('no project: the title, the registered projects and « Ajouter un projet… », nothing else; without any project the folder field', () => {
  const m = load({ project: null });
  const h = norm(m.view());
  assert.match(h, /<h1>calmdev<\/h1><p class="sub">Choisis un projet, ou ajoute le dossier d'un projet.<\/p>/);
  assert.match(h, /<form class="mc-pick" id="mcPick" novalidate><select class="control" name="project"[^>]*><option value="" selected disabled>Choisir un projet…<\/option><option value="\/Users\/dev\/escadrille"[^>]*>escadrille<\/option><option value="__other">Ajouter un projet…<\/option><\/select>/);
  assert.ok(!/mc-cols|composer|status/.test(h), 'nothing else');
  const none = norm(load({ project: null, projects: [] }).view());
  assert.match(none, /Ajoute le dossier d'un projet pour commencer\./); assert.match(none, /<input type="hidden" name="project" value="__other">/); assert.ok(!/<select/.test(none));
  assert.equal(m.title(), 'calmdev');
});
