import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBlocks, stripBlocks, validatePlan, validateInstall, validateQuestions, validateState } from '../lib/blocks.mjs';

const text = `Voici mes questions.\n\n\`\`\`escadrille:install\n[{"kind":"plugin","name":"taste-skill","why":"les écrans","how":"claude plugin install taste-skill@taste-skill"}]\n\`\`\`\n\nEt le plan :\n\n\`\`\`escadrille:plan\n{"title":"Les avatars","sessions":[{"id":"A","name":"L'API","stops":["Le schéma"],"prompt":"Fais l'API."},{"id":"B","wave":2,"after":["A"],"name":"L'écran","stops":["La maquette"],"prompt":"Fais l'écran."}]}\n\`\`\`\n`;

test('finds both blocks and strips them from the prose', () => {
  const blocks = findBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'install'); assert.equal(blocks[0].value[0].name, 'taste-skill');
  assert.equal(blocks[1].kind, 'plan'); assert.equal(blocks[1].value.title, 'Les avatars');
  assert.equal(stripBlocks(text), 'Voici mes questions.\n\nEt le plan :');
});

test('a stream with the old escadrille: blocks and one with the new calmdev: blocks read the same', () => {
  const state = '{"stops":[0],"health":"ok","why":"","claude":"Regarde a.md","summary":"Fait : a\\nReste : rien","done":false}';
  const pilot = '{"actions":[{"do":"memory","line":"x"}]}'; const plan = '{"title":"T","sessions":[]}';
  for (const name of ['escadrille', 'calmdev']) {
    const msg = `Fini.\n\n\`\`\`${name}:state\n${state}\n\`\`\`\n\n\`\`\`${name}:plan\n${plan}\n\`\`\`\n\n\`\`\`${name}:pilot\n${pilot}\n\`\`\``;
    const blocks = findBlocks(msg);
    assert.deepEqual(blocks.map((b) => b.kind), ['state', 'plan', 'pilot'], name);
    assert.equal(blocks[0].value.claude, 'Regarde a.md'); assert.equal(blocks[2].value.actions[0].line, 'x');
    assert.equal(stripBlocks(msg), 'Fini.', name);
  }
  assert.deepEqual(findBlocks('```other:state\n{}\n```'), [], 'another prefix is not ours');
});

test('reports a block whose JSON is broken', () => {
  const [b] = findBlocks('```escadrille:plan\n{"title": }\n```');
  assert.match(b.error, /JSON invalide/);
});

test('validatePlan fills the gaps from the escadrille and keeps the waves in order', () => {
  const { plan, errors } = validatePlan(findBlocks(text)[1].value, { path: '/tmp', model: 'claude-opus-5-5', idPrefix: '2026-11-01' });
  assert.equal(errors, undefined);
  assert.equal(plan.id, '2026-11-01-les-avatars');
  assert.deepEqual(plan.waves.map((w) => w.n), [1, 2]);
  assert.equal(plan.sessions[0].path, '/tmp'); assert.equal(plan.sessions[0].model, 'claude-opus-5-5'); assert.equal(plan.sessions[0].wave, 1);
  assert.deepEqual(plan.sessions[1].after, ['A']);
});

test('validatePlan refuses a dependency in the same wave, a missing prompt and an unknown model', () => {
  const { errors } = validatePlan({ title: 'x', sessions: [{ id: 'A', name: 'a', stops: ['s'], prompt: 'p', model: 'gpt' }, { id: 'B', name: 'b', after: ['A'], stops: ['s'] }] }, { path: '/tmp' });
  assert.ok(errors.some((e) => /modèle inconnu/.test(e)));
  assert.ok(errors.some((e) => /prompt manquant/.test(e)));
  assert.ok(errors.some((e) => /vague antérieure/.test(e)));
});

test('validateInstall normalises kinds and keeps the boxes ticked by default', () => {
  const { items } = validateInstall([{ kind: 'weird', name: 'x' }, { kind: 'skill', name: 'y', checked: false, scope: 'session' }]);
  assert.equal(items[0].kind, 'rule'); assert.equal(items[0].checked, true);
  assert.equal(items[1].scope, 'session'); assert.equal(items[1].checked, false);
});

