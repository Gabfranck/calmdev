import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validatePlaybook, playbookWaves, scanLeaks, templateIds } from '../lib/playbooks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = join(root, 'playbooks/examples/quiz-de-classe.json');
const example = () => JSON.parse(readFileSync(examplePath, 'utf8'));
const errorsOf = (pb, opts) => validatePlaybook(pb, opts).errors;

test('the example of the public repository is valid', () => {
  const r = validatePlaybook(example());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('the example uses only known templates once the templates exist', () => {
  const ids = templateIds(join(root, 'plans/templates'));
  if (!ids.size) return; // plans/templates arrives with session H
  assert.deepEqual(errorsOf(example(), { templates: ids }), []);
});

test('the public repository only holds the format and anonymous examples', () => {
  assert.deepEqual(readdirSync(join(root, 'playbooks')).sort(), ['examples', 'format']);
  for (const name of readdirSync(join(root, 'playbooks/examples'))) {
    const pb = JSON.parse(readFileSync(join(root, 'playbooks/examples', name), 'utf8'));
    assert.equal(pb.license, 'example', `${name} must be an example`);
    assert.notEqual(pb.price.model, 'one-time', `${name}: nothing is sold from the public repository`);
    assert.doesNotMatch(JSON.stringify(pb), /orchard/i, `${name}: no Orchard name in the public repository`);
  }
});

test('required fields, unknown fields and the one-sentence promise', () => {
  const pb = example();
  delete pb.metrics;
  pb.extra = 1;
  pb.promise = 'Une phrase. Puis une autre.';
  const e = errorsOf(pb);
  assert.ok(e.includes('metrics: missing'));
  assert.ok(e.includes('extra: unknown field'));
  assert.ok(e.includes('promise: one sentence'));
});

test('config: unique keys and defaults that fit their kind', () => {
  const pb = example();
  pb.config.push({ key: 'lang', label: 'x', kind: 'text', default: '' });
  pb.config.push({ key: 'accent', label: 'Accent', kind: 'color', default: 'violet' });
  pb.config.push({ key: 'plan', label: 'Offre', kind: 'choice', options: ['a', 'b'], default: 'c' });
  const e = errorsOf(pb);
  assert.ok(e.some((m) => m.includes('duplicate "lang"')));
  assert.ok(e.some((m) => m.startsWith('config[6].default')));
  assert.ok(e.some((m) => m.startsWith('config[7].default')));
});

test('plans: template or idea, known dependencies, no cycle, placeholders in the config', () => {
  const pb = example();
  pb.plans[0].after = ['passe'];
  pb.plans[1].idea += ' {{inconnu}}';
  pb.plans.push({ id: 'double', template: 'x', idea: 'les deux à la fois', after: ['nulle-part'], budget: 0 });
  const e = errorsOf(pb, { templates: new Set(['passe-design']) });
  assert.ok(e.some((m) => m.startsWith('plans: cycle')), e.join('\n'));
  assert.ok(e.some((m) => m.includes('{{inconnu}}')));
  assert.ok(e.some((m) => m.includes('exactly one of template or idea')));
  assert.ok(e.some((m) => m.includes('unknown plan "nulle-part"')));
  assert.ok(e.some((m) => m.includes('unknown template "x"')));
  assert.ok(e.some((m) => m.startsWith('plans[3].budget')));
});

test('waves follow the dependencies', () => {
  const pb = example();
  pb.plans.push({ id: 'landing', idea: 'une page seule, sans dépendance', after: [], budget: 5 });
  assert.deepEqual(playbookWaves(pb), [['socle', 'landing'], ['ecrans'], ['passe']]);
});

test('ready criteria are checkable and local only', () => {
  const pb = example();
  pb.ready.push({ id: 'prod', label: 'En ligne', check: { kind: 'url', url: 'https://mon-quiz.fr' } });
  pb.ready.push({ id: 'vague', label: 'Ça a l\'air bien', check: { kind: 'feeling' } });
  pb.ready.push({ id: 'dehors', label: 'Hors projet', check: { kind: 'file', path: '../secret' } });
  const e = errorsOf(pb);
  assert.ok(e.some((m) => m.includes('localhost only')));
  assert.ok(e.some((m) => m.startsWith('ready[4].check.kind')));
  assert.ok(e.some((m) => m.startsWith('ready[5].check.path')));
});

test('assets stay inside the playbook, and ready ones must exist', () => {
  const pb = example();
  pb.assets.push({ path: '../hors.md', kind: 'doc' }, { path: 'absent.md', kind: 'doc', state: 'ready' });
  const e = errorsOf(pb, { root: join(root, 'playbooks/examples') });
  assert.ok(e.some((m) => m.startsWith('assets[1].path')));
  assert.ok(e.some((m) => m.includes('"absent.md" is marked ready but missing')));
});

test('leaks: keys, e-mails and home paths are refused', () => {
  const pb = example();
  pb.audience = 'Contact : prof.martin@college.fr';
  pb.config[0].help = 'clé sk_live_abcdefgh12345678';
  pb.assets[0].note = `copié de ${['', 'Users', 'quelquun', 'projet', ''].join('/')}`;
  const e = errorsOf(pb);
  assert.ok(e.includes('audience: looks like an e-mail address'));
  assert.ok(e.includes('config[0].help: looks like a Stripe key'));
  assert.ok(e.includes('assets[0].note: looks like an absolute home path'));
  assert.deepEqual(scanLeaks({ a: 'support@example.com' }), []);
});

// The paid playbooks live outside the repository; when this machine has one, it must be valid too.
const privateDir = process.env.ESCADRILLE_PLAYBOOKS ?? join(homedir(), '.escadrille/playbooks');
const eduQuiz = join(privateDir, 'edu-quiz/playbook.json');
let readable = false;
try { readable = existsSync(eduQuiz) && !!readFileSync(eduQuiz); } catch { readable = false; }
test('the private edu-quiz playbook is valid when present', { skip: !readable && 'not on this machine' }, () => {
  const pb = JSON.parse(readFileSync(eduQuiz, 'utf8'));
  const ids = templateIds(join(root, 'plans/templates'));
  const r = validatePlaybook(pb, { root: dirname(eduQuiz), templates: ids.size ? ids : undefined });
  assert.deepEqual(r.errors, []);
  assert.equal(pb.license, 'proprietary');
  assert.ok(playbookWaves(pb).length >= 3);
});
