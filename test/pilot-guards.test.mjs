// PIL (Dev, 6 November): the pilot cannot skid. One test per guard (docs/pilot.md, « Les garde-fous », 7 to 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAnswer, permissionKey, createDenials, muteWaiting, scopeCheck, planCapCheck, DEFAULT_PLAN_CAP } from '../lib/pilot.mjs';
import { classify } from '../lib/wake.mjs';

const outside = (id, extra = {}) => ({ id, kind: 'permission', tool: 'Bash', input: { command: 'git  commit -m  "x"', dangerouslyDisableSandbox: true }, text: 'git commit -m "x"', suggest: { allow: false, reason: 'Hors bac à sable : à décider soi-même', rule: 'sandbox-off' }, at: '2026-11-06T10:00:00Z', ...extra });

test('(1) an allow:true on an out-of-sandbox request is refused with the way that works; the second identical request does not wake the pilot', () => {
  const d = decideAnswer({ entry: outside('p1'), mode: 'autonome', allow: true });
  assert.equal(d.ok, false); assert.equal(d.dev, true);
  assert.match(d.why, /hors bac/); assert.match(d.why, /À toi/, 'the refusal gives the way that works');
  assert.equal(decideAnswer({ entry: outside('p1'), mode: 'autonome', allow: false }).ok, true, 'refusing stays allowed');
  // the 6 November loop: the same command (normalised) comes back with a new pendingId
  const denials = createDenials();
  const k1 = permissionKey('plan-x', 'CON', outside('p1')); const k2 = permissionKey('plan-x', 'CON', outside('p2', { input: { command: 'git commit -m "x"', dangerouslyDisableSandbox: true } }));
  assert.equal(k1, k2, 'same session, same normalised command, same key');
  assert.equal(denials.muted(k1), false);
  const r = denials.refuse(k1, { toDev: d.dev }); assert.equal(r.muted, true); assert.equal(r.first, true, 'goes to « À toi » once');
  assert.equal(denials.refuse(k1).first, false, 'never twice');
  const waiting = [{ plan: 'plan-x', session: 'CON', pendingId: 'p2', kind: 'permission', tool: 'Bash', command: 'git commit -m "x"', input: outside('p2').input, at: '2026-11-06T10:01:00Z' }];
  const events = [{ seq: 9, plan: 'plan-x', session: 'CON', what: 'attend', text: '' }];
  const m = muteWaiting({ waiting, events, muted: (w) => denials.muted(permissionKey(w.plan, w.session, w)) });
  const cl = classify({ events: m.events, waiting: m.waiting, rows: { 'plan-x/CON': { status: 'waiting' } } });
  assert.equal(cl.judge, false, 'the second identical request does not wake the pilot');
  // two plain refusals of the pilot mute too (« refusée deux fois »)
  const other = createDenials(); const k = permissionKey('p', 'B', { tool: 'Bash', input: { command: 'ls /etc' } });
  assert.equal(other.refuse(k).muted, false); assert.equal(other.refuse(k).muted, true);
});

test('(2) POL: the pilot grants what the rule allows by its target; what it does not know goes up to the developer', () => {
  const ask = (rule, allow = true) => ({ kind: 'permission', tool: 'Bash', input: { command: 'x' }, suggest: { allow, reason: '', rule } });
  for (const rule of ['read-only', 'write-inside', 'local-run', 'local-bin', 'git-local']) assert.equal(decideAnswer({ entry: ask(rule), mode: 'guide', allow: true }).ok, true, `${rule} granted`);
  for (const entry of [ask('write-guarded', null), ask(null, null)]) {
    const d = decideAnswer({ entry, mode: 'autonome', allow: true });
    assert.equal(d.ok, false, `${entry.suggest.rule} refused`); assert.equal(d.dev, true); assert.match(d.why, /ne dit pas oui/); assert.match(d.why, /À toi/);
  }
  assert.equal(decideAnswer({ entry: { kind: 'permission', tool: 'Write', input: { file_path: '/w/a.mjs' }, suggest: null }, mode: 'autonome', allow: true }).ok, false, 'no rule said yes: up to the developer');
  assert.equal(decideAnswer({ entry: ask('write-inside'), mode: 'autonome', allow: false }).ok, true, 'the pilot may still refuse');
});

test('(3) a pilot message that adds a file outside the brief becomes a question; a reminder or an unblock passes', () => {
  const brief = 'Corrige lib/pilot.mjs et ajoute son test dans test/pilot-guards.test.mjs. Ne touche à rien d’autre.';
  const out = scopeCheck({ text: 'Crée aussi src/billing/invoice.mjs pour la facture.', brief });
  assert.equal(out.ok, false); assert.match(out.why, /src\/billing\/invoice\.mjs/);
  assert.equal(scopeCheck({ text: 'Installe zod pour valider.', brief }).ok, false, 'an install is a widening');
  assert.equal(scopeCheck({ text: 'Ouvre le réseau vers api.example.com.', brief }).ok, false, 'network is a widening');
  assert.equal(scopeCheck({ text: 'Rappel du brief : lib/pilot.mjs seulement, puis l’arrêt 1.', brief }).ok, true, 'a reminder passes');
  assert.equal(scopeCheck({ text: 'Continue, la permission est réglée.', brief }).ok, true, 'an unblock passes');
  assert.equal(scopeCheck({ text: 'Le test va dans test/pilot13.test.mjs.', brief }).ok, true, 'a file in a folder the brief names passes');
});

test('(4) a launch by the pilot above pilotPlanCapUsd waits for the click', () => {
  assert.equal(DEFAULT_PLAN_CAP, 10);
  assert.equal(planCapCheck({ cost: 8 }).ok, true);
  const d = planCapCheck({ cost: 12 }); assert.equal(d.ok, false); assert.match(d.why, /clic/); assert.match(d.why, /10/);
  assert.equal(planCapCheck({ cost: 12, cap: 20 }).ok, true, 'the setting raises it');
  assert.equal(planCapCheck({ cost: null }).ok, false, 'an unknown cost waits too');
});
