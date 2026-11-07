// The click robot (phase 10, session F), without a browser: the list of refused actions against every button of
// public/ in both languages, the page list, the report and the command line, and the throwaway seeded server that
// the robot starts (a real server on a free port, claude disabled). The browser part is not tested here: the
// sandbox of a session has none; docs/terrain.md says where to run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DENY_DATA, DENY_IDS, denyReason, isDenied, isOutsideLink } from '../scripts/click-denylist.mjs';
import { CLICKABLE, consoleError, deadButton, defect, isDeadClick, httpError, pageError, pageList, parseArgs, report, traceLine, visitUrl, visits, whereOf, withQuery } from '../scripts/click-robot-lib.mjs';
import { freePort, serverEnv, startServer } from '../scripts/click-robot-server.mjs';
import { testEnv } from './test-env.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC = path.join(HERE, '..', 'public');
const en = JSON.parse(readFileSync(path.join(PUBLIC, 'i18n', 'en.json'), 'utf8'));
const fr = JSON.parse(readFileSync(path.join(PUBLIC, 'i18n', 'fr.json'), 'utf8'));

// ---- every button of the app ----
const sources = readdirSync(PUBLIC).filter((f) => /\.(html|js)$/.test(f)).map((f) => [f, readFileSync(path.join(PUBLIC, f), 'utf8')]);
const parseAttrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? '']));
const buttons = [];
for (const [file, src] of sources) {
  for (const m of src.matchAll(/<button\b([^>]*)>([^]{0,240}?)<\/button>/g)) {
    const keys = [...m[2].matchAll(/['"`]([a-z]+\.[A-Za-z.]+)['"`]|data-i18n="([\w.]+)"/g)].map((k) => k[1] || k[2]);
    const text = m[2].replace(/<[^>]*>/g, '').replace(/\$\{[^}]*\}/g, '').trim();
    buttons.push({ file, attrs: parseAttrs(m[1]), keys, text });
  }
}

// A button whose label key says it acts: launches, merges, answers, stops, sends, deletes, notifies, opens a folder or a window.
const ACTING = /^(launch\w*|merge|stop\w*|send\w*|allow\w*|always|deny|refuse|accept\w*|answer\w*|terminal|resume|openProject|openPr|startDev|runTests|continue|retry|rewrite|tell|harden|raise|save|erase|replace|remove\w*|forget|confirm|add\w*|notify\w*|dictate|finish|approve|reject|seenGo|activate)$/;
const actingKeys = (b) => b.keys.filter((k) => ACTING.test(k.split('.').pop()) && (en[k] !== undefined || k.startsWith('lang.')));

test('the scan sees the buttons of the app', () => {
  assert.ok(buttons.length > 100, `only ${buttons.length} buttons found`);
  assert.ok(buttons.filter((b) => actingKeys(b).length).length > 30);
});

test('no button that launches, merges, answers, stops or opens can be clicked, in English or French', () => {
  const missed = [];
  for (const b of buttons) for (const k of actingKeys(b)) for (const [lang, dict] of [['en', en], ['fr', fr]]) {
    const label = (dict[k] ?? '').replace(/\{[^}]*\}/g, '').trim();
    const el = { tag: 'button', label, attrs: b.attrs, type: b.attrs.type, role: b.attrs.role };
    if (!isDenied(el)) missed.push(`${b.file} · ${k} · ${lang} « ${label} » · ${JSON.stringify(b.attrs).slice(0, 120)}`);
  }
  assert.deepEqual(missed, []);
});

test('every submit button, switch and acting data-* is refused whatever its label says', () => {
  for (const b of buttons) {
    const { disabled, ...attrs } = b.attrs; // `disabled` in a template is a ternary, not a state
    if (attrs.type === 'submit') assert.equal(denyReason({ tag: 'button', label: 'Hello', attrs, type: 'submit' }), 'submit', b.file);
  }
  assert.equal(denyReason({ tag: 'input', label: '', attrs: { type: 'checkbox', role: 'switch', id: 'x' }, role: 'switch' }), 'switch');
  for (const d of DENY_DATA) assert.equal(denyReason({ tag: 'button', label: 'Hello', attrs: { [d]: '' } }), d);
  for (const id of DENY_IDS) assert.equal(denyReason({ tag: 'button', label: 'Hello', attrs: { id } }), `#${id}`);
  assert.equal(denyReason({ tag: 'button', label: 'Hello', attrs: { disabled: '' } }), 'disabled');
});

test('every data-* and id that marks an acting button of the app is in the list', () => {
  // the attributes of buttons whose key is acting, minus the ones that only navigate: all must be refused through the element itself
  const bare = buttons.filter((b) => actingKeys(b).length && !isDenied({ tag: 'button', label: '', attrs: b.attrs, type: b.attrs.type, role: b.attrs.role }));
  // a button refused only by its label is allowed (the label test above covers it) ; list them so a rename is visible
  const names = bare.map((b) => `${b.file}:${actingKeys(b).join(',')}`);
  assert.ok(names.length < 25, `${names.length} acting buttons held by their label alone: ${names.join(' ')}`);
});

test('the labels of the actions are refused, English and French', () => {
  const must = [
    'Launch', 'Lancer', 'Launch the multi-session', 'Lancer la multi-session', 'Merge', 'Fusionner', 'Stop', 'Arrêter', 'Stop everything', 'Tout arrêter',
    'Send', 'Envoyer', 'Send the review', 'Allow', 'Autoriser', 'Always', 'Toujours', 'Refuse', 'Refuser', 'Accept all', 'Tout accepter', 'Approve', 'Approuver',
    'Retry', 'Réessayer', 'Relancer', 'Resume in the page', 'Reprendre dans la page', 'Rewrite', 'Réécrire', 'Run the tests', 'Lancer les tests',
    'Open the project', 'Ouvrir le projet', 'Open the PR', 'Ouvrir la PR', 'Open in a terminal', 'Ouvrir dans un terminal', 'Start the dev server',
    'Finish the review', 'Terminer la revue', 'Until the limit', "Jusqu'à la limite", 'Dictate', 'Dicter', 'Save', 'Enregistrer', 'Delete', 'Supprimer',
    'Forget', 'Oublier', 'Notify me', 'Me prévenir quand elle répond', 'Tell me when it answers', 'Add to the backlog', 'Seen, continue', 'Vu, continuer', 'Confirm', 'Pull request',
  ];
  for (const label of must) assert.ok(isDenied({ tag: 'button', label, attrs: {} }), `« ${label} » should be refused`);
});

test('navigation is not over-refused: tabs, folds, details, closes and in-app links stay clickable', () => {
  const keys = ['flow.detail', 'flow.less', 'plan.theFlow', 'plan.close', 'plan.fullCard', 'esc.see', 'esc.fold', 'esc.detail', 'nav.close', 'nav.review', 'plan.allLog', 'main.older', 'plan.seeDiff', 'rev.loadDiff', 'esc.openPlan', 'flow.openThread', 'main.openPlan'];
  for (const k of keys) for (const dict of [en, fr]) {
    if (dict[k] === undefined) continue;
    assert.equal(denyReason({ tag: 'button', label: dict[k], attrs: { type: 'button' }, type: 'button' }), null, `${k} « ${dict[k]} »`);
  }
  for (const label of ['Flow', 'Le flot', 'Sessions', 'Journal', 'Details', 'Détail', 'Close', 'Fermer', 'Fold', 'Replier']) assert.equal(denyReason({ tag: 'button', label, attrs: { 'data-tab': 'x', type: 'button' } }), null, label);
  assert.equal(denyReason({ tag: 'a', label: 'Flow', attrs: {}, href: '/flow?project=%2Ftmp%2Fx' }), null);
  assert.equal(denyReason({ tag: 'a', label: 'Rafale', attrs: {}, href: '#rafale' }), null);
  assert.equal(denyReason({ tag: 'summary', label: 'Détail', attrs: {} }), null);
  assert.equal(denyReason({ tag: 'input', label: '', attrs: { type: 'checkbox', 'data-k': '1' }, type: 'checkbox' }), null);
});

test('a link that leaves the app, opens a window or calls the API is refused', () => {
  const base = 'http://127.0.0.1:3197';
  assert.ok(isOutsideLink('https://example.com/x', undefined, base));
  assert.ok(isOutsideLink('//example.com', undefined, base));
  assert.ok(isOutsideLink('mailto:a@b.c'));
  assert.ok(isOutsideLink('javascript:alert(1)'));
  assert.ok(isOutsideLink('/api/plans'));
  assert.ok(isOutsideLink('/flow', '_blank'));
  assert.ok(!isOutsideLink(`${base}/flow`, undefined, base));
  assert.ok(!isOutsideLink('/flow?project=x'));
  assert.ok(!isOutsideLink('#memoire'));
  assert.ok(!isOutsideLink('', undefined, base));
  assert.equal(denyReason({ tag: 'a', label: 'localhost:5173', attrs: {}, href: 'http://localhost:5173', target: '_blank' }), 'link');
  assert.equal(denyReason({ tag: 'a', label: 'PR', attrs: { href: 'https://github.com/x/y/pull/1', target: '_blank' } }), 'link');
});

test('the link template of the app that opens a window carries target=_blank, which the list refuses', () => {
  let n = 0;
  for (const [file, src] of sources) for (const m of src.matchAll(/<a\b([^>]*target="_blank"[^>]*)>/g)) { n++; assert.equal(denyReason({ tag: 'a', label: 'x', attrs: parseAttrs(m[1]) }), 'link', file); }
  assert.ok(n >= 2);
});

// ---- the page list ----
const SEED = path.join(tmpdir(), 'robot-seed');
test('the page list: every screen of public/, each view behind a hash, every plan, the empty project, no path of ours', () => {
  const pages = pageList({ seedDir: SEED, planIds: ['p1', 'p2'] });
  const text = pages.join('\n');
  for (const f of readdirSync(PUBLIC).filter((x) => x.endsWith('.html'))) {
    const route = f === 'index.html' ? '/?' : `/${f.replace(/\.html$/, '')}`;
    assert.ok(pages.some((p) => (f === 'index.html' ? p.startsWith('/?') : p.startsWith(route) || p.startsWith(`/${f}`))), `no visit of ${f}`);
  }
  for (const v of ['#memoire', '#acces', '#rafale', '#pilote', '#phone']) assert.ok(text.includes(v), v);
  assert.ok(text.includes('/plan/p1?') && text.includes('/plan/p2?'));
  assert.ok(pages.some((p) => p.includes(encodeURIComponent(path.join(SEED, 'Vide')))));
  assert.ok(pages.includes('/design-system.html') && pages.includes('/'));
  assert.ok(!text.includes('/Users/'), 'no path of a machine');
  assert.equal(new Set(pages).size, pages.length);
});

test('the visits: both languages, both widths, the language first and the hash last', () => {
  const pages = pageList({ seedDir: SEED, planIds: [] });
  const vs = visits(pages);
  assert.equal(vs.length, pages.length * 4);
  assert.deepEqual([...new Set(vs.map((v) => `${v.lang}${v.width}`))].sort(), ['en1440', 'en390', 'fr1440', 'fr390']);
  assert.equal(visitUrl('/?project=a#rafale', 'en'), '/?lang=en&project=a#rafale');
  assert.equal(visitUrl('/design-system.html', 'fr'), '/design-system.html?lang=fr');
  assert.equal(visitUrl('/#acces', 'fr'), '/?lang=fr#acces');
  assert.equal(withQuery('/signaler.html?ecran=Flot', [['project', '/a b']]), '/signaler.html?ecran=Flot&project=%2Fa%20b');
  assert.equal(whereOf({ page: '/?project=x#rafale', lang: 'fr', width: 390 }), '/#rafale [fr 390]');
});

test('the clickable selector reaches the content and never the sidebar', () => {
  assert.ok(CLICKABLE.includes('main button') && CLICKABLE.includes('#content button') && CLICKABLE.includes('.sheet button'));
  assert.ok(!/nav|aside|sidebar/.test(CLICKABLE));
});

// ---- the dead buttons (Dev, 2026-11-03 19:45) ----
test('a click with no request, no DOM change, no navigation and no message is a dead button, in one line', () => {
  const none = { requests: 0, mutations: 0, navigated: false, messages: 0 };
  assert.equal(isDeadClick(none, { tag: 'button' }), true);
  for (const k of ['requests', 'mutations', 'messages']) assert.equal(isDeadClick({ ...none, [k]: 1 }, { tag: 'button' }), false, k);
  assert.equal(isDeadClick({ ...none, navigated: true }, { tag: 'a' }), false);
  assert.equal(isDeadClick(none, { tag: 'input', type: 'checkbox' }), false, 'a checkbox answers by its own tick');
  assert.equal(isDeadClick(null, { tag: 'button' }), false, 'nothing measured, nothing said');
  assert.equal(deadButton('/flow [fr 1440]', 'Renommer'), 'BOUTON MORT /flow Renommer');
  assert.equal(deadButton('/flow [fr 390]', 'Renommer'), deadButton('/flow [fr 1440]', 'Renommer'), 'one line for both widths');
  assert.equal(deadButton('/#pilote [en 390]', ''), 'BOUTON MORT /#pilote (sans texte)');
  const r = report({ clicks: 2, visited: 1, defects: [deadButton('/ [fr 1440]', 'X'), deadButton('/ [fr 390]', 'X')] });
  assert.deepEqual(r.unique, ['BOUTON MORT / X']); assert.equal(r.code, 1);
});

test('the robot measures every click: requests, mutations, navigations, messages, and swallowed popups count', () => {
  const src = readFileSync(path.join(HERE, '..', 'scripts', 'click-robot.mjs'), 'utf8');
  for (const s of ["p.on('request'", 'MutationObserver', 'window.__robotFx', 'isDeadClick(', 'deadButton(where, el.label)', 'writeText']) assert.ok(src.includes(s), s);
});

// ---- the report ----
test('the report: one line per defect, deduplicated, sorted, exit code 1 when any', () => {
  const a = pageError('/flow [fr 1440]', 'chargement', new Error('x is not defined\n at y'));
  const r = report({ clicks: 10, visited: 4, skipped: 3, defects: [a, a, null, consoleError('/ [en 390]', 'clic « A »', 'Uncaught TypeError')] });
  assert.equal(r.unique.length, 2);
  assert.equal(r.code, 1);
  assert.match(r.text, /^4 pages, 10 clics, 3 refusés\n/);
  assert.match(r.text, /PAGEERROR Error: x is not defined$/m);
  assert.deepEqual(r.unique, [...r.unique].sort());
  const ok = report({ clicks: 5, visited: 2, defects: [null, undefined] });
  assert.equal(ok.code, 0);
  assert.match(ok.text, /aucun défaut$/);
});

test('what counts as a defect: page errors, console errors, GET errors; not the requests the robot blocks', () => {
  assert.equal(consoleError('w', 'a', 'net::ERR_FAILED'), null);
  assert.equal(consoleError('w', 'a', 'TypeError: Failed to fetch'), null);
  assert.equal(consoleError('w', 'a', 'Request aborted'), null);
  assert.match(consoleError('w', 'a', 'Uncaught ReferenceError: foo'), /CONSOLE Uncaught ReferenceError: foo/);
  assert.match(httpError('w', 'a', { status: 500, method: 'GET', url: 'http://h/api/x' }, 'http://h'), /HTTP 500 \/api\/x/);
  assert.equal(httpError('w', 'a', { status: 500, method: 'POST', url: 'http://h/api/x' }), null);
  assert.equal(httpError('w', 'a', { status: 304, method: 'GET', url: 'http://h/x' }), null);
  assert.equal(defect({ where: 'w', kind: 'FIGÉ' }), 'w · chargement · FIGÉ');
  assert.ok(defect({ where: 'w', kind: 'K', detail: 'x'.repeat(500) }).length < 200);
});

test('a page closed, crashed or downloading, or a dead browser, is a defect: never hidden, exit code 1', () => {
  for (const kind of ['FERMÉE', 'PLANTÉE', 'TÉLÉCHARGEMENT', 'NAVIGATEUR FERMÉ']) {
    const r = report({ visited: 1, defects: [defect({ where: '/review [fr 1440]', kind })] });
    assert.equal(r.code, 1, kind);
    assert.match(r.text, new RegExp(`/review \\[fr 1440\\] · chargement · ${kind}`));
  }
  assert.equal(traceLine('/review [fr 1440]', 'navigated', '/review?lang=fr'), '· /review [fr 1440] · navigated /review?lang=fr');
  assert.ok(traceLine('w', 'console.log', 'y'.repeat(900)).length < 240);
});

test('the review page never leaves, reloads or closes itself on load', () => {
  const src = readFileSync(path.join(PUBLIC, 'review.html'), 'utf8');
  assert.doesNotMatch(src, /location\.(href|assign|replace|reload)\s*[=(]|window\.close\(|http-equiv=["']?refresh/i);
});

test('the command line', () => {
  assert.deepEqual(parseArgs([]), { port: null, seedDir: null, browser: null, only: null, langs: null, keep: false, trace: false, base: null, help: false, max: 40 });
  assert.equal(parseArgs(['--trace']).trace, true);
  const o = parseArgs(['--port', '3197', '--seed-dir', '/x', '--only', '/flow', '--langs', 'en', '--keep', '--base', 'http://h:1/', '--max', '5']);
  assert.deepEqual([o.port, o.seedDir, o.only, o.langs, o.keep, o.base, o.max], [3197, '/x', '/flow', ['en'], true, 'http://h:1', 5]);
  assert.throws(() => parseArgs(['--port']), /wants a value/);
  assert.throws(() => parseArgs(['--port', 'abc']), /1-65535/);
  assert.throws(() => parseArgs(['--langs', 'de']), /fr,en/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.equal(parseArgs(['--help']).help, true);
});

// ---- the throwaway server ----
test('the throwaway server never starts a claude and keeps everything in its own folder', () => {
  const env = serverEnv({ port: 4000, seedDir: '/s', tmp: '/t', base: {} });
  assert.equal(env.ESCADRILLE_CLAUDE, '/usr/bin/false');
  assert.equal(env.PORT, '4000');
  for (const k of ['ESCADRILLE_DB', 'ESCADRILLE_PLANS', 'ESCADRILLE_HOME', 'ESCADRILLE_TRANSCRIPTS', 'ESCADRILLE_SESSIONS']) assert.ok(env[k].startsWith('/t/'), k);
  assert.ok(!/sessions\.sqlite/.test(env.ESCADRILLE_DB));
  assert.equal(env.ESCADRILLE_SEED_ROOT, '/s');
});

test('the robot starts a seeded server on a free port, lists its plans, serves every page, and stops it', async () => {
  const seedDir = path.join(mkdtempSync(path.join(tmpdir(), 'escadrille-robot-test-')), 'seed');
  const port = await freePort();
  const srv = await startServer({ port, seedDir, env: { ...testEnv(), ESCADRILLE_GATE: 'off' } });
  try {
    assert.equal(srv.base, `http://127.0.0.1:${port}`);
    assert.ok(existsSync(path.join(seedDir, 'Carnet')) && existsSync(path.join(seedDir, 'Vide')), 'seeded under the folder it was given');
    const plans = await (await fetch(`${srv.base}/api/plans?project=${encodeURIComponent(path.join(seedDir, 'Carnet'))}`)).json();
    const planIds = plans.map((p) => p.id);
    assert.ok(planIds.length >= 3, `plans: ${planIds}`);
    const pages = pageList({ seedDir, planIds });
    const bad = [];
    for (const p of pages) { const r = await fetch(srv.base + visitUrl(p, 'en')); if (r.status !== 200) bad.push(`${r.status} ${p}`); }
    assert.deepEqual(bad, []);
  } finally { await srv.stop(); }
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/plans`), 'the server is stopped');
});

test('the seeded server fills what /review reads on load', async () => {
  const seedDir = path.join(mkdtempSync(path.join(tmpdir(), 'escadrille-robot-review-')), 'seed');
  const srv = await startServer({ port: await freePort(), seedDir, env: { ...testEnv(), ESCADRILLE_GATE: 'off' } });
  try {
    for (const proj of ['Carnet', 'Vide']) {
      const pq = '?project=' + encodeURIComponent(path.join(seedDir, proj));
      const page = await fetch(srv.base + visitUrl('/review' + pq, 'fr'), { redirect: 'manual' });
      assert.equal(page.status, 200, `${proj}: /review`);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.equal(page.headers.get('content-disposition'), null, 'no download');
      assert.equal(page.headers.get('location'), null, 'no redirect');
      // what the queue reads on load (review.html, queue()), and the game and the sidebar's escadrilles
      for (const [u, key] of [['/api/reviews' + pq, 'reviews'], ['/api/qa' + pq, 'qa'], ['/api/game' + pq, null], ['/api/escadrilles', null]]) {
        const r = await fetch(srv.base + u, { redirect: 'manual' });
        assert.equal(r.status, 200, `${proj}: ${u.split('?')[0]}`);
        const j = await r.json();
        if (key) assert.ok(Array.isArray(j[key]), `${proj}: ${u.split('?')[0]} lists ${key}`);
      }
    }
  } finally { await srv.stop(); }
});