test('validateQuestions numbers and trims the questions', () => {
  const { items } = validateQuestions([{ title: ' Où vit le flot ? ', recommendation: 'Dans plan.html' }, { n: 5, title: 'La livraison' }]);
  assert.equal(items[0].n, 1); assert.equal(items[0].title, 'Où vit le flot ?'); assert.equal(items[1].n, 5);
  assert.ok(validateQuestions([]).errors);
  assert.equal(findBlocks('```escadrille:questions\n[{"title":"x"}]\n```')[0].kind, 'questions');
});

test('a plan whose prompt holds a fenced code block still closes at the right fence', () => {
  const text = 'Le plan :\n\n```escadrille:plan\n{"title":"Avec du code","sessions":[{"id":"A","name":"a","stops":["s"],"prompt":"Lance :\\n```sh\\nnode --test\\n```\\npuis commite."}]}\n```\n\nVoilà.';
  const [b] = findBlocks(text);
  assert.equal(b.error, undefined); assert.equal(b.value.sessions[0].prompt.includes('node --test'), true);
  assert.equal(stripBlocks(text), 'Le plan :\n\nVoilà.');
});

test('validatePlan keeps a session budget and the network list, drops a bad budget, renders network empty by default', () => {
  const { plan, errors } = validatePlan({ title: 'x', network: ['api.github.com', ' registry.npmjs.org ', ''], sessions: [{ id: 'A', name: 'a', stops: ['s'], prompt: 'p', budget: 2.5 }, { id: 'B', name: 'b', stops: ['s'], prompt: 'p', budget: '3' }, { id: 'C', name: 'c', stops: ['s'], prompt: 'p', budget: -1 }, { id: 'D', name: 'd', stops: ['s'], prompt: 'p' }] }, { path: '/tmp' });
  assert.equal(errors, undefined);
  assert.deepEqual(plan.network, ['api.github.com', 'registry.npmjs.org']);
  assert.deepEqual(plan.sessions.map((s) => s.budget), [2.5, 3, undefined, undefined]);
  assert.deepEqual(validatePlan({ title: 'x', sessions: [{ id: 'A', name: 'a', stops: ['s'], prompt: 'p' }] }, { path: '/tmp' }).plan.network, []);
});

test('validateState accepts an optional summary and gives null without one', () => {
  assert.equal(validateState({ stops: [0], health: 'ok', why: '', claude: 'x', done: false }).state.summary, null);
  assert.equal(validateState({ stops: [0], summary: ' Fait : a\nReste : b ' }).state.summary, 'Fait : a\nReste : b');
  assert.equal(validateState({ stops: [0], summary: 42 }).state.summary, null);
});

test('a slug of more than 48 characters is cut at a word', () => {
  const { plan } = validatePlan({ title: 'Phase 2 : le flot et l’estimation, en trois sessions pour la nuit', sessions: [{ id: 'A', name: 'a', stops: ['s'], prompt: 'p' }] }, { path: '/tmp' });
  assert.equal(plan.id, 'phase-2-le-flot-et-l-estimation-en-trois');
});

test('validatePlan keeps next as a plan id or judge, qa, none; refuses anything else; drops an empty one', () => {
  const base = { title: 'x', sessions: [{ name: 'a', prompt: 'p', stops: ['s'] }] }; const d = { path: '/p', model: 'claude-sonnet-5-5' };
  assert.equal(validatePlan({ ...base, next: '2026-11-04-phase-13' }, d).plan.next, '2026-11-04-phase-13');
  assert.equal(validatePlan({ ...base, next: ' judge ' }, d).plan.next, 'judge');
  assert.equal('next' in validatePlan({ ...base, next: '' }, d).plan, false); assert.equal('next' in validatePlan(base, d).plan, false);
  assert.match(validatePlan({ ...base, next: 'not a plan' }, d).errors.join(' '), /next/);
});
