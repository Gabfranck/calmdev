// The list of models: the fallback, the models seen in transcripts, the local override file (docs/models.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildModels, listModels, isModel, modelName, defaultModel, plannerModel, nameOf, NO_ADAPTER } from '../lib/models.mjs';
import { validatePlan } from '../lib/blocks.mjs';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-models-')));
const NONE = path.join(tmp(), 'absent.json'); // no override file
const EMPTY = path.join(tmp(), 'no-transcripts'); // no transcripts
// A transcript root with one session whose assistant message names `model`
const transcripts = (model) => {
  const root = tmp(); const dir = path.join(root, '-proj'); mkdirSync(dir);
  const line = { type: 'assistant', sessionId: 's1', timestamp: '2026-11-01T08:00:00.000Z', message: { id: 'm1', model, usage: { input_tokens: 10, output_tokens: 5 } } };
  writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(line) + '\n');
  return root;
};
const override = (o) => { const f = path.join(tmp(), 'models.json'); writeFileSync(f, JSON.stringify(o)); return f; };
const ids = (l) => l.map((m) => m.id);

test('the fallback lists the four current models with their prices, Opus 5.5 by default and first', () => {
  const l = buildModels({ root: EMPTY, overrideFile: NONE });
  assert.deepEqual(ids(l).sort(), ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(l[0].id, 'claude-opus-5-5'); assert.equal(l[0].default, true);
  assert.equal(l.filter((m) => m.default).length, 1);
  const sonnet = l.find((m) => m.id === 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.price, { input: 2, output: 10, cacheRead: 0.2 });
  assert.equal(sonnet.name, 'Sonnet 5.5'); assert.equal(sonnet.provider, 'claude'); assert.equal(sonnet.available, true);
});

test('a model unknown to the code, seen in a transcript, appears with a derived name', () => {
  const l = buildModels({ root: transcripts('claude-opus-6-0-20270101'), overrideFile: NONE });
  const m = l.find((x) => x.id === 'claude-opus-6-0');
  assert.ok(m, 'claude-opus-6-0 is listed'); assert.equal(m.name, 'Opus 6.0'); assert.equal(m.available, true); assert.equal(m.price, undefined);
  assert.ok(!ids(buildModels({ root: transcripts('<synthetic>'), overrideFile: NONE })).includes('<synthetic>'));
});

test('derived names', () => {
  assert.equal(nameOf('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(nameOf('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(nameOf('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(nameOf('claude-fable-6'), 'Fable 6');
});

test('the override adds, masks and renames; the default can move', () => {
  const f = override({ hide: ['claude-fable-5-1'], default: 'claude-sonnet-5-5', add: [{ id: 'claude-next-1', name: 'Next', price: { input: 1, output: 5, cacheRead: 0.1 } }, { id: 'claude-opus-5-5', name: 'Opus (maison)' }] });
  const l = buildModels({ root: EMPTY, overrideFile: f });
  assert.ok(!ids(l).includes('claude-fable-5-1'));
  assert.equal(l.find((m) => m.id === 'claude-next-1').name, 'Next');
  assert.deepEqual(l.find((m) => m.id === 'claude-next-1').price, { input: 1, output: 5, cacheRead: 0.1 });
  assert.equal(l.find((m) => m.id === 'claude-opus-5-5').name, 'Opus (maison)');
  assert.equal(l[0].id, 'claude-sonnet-5-5'); assert.equal(l.filter((m) => m.default).length, 1);
  // a broken file changes nothing
  const bad = path.join(tmp(), 'bad.json'); writeFileSync(bad, '{nope');
  assert.equal(buildModels({ root: EMPTY, overrideFile: bad }).length, 4);
});

test('an ollama or openai-compatible model is listed, unavailable, with the reason', () => {
  const f = override({ add: [{ id: 'llama3.2', provider: 'ollama' }, { id: 'local-gpt', name: 'Local GPT', provider: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' }] });
  listModels({ root: EMPTY, overrideFile: f });
  const l = listModels();
  const o = l.find((m) => m.id === 'llama3.2');
  assert.equal(o.provider, 'ollama'); assert.equal(o.available, false); assert.equal(o.reason, NO_ADAPTER);
  const g = l.find((m) => m.id === 'local-gpt');
  assert.equal(g.available, false); assert.equal(g.baseUrl, 'http://localhost:8000/v1');
  assert.equal(isModel('llama3.2'), false); assert.equal(isModel('claude-opus-5-5'), true);
  assert.equal(modelName('llama3.2'), 'Llama3.2'); assert.equal(modelName('claude-haiku-5-5'), 'Haiku 5.5');
});

test('the planner model: the escadrille\'s, else the project\'s, else the default; a retired one is skipped', () => {
  listModels({ root: EMPTY, overrideFile: override({ hide: ['claude-haiku-5-5'] }) });
  assert.equal(defaultModel(), 'claude-opus-5-5');
  assert.equal(plannerModel('claude-sonnet-5-5', 'claude-opus-5-5'), 'claude-sonnet-5-5');
  assert.equal(plannerModel(undefined, 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(plannerModel(null, 'claude-haiku-5-5'), 'claude-opus-5-5');
  assert.equal(plannerModel(), 'claude-opus-5-5');
});

test('validatePlan accepts any available model and refuses the others', () => {
  listModels({ root: transcripts('claude-opus-6-0'), overrideFile: override({ add: [{ id: 'llama3.2', provider: 'ollama' }] }) });
  const plan = (model) => ({ title: 'T', goal: 'g', waves: [{ n: 1, title: 'V' }], sessions: [{ id: 'A', name: 'a', prompt: 'p', stops: ['x'], model }] });
  const d = { path: '/tmp/x', project: '/tmp/x' };
  assert.equal(validatePlan(plan('claude-opus-6-0'), d).errors, undefined);
  assert.match(validatePlan(plan('llama3.2'), d).errors.join(), /modèle inconnu/);
  assert.match(validatePlan(plan('gpt-9'), d).errors.join(), /modèle inconnu/);
});
