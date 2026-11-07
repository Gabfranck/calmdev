// LEV (7 November): what a launched session reads, cut to its task (lib/sessionctx.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { READ_RULE, PLANNER_DOCS_RULE, skillSettings, withSkills, installedPlugins, decisionsExcerpt, decisionsSection, citesDecisions, KEEP } from '../lib/sessionctx.mjs';
import { kindOf } from '../lib/learning.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DECISIONS = readFileSync(path.join(ROOT, 'docs', 'decisions.md'), 'utf8');
// The public repository receives a template docs/decisions.md without the themed sections: the excerpt tests need the real one.
const REAL = /^# Interface$/m.test(DECISIONS) ? {} : { skip: 'docs/decisions.md is the public template (no themed sections)' };
const IDS = ['frontend-design@claude-plugins-official', 'taste-skill@taste-skill', 'hyperframes@claude-plugins-official', 'logo-design@logo-design-skill', 'stripe@claude-plugins-official'];
const KINDS = ['front', 'design', 'back', 'migration', 'qa', 'tests', 'docs', 'other'];

test('the reading rule says: what the task cites, nothing by default', () => {
  assert.match(READ_RULE, /lis ce que ta tâche cite, rien d'autre d'office/);
  assert.match(READ_RULE, /docs\/flot\.md/); assert.match(READ_RULE, /planification et le pilote/);
  assert.match(PLANNER_DOCS_RULE, /cite les fichiers de docs utiles/);
});

test('front keeps taste-skill and frontend-design only, back/qa/tests/migration no design, video or logo plugin', () => {
  const off = (k) => Object.keys(skillSettings(k, { installed: IDS }).enabledPlugins || {}).sort();
  assert.deepEqual(off('front'), ['hyperframes@claude-plugins-official', 'logo-design@logo-design-skill']);
  for (const k of ['back', 'qa', 'tests', 'migration']) assert.deepEqual(off(k), ['frontend-design@claude-plugins-official', 'hyperframes@claude-plugins-official', 'logo-design@logo-design-skill', 'taste-skill@taste-skill'], k);
  assert.deepEqual(off('design'), []);
  assert.deepEqual(off('docs'), []); assert.deepEqual(off('other'), []);
  for (const k of KINDS) assert.ok(!Object.keys(skillSettings(k, { installed: IDS }).enabledPlugins || {}).includes('stripe@claude-plugins-official'), 'a non-design plugin stays as the developer set it');
});

test('withSkills merges into the launch settings and never turns a plugin on', () => {
  const s = withSkills({ hooks: { PreToolUse: [] }, enabledPlugins: { 'x@y': true } }, 'back', { installed: IDS });
  assert.deepEqual(s.hooks, { PreToolUse: [] });
  assert.equal(s.enabledPlugins['x@y'], true);
  assert.equal(s.enabledPlugins['taste-skill@taste-skill'], false);
  assert.ok(Object.values(withSkills({}, 'front', { installed: IDS }).enabledPlugins).every((v) => v === false));
  const same = { a: 1 }; assert.equal(withSkills(same, 'docs', { installed: IDS }), same);
  assert.equal(withSkills(same, 'back', { installed: [] }), same, 'nothing installed: nothing changes');
});

test('installedPlugins reads the user folder, CLAUDE_CONFIG_DIR first, and survives a missing file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lev-'));
  mkdirSync(path.join(dir, 'plugins'));
  writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'taste-skill@taste-skill': [{}] } }));
  assert.deepEqual(installedPlugins({ env: { CLAUDE_CONFIG_DIR: dir } }), ['taste-skill@taste-skill']);
  assert.deepEqual(installedPlugins({ home: path.join(dir, 'none'), env: {} }), []);
});

test('the kind of a session picks its plugins: a screen session is front, a server one back', () => {
  assert.equal(kindOf({ id: 'ECR', name: 'écran des réglages', prompt: 'public/settings.html' }), 'front');
  assert.equal(kindOf({ id: 'SRV', name: 'routes du serveur', prompt: 'server.mjs lib/foo.mjs' }), 'back');
});

