// The fixed context of a session (phase 14, docs/frugal.md « Le contexte fixe »): read from the first call of each
// transcript, the median over seven days against the seven days before, the alert above +20 %, the pieces found on
// disk (CLAUDE.md, MEMORY.md, the skills list, the prompts) and GET /api/learning `context`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixedContext, contextPieces, contextReport, projectFolder, tokensOf, ALERT_GROWTH } from '../lib/context.mjs';
import { scanTranscripts, parseTranscript } from '../lib/usage.mjs';
import { learningReport } from '../lib/learning.mjs';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, 'fixtures', 'projects');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const DAY = 864e5;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const session = (id, tokens, daysAgo, project = '/p/one') => ({ sessionId: id, project, model: 'claude-fable-5-1', tokens: 1, firstAt: new Date(NOW - daysAgo * DAY).toISOString(), promptChars: 2000, first: { context: tokens, input: 100, cacheWrite: 0, cacheRead: tokens - 100, model: 'claude-fable-5-1', at: new Date(NOW - daysAgo * DAY).toISOString() } });

test('the first call of a transcript: input + cache written + cache read, the first assistant message out of a sidechain', () => {
  const s = Object.fromEntries(scanTranscripts({ root: ROOT }).map((x) => [x.sessionId, x]));
  assert.deepEqual(s.a1.first, { input: 10, cacheWrite: 100, cacheRead: 1000, context: 1110, model: 'claude-opus-5-5', at: '2026-10-30T10:00:03.000Z' });
  assert.equal(s.b1.first.context, 1000);
  // a sidechain first, then the main call: the main call is the first
  const lines = [
    { type: 'assistant', isSidechain: true, timestamp: '2026-11-01T00:00:00.000Z', message: { id: 's', model: 'm', usage: { input_tokens: 5, cache_read_input_tokens: 5 } } },
    { type: 'assistant', timestamp: '2026-11-01T00:00:01.000Z', message: { id: 'a', model: 'm', usage: { input_tokens: 7, cache_creation_input_tokens: 40000, cache_read_input_tokens: 3 } } },
    { type: 'assistant', timestamp: '2026-11-01T00:00:02.000Z', message: { id: 'b', model: 'm', usage: { input_tokens: 1, cache_read_input_tokens: 40010 } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  assert.equal(parseTranscript(lines, '/x/y.jsonl').first.context, 40010);
  assert.equal(parseTranscript('', '/x/z.jsonl').first, null);
});

test('fixedContext: the median of the last seven days against the seven days before, the alert above +20 %', () => {
  const sessions = [session('a', 40000, 10), session('b', 42000, 9), session('c', 38000, 8), session('d', 50000, 3), session('e', 52000, 2), session('f', 48000, 1), session('x', 999999, 2, '/p/other')];
  const c = fixedContext({ sessions, project: '/p/one', now: NOW });
  assert.equal(c.tokens, 50000); assert.equal(c.sessions, 3);
  assert.equal(c.before, 40000); assert.equal(c.beforeSessions, 3); assert.equal(c.since, null);
  assert.equal(c.growth, 0.25); assert.equal(c.alert, true); assert.equal(c.threshold, ALERT_GROWTH);
  assert.equal(c.latest.sessionId, 'f');
  const flat = fixedContext({ sessions: [session('a', 40000, 10), session('d', 44000, 3)], project: '/p/one', now: NOW });
  assert.equal(flat.growth, 0.1); assert.equal(flat.alert, false);
  // a fall is said as such, never an alert
  assert.equal(fixedContext({ sessions: [session('a', 40000, 10), session('d', 30000, 3)], project: '/p/one', now: NOW }).growth, -0.25);
});

test('fixedContext: a young project compares with its first day; one session says the figure without a growth; nothing says null', () => {
  const young = fixedContext({ sessions: [session('a', 40000, 2.9), session('b', 41000, 2.6), session('c', 50000, 1), session('d', 52000, 0.5)], project: '/p/one', now: NOW });
  assert.equal(young.tokens, 45500); assert.equal(young.before, 40500); assert.equal(young.beforeSessions, 2);
  assert.equal(young.since, new Date(NOW - 2.9 * DAY).toISOString());
  assert.ok(young.growth > 0.12 && young.growth < 0.13);
  const one = fixedContext({ sessions: [session('a', 40000, 1)], project: '/p/one', now: NOW });
  assert.equal(one.tokens, 40000); assert.equal(one.growth, null); assert.equal(one.alert, false);
  const none = fixedContext({ sessions: [], project: '/p/one', now: NOW });
  assert.equal(none.tokens, null); assert.equal(none.growth, null); assert.equal(none.alert, false); assert.equal(none.latest, null);
  // a transcript without a first call (an old cache row) is left out
  assert.equal(fixedContext({ sessions: [{ sessionId: 'z', project: '/p/one', firstAt: new Date(NOW).toISOString() }], project: '/p/one', now: NOW }).tokens, null);
});

test('contextPieces: CLAUDE.md, MEMORY.md of the project, the skills listed (user, plugins, project), the median prompt', () => {
  const home = tmp('escadrille-ctx-home-'); const project = tmp('escadrille-ctx-proj-');
  mkdirSync(path.join(project, '.git')); // a repository: its own root
  writeFileSync(path.join(project, 'CLAUDE.md'), 'x'.repeat(2000));
  const skill = (dir, name, description, body = '') => { mkdirSync(path.join(dir, name), { recursive: true }); writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`); };
  skill(path.join(home, '.claude', 'skills'), 'alpha', 'A'.repeat(100), 'b'.repeat(5000));
  skill(path.join(project, '.claude', 'skills'), 'plan', 'P'.repeat(50));
  const plugin = path.join(home, 'plug', '1.0.0'); skill(path.join(plugin, 'skills'), 'video', 'V'.repeat(200));
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'video@market': [{ installPath: plugin }] } }));
  const mem = path.join(home, '.claude', 'projects', projectFolder(project), 'memory'); mkdirSync(mem, { recursive: true });
  writeFileSync(path.join(mem, 'MEMORY.md'), 'm'.repeat(1200));
  const sessions = [{ ...session('a', 40000, 1, project), promptChars: 3000 }, { ...session('b', 40000, 1, project), promptChars: 5000 }, { ...session('c', 40000, 1, '/elsewhere'), promptChars: 99999 }];
  const p = contextPieces({ project, home, sessions });
  assert.deepEqual(p.claudeMd, { files: [path.join(project, 'CLAUDE.md')], chars: 2000, tokens: 500 });
  assert.equal(p.memory.exists, true); assert.equal(p.memory.chars, 1200); assert.equal(p.memory.tokens, 300);
  assert.equal(p.skills.count, 3);
  assert.deepEqual(p.skills.list.map((s) => [s.name, s.source]), [['video', 'video'], ['alpha', 'user'], ['plan', 'project']]);
  assert.equal(p.skills.chars, (5 + 200 + 4) + (5 + 100 + 4) + (4 + 50 + 4), 'name and description of each, what the system prompt lists');
  assert.ok(p.skills.bodyChars > 5000, 'the bodies are counted apart: read only when a skill is invoked');
  assert.deepEqual(p.prompt, { sessions: 2, chars: 4000, tokens: 1000 });
  assert.equal(p.charsPerToken, 4); assert.equal(tokensOf(4000), 1000);
  // the report: the rest is the first call beyond the pieces found
  const r = contextReport({ sessions, project, now: NOW, home });
  assert.equal(r.tokens, 40000); assert.equal(r.pieces.rest, 40000 - 500 - 300 - p.skills.tokens - 1000);
  // nothing on disk, nothing measured: zeros and nulls, never a throw
  const empty = contextReport({ sessions: [], project: tmp('escadrille-ctx-empty-'), now: NOW, home: tmp('escadrille-ctx-nohome-') });
  assert.equal(empty.tokens, null); assert.equal(empty.pieces.rest, null); assert.equal(empty.pieces.skills.count, 0); assert.equal(empty.pieces.memory.exists, false);
});

test('learningReport carries `context` from the same transcripts as the registry', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table plans (id text primary key, title text, created text, json text, project text); create table sessions (plan text, id text, status text, usage text, at text, session_id text); create table escadrilles (id text primary key, weekly real, reset_at text, at text, project text, usage text); create table reviews (id text primary key, plan text, session text, verdict text, body text, retries integer, escalated integer, kind text, verdict_at text, at text); create table messages (seq integer primary key, escadrille text, role text, text text, data text, at text); create table session_messages (seq integer primary key, plan text, session text, role text, text text, data text, at text); create table review_comments (id integer primary key, review text, body text, author text, at text);');
  const project = tmp('escadrille-ctx-rep-');
  const r = learningReport({ db, project, transcripts: [session('a', 40000, 10, project), session('b', 50000, 1, project)], now: NOW, home: tmp('escadrille-ctx-rep-home-') });
  assert.equal(r.context.tokens, 50000); assert.equal(r.context.before, 40000); assert.equal(r.context.growth, 0.25); assert.equal(r.context.alert, true);
  assert.equal(r.context.pieces.prompt.chars, 2000);
});
