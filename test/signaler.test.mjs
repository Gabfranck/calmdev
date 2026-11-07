// public/signaler.js: the screen's name, the way back, the line found in the answer; and the page's request
// against the stand-in of the backlog contract (test/signaler-fake.mjs), since the server's side is session A's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fake } from './signaler-fake.mjs';
import '../public/signaler.js';
import { i18nGlobal } from './i18n-env.mjs';
i18nGlobal();

const S = globalThis.escadrilleSignaler;

test('the screen comes from ?ecran=, calmdev when absent or blank', () => {
  assert.equal(S.screen('?ecran=Ressources'), 'Ressources');
  assert.equal(S.screen('?ecran=R%C3%A9sum%C3%A9%20t%C3%A9l%C3%A9phone'), 'Résumé téléphone');
  assert.equal(S.screen(''), 'calmdev');
  assert.equal(S.screen('?ecran=%20'), 'calmdev');
});

test('the way back leads to the screen when known, keeps the project, else the home', () => {
  assert.deepEqual(S.backTo('Ressources', '/p/x'), { href: '/resources?project=%2Fp%2Fx', label: 'Revenir à Ressources' });
  assert.deepEqual(S.backTo('Rafale', '/p/x'), { href: '/?project=%2Fp%2Fx#rafale', label: 'Revenir à Avancer le backlog' });
  assert.deepEqual(S.backTo('Accès', null), { href: '/#acces', label: 'Revenir à Accès' });
  assert.deepEqual(S.backTo('Inconnu', null), { href: '/', label: 'Revenir à calmdev' });
});

test('the line added is the last task holding the text, else the last task', () => {
  const tasks = [{ n: 1, text: 'a' }, { n: 2, text: 'Flot : le bouton  saute' }, { n: 3, text: 'b' }];
  assert.equal(S.added(tasks, 'le bouton\nsaute').n, 2);
  assert.equal(S.added(tasks, 'rien').n, 3);
  assert.equal(S.added(null, 'x'), null);
});

test('the page has one field, one primary button, the script and no dependency', () => {
  const html = readFileSync(new URL('../public/signaler.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<textarea/g) || []).length, 1);
  assert.equal((html.match(/btn primary/g) || []).length, 1);
  assert.match(html, /data-i18n="sig.send"/);
  assert.match(html, /<script src="\/signaler.js">/);
});

test('the request the page sends gets { exists, file, tasks } from the stand-in', async () => {
  const f = fake(); await new Promise((ok) => f.server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${f.server.address().port}/api/project/backlog`;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: '/p/x', from: 'defect', text: 'Le tri\nsaute', screen: 'Ressources' }) });
    const body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.file, '/p/x/docs/backlog.md');
    assert.equal(S.added(body.tasks, 'Le tri\nsaute').text, 'Ressources : Le tri saute');
    assert.deepEqual(f.posts[0], { project: '/p/x', from: 'defect', text: 'Le tri\nsaute', screen: 'Ressources' });
  } finally { f.server.close(); }
});