test('the excerpt of docs/decisions.md holds the sections of the domain, the head and the recent ones', REAL, () => {
  const front = decisionsExcerpt(DECISIONS, 'front');
  assert.ok(front.titles.some((t) => t.startsWith('Interface')));
  assert.ok(!front.titles.includes('Commercial'));
  assert.match(front.text, /^# Les décisions en vigueur/);
  assert.match(front.text, /^# Interface$/m, 'the parent heading rides with its sections');
  assert.match(front.text, /^# Nouvelles décisions/m);
  const back = decisionsExcerpt(DECISIONS, 'back');
  assert.ok(back.titles.includes('Sessions et worktrees') && !back.titles.some((t) => t.startsWith('Téléphone')));
  for (const k of KINDS) { const ex = decisionsExcerpt(DECISIONS, k); assert.ok(ex && ex.chars < ex.total * 0.6, `${k}: ${ex?.chars} of ${ex?.total}`); }
  assert.equal(decisionsExcerpt('# Rien\n\n## Autre chose\n- x\n', 'front'), null, 'no section of the domain: the file as before');
});

test('the server joins the excerpt only when the task cites docs/decisions.md', REAL, () => {
  assert.ok(citesDecisions('Lis docs/decisions.md, section Revue.'));
  assert.ok(citesDecisions('voir `./docs/decisions.md`'));
  assert.ok(!citesDecisions('voir team/docs/decisions.mdx et lib/decisions.md'));
  assert.equal(decisionsSection({ prompt: 'Corrige la route.', cwd: ROOT, kind: 'back' }), '');
  const sec = decisionsSection({ prompt: 'Lis docs/decisions.md puis corrige la route.', cwd: ROOT, kind: 'back' });
  assert.match(sec, /## Extrait de docs\/decisions\.md \(domaine back\)/);
  assert.match(sec, /ne relis pas docs\/decisions\.md en entier/);
  assert.ok(sec.length < DECISIONS.length * 0.6);
  assert.equal(decisionsSection({ prompt: 'docs/decisions.md', cwd: path.join(ROOT, 'nowhere'), kind: 'back' }), '');
});

// The measure (task 4): what a session of each kind reads by default, before and after. Before: the docs CLAUDE.md
// sent it to (docs/flot.md, ROADMAP.md, docs/decisions.md) and every skill listed. After: the rule, the excerpt when
// cited, the skills of its kind. Characters, the same unit as lib/context.mjs.
export const measure = ({ installed = IDS, listed = { 'frontend-design': 400, 'taste-skill': 1100, 'logo-design': 1000, hyperframes: 22 * 450 } } = {}) => {
  const size = (f) => { try { return readFileSync(path.join(ROOT, f), 'utf8').length; } catch { return 0; } };
  const docs = size('docs/flot.md') + size('ROADMAP.md') + DECISIONS.length;
  const skillsAll = Object.values(listed).reduce((a, b) => a + b, 0);
  return Object.fromEntries(KINDS.map((k) => {
    const offIds = Object.keys(skillSettings(k, { installed }).enabledPlugins || {}).map((id) => id.split('@')[0]);
    const skills = skillsAll - offIds.reduce((n, name) => n + (listed[name] || 0), 0);
    const after = READ_RULE.length + decisionsExcerpt(DECISIONS, k).chars + skills;
    return [k, { before: docs + skillsAll, after }];
  }));
};
test('every kind reads less than before', REAL, () => {
  for (const [k, m] of Object.entries(measure())) assert.ok(m.after < m.before / 2, `${k}: ${m.after} >= ${m.before} / 2`);
  assert.ok(KEEP.front.length === 2);
});

test('SOURCE_RULE asks for the file that proves a claim about a team', async () => {
  const { SOURCE_RULE } = await import('../lib/sessionctx.mjs');
  assert.match(SOURCE_RULE, /infra ou les outils d'une équipe cite le fichier/);
  assert.match(SOURCE_RULE, /supposé/);
});
