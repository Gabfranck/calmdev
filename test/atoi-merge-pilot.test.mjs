// « À toi », 6 November: Fusionner in conflict said nothing (ATOI: server.mjs and docs/backlog.md), and a message left without
// an answer by a dead pilot never reached the list. Checked in the home (vm, as test/abandon-planning.test.mjs): the conflict and
// its files on the line, with the path that works; the silent pilot's line and its « Relancer le pilote » button that posts.
// And lib/pilotdeath.mjs: the cause written for server.log, the cut after two restarts without effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { i18nInto } from './i18n-env.mjs';
import * as pd from '../lib/pilotdeath.mjs';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const home = ({ pilot = { on: true }, answer = () => null } = {}) => {
  const calls = []; const listeners = {};
  const el = (extra = {}) => ({ appendChild() {}, classList: { toggle() {}, contains: () => false, remove() {} }, textContent: '', value: '', disabled: false, focus() {}, addEventListener() {}, dispatchEvent() {}, closest: () => null, dataset: {}, ...extra });
  const nodes = { text: el({ id: 'text' }), state: el({ id: 'state' }), send: el({ id: 'send' }) };
  const document = { head: el(), body: el(), createElement: () => el(), getElementById: (id) => nodes[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener: (k, f) => { (listeners[k] ||= []).push(f); }, activeElement: null, hidden: false, documentElement: el() };
  const window = { document, location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {}, state: null }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, innerWidth: 1440, queueMicrotask: (f) => f(), setInterval: () => 0, clearTimeout() {}, setTimeout: () => 0, requestAnimationFrame: () => 0, fetch: async () => ({ ok: false, json: async () => ({}) }) };
  window.window = window; Object.assign(window, { Promise, URLSearchParams, Date, console, JSON, Math, Number, String, Array, Object, Event: class {} });
  Object.assign(window, { escId: null, project: '/p/calmdev', meta: { models: [], projects: [{ path: '/p/calmdev', name: 'calmdev' }] }, settings: null, render() {},
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), md: (s) => `<p>${s}</p>`,
    api: async (p, body) => { calls.push({ p, body }); return answer(p, body); },
    fmt: (n) => String(n), canvas: el(), setupSpeech() {}, P: { name: (p) => (p ? p.split('/').pop() : ''), withProject: (h) => h } });
  i18nInto(window); for (const f of ['todo.js', 'mainchat.js']) runInNewContext(readFileSync(path.join(PUB, f), 'utf8'), window);
  const m = window.escadrilleMain;
  m.set({ st: { project: '/p/calmdev', messages: [], more: false, total: 0 }, pilot, flow: { nodes: [{ plan: 'pl', session: 'ATOI', waitingFor: 'merge' }], plans: [{ id: 'pl', title: 'Les défauts' }] }, reviews: [], escs: [] });
  const click = async (attrs) => { const b = el({ dataset: attrs }); for (const f of listeners.click || []) f({ target: { closest: (s) => (s === 'button' ? b : null) } }); await new Promise((r) => setImmediate(r)); };
  return { m, calls, click };
};
// the lines of « À toi » as the page draws them (escadrilleMain.waiting: badge, text, why, note, act)
const text = (h) => h.m.waiting().map((l) => [l.text, l.why, l.note || '', l.note ? 'class="line has-note"' : '', l.note ? `class="await-note" role="status">${l.note}<` : '', l.act].join(' | ')).join('\n');

test('Fusionner in conflict says the files and the path on the line itself', async () => {
  const h = home({ pilot: { on: false }, answer: (p) => (p.endsWith('/merge') ? { error: 'fusion en conflit', conflict: true, files: ['server.mjs', 'docs/backlog.md'] } : null) });
  assert.match(text(h), /data-merge="pl\/ATOI"/);
  await h.click({ merge: 'pl/ATOI' });
  assert.equal(h.calls.at(-1).p, '/api/plan/pl/session/ATOI/merge');
  const v = text(h);
  assert.match(v, /class="line has-note"/);
  assert.match(v, /class="await-note" role="status">Conflit sur server\.mjs, docs\/backlog\.md\. La session fusionne la branche du projet dans la sienne, résout et commite ; puis Fusionner à nouveau\.</);
  assert.match(v, /data-merge="pl\/ATOI">Fusionner</, 'the button stays to merge again');
});

test('a message the pilot left unanswered is a line of « À toi »; Relancer le pilote posts and the line goes', async () => {
  const stalled = { on: true, stall: { reason: "le pilote n'a pas répondu", at: 'x' }, unanswered: [{ seq: 7, text: 'Relance APPS stp', at: 'x' }] };
  const h = home({ pilot: stalled, answer: (p) => (p === '/api/pilot/retry' ? { ok: true, pilot: { on: true, stall: null, unanswered: [] } } : null) });
  let v = text(h);
  assert.match(v, /Le pilote n’a pas répondu à ton message/);
  assert.match(v, /« Relance APPS stp »/);
  assert.match(v, /data-pilot-retry>Relancer le pilote</);
  await h.click({ pilotRetry: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), { p: '/api/pilot/retry', body: { project: '/p/calmdev' } });
  v = text(h); assert.doesNotMatch(v, /data-pilot-retry/);
  const cut = home({ pilot: { on: false, stall: { reason: 'coupé après 2 relances sans effet', cut: true }, unanswered: [] } });
  assert.match(text(cut), /Pilote coupé après deux relances sans effet/);
});

test('pilotdeath: the cause for server.log, the cut at the third restart, the unanswered messages', () => {
  assert.equal(pd.exitLine({ project: '/p', code: 1, signal: null, stderr: 'a\nb\nc\nAPI Error: 529 overloaded\n', answered: false, cost: 0 }),
    'pilot /p: exit code 1, no answer, 0.0000 $, stderr: b / c / API Error: 529 overloaded');
  assert.match(pd.exitLine({ project: '/p', code: null, signal: 'SIGKILL', stderr: '' }), /exit code none, signal SIGKILL, no answer, 0\.0000 \$, stderr empty/);
  const g = pd.createRestartGuard();
  assert.deepEqual([g.restarted('/p'), g.restarted('/p'), g.restarted('/p')].map((r) => r.cut), [false, false, true]);
  g.restarted('/q'); g.answered('/q'); assert.equal(g.count('/q'), 0, 'an answer clears the count');
  assert.deepEqual(pd.unanswered({ pending: [{ seq: 1, text: 'x', at: 't' }], stall: null }), []);
  assert.deepEqual(pd.unanswered({ pending: [{ seq: 1, text: 'x', at: 't', extra: 1 }], stall: { reason: 'r' } }), [{ seq: 1, text: 'x', at: 't' }]);
});
