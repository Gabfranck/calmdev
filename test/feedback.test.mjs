// « Retour » (lib/feedback.mjs, public/feedback.js): the report of a project whose errors carry a key, a home path,
// the project's name and a prompt leaves masked; the issue URL is cut near 6 000 characters and says so; nothing is
// requested but the local report, and the only way out is a link the developer clicks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fb from '../lib/feedback.mjs';
import '../public/feedback.js';
import { DENY_LABEL } from '../scripts/click-denylist.mjs';

const F = globalThis.escadrilleFeedback;
// built at run time: a tracked file never carries a home path nor a key as is (test/trace-scan.test.mjs)
const HOME = ['', 'Users', 'alice'].join('/');
const KEY = ['sk', 'ant', 'api03', 'AbCdEf123456GhIjKl789012MnOpQr'].join('-');
const project = `${HOME}/Dev/Moonbase`;
const ctx = fb.contextOf([project], HOME);
const LOG = [
  '2026-11-07T10:00:00Z listening on 127.0.0.1:3078',
  `2026-11-07T10:01:00Z session error: claude exited with key ${KEY} in ${project}/.claude/worktrees/x`,
  '2026-11-07T10:02:00Z plan failed: prompt « Ajoute la page de paiement de Moonbase avec Stripe » refused',
  `2026-11-07T10:03:00Z EPERM: operation not permitted, open '${HOME}/Library/foo.json'`,
  "2026-11-07T10:04:00Z test apps: pid 42 failed to stop in /private/tmp/claude-501/x",
  'const token = "abc"; // a plain line of code',
].join('\n');

test('the report of a project with a key and a /Users path in its errors leaves masked', () => {
  const sessions = [
    { usage: JSON.stringify({ cost: 1.25 }), worktree: JSON.stringify({ path: `${project}/.claude/worktrees/a`, merged: true }), stops: '[0,1]', session_id: 'abc' },
    { usage: JSON.stringify({ cost: 0.5 }), worktree: null, stops: '[0]', session_id: null },
  ];
  const f = fb.facts({ plans: 1, sessions });
  assert.deepEqual(f.steps, { install: true, plan: true, session: true, merge: true });
  assert.equal(f.stops, 3); assert.equal(f.cost, 1.75);
  const report = fb.report({ version: '0.1.0 · abc123', facts: f, errors: fb.logErrors(LOG, ctx) });
  const whole = F.compose(report, 'Le premier plan a mis du temps');
  assert.match(whole, /Le premier plan a mis du temps/);
  assert.match(whole, /session error/);
  assert.match(whole, /EPERM/);
  for (const leak of [/sk-ant/, /AbCdEf123456/, new RegExp(HOME.slice(0, 6)), /alice/i, /Moonbase/i, /paiement/, /Stripe/, /\/private\/tmp/, /Library/, /const token/]) assert.doesNotMatch(whole, leak, String(leak));
  assert.equal(fb.logErrors(LOG, ctx).length, 4);
});

test('a fresh install says the steps not yet crossed, an empty log says no error', () => {
  const r = fb.report({ version: '—', facts: fb.facts({ plans: 0, sessions: [] }), errors: [] });
  assert.match(r, /installation oui → premier plan pas encore → première session pas encore → première fusion pas encore/);
  assert.match(r, /coût : 0\.00 \$/); assert.match(r, /- aucune/);
});

test('the issue URL is prefilled on the repository, cut near 6 000 characters on a line, the cut said', () => {
  const short = F.issueUrl('court');
  assert.equal(short.cut, false);
  assert.ok(short.url.startsWith('https://github.com/Gabfranck/calmdev/issues/new?title='));
  assert.equal(new URL(short.url).searchParams.get('body'), 'court');
  const long = F.issueUrl(Array.from({ length: 400 }, (_, i) => `- ligne ${i} ${'x'.repeat(20)}`).join('\n'));
  const body = new URL(long.url).searchParams.get('body');
  assert.equal(long.cut, true);
  assert.ok(body.length <= 6100 && body.length > 5000, String(body.length));
  assert.match(body, /- ligne \d+ x+\n\n_\(rapport tronqué à 6 000 caractères\)_$/);
});

test('nothing is requested without the click: one local GET, the way out a link, no key', () => {
  const page = readFileSync(new URL('../public/feedback.js', import.meta.url), 'utf8');
  const fetches = [...page.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ["'/api/feedback'"]);
  for (const out of [/sendBeacon/, /XMLHttpRequest/, /window\.open|root\.open\(/, /location\s*=|location\.href\s*=|location\.assign/, /token|authorization/i]) assert.doesNotMatch(page, out, String(out));
  assert.match(page, /<a class="btn primary" id="fbIssue" href="\$\{esc\(url\)\}" target="_blank" rel="noopener noreferrer">/);
  const lib = readFileSync(new URL('../lib/feedback.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(lib, /node:(https?|net|tls|dgram)|fetch\(/);
});

test('the click robot never follows « Ouvrir une issue » nor « Copier »', () => {
  for (const l of ['Ouvrir une issue', 'Open an issue', 'Copier', 'Copy']) assert.ok(DENY_LABEL.test(l), l);
});
